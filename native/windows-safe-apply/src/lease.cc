#include "lease.h"
#include <algorithm>
#include <iterator>
#include "win_io.h"

namespace wsa {

namespace {

ResultCode WriteExactAndFlush(HANDLE h, const std::vector<uint8_t>& bytes, FaultPoint fault) {
  if (fault == FaultPoint::FAIL_BEFORE_FIRST_WRITE) return ResultCode::FAULT_INJECTED;

  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(h, zero, nullptr, FILE_BEGIN)) return ResultCode::IO_FAILED;

  size_t written = 0;
  size_t chunkSize = bytes.size();
  if (fault == FaultPoint::SHORT_WRITE) chunkSize = 4;
  // Force at least one partial chunk so the FAIL_DURING_WRITE check below
  // (written > 0 && written < bytes.size()) can actually observe a
  // partially-written state before the injected failure, instead of the
  // whole small in-memory buffer completing in a single WriteFile call.
  if (fault == FaultPoint::FAIL_DURING_WRITE && bytes.size() > 1) chunkSize = bytes.size() / 2;
  while (written < bytes.size()) {
    size_t want = std::min(chunkSize == 0 ? bytes.size() : chunkSize, bytes.size() - written);
    if (want == 0) want = bytes.size() - written;
    DWORD wroteNow = 0;
    if (!WriteFile(h, bytes.data() + written, static_cast<DWORD>(want), &wroteNow, nullptr)) {
      return ResultCode::IO_FAILED;
    }
    written += wroteNow;
    if (fault == FaultPoint::FAIL_DURING_WRITE && written > 0 && written < bytes.size()) {
      return ResultCode::IO_FAILED;
    }
    if (wroteNow == 0 && want > 0) return ResultCode::IO_FAILED;  // no forward progress - fail closed
  }

  if (fault == FaultPoint::FAIL_BEFORE_FINAL_LENGTH) return ResultCode::FAULT_INJECTED;

  LARGE_INTEGER finalPos{};
  finalPos.QuadPart = static_cast<LONGLONG>(bytes.size());
  if (!SetFilePointerEx(h, finalPos, nullptr, FILE_BEGIN)) return ResultCode::IO_FAILED;
  if (!SetEndOfFile(h)) return ResultCode::IO_FAILED;

  if (fault == FaultPoint::FAIL_BEFORE_FLUSH) return ResultCode::FAULT_INJECTED;
  if (!FlushFileBuffers(h)) return ResultCode::IO_FAILED;

  if (fault == FaultPoint::FAIL_AFTER_FLUSH_BEFORE_VERIFY) return ResultCode::FAULT_INJECTED;
  return ResultCode::OK;
}

// V4 hardening: FillOutcome no longer computes its own hash internally - the
// old `if (Sha256Hex(...)) outcome->sha256Hex = hex;` pattern left
// sha256Hex empty (but still reported the caller's ResultCode::OK) on a
// BCrypt failure. Every caller now MUST have already computed and CHECKED
// the digest (via Sha256Hex/Sha256HexOrFault, failing closed on false)
// before calling in - this is the single chokepoint all of them funnel
// through, so it is the natural place to make "an OK outcome always carries
// real SHA-256 evidence" a fact about the code's structure, not just a
// convention every call site has to remember.
void FillOutcome(EntryOutcome* outcome, ResultCode code, const std::string& sha256Hex, uint64_t length,
                  const NativeIdentity& id) {
  outcome->code = code;
  outcome->length = length;
  outcome->sha256Hex = sha256Hex;
  outcome->nativeFileId128Hex = FormatFileId128Hex(id);
  outcome->nativeVolumeSerial = id.volumeSerial;
}

void CloseChain(std::vector<GuardedDir>* chain) {
  for (auto& dir : *chain) CloseGuardedDir(&dir);
  chain->clear();
}

// V3 hardening: every call site that reports an OK outcome carrying identity
// evidence (nativeFileId128Hex/nativeVolumeSerial, via FillOutcome) must
// route through this instead of calling CaptureNativeIdentity directly - a
// bare, return-value-ignoring CaptureNativeIdentity(h, &id) call followed by
// FillOutcome(..., ResultCode::OK, ..., id) would silently report OK with a
// default-constructed (all-zero) NativeIdentity on the rare real Win32
// failure. FORCE_IDENTITY_CAPTURE_FAILURE lets a test exercise that failure
// path deterministically without needing a genuine one.
bool CaptureIdentityOrFault(HANDLE h, FaultPoint fault, NativeIdentity* out) {
  if (fault == FaultPoint::FORCE_IDENTITY_CAPTURE_FAILURE) return false;
  return CaptureNativeIdentity(h, out);
}

// V4 hardening: every call site that computes the SHA-256 evidence for an OK
// outcome's receipt must route through this instead of calling Sha256Hex
// directly and trusting it blindly - the old pattern
// (`Sha256Hex(..., &actualHex); Sha256Hex(..., &expectedHex); actualHex ==
// expectedHex`) meant that if BOTH calls happened to fail, both strings stay
// empty and "" == "" passes verification with no real SHA-256 evidence
// behind it at all. FORCE_SHA256_FAILURE lets a test exercise the failure
// path deterministically without needing a genuine BCrypt failure.
bool Sha256HexOrFault(const uint8_t* data, size_t len, FaultPoint fault, std::string* out) {
  if (fault == FaultPoint::FORCE_SHA256_FAILURE) return false;
  return Sha256Hex(data, len, out);
}

}  // namespace

