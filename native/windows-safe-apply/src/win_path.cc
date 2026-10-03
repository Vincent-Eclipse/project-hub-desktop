#include "win_path.h"
#include <algorithm>
#include <cwchar>
#include <cwctype>
#include <iterator>

namespace wsa {

namespace {

bool g_forceCaseSensitiveForTests = false;

bool IsDisallowedChar(wchar_t c) {
  // Ordinary Windows filename restriction set, plus control characters.
  // Deliberately conservative - this is a fixture-only V1, not a general
  // filename normalizer.
  switch (c) {
    case L'<': case L'>': case L':': case L'"':
    case L'|': case L'?': case L'*':
      return true;
    default:
      return c < 0x20;
  }
}

// Windows reserved DOS/device names - rejected as any segment's base name
// (the part before a first '.'), case-insensitively, regardless of a
// trailing extension: "NUL.txt" refers to the same reserved device as "NUL".
bool IsReservedDeviceBaseName(const std::wstring& baseNameUpper) {
  static const wchar_t* kReserved[] = {L"CON",  L"PRN",  L"AUX",  L"NUL",  L"COM1", L"COM2", L"COM3", L"COM4",
                                        L"COM5", L"COM6", L"COM7", L"COM8", L"COM9", L"LPT1", L"LPT2", L"LPT3",
                                        L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8", L"LPT9"};
  for (const wchar_t* reserved : kReserved) {
    if (baseNameUpper == reserved) return true;
  }
  return false;
}

bool SegmentIsReservedDeviceName(const std::wstring& segment) {
  std::wstring upper = segment;
  std::transform(upper.begin(), upper.end(), upper.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towupper(c)); });
  size_t dot = upper.find(L'.');
  std::wstring base = (dot == std::wstring::npos) ? upper : upper.substr(0, dot);
  return IsReservedDeviceBaseName(base);
}

ResultCode QueryAttributeTag(HANDLE h, FILE_ATTRIBUTE_TAG_INFO* out) {
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, out, sizeof(*out))) {
    return ResultCode::INTERNAL_ERROR;
  }
  return ResultCode::OK;
}

ResultCode QueryVolumeSerial(HANDLE h, ULONGLONG* outSerial) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(h, &info)) return ResultCode::INTERNAL_ERROR;
  *outSerial = info.dwVolumeSerialNumber;
  return ResultCode::OK;
}

// Queries FileCaseSensitiveInfo (Windows 10 1803+ / documented since SDK
// 10.0.17763.0) for the given directory handle. Fails closed
// (CASE_SENSITIVE_REJECTED is NOT returned here on query failure - a query
// failure means "cannot verify", which the caller must treat as a hard
// blocker, never as an implicit pass) - see the INTERNAL_ERROR return.
ResultCode CheckNotCaseSensitive(HANDLE dirHandle) {
  if (g_forceCaseSensitiveForTests) return ResultCode::CASE_SENSITIVE_REJECTED;
  FILE_CASE_SENSITIVE_INFO info{};
  if (!GetFileInformationByHandleEx(dirHandle, FileCaseSensitiveInfo, &info, sizeof(info))) {
    // The API itself is unsupported/unqueryable on this profile - report the
    // blocker rather than silently accepting a possibly case-sensitive
    // directory.
    return ResultCode::INTERNAL_ERROR;
  }
  if (info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR) return ResultCode::CASE_SENSITIVE_REJECTED;
  return ResultCode::OK;
}

