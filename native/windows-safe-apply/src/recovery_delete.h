#pragma once
// M4.8B.2A - narrow, single-purpose CREATE recovery-delete primitive.
//
// This is NOT a general delete API and does not add RENAME/MOVE or arbitrary
// deletion authority. Its ONLY purpose: given durable evidence a future
// B.2 journal captured and committed BEFORE a crash (never inferred, never
// reconstructed from path or content alone), safely delete the file
// currently at `relPath` under `root` ONLY when it can be proven - via
// native filesystem identity, not path or content alone - to be the EXACT
// SAME object a previous Eclipse CREATE produced.
//
// Security discipline (mirrors every other entry kind in this module):
//   OPEN EXISTING TARGET (OPEN_EXISTING, never CREATE_NEW/CREATE_ALWAYS)
//   -> HOLD ONE EXCLUSIVE GUARDED HANDLE (share=0)
//   -> VERIFY path/root safety (reused, unmodified: ValidateRelativeSegments/
//      OpenRootGuard/WalkGuardedAncestorChain - no new path logic at all)
//   -> VERIFY native identity (root AND target) against caller-supplied
//      durable expected evidence - NEVER inferred from the path string or
//      from content alone
//   -> VERIFY content (exact byte length + SHA-256)
//   -> RE-VERIFY link count + native identity from the SAME handle, BACK-TO-
//      BACK with the delete call immediately below (M4.8B.2A V2 fix - see
//      recovery_delete.cc: M4.8B.0 already empirically proved
//      CreateHardLinkW can succeed against a target even under an exclusive
//      share=0 handle, so the earlier checks - taken before the
//      not-instantaneous content read/hash - could themselves be raced by
//      an external hardlink; this mirrors B.0's own accepted minimum-window
//      mitigation, not a claim of race immunity)
//   -> DELETE THROUGH THAT SAME HANDLE (FILE_DISPOSITION_INFO + CloseHandle -
//      the identical mechanism Lease::RollbackFile's CREATE branch already
//      uses)
//
// Never: close the handle and delete-by-pathname afterward - that would
// reopen exactly the TOCTOU/replacement race this whole module exists to
// avoid. Every check below runs against the ONE handle opened first; nothing
// is ever re-derived from the path string again after that point.
//
// If any required expected-evidence field is missing or malformed, this
// fails at the N-API boundary (napi_entry.cc's ParseRecoverDeleteCreated
// Request) before any Win32 call is made at all - see that function. If root
// identity, target identity, length, or SHA-256 do not EXACTLY match, this
// fails closed (PRECONDITION_FAILED) and the file is left completely
// untouched - a byte-identical replacement with a different native identity
// is never deleted, and a native-identity match with different content is
// never deleted either. A file that cannot be proven to be the same object
// (e.g. because the durable identity evidence was never captured before a
// crash) can never be safely passed to this primitive in the first place -
// that case is a future B.2 RECOVERY_CONFLICT, not something this primitive
// can or should resolve.

#include <windows.h>
#include <cstdint>
#include <string>
#include "common.h"
#include "lease.h"  // EntryOutcome, kMaxRelativePathChars, kMaxProposedBytes

namespace wsa {

struct RecoverDeleteCreatedRequest {
  std::wstring root;
  std::wstring relPath;
  ULONGLONG expectedRootVolumeSerial = 0;
  uint8_t expectedRootFileId128[16] = {};
  ULONGLONG expectedVolumeSerial = 0;
  uint8_t expectedFileId128[16] = {};
  std::string expectedSha256Hex;
  uint64_t expectedLength = 0;
};

ResultCode RecoverDeleteCreated(const RecoverDeleteCreatedRequest& request, EntryOutcome* outcome);

}  // namespace wsa
