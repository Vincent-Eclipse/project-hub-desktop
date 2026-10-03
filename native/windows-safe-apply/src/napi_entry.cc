// M4.8B.0 - the ONLY JS-facing surface of this module. Deliberately tiny:
// six fixed entry points, each accepting only a bounded, fully-typed
// structure (never a raw path/flag/command chosen freely by JS). The lease
// handed back to JS is a Napi::External<Lease> - JS can pass it back in, but
// can never read, forge, or manipulate the pointer it wraps.
#include <napi.h>
#include <windows.h>
#include <cmath>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>
#include "lease.h"
#include "recovery_delete.h"
#include "win_path.h"

namespace {

using wsa::EntryOutcome;
using wsa::Lease;
using wsa::Plan;
using wsa::RecoverDeleteCreatedRequest;
using wsa::ResultCode;

std::wstring Utf8ToWide(const std::string& utf8) {
  if (utf8.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  if (len <= 0) return L"";
  std::wstring wide(static_cast<size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), wide.data(), len);
  return wide;
}

void ThrowCoded(Napi::Env env, ResultCode code, const char* context) {
  Napi::Error err = Napi::Error::New(env, std::string(context) + ": " + wsa::ResultCodeName(code));
  err.Set("code", Napi::String::New(env, wsa::ResultCodeName(code)));
  err.ThrowAsJavaScriptException();
}

std::string RequireString(Napi::Env env, Napi::Object obj, const char* key, bool* ok) {
  Napi::Value v = obj.Get(key);
  if (!v.IsString()) {
    *ok = false;
    return "";
  }
  return v.As<Napi::String>().Utf8Value();
}

// V2 hardening: every one of these bounds is checked BEFORE any array is
// iterated or any Buffer is copied into a std::vector, so a caller cannot
// force this boundary to allocate/copy an arbitrarily large amount of memory
// merely by supplying an oversized `proposedBytes` or an oversized array
// before the (much later) Lease::Prepare bound check would have caught it.
bool IsExactLowercaseHex(const std::string& s, size_t exactLength) {
  if (s.size() != exactLength) return false;
  for (char c : s) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool IsExactLowercaseHex64(const std::string& s) { return IsExactLowercaseHex(s, 64); }

// M4.8B.2A - decimal-string -> ULONGLONG parser for recoverDeleteCreated's
// expected*VolumeSerial fields. nativeVolumeSerial is already surfaced to JS
// as a decimal STRING (see OutcomeToObject below - a plain Number would risk
// silent precision loss for a 64-bit value), so the expected-evidence input
// must be parsed the same way, not via a JS Number. Rejects anything that
// isn't a non-empty, digits-only, non-overflowing decimal string - never
// throws (std::stoull is deliberately not used here, since it accepts a
// leading '+'/'-' and silently ignores a non-numeric suffix instead of
// failing closed on it).
bool ParseDecimalUint64(const std::string& s, ULONGLONG* out) {
  if (s.empty() || s.size() > 20) return false;  // ULLONG_MAX has 20 decimal digits
  ULONGLONG value = 0;
  constexpr ULONGLONG kMax = (std::numeric_limits<ULONGLONG>::max)();
  for (char c : s) {
    if (c < '0' || c > '9') return false;
    ULONGLONG digit = static_cast<ULONGLONG>(c - '0');
    if (value > (kMax - digit) / 10) return false;  // would overflow
    value = value * 10 + digit;
  }
  *out = value;
  return true;
}

// M4.8B.2A - exact-length lowercase-hex -> raw bytes decoder for
// recoverDeleteCreated's expected*FileId128Hex fields (mirrors
// nativeFileId128Hex's own lowercase-hex encoding in OutcomeToObject).
// Caller MUST have already validated the string via IsExactLowercaseHex(s,
// outLen*2) - this function trusts that and only decodes.
void DecodeLowercaseHexBytes(const std::string& hex, uint8_t* out, size_t outLen) {
  auto hexVal = [](char c) -> int { return (c <= '9') ? (c - '0') : (c - 'a' + 10); };
  for (size_t i = 0; i < outLen; i++) {
    out[i] = static_cast<uint8_t>((hexVal(hex[i * 2]) << 4) | hexVal(hex[i * 2 + 1]));
  }
}

// A present field that is not an array at all is a malformed plan, not an
// "absent, so ignore it" field - only a genuinely MISSING key is optional.
bool GetOptionalArray(Napi::Object obj, const char* key, Napi::Array* out, bool* ok) {
  if (!obj.Has(key)) {
    *out = Napi::Array::New(obj.Env(), 0);
    return true;
  }
  Napi::Value v = obj.Get(key);
  if (!v.IsArray()) {
    *ok = false;
    return false;
  }
  *out = v.As<Napi::Array>();
  return true;
}

bool ParsePlan(Napi::Env env, Napi::Object planObj, Plan* out) {
  bool ok = true;
  std::string rootUtf8 = RequireString(env, planObj, "root", &ok);
  if (!ok) return false;
  out->root = Utf8ToWide(rootUtf8);
  if (out->root.empty()) return false;
  // V3 hardening: reject an embedded NUL at the very first boundary, before
  // a Lease even exists (so INVALID_PLAN here can never leave any handle
  // open or any filesystem call attempted) - see OpenRootGuard in
  // win_path.cc for why this can't be left to Win32/CreateFileW's own
  // C-string truncation to "catch". Checked here for defense-in-depth AND
  // in win_path.cc so the guarantee holds regardless of caller.
  if (out->root.find(L'\0') != std::wstring::npos) return false;

  Napi::Array sourcesArr, modifiesArr, createsArr;
  if (!GetOptionalArray(planObj, "sources", &sourcesArr, &ok)) return false;
  if (!GetOptionalArray(planObj, "modifies", &modifiesArr, &ok)) return false;
  if (!GetOptionalArray(planObj, "creates", &createsArr, &ok)) return false;

  // Reject oversized arrays BEFORE iterating/copying any of them - this must
  // match (or be at least as strict as) Lease::Prepare's own
  // kMaxEntriesPerKind bound, but checked here at the very first boundary
  // rather than relying on the later native-side bound alone.
  if (sourcesArr.Length() > wsa::kMaxEntriesPerKind || modifiesArr.Length() > wsa::kMaxEntriesPerKind ||
      createsArr.Length() > wsa::kMaxEntriesPerKind) {
    return false;
  }

  for (uint32_t i = 0; i < sourcesArr.Length(); i++) {
    Napi::Value item = sourcesArr.Get(i);
    if (!item.IsObject()) return false;
    Napi::Object o = item.As<Napi::Object>();
    std::string p = RequireString(env, o, "path", &ok);
    if (!ok) return false;
    wsa::SourcePlanEntry e;
    e.relPath = Utf8ToWide(p);
    out->sources.push_back(e);
  }

  for (uint32_t i = 0; i < modifiesArr.Length(); i++) {
    Napi::Value item = modifiesArr.Get(i);
    if (!item.IsObject()) return false;
    Napi::Object o = item.As<Napi::Object>();
    wsa::ModifyPlanEntry e;
    std::string p = RequireString(env, o, "path", &ok);
    e.expectedSha256Hex = RequireString(env, o, "expectedSha256Hex", &ok);
    if (!ok || !IsExactLowercaseHex64(e.expectedSha256Hex)) return false;

    Napi::Value lenV = o.Get("expectedLength");
    if (!lenV.IsNumber()) return false;
    double lenD = lenV.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(lenD) || lenD < 0 || lenD != std::floor(lenD) || lenD > static_cast<double>(wsa::kMaxProposedBytes)) {
      return false;
    }
    e.expectedLength = static_cast<uint64_t>(lenD);

    // Reject an oversized Buffer BEFORE copying it into a std::vector.
    Napi::Value bytesV = o.Get("proposedBytes");
    if (!bytesV.IsBuffer()) return false;
    auto buf = bytesV.As<Napi::Buffer<uint8_t>>();
    if (buf.Length() > wsa::kMaxProposedBytes) return false;
    e.proposedBytes.assign(buf.Data(), buf.Data() + buf.Length());

    e.relPath = Utf8ToWide(p);
    out->modifies.push_back(std::move(e));
  }

  for (uint32_t i = 0; i < createsArr.Length(); i++) {
    Napi::Value item = createsArr.Get(i);
    if (!item.IsObject()) return false;
    Napi::Object o = item.As<Napi::Object>();
    wsa::CreatePlanEntry e;
    std::string p = RequireString(env, o, "path", &ok);
    if (!ok) return false;

    Napi::Value bytesV = o.Get("proposedBytes");
    if (!bytesV.IsBuffer()) return false;
    auto buf = bytesV.As<Napi::Buffer<uint8_t>>();
    if (buf.Length() > wsa::kMaxProposedBytes) return false;
    e.proposedBytes.assign(buf.Data(), buf.Data() + buf.Length());

    e.relPath = Utf8ToWide(p);
    out->creates.push_back(std::move(e));
  }

  return true;
}

// M4.8B.2A - parses recoverDeleteCreated's request object. Every field is
// REQUIRED (no defaults, nothing optional, nothing inferred) - a missing or
// malformed field of ANY kind fails the whole request closed (INVALID_PLAN)
// before any Win32 call exists, mirroring ParsePlan's own discipline above.
// Extra/unknown fields are ignored, exactly like ParsePlan already does for
// the plan object - no exact-key enforcement at this native boundary (that
// belongs to a higher-trust caller if it wants it, as B.1's
// applyAuthorityService.ts does for its own input).
bool ParseRecoverDeleteCreatedRequest(Napi::Env env, Napi::Object obj, RecoverDeleteCreatedRequest* out) {
  bool ok = true;

  std::string rootUtf8 = RequireString(env, obj, "root", &ok);
  if (!ok) return false;
  out->root = Utf8ToWide(rootUtf8);
  if (out->root.empty() || out->root.find(L'\0') != std::wstring::npos) return false;

  std::string relPathUtf8 = RequireString(env, obj, "relPath", &ok);
  if (!ok) return false;
  out->relPath = Utf8ToWide(relPathUtf8);
  if (out->relPath.empty() || out->relPath.find(L'\0') != std::wstring::npos) return false;

  std::string rootSerialStr = RequireString(env, obj, "expectedRootVolumeSerial", &ok);
  if (!ok || !ParseDecimalUint64(rootSerialStr, &out->expectedRootVolumeSerial)) return false;

  std::string rootFileIdHex = RequireString(env, obj, "expectedRootFileId128Hex", &ok);
  if (!ok || !IsExactLowercaseHex(rootFileIdHex, 32)) return false;
  DecodeLowercaseHexBytes(rootFileIdHex, out->expectedRootFileId128, sizeof(out->expectedRootFileId128));

  std::string targetSerialStr = RequireString(env, obj, "expectedVolumeSerial", &ok);
  if (!ok || !ParseDecimalUint64(targetSerialStr, &out->expectedVolumeSerial)) return false;

  std::string targetFileIdHex = RequireString(env, obj, "expectedFileId128Hex", &ok);
  if (!ok || !IsExactLowercaseHex(targetFileIdHex, 32)) return false;
  DecodeLowercaseHexBytes(targetFileIdHex, out->expectedFileId128, sizeof(out->expectedFileId128));

  out->expectedSha256Hex = RequireString(env, obj, "expectedSha256Hex", &ok);
  if (!ok || !IsExactLowercaseHex64(out->expectedSha256Hex)) return false;

  // Same bound/format discipline as ModifyPlanEntry's expectedLength above -
  // finite, non-negative, integral, and within the same fixture-only
  // kMaxProposedBytes bound (a recovery target can never legitimately exceed
  // what this module ever allowed a CREATE to write in the first place).
  Napi::Value lenV = obj.Get("expectedLength");
  if (!lenV.IsNumber()) return false;
  double lenD = lenV.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(lenD) || lenD < 0 || lenD != std::floor(lenD) || lenD > static_cast<double>(wsa::kMaxProposedBytes)) {
    return false;
  }
  out->expectedLength = static_cast<uint64_t>(lenD);