// Opens one directory component with the fixed, documented guarded-directory
// protocol: FILE_FLAG_BACKUP_SEMANTICS (required to open any directory via
// CreateFileW at all) + FILE_FLAG_OPEN_REPARSE_POINT (so a reparse point is
// opened AS a reparse point, never transparently followed). Rejects anything
// that is not a plain, non-reparse, non-case-sensitive directory.
ResultCode OpenAndValidateDir(const std::wstring& absolutePath, GuardedDir* out) {
  HANDLE h = CreateFileW(
      absolutePath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) return ResultCode::NOT_FOUND;
    if (err == ERROR_SHARING_VIOLATION) return ResultCode::BUSY;
    return ResultCode::PARENT_INVALID;
  }
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (QueryAttributeTag(h, &tag) != ResultCode::OK) {
    CloseHandle(h);
    return ResultCode::INTERNAL_ERROR;
  }
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    CloseHandle(h);
    return ResultCode::REPARSE_REJECTED;
  }
  if (!(tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
    CloseHandle(h);
    return ResultCode::PARENT_INVALID;
  }
  ResultCode caseRc = CheckNotCaseSensitive(h);
  if (caseRc != ResultCode::OK) {
    CloseHandle(h);
    return caseRc;
  }
  ULONGLONG serial = 0;
  if (QueryVolumeSerial(h, &serial) != ResultCode::OK) {
    CloseHandle(h);
    return ResultCode::INTERNAL_ERROR;
  }
  out->handle = h;
  out->volumeSerial = serial;
  return ResultCode::OK;
}

}  // namespace

bool ValidateRelativeSegments(const std::wstring& relativePath, std::vector<std::wstring>* outSegments) {
  outSegments->clear();
  if (relativePath.empty() || relativePath.size() > 4000) return false;
  if (relativePath.find(L'\0') != std::wstring::npos) return false;
  // Reject any absolute form outright: drive-qualified ("C:" or "C:foo",
  // i.e. ANY colon at index 1 - drive-relative "C:foo" is exactly as
  // dangerous as fully-qualified "C:\foo" here, since both resolve outside
  // the intended plan-relative namespace), UNC ("\\\\"), a leading
  // separator, or the "\\?\" extended-length prefix.
  if (relativePath.size() >= 2 && relativePath[1] == L':') return false;
  if (relativePath.size() >= 2 && (relativePath[0] == L'\\' || relativePath[0] == L'/') &&
      (relativePath[1] == L'\\' || relativePath[1] == L'/')) {
    return false;
  }
  if (relativePath[0] == L'\\' || relativePath[0] == L'/') return false;

  std::wstring current;
  auto flush = [&]() -> bool {
    if (current.empty()) return false;
    if (current == L"." || current == L"..") return false;
    if (current.back() == L' ' || current.back() == L'.') return false;  // trailing space/dot - ambiguous on Windows
    for (wchar_t c : current) {
      if (IsDisallowedChar(c)) return false;
    }
    if (SegmentIsReservedDeviceName(current)) return false;
    outSegments->push_back(current);
    current.clear();
    return true;
  };
  for (wchar_t c : relativePath) {
    if (c == L'\\' || c == L'/') {
      if (!flush()) return false;
    } else {
      current.push_back(c);
    }
  }
  if (!flush()) return false;
  if (outSegments->empty() || outSegments->size() > kMaxPathSegments) return false;
  return true;
}

ResultCode ValidateSupportedStorageProfile(HANDLE rootHandle, const std::wstring& absoluteRootPath) {
  wchar_t fsName[64] = {};
  DWORD fsFlags = 0;
  if (!GetVolumeInformationByHandleW(rootHandle, nullptr, 0, nullptr, nullptr, &fsFlags, fsName,
                                      static_cast<DWORD>(std::size(fsName)))) {
    return ResultCode::UNSUPPORTED_STORAGE_PROFILE;
  }
  if (_wcsicmp(fsName, L"NTFS") != 0) return ResultCode::UNSUPPORTED_STORAGE_PROFILE;

  // absoluteRootPath is already confirmed drive-qualified ("X:\...") by
  // OpenRootGuard before this is called - GetDriveTypeW takes a root path
  // like "C:\\" (a bare drive letter + colon + backslash).
  std::wstring driveRoot = absoluteRootPath.substr(0, 2) + L"\\";
  UINT driveType = GetDriveTypeW(driveRoot.c_str());
  if (driveType != DRIVE_FIXED) return ResultCode::UNSUPPORTED_STORAGE_PROFILE;

  return ResultCode::OK;
}

void __setForceCaseSensitiveForTests(bool force) { g_forceCaseSensitiveForTests = force; }

