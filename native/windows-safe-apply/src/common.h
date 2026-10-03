#pragma once
// M4.8B.0 - shared, tiny result/error vocabulary for the Windows guarded
// mutation primitive prototype. Deliberately small - no generic error
// framework, no exception hierarchy. Every native entry point returns one of
// these fixed codes plus a small, fixed payload; nothing here is derived from
// caller-provided strings.

// FILE_ID_INFO / FileIdInfo (FILE_INFO_BY_HANDLE_CLASS) require the Windows 8+
// SDK surface - this prototype targets modern Windows 10/11 only (the V1
// profile explicitly excludes older platforms), so this is pinned centrally
// here, before any windows.h include anywhere in this module.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <cstdint>
#include <string>

namespace wsa {

enum class ResultCode {
  OK = 0,
  INVALID_PLAN,
  UNSUPPORTED_PATH,
  ROOT_INVALID,
  PARENT_INVALID,
  REPARSE_REJECTED,
  HARDLINK_REJECTED,
  NOT_FOUND,
  ALREADY_EXISTS,
  BUSY,
  PRECONDITION_FAILED,
  IO_FAILED,
  VERIFY_FAILED,
  FAULT_INJECTED,
  BAD_HANDLE,
  UNSUPPORTED_STORAGE_PROFILE,
  CASE_SENSITIVE_REJECTED,
  INTERNAL_ERROR
};

inline const char* ResultCodeName(ResultCode code) {
  switch (code) {
    case ResultCode::OK: return "OK";
    case ResultCode::INVALID_PLAN: return "INVALID_PLAN";
    case ResultCode::UNSUPPORTED_PATH: return "UNSUPPORTED_PATH";
    case ResultCode::ROOT_INVALID: return "ROOT_INVALID";
    case ResultCode::PARENT_INVALID: return "PARENT_INVALID";
    case ResultCode::REPARSE_REJECTED: return "REPARSE_REJECTED";
    case ResultCode::HARDLINK_REJECTED: return "HARDLINK_REJECTED";
    case ResultCode::NOT_FOUND: return "NOT_FOUND";
    case ResultCode::ALREADY_EXISTS: return "ALREADY_EXISTS";
    case ResultCode::BUSY: return "BUSY";
    case ResultCode::PRECONDITION_FAILED: return "PRECONDITION_FAILED";
    case ResultCode::IO_FAILED: return "IO_FAILED";
    case ResultCode::VERIFY_FAILED: return "VERIFY_FAILED";
    case ResultCode::FAULT_INJECTED: return "FAULT_INJECTED";
    case ResultCode::BAD_HANDLE: return "BAD_HANDLE";
    case ResultCode::UNSUPPORTED_STORAGE_PROFILE: return "UNSUPPORTED_STORAGE_PROFILE";
    case ResultCode::CASE_SENSITIVE_REJECTED: return "CASE_SENSITIVE_REJECTED";
    case ResultCode::INTERNAL_ERROR: return "INTERNAL_ERROR";
  }
  return "INTERNAL_ERROR";
}

// Fixed, non-generic fault injection points - test-only, always compiled in
// but inert (NONE) unless a test explicitly arms one via __setFaultPoint on a
// specific lease entry. Mirrors the existing JS-side
// __setTestHookAfterStatBefore pattern used elsewhere in this repo.
enum class FaultPoint : uint32_t {
  NONE = 0,
  FAIL_BEFORE_FIRST_WRITE,
  SHORT_WRITE,
  FAIL_DURING_WRITE,
  FAIL_BEFORE_FINAL_LENGTH,
  FAIL_BEFORE_FLUSH,
  FAIL_AFTER_FLUSH_BEFORE_VERIFY,
  VERIFY_MISMATCH,
  ROLLBACK_WRITE_FAILURE,
  // V3 hardening: forces the post-operation CaptureNativeIdentity call (the
  // one whose result feeds the OK outcome's nativeFileId128Hex/
  // nativeVolumeSerial evidence) to be treated as failed, without needing a
  // genuine Win32 failure to occur. Lets a test deterministically prove that
  // ApplyModify/VerifyFile/RollbackFile can never return OK with a
  // default-constructed (all-zero) NativeIdentity - see lease.cc.
  FORCE_IDENTITY_CAPTURE_FAILURE,
  // V4 hardening: forces the checked SHA-256 computation used for an OK
  // outcome's receipt evidence (sha256Hex) to be treated as failed, without
  // needing a genuine BCrypt failure to occur. Lets a test deterministically
  // prove that ApplyModify/CreateFileEntry/VerifyFile/RollbackFile can never
  // return OK with missing/empty/fabricated SHA-256 evidence - see lease.cc's
  // Sha256HexOrFault.
  FORCE_SHA256_FAILURE
};

}  // namespace wsa