  return true;
}

Napi::Object OutcomeToObject(Napi::Env env, const EntryOutcome& o) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("code", Napi::String::New(env, wsa::ResultCodeName(o.code)));
  obj.Set("sha256Hex", Napi::String::New(env, o.sha256Hex));
  obj.Set("length", Napi::Number::New(env, static_cast<double>(o.length)));
  obj.Set("nativeFileId128Hex", Napi::String::New(env, o.nativeFileId128Hex));
  obj.Set("nativeVolumeSerial", Napi::String::New(env, std::to_string(o.nativeVolumeSerial)));
  return obj;
}

Lease* Unwrap(Napi::Env env, Napi::Value v) {
  if (!v.IsExternal()) {
    Napi::TypeError::New(env, "expected an opaque lease handle").ThrowAsJavaScriptException();
    return nullptr;
  }
  return v.As<Napi::External<Lease>>().Data();
}

void LeaseFinalizer(Napi::Env, Lease* lease) { delete lease; }

Napi::Value PrepareLease(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "prepareLease(plan) requires a plan object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Plan plan;
  if (!ParsePlan(env, info[0].As<Napi::Object>(), &plan)) {
    ThrowCoded(env, ResultCode::INVALID_PLAN, "prepareLease");
    return env.Undefined();
  }

  auto* lease = new Lease();
  std::vector<EntryOutcome> modifyOutcomes;
  EntryOutcome rootOutcome;
  ResultCode rc = lease->Prepare(plan, &modifyOutcomes, &rootOutcome);
  if (rc != ResultCode::OK) {
    delete lease;
    ThrowCoded(env, rc, "prepareLease");
    return env.Undefined();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("lease", Napi::External<Lease>::New(env, lease, LeaseFinalizer));
  result.Set("root", OutcomeToObject(env, rootOutcome));
  Napi::Array modArr = Napi::Array::New(env, modifyOutcomes.size());
  for (size_t i = 0; i < modifyOutcomes.size(); i++) modArr.Set(static_cast<uint32_t>(i), OutcomeToObject(env, modifyOutcomes[i]));
  result.Set("modifies", modArr);
  return result;
}

Napi::Value ApplyModify(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Lease* lease = Unwrap(env, info[0]);
  if (!lease) return env.Undefined();
  size_t index = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  EntryOutcome outcome;
  ResultCode rc = lease->ApplyModify(index, &outcome);
  if (rc != ResultCode::OK) {
    Napi::Object partial = OutcomeToObject(env, outcome);
    Napi::Error err = Napi::Error::New(env, std::string("applyModify: ") + wsa::ResultCodeName(rc));
    err.Set("code", Napi::String::New(env, wsa::ResultCodeName(rc)));
    err.ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return OutcomeToObject(env, outcome);
}

Napi::Value CreateFile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Lease* lease = Unwrap(env, info[0]);
  if (!lease) return env.Undefined();
  size_t index = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  EntryOutcome outcome;
  ResultCode rc = lease->CreateFileEntry(index, &outcome);
  if (rc != ResultCode::OK) {
    ThrowCoded(env, rc, "createFile");
    return env.Undefined();
  }
  return OutcomeToObject(env, outcome);
}

Napi::Value VerifyFile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Lease* lease = Unwrap(env, info[0]);
  if (!lease) return env.Undefined();
  size_t index = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  bool isCreate = info.Length() > 2 && info[2].As<Napi::Boolean>().Value();
  EntryOutcome outcome;
  ResultCode rc = lease->VerifyFile(index, isCreate, &outcome);
  if (rc != ResultCode::OK) {
    ThrowCoded(env, rc, "verifyFile");
    return env.Undefined();
  }
  return OutcomeToObject(env, outcome);
}