ResultCode OpenRootGuard(const std::wstring& absoluteRootPath, GuardedDir* outRoot) {
  // V3 hardening: explicitly reject an embedded NUL BEFORE any Win32
  // filesystem API sees this path - std::wstring is length-delimited, not
  // NUL-terminated, so a JS root string containing an embedded L'\0' (e.g.
  // "C:\\allowed\\0\\hidden") survives Utf8ToWide's explicit-length
  // conversion intact, but CreateFileW's own C-string handling would only
  // ever see the prefix up to the first NUL - a silent divergence between
  // what this validator inspects and what the OS actually opens. Checked
  // here, at the true single entry point before any Win32 call touches this
  // path, rather than relying on that truncation as if it were validation.
  if (absoluteRootPath.find(L'\0') != std::wstring::npos) return ResultCode::ROOT_INVALID;
  if (absoluteRootPath.size() < 3 || absoluteRootPath[1] != L':' ||
      (absoluteRootPath[2] != L'\\' && absoluteRootPath[2] != L'/')) {
    // V1/V2 profile requires a canonical drive-qualified root (e.g.
    // "C:\..."). This also rejects drive-RELATIVE forms like "C:foo" (no
    // separator right after the colon). Embedded NUL is handled separately,
    // above - see the V3/V4 hardening comment on this function's first
    // check, which explicitly scans for it rather than assuming it can't
    // occur.
    return ResultCode::ROOT_INVALID;
  }
  wchar_t driveLetter = absoluteRootPath[0];
  if (!((driveLetter >= L'A' && driveLetter <= L'Z') || (driveLetter >= L'a' && driveLetter <= L'z'))) {
    return ResultCode::ROOT_INVALID;
  }
  ResultCode rc = OpenAndValidateDir(absoluteRootPath, outRoot);
  if (rc != ResultCode::OK) {
    // Preserve the more specific rejection reasons; only collapse a truly
    // generic failure to ROOT_INVALID.
    switch (rc) {
      case ResultCode::REPARSE_REJECTED:
      case ResultCode::CASE_SENSITIVE_REJECTED:
        return rc;
      default:
        return ResultCode::ROOT_INVALID;
    }
  }
  ResultCode profileRc = ValidateSupportedStorageProfile(outRoot->handle, absoluteRootPath);
  if (profileRc != ResultCode::OK) {
    CloseGuardedDir(outRoot);
    return profileRc;
  }
  return ResultCode::OK;
}

ResultCode WalkGuardedAncestorChain(const GuardedDir& root, const std::vector<std::wstring>& segments,
                                     std::vector<GuardedDir>* outChain) {
  if (segments.size() < 2) return ResultCode::OK;  // no intermediate ancestors - caller uses `root` directly.

  wchar_t buf[32768];
  DWORD n = GetFinalPathNameByHandleW(root.handle, buf, static_cast<DWORD>(std::size(buf)), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (n == 0 || n >= std::size(buf)) return ResultCode::INTERNAL_ERROR;
  std::wstring currentPath(buf, n);

  ULONGLONG expectedSerial = root.volumeSerial;
  for (size_t i = 0; i + 1 < segments.size(); i++) {
    currentPath += L"\\";
    currentPath += segments[i];
    GuardedDir next{};
    ResultCode rc = OpenAndValidateDir(currentPath, &next);
    if (rc != ResultCode::OK) {
      // Propagate specific, security-relevant codes as-is (REPARSE_REJECTED,
      // CASE_SENSITIVE_REJECTED, NOT_FOUND, BUSY) - only a truly generic
      // open/validate failure collapses to the catch-all PARENT_INVALID.
      // Every ancestor already opened successfully stays in `outChain` for
      // the caller to close - this function never closes what it already
      // pushed.
      switch (rc) {
        case ResultCode::NOT_FOUND:
        case ResultCode::REPARSE_REJECTED:
        case ResultCode::CASE_SENSITIVE_REJECTED:
        case ResultCode::BUSY:
          return rc;
        default:
          return ResultCode::PARENT_INVALID;
      }
    }
    if (next.volumeSerial != expectedSerial) {
      CloseHandle(next.handle);
      return ResultCode::PARENT_INVALID;
    }
    outChain->push_back(next);
  }
  return ResultCode::OK;
}

void CloseGuardedDir(GuardedDir* dir) {
  if (dir->handle != INVALID_HANDLE_VALUE) {
    CloseHandle(dir->handle);
    dir->handle = INVALID_HANDLE_VALUE;
  }
}

}  // namespace wsa