Lease::Lease() = default;
Lease::~Lease() { Close(); }

ResultCode Lease::ResolveParent(const std::wstring& relPath, std::vector<std::wstring>* segmentsOut,
                                 std::vector<GuardedDir>* ancestorChainOut, HANDLE* parentHandleOut) {
  if (relPath.size() > kMaxRelativePathChars) return ResultCode::UNSUPPORTED_PATH;
  if (!ValidateRelativeSegments(relPath, segmentsOut)) return ResultCode::UNSUPPORTED_PATH;
  ResultCode rc = WalkGuardedAncestorChain(root_, *segmentsOut, ancestorChainOut);
  if (rc != ResultCode::OK) return rc;
  *parentHandleOut = ancestorChainOut->empty() ? root_.handle : ancestorChainOut->back().handle;
  return ResultCode::OK;
}

std::wstring Lease::AbsoluteChildPath(HANDLE parentHandle, const std::wstring& leaf) {
  wchar_t buf[32768];
  DWORD n = GetFinalPathNameByHandleW(parentHandle, buf, static_cast<DWORD>(std::size(buf)), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (n == 0 || n >= std::size(buf)) return L"";
  std::wstring path(buf, n);
  path += L"\\";
  path += leaf;
  return path;
}

ResultCode Lease::Prepare(const Plan& plan, std::vector<EntryOutcome>* modifyOutcomes, EntryOutcome* rootOutcome) {
  if (plan.sources.size() > kMaxEntriesPerKind || plan.modifies.size() > kMaxEntriesPerKind ||
      plan.creates.size() > kMaxEntriesPerKind) {
    return ResultCode::INVALID_PLAN;
  }

  ResultCode rc = OpenRootGuard(plan.root, &root_);
  if (rc != ResultCode::OK) return rc;
  rootReady_ = true;
  {
    NativeIdentity rootId{};
    if (!CaptureNativeIdentity(root_.handle, &rootId)) return ResultCode::INTERNAL_ERROR;
    if (rootId.isReparsePoint) return ResultCode::REPARSE_REJECTED;
    rootOutcome->code = ResultCode::OK;
    rootOutcome->nativeFileId128Hex = FormatFileId128Hex(rootId);
    rootOutcome->nativeVolumeSerial = rootId.volumeSerial;
  }

  for (const auto& s : plan.sources) {
    // Pushed IMMEDIATELY (before ResolveParent even runs) so that whatever
    // partial ancestor chain WalkGuardedAncestorChain manages to open before
    // a later failure lands directly inside this owned SourceState - Close()
    // will release it regardless of where Prepare() aborts.
    SourceState ss;
    ss.plan = s;
    sources_.push_back(std::move(ss));
    SourceState& sref = sources_.back();

    std::vector<std::wstring> segments;
    HANDLE parentHandle = INVALID_HANDLE_VALUE;
    ResultCode prc = ResolveParent(s.relPath, &segments, &sref.ancestorChain, &parentHandle);
    if (prc != ResultCode::OK) return prc;
    std::wstring absPath = AbsoluteChildPath(parentHandle, segments.back());
    HANDLE h = CreateFileW(absPath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
      DWORD err = GetLastError();
      return err == ERROR_SHARING_VIOLATION ? ResultCode::BUSY : ResultCode::NOT_FOUND;
    }
    sref.handle = h;

    NativeIdentity id{};
    if (!CaptureNativeIdentity(h, &id)) return ResultCode::INTERNAL_ERROR;
    if (id.isReparsePoint) return ResultCode::REPARSE_REJECTED;
  }

  for (const auto& m : plan.modifies) {
    ModifyState st;
    st.plan = m;
    modifies_.push_back(std::move(st));
    ModifyState& ref = modifies_.back();

    std::vector<std::wstring> segments;
    HANDLE parentHandle = INVALID_HANDLE_VALUE;
    ResultCode prc = ResolveParent(m.relPath, &segments, &ref.ancestorChain, &parentHandle);
    if (prc != ResultCode::OK) return prc;
    std::wstring absPath = AbsoluteChildPath(parentHandle, segments.back());

    // A plain (non-reparse) directory can never be a valid MODIFY target -
    // reject it explicitly via a cheap attribute probe before attempting
    // CreateFileW, since opening a directory without
    // FILE_FLAG_BACKUP_SEMANTICS (deliberately not used for ordinary file
    // targets) would otherwise fail with a generic ERROR_ACCESS_DENIED. A
    // reparse-tagged entry (e.g. a directory junction masquerading as the
    // target) is deliberately NOT special-cased here - it still flows into
    // the normal open+identity-check path below, which reports the more
    // specific REPARSE_REJECTED.
    DWORD preAttrs = GetFileAttributesW(absPath.c_str());
    if (preAttrs != INVALID_FILE_ATTRIBUTES && (preAttrs & FILE_ATTRIBUTE_DIRECTORY) &&
        !(preAttrs & FILE_ATTRIBUTE_REPARSE_POINT)) {
      return ResultCode::UNSUPPORTED_PATH;
    }

    HANDLE h = CreateFileW(absPath.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
      DWORD err = GetLastError();
      return err == ERROR_SHARING_VIOLATION ? ResultCode::BUSY
             : (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) ? ResultCode::NOT_FOUND
                                                                             : ResultCode::IO_FAILED;
    }
    ref.handle = h;

    NativeIdentity id{};
    if (!CaptureNativeIdentity(ref.handle, &id)) return ResultCode::INTERNAL_ERROR;
    if (id.isReparsePoint) return ResultCode::REPARSE_REJECTED;
    if (id.attributes & FILE_ATTRIBUTE_DIRECTORY) return ResultCode::UNSUPPORTED_PATH;
    if (id.linkCount > 1) return ResultCode::HARDLINK_REJECTED;
    ref.identity = id;

    ResultCode readRc = ReadAllThroughHandle(ref.handle, kMaxProposedBytes, &ref.originalBytes);
    if (readRc != ResultCode::OK) return readRc;

    std::string actualHex;
    if (!Sha256Hex(ref.originalBytes.data(), ref.originalBytes.size(), &actualHex)) return ResultCode::INTERNAL_ERROR;
    if (actualHex != m.expectedSha256Hex || ref.originalBytes.size() != m.expectedLength) {
      return ResultCode::PRECONDITION_FAILED;
    }
    ref.prepared = true;

    // Reuse the digest already computed and checked above (actualHex) -
    // re-hashing the identical originalBytes again here would be a second,
    // independently-fallible SHA-256 call over the exact same bytes,
    // microseconds apart, with no intervening state change (V4 hardening).
    EntryOutcome outcome;
    FillOutcome(&outcome, ResultCode::OK, actualHex, ref.originalBytes.size(), id);
    modifyOutcomes->push_back(outcome);
  }

  for (const auto& c : plan.creates) {
    if (c.proposedBytes.size() > kMaxProposedBytes) return ResultCode::INVALID_PLAN;
    CreateState st;
    st.plan = c;
    creates_.push_back(std::move(st));
    CreateState& ref = creates_.back();

    std::vector<std::wstring> segments;
    HANDLE parentHandle = INVALID_HANDLE_VALUE;
    ResultCode prc = ResolveParent(c.relPath, &segments, &ref.ancestorChain, &parentHandle);
    if (prc != ResultCode::OK) return prc;
    ref.parentReady = true;
  }

  return ResultCode::OK;
}

ResultCode Lease::ApplyModify(size_t index, EntryOutcome* outcome) {
  if (closed_) return ResultCode::BAD_HANDLE;
  if (index >= modifies_.size()) return ResultCode::BAD_HANDLE;
  ModifyState& st = modifies_[index];
  // Once a mutation attempt (successful or failed) has been made, the entry
  // must be rolled back before another attempt is allowed - retrying
  // WriteExactAndFlush over an already-partially-written file without first
  // restoring it would layer one uncertain state on top of another.
  if (!st.prepared || st.mayHaveMutated) return ResultCode::BAD_HANDLE;

  // Mark rollback-eligible BEFORE attempting the first potentially-mutating
  // Win32 call - except for FAIL_BEFORE_FIRST_WRITE, which is specifically
  // the one fault point that never attempts a write at all, and therefore
  // must remain provably no-mutation (rollback correctly stays BAD_HANDLE
  // for it). A WriteFile/SetEndOfFile/FlushFileBuffers failure returned for
  // ANY other reason is never treated as proof that nothing changed on disk.
  // V2 hardening: CreateHardLinkW against this exact target was empirically
  // found to SUCCEED even while this exclusive share=0 handle is held (it
  // operates on the directory namespace, not the open file object, so
  // share=0 does not block it - though it DOES still block any read/write
  // access through the new alias name, since share-mode arbitration is keyed
  // to the underlying file object). To avoid ever willingly mutating a
  // target that has become multi-linked since Prepare() validated it,
  // re-check the link count via the SAME held handle immediately before
  // attempting the first potentially-mutating call - these two Win32 calls
  // are back-to-back with no I/O wait in between, which closes the window to
  // the practical minimum achievable without kernel-level atomicity (this is
  // NOT claimed to be a perfect guarantee - see M4.8B0-REVIEW-v2.md).
  NativeIdentity recheckId{};
  if (!CaptureNativeIdentity(st.handle, &recheckId)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  if (recheckId.linkCount > 1) {
    // Provably no mutation was attempted - mayHaveMutated stays false,
    // exactly like FAIL_BEFORE_FIRST_WRITE.
    outcome->code = ResultCode::HARDLINK_REJECTED;
    return ResultCode::HARDLINK_REJECTED;
  }

  if (st.faultPoint != FaultPoint::FAIL_BEFORE_FIRST_WRITE) {
    st.mayHaveMutated = true;
  }

  ResultCode rc = WriteExactAndFlush(st.handle, st.plan.proposedBytes, st.faultPoint);
  if (rc != ResultCode::OK) {
    outcome->code = rc;
    return rc;
  }

  std::vector<uint8_t> readback;
  ResultCode readRc = ReadAllThroughHandle(st.handle, kMaxProposedBytes, &readback);
  if (readRc != ResultCode::OK) {
    outcome->code = readRc;
    return readRc;
  }
  // Exact byte-for-byte comparison - both buffers are already fully in
  // memory and bounded to kMaxProposedBytes, so there is no reason to detour
  // through two independently-fallible SHA-256 calls just to decide
  // equality (V4 hardening: that old pattern let "" == "" pass verification
  // if BOTH hash calls happened to fail).
  bool matches = (readback == st.plan.proposedBytes);
  if (st.faultPoint == FaultPoint::VERIFY_MISMATCH) matches = false;
  if (!matches) {
    outcome->code = ResultCode::VERIFY_FAILED;
    return ResultCode::VERIFY_FAILED;
  }

  // The write itself is already fully verified (exact final length, flush,
  // guarded readback, exact byte match against the proposed bytes, all
  // above) - mayHaveMutated/verifiedApplied correctly reflect that
  // regardless of whether the receipt hash or final identity capture below
  // succeed. But this call must fail closed on the RETURNED outcome if it
  // can't vouch for the SHA-256/identity evidence it is contracted to
  // report - never OK with missing/fabricated evidence.
  st.verifiedApplied = true;

  std::string receiptHex;
  if (!Sha256HexOrFault(readback.data(), readback.size(), st.faultPoint, &receiptHex)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }

  NativeIdentity id{};
  if (!CaptureIdentityOrFault(st.handle, st.faultPoint, &id)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  FillOutcome(outcome, ResultCode::OK, receiptHex, readback.size(), id);
  return ResultCode::OK;
}

ResultCode Lease::CreateFileEntry(size_t index, EntryOutcome* outcome) {
  if (closed_) return ResultCode::BAD_HANDLE;
  if (index >= creates_.size()) return ResultCode::BAD_HANDLE;
  CreateState& st = creates_[index];
  // Once CREATE_NEW has succeeded once, the entry must be rolled back
  // (deleted via the owned handle) before another creation attempt.
  if (!st.parentReady || st.createdOwned) return ResultCode::BAD_HANDLE;

  std::vector<std::wstring> segments;
  ValidateRelativeSegments(st.plan.relPath, &segments);
  HANDLE parentHandle = st.ancestorChain.empty() ? root_.handle : st.ancestorChain.back().handle;
  std::wstring absPath = AbsoluteChildPath(parentHandle, segments.back());

  HANDLE h = CreateFileW(absPath.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, 0, nullptr, CREATE_NEW,
                          FILE_FLAG_OPEN_REPARSE_POINT | FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    outcome->code = (err == ERROR_FILE_EXISTS || err == ERROR_ALREADY_EXISTS) ? ResultCode::PRECONDITION_FAILED
                                                                               : ResultCode::IO_FAILED;
    return outcome->code;
  }
  // The lease now exclusively owns a real, newly-created filesystem object
  // via this handle - rollback-eligible from this exact point onward,
  // regardless of whether the content write below succeeds.
  st.handle = h;
  st.createdOwned = true;

  // V2 hardening: the same CreateHardLinkW-during-lease gap documented in
  // ApplyModify above applies here too (empirically confirmed) - an external
  // process can hardlink an alias to our just-created file in the instant
  // after CREATE_NEW succeeds. Re-check before writing any content;
  // createdOwned stays true either way so rollback can still delete the
  // (now possibly multi-linked) object we own via this handle.
  {
    NativeIdentity recheckId{};
    if (!CaptureNativeIdentity(h, &recheckId)) {
      outcome->code = ResultCode::INTERNAL_ERROR;
      return ResultCode::INTERNAL_ERROR;
    }
    if (recheckId.linkCount > 1) {
      outcome->code = ResultCode::HARDLINK_REJECTED;
      return ResultCode::HARDLINK_REJECTED;
    }
  }

  ResultCode rc = WriteExactAndFlush(h, st.plan.proposedBytes, st.faultPoint);
  if (rc != ResultCode::OK) {
    outcome->code = rc;
    return rc;
  }

  std::vector<uint8_t> readback;
  ResultCode readRc = ReadAllThroughHandle(h, kMaxProposedBytes, &readback);
  if (readRc != ResultCode::OK) {
    outcome->code = readRc;
    return readRc;
  }
  // Exact byte-for-byte comparison - see ApplyModify's equivalent check
  // above for why this replaces the old dual-Sha256Hex-then-compare-hex
  // pattern (V4 hardening).
  bool matches = (readback == st.plan.proposedBytes);
  if (st.faultPoint == FaultPoint::VERIFY_MISMATCH) matches = false;
  if (!matches) {
    outcome->code = ResultCode::VERIFY_FAILED;
    return ResultCode::VERIFY_FAILED;
  }

  std::string receiptHex;
  if (!Sha256HexOrFault(readback.data(), readback.size(), st.faultPoint, &receiptHex)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }

  NativeIdentity id{};
  if (!CaptureIdentityOrFault(h, st.faultPoint, &id)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  if (id.isReparsePoint) {
    outcome->code = ResultCode::REPARSE_REJECTED;
    return ResultCode::REPARSE_REJECTED;
  }
  st.identity = id;
  st.createdVerified = true;
  FillOutcome(outcome, ResultCode::OK, receiptHex, readback.size(), id);
  return ResultCode::OK;
}

ResultCode Lease::VerifyFile(size_t index, bool isCreate, EntryOutcome* outcome) {
  if (closed_) return ResultCode::BAD_HANDLE;
  HANDLE h = INVALID_HANDLE_VALUE;
  FaultPoint fp = FaultPoint::NONE;
  if (isCreate) {
    if (index >= creates_.size() || !creates_[index].createdOwned) return ResultCode::BAD_HANDLE;
    h = creates_[index].handle;
    fp = creates_[index].faultPoint;
  } else {
    if (index >= modifies_.size() || !modifies_[index].prepared) return ResultCode::BAD_HANDLE;
    h = modifies_[index].handle;
    fp = modifies_[index].faultPoint;
  }
  std::vector<uint8_t> current;
  ResultCode rc = ReadAllThroughHandle(h, kMaxProposedBytes, &current);
  if (rc != ResultCode::OK) {
    outcome->code = rc;
    return rc;
  }
  std::string currentHex;
  if (!Sha256HexOrFault(current.data(), current.size(), fp, &currentHex)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  NativeIdentity id{};
  if (!CaptureIdentityOrFault(h, fp, &id)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  FillOutcome(outcome, ResultCode::OK, currentHex, current.size(), id);
  return ResultCode::OK;
}

ResultCode Lease::RollbackFile(size_t index, bool isCreate, EntryOutcome* outcome) {
  if (closed_) return ResultCode::BAD_HANDLE;
  if (isCreate) {
    if (index >= creates_.size() || !creates_[index].createdOwned) return ResultCode::BAD_HANDLE;
    CreateState& st = creates_[index];
    if (st.faultPoint == FaultPoint::ROLLBACK_WRITE_FAILURE) {
      outcome->code = ResultCode::FAULT_INJECTED;
      return ResultCode::FAULT_INJECTED;
    }
    FILE_DISPOSITION_INFO disp{};
    disp.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(st.handle, FileDispositionInfo, &disp, sizeof(disp))) {
      outcome->code = ResultCode::IO_FAILED;
      return ResultCode::IO_FAILED;
    }
    CloseHandle(st.handle);
    st.handle = INVALID_HANDLE_VALUE;
    st.createdOwned = false;
    st.createdVerified = false;
    outcome->code = ResultCode::OK;
    return ResultCode::OK;
  }

  if (index >= modifies_.size() || !modifies_[index].mayHaveMutated) return ResultCode::BAD_HANDLE;
  ModifyState& st = modifies_[index];
  if (st.faultPoint == FaultPoint::ROLLBACK_WRITE_FAILURE) {
    outcome->code = ResultCode::FAULT_INJECTED;
    return ResultCode::FAULT_INJECTED;
  }
  ResultCode rc = WriteExactAndFlush(st.handle, st.originalBytes, FaultPoint::NONE);
  if (rc != ResultCode::OK) {
    outcome->code = rc;
    return rc;
  }
  std::vector<uint8_t> readback;
  ResultCode readRc = ReadAllThroughHandle(st.handle, kMaxProposedBytes, &readback);
  if (readRc != ResultCode::OK) {
    outcome->code = readRc;
    return readRc;
  }
  // Exact byte-for-byte comparison - see ApplyModify's equivalent check for
  // why this replaces the old dual-Sha256Hex-then-compare-hex pattern (V4
  // hardening).
  if (readback != st.originalBytes) {
    outcome->code = ResultCode::VERIFY_FAILED;
    return ResultCode::VERIFY_FAILED;
  }
  // Content rollback is already fully verified (exact byte match against
  // originalBytes, above) - the entry genuinely no longer needs rollback, so
  // mayHaveMutated/verifiedApplied are updated regardless of whether the
  // receipt hash or final identity capture below succeed; but the RETURNED
  // outcome must still fail closed rather than report OK with missing/
  // fabricated evidence.
  st.mayHaveMutated = false;
  st.verifiedApplied = false;

  std::string receiptHex;
  if (!Sha256HexOrFault(readback.data(), readback.size(), st.faultPoint, &receiptHex)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }

  NativeIdentity id{};
  if (!CaptureIdentityOrFault(st.handle, st.faultPoint, &id)) {
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  FillOutcome(outcome, ResultCode::OK, receiptHex, readback.size(), id);
  return ResultCode::OK;
}

void Lease::SetFaultPoint(size_t index, bool isCreate, FaultPoint fp) {
  if (isCreate) {
    if (index < creates_.size()) creates_[index].faultPoint = fp;
  } else {
    if (index < modifies_.size()) modifies_[index].faultPoint = fp;
  }
}

void Lease::Close() {
  if (closed_) return;
  closed_ = true;
  for (auto& s : sources_) {
    if (s.handle != INVALID_HANDLE_VALUE) CloseHandle(s.handle);
    CloseChain(&s.ancestorChain);
  }
  for (auto& m : modifies_) {
    if (m.handle != INVALID_HANDLE_VALUE) CloseHandle(m.handle);
    CloseChain(&m.ancestorChain);
  }
  for (auto& c : creates_) {
    if (c.handle != INVALID_HANDLE_VALUE) CloseHandle(c.handle);
    CloseChain(&c.ancestorChain);
  }
  if (rootReady_) CloseGuardedDir(&root_);
}

}  // namespace wsa