Napi::Value RollbackFile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Lease* lease = Unwrap(env, info[0]);
  if (!lease) return env.Undefined();
  size_t index = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  bool isCreate = info.Length() > 2 && info[2].As<Napi::Boolean>().Value();
  EntryOutcome outcome;
  ResultCode rc = lease->RollbackFile(index, isCreate, &outcome);
  if (rc != ResultCode::OK) {
    ThrowCoded(env, rc, "rollbackFile");
    return env.Undefined();
  }
  return OutcomeToObject(env, outcome);
}

// M4.8B.2A - the ONE narrow CREATE recovery-delete entry point. Unlike
// prepareLease/applyModify/createFile/verifyFile/rollbackFile, this is NOT
// part of the multi-entry Lease batch lifecycle at all - it takes no lease
// handle, opens/verifies/deletes exactly one already-existing target in a
// single self-contained call, and requires the caller to supply durable
// expected identity/content evidence for BOTH the root and the target (see
// recovery_delete.h). Exported in BOTH the test and production-shaped
// builds (registered below, OUTSIDE the WSA_ENABLE_TEST_HOOKS block) - this
// is a legitimate recovery primitive, not a test hook.
Napi::Value RecoverDeleteCreated(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "recoverDeleteCreated(request) requires a request object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  RecoverDeleteCreatedRequest request;
  if (!ParseRecoverDeleteCreatedRequest(env, info[0].As<Napi::Object>(), &request)) {
    ThrowCoded(env, ResultCode::INVALID_PLAN, "recoverDeleteCreated");
    return env.Undefined();
  }
  EntryOutcome outcome;
  ResultCode rc = wsa::RecoverDeleteCreated(request, &outcome);
  if (rc != ResultCode::OK) {
    ThrowCoded(env, rc, "recoverDeleteCreated");
    return env.Undefined();
  }
  return OutcomeToObject(env, outcome);
}

