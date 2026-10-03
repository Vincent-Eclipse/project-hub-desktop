#pragma once
// M4.8B.0 V2 - bounded Windows path validation + guarded directory traversal.
// This file NEVER accepts a caller-supplied Win32 flag, shell command, or
// arbitrary path form. It only ever validates a plan-relative path made of
// ordinary path segments and walks it component-by-component using a fixed,
// documented Win32 protocol (CreateFileW + FILE_FLAG_BACKUP_SEMANTICS +
// FILE_FLAG_OPEN_REPARSE_POINT + GetFileInformationByHandleEx), rejecting any
// reparse point, non-directory, cross-volume, or case-sensitive parent along
// the way. Every directory opened during a walk is RETAINED (not closed) for
// the full lease lifetime - V2 fixes a V1 bug where only the immediate parent
// was held, which did not actually pin the whole ancestor namespace.

#include <windows.h>
#include <string>
#include <vector>
#include "common.h"

namespace wsa {

constexpr size_t kMaxPathSegments = 16;

// Splits an already-percent-free UTF-16 relative path (using '/' or '\\' as
// separators) into ordinary segments, rejecting: empty segments, "." / "..",
// a leading drive letter or UNC prefix, any embedded NUL, any of the
// characters Windows itself disallows in a normal filename
// (< > : " | ? * and control chars), a trailing space/dot on any segment,
// a Windows reserved DOS/device name as any segment's base name (CON, PRN,
// AUX, NUL, COM1-9, LPT1-9 - case-insensitively, and regardless of a trailing
// extension, since Windows treats "NUL.txt" as the same reserved device as
// "NUL"), and more than kMaxPathSegments segments (bounds ancestor-guard
// handle count). Returns false (UNSUPPORTED_PATH) if the path is anything
// other than a plain, relative, single-volume-relative path.
bool ValidateRelativeSegments(const std::wstring& relativePath, std::vector<std::wstring>* outSegments);

// A single open, guarded directory handle plus the strong identity captured
// while opening it (used to confirm every ancestor in a chain resolves to an
// ordinary, non-reparse, non-case-sensitive directory on the same volume as
// the root).
struct GuardedDir {
  HANDLE handle = INVALID_HANDLE_VALUE;
  ULONGLONG volumeSerial = 0;
};

// Opens `absoluteRootPath` (a caller-trusted root directory path - never
// derived from untrusted input) as a guarded directory handle: rejects
// anything that is not a real, non-reparse, non-case-sensitive, ordinary
// directory on a supported storage profile (local fixed NTFS volume - see
// ValidateSupportedStorageProfile). This is the ONLY function in this module
// that opens an absolute path; every other path here is relative to an
// already-guarded ancestor. Requires a canonical drive-qualified form
// ("C:\..." - rejects "C:foo", UNC, "\\?\", and non-drive-qualified paths).
ResultCode OpenRootGuard(const std::wstring& absoluteRootPath, GuardedDir* outRoot);

// Walks `segments[0..segments.size()-2]` (i.e. every path component except
// the final leaf) starting from `root`, opening and validating EACH
// intermediate directory the same way as OpenRootGuard (reparse/case-
// sensitivity/same-volume checks included), and APPENDING every one of them
// to `outChain` in root-to-leaf order as it succeeds - even on a later
// failure, everything already opened remains in `outChain` for the caller to
// close (mirrors the "push immediately" leak-safety pattern used elsewhere in
// this module). If the leaf has no intermediate ancestors (a single-segment
// relative path), `outChain` is left empty and the caller uses `root` itself
// as the immediate parent - no redundant duplicate handle is created for that
// common case.
ResultCode WalkGuardedAncestorChain(const GuardedDir& root, const std::vector<std::wstring>& segments,
                                     std::vector<GuardedDir>* outChain);

// Confirms `rootHandle`'s volume is a local, fixed NTFS volume (via
// GetVolumeInformationByHandleW for the filesystem name and GetDriveTypeW for
// the fixed/removable/remote classification, derived from the already-
// validated canonical drive letter in `absoluteRootPath`). Fails closed
// (UNSUPPORTED_STORAGE_PROFILE) for anything else - remote/network shares,
// removable media, non-NTFS filesystems - rather than silently accepting
// them. Uses only documented Win32 APIs; no WMI, no PowerShell.
ResultCode ValidateSupportedStorageProfile(HANDLE rootHandle, const std::wstring& absoluteRootPath);

// Test-only. Forces every subsequent case-sensitivity query performed by this
// module to report "case-sensitive" regardless of the real, queried result -
// lets a test deterministically exercise the CASE_SENSITIVE_REJECTED
// rejection path without needing a real per-directory case-sensitive fixture
// (creating one requires elevation/Developer Mode, which may not be
// available in every test environment). Never used by production code (there
// is no production caller of this module at all in M4.8B.0).
void __setForceCaseSensitiveForTests(bool force);

void CloseGuardedDir(GuardedDir* dir);

}  // namespace wsa