Napi::Value CloseLease(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Lease* lease = Unwrap(env, info[0]);
  if (!lease) return env.Undefined();
  lease->Close();
  return env.Undefined();
}

// Test-only exports below this point are compiled ONLY into the
// `windows_safe_apply` target (see binding.gyp's WSA_ENABLE_TEST_HOOKS
// define). The separate `windows_safe_apply_production` target compiles the
// EXACT SAME Lease/win_path/win_identity mutation code from the exact same
// .cc files, but WITHOUT this define - so it never registers setFaultPoint
// or setForceCaseSensitiveForTests at all (see the #ifdef below and
// windowsSafeApply.productionShape.windows.test.ts, which proves this by
// loading both binaries and comparing their exported keys). There are
// deliberately not two different mutation implementations - only the
// JS-facing export list differs between the two build targets.
#ifdef WSA_ENABLE_TEST_HOOKS

// Test-only. Mirrors the existing JS-side __setTestHookAfterStatBefore
// pattern elsewhere in this repo. Inert unless a test explicitly arms a
// specific fault point on a specific plan entry. Not present at all in the
// production-shaped build (see above).
Napi::Value SetFaultPoint(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Lease* lease = Unwrap(env, info[0]);
  if (!lease) return env.Undefined();
  size_t index = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  bool isCreate = info[2].As<Napi::Boolean>().Value();
  std::string name = info[3].As<Napi::String>().Utf8Value();

  static const std::unordered_map<std::string, wsa::FaultPoint> kNames = {
      {"NONE", wsa::FaultPoint::NONE},
      {"FAIL_BEFORE_FIRST_WRITE", wsa::FaultPoint::FAIL_BEFORE_FIRST_WRITE},
      {"SHORT_WRITE", wsa::FaultPoint::SHORT_WRITE},
      {"FAIL_DURING_WRITE", wsa::FaultPoint::FAIL_DURING_WRITE},
      {"FAIL_BEFORE_FINAL_LENGTH", wsa::FaultPoint::FAIL_BEFORE_FINAL_LENGTH},
      {"FAIL_BEFORE_FLUSH", wsa::FaultPoint::FAIL_BEFORE_FLUSH},
      {"FAIL_AFTER_FLUSH_BEFORE_VERIFY", wsa::FaultPoint::FAIL_AFTER_FLUSH_BEFORE_VERIFY},
      {"VERIFY_MISMATCH", wsa::FaultPoint::VERIFY_MISMATCH},
      {"ROLLBACK_WRITE_FAILURE", wsa::FaultPoint::ROLLBACK_WRITE_FAILURE},
      {"FORCE_IDENTITY_CAPTURE_FAILURE", wsa::FaultPoint::FORCE_IDENTITY_CAPTURE_FAILURE},
      {"FORCE_SHA256_FAILURE", wsa::FaultPoint::FORCE_SHA256_FAILURE},
  };
  auto it = kNames.find(name);
  if (it == kNames.end()) {
    Napi::TypeError::New(env, "unknown fault point").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  lease->SetFaultPoint(index, isCreate, it->second);
  return env.Undefined();
}

// Test-only. Forces the case-sensitivity query performed on every guarded
// directory open to report "case-sensitive" - lets a test deterministically
// exercise CASE_SENSITIVE_REJECTED without needing a real per-directory
// case-sensitive fixture (which requires elevation/Developer Mode). Not
// present at all in the production-shaped build.
Napi::Value SetForceCaseSensitiveForTests(const Napi::CallbackInfo& info) {
  bool force = info.Length() > 0 && info[0].As<Napi::Boolean>().Value();
  wsa::__setForceCaseSensitiveForTests(force);
  return info.Env().Undefined();
}

#endif  // WSA_ENABLE_TEST_HOOKS

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platformSupported", Napi::Boolean::New(env, true));
  exports.Set("prepareLease", Napi::Function::New(env, PrepareLease));
  exports.Set("applyModify", Napi::Function::New(env, ApplyModify));
  exports.Set("createFile", Napi::Function::New(env, CreateFile));
  exports.Set("verifyFile", Napi::Function::New(env, VerifyFile));
  exports.Set("rollbackFile", Napi::Function::New(env, RollbackFile));
  exports.Set("closeLease", Napi::Function::New(env, CloseLease));
  // M4.8B.2A - a legitimate recovery primitive, present in BOTH build
  // targets (unlike setFaultPoint/setForceCaseSensitiveForTests below, which
  // stay strictly test-only and WSA_ENABLE_TEST_HOOKS-gated).
  exports.Set("recoverDeleteCreated", Napi::Function::New(env, RecoverDeleteCreated));
#ifdef WSA_ENABLE_TEST_HOOKS
  exports.Set("setFaultPoint", Napi::Function::New(env, SetFaultPoint));
  exports.Set("setForceCaseSensitiveForTests", Napi::Function::New(env, SetForceCaseSensitiveForTests));
#endif
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_safe_apply, Init)
