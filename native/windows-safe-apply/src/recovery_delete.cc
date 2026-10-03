#include "recovery_delete.h"
#include <cstring>
#include <iterator>
#include "win_identity.h"
#include "win_io.h"
#include "win_path.h"

namespace wsa {

namespace {

// Identical construction to Lease::AbsoluteChildPath (lease.cc) - duplicated
// here (not shared) because that method is a private Lease member tied to
// the multi-entry batch lifecycle, while this primitive is a standalone,
// single-shot operation with no Lease object at all. The logic itself is a
// few lines of documented Win32 (GetFinalPathNameByHandleW + append leaf);
// the security-relevant bounded-read logic (the part actually worth sharing
// to avoid two independently-fallible copies) is what win_io.h factors out.
std::wstring AbsoluteChildPathFor(HANDLE parentHandle, const std::wstring& leaf) {
  wchar_t buf[32768];
  DWORD n = GetFinalPathNameByHandleW(parentHandle, buf, static_cast<DWORD>(std::size(buf)), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (n == 0 || n >= std::size(buf)) return L"";
  std::wstring path(buf, n);
  path += L"\\";
  path += leaf;
  return path;
}

void CloseChain(std::vector<GuardedDir>* chain) {
  for (auto& dir : *chain) CloseGuardedDir(&dir);
  chain->clear();
}

}  // namespace

ResultCode RecoverDeleteCreated(const RecoverDeleteCreatedRequest& request, EntryOutcome* outcome) {
  *outcome = EntryOutcome{};

  // 1) Path safety - the EXACT same bounded relative-path validator every
  //    other entry kind (MODIFY/CREATE/source) already uses. No new path
  //    validation logic is introduced here at all.
  if (request.relPath.size() > kMaxRelativePathChars) {
    outcome->code = ResultCode::UNSUPPORTED_PATH;
    return ResultCode::UNSUPPORTED_PATH;
  }
  std::vector<std::wstring> segments;
  if (!ValidateRelativeSegments(request.relPath, &segments)) {
    outcome->code = ResultCode::UNSUPPORTED_PATH;
    return ResultCode::UNSUPPORTED_PATH;
  }

  // 2) Root safety - the EXACT same guarded-root open every other entry kind
  //    uses (embedded-NUL rejection, drive-qualified form, reparse rejection,
  //    case-sensitivity rejection, NTFS/fixed-volume checks all already
  //    happen inside OpenRootGuard - nothing duplicated or reimplemented).
  GuardedDir root{};
  ResultCode rootRc = OpenRootGuard(request.root, &root);
  if (rootRc != ResultCode::OK) {
    outcome->code = rootRc;
    return rootRc;
  }

  // 3) Root IDENTITY must match the durable evidence the caller captured
  //    BEFORE the original CREATE - NEVER inferred from the path string. A
  //    caller pointing this at a different (even if similarly-named) root
  //    must fail closed here, before any target is even resolved.
  NativeIdentity rootId{};
  if (!CaptureNativeIdentity(root.handle, &rootId)) {
    CloseGuardedDir(&root);
    outcome->code = ResultCode::INTERNAL_ERROR;
    return ResultCode::INTERNAL_ERROR;
  }
  if (rootId.volumeSerial != request.expectedRootVolumeSerial ||
      memcmp(rootId.fileId128, request.expectedRootFileId128, sizeof(rootId.fileId128)) != 0) {
    CloseGuardedDir(&root);
    outcome->code = ResultCode::PRECONDITION_FAILED;
    return ResultCode::PRECONDITION_FAILED;
  }

  // 4) Guard every intermediate ancestor exactly like MODIFY/CREATE do -
  //    reused, unmodified.
  std::vector<GuardedDir> ancestorChain;
  ResultCode chainRc = WalkGuardedAncestorChain(root, segments, &ancestorChain);
  if (chainRc != ResultCode::OK) {
    CloseChain(&ancestorChain);
    CloseGuardedDir(&root);
    outcome->code = chainRc;
    return chainRc;
  }
  HANDLE parentHandle = ancestorChain.empty() ? root.handle : ancestorChain.back().handle;
  std::wstring absPath = AbsoluteChildPathFor(parentHandle, segments.back());

  // 5) Same directory pre-check MODIFY uses (lease.cc): a plain (non-reparse)
  //    directory can never be a valid recovery-delete target - reject it
  //    explicitly via a cheap attribute probe before CreateFileW, since
  //    opening a directory without FILE_FLAG_BACKUP_SEMANTICS would
  //    otherwise fail with a generic ERROR_ACCESS_DENIED. A reparse-tagged
  //    entry is deliberately NOT special-cased here - it still flows into
  //    the normal open+identity-check path below, which reports the more
  //    specific REPARSE_REJECTED.
  DWORD preAttrs = GetFileAttributesW(absPath.c_str());
  if (preAttrs != INVALID_FILE_ATTRIBUTES && (preAttrs & FILE_ATTRIBUTE_DIRECTORY) &&
      !(preAttrs & FILE_ATTRIBUTE_REPARSE_POINT)) {
    CloseChain(&ancestorChain);
    CloseGuardedDir(&root);
    outcome->code = ResultCode::UNSUPPORTED_PATH;
    return ResultCode::UNSUPPORTED_PATH;
  }

  // 6) Open the EXISTING target - OPEN_EXISTING only (never CREATE_NEW/
  //    CREATE_ALWAYS - this primitive never creates anything). Smallest
  //    rights needed: GENERIC_READ (to verify content) + DELETE (to remove
  //    via THIS SAME handle later) - no GENERIC_WRITE, since this primitive
  //    never writes content. share=0 (exclusive), matching MODIFY's own
  //    discipline. FILE_FLAG_OPEN_REPARSE_POINT so a reparse point is opened
  //    AS a reparse point rather than silently followed to whatever it
  //    points at - the identity check below then rejects it explicitly.
  HANDLE h = CreateFileW(absPath.c_str(), GENERIC_READ | DELETE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT,
                          nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    CloseChain(&ancestorChain);
    CloseGuardedDir(&root);
    ResultCode openRc = (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) ? ResultCode::NOT_FOUND
                         : (err == ERROR_SHARING_VIOLATION)                          ? ResultCode::BUSY
                                                                                      : ResultCode::IO_FAILED;
    outcome->code = openRc;
    return openRc;
  }

  // From here on, `h` is the ONE handle every remaining check AND the final
  // delete operate on - never reopened, never re-derived from `absPath`
  // again. This is the entire point of this primitive: verify-then-delete
  // through the SAME opened object, never check-path-then-delete-by-name.
  // Defensive default (never actually reached - every branch below sets
  // finalRc explicitly before breaking or falling through) - if some future
  // edit ever missed a path, this fails closed rather than reading
  // uninitialized memory as a success code.
  ResultCode finalRc = ResultCode::INTERNAL_ERROR;
  std::string actualHex;
  std::vector<uint8_t> current;
  NativeIdentity targetId{};
  // Filled by the back-to-back late recheck immediately before the delete
  // call, below - declared here (not inside the do-while) so the success
  // path can report the freshest identity actually observed at delete time.
  NativeIdentity recheckId{};
  do {
    if (!CaptureNativeIdentity(h, &targetId)) {
      finalRc = ResultCode::INTERNAL_ERROR;
      break;
    }

    // Reparse safety - a symlink/junction placed at this exact path since
    // the original CREATE (e.g. by an external tool during the crash
    // window) must never be followed or deleted transparently.
    if (targetId.isReparsePoint) {
      finalRc = ResultCode::REPARSE_REJECTED;
      break;
    }
    // A directory can never be a valid recovery-delete target (CREATE never
    // produces one).
    if (targetId.attributes & FILE_ATTRIBUTE_DIRECTORY) {
      finalRc = ResultCode::UNSUPPORTED_PATH;
      break;
    }
    // Hardlink policy - UNCHANGED from MODIFY/CREATE's own rule (lease.cc):
    // if the object about to be deleted currently has more than one link,
    // this primitive cannot be sure deleting THIS name is safe/expected -
    // fail closed rather than silently deleting a multi-linked object. No
    // bypass of the accepted B.0 hardlink policy is introduced here.
    if (targetId.linkCount > 1) {
      finalRc = ResultCode::HARDLINK_REJECTED;
      break;
    }

    // Target IDENTITY must match the durable evidence captured at the
    // original CREATE's success - the ONLY safe proof of authorship this
    // module has (see recovery_delete.h). Content match alone is never
    // treated as sufficient - checked separately, below, in addition to
    // (never instead of) this.
    if (targetId.volumeSerial != request.expectedVolumeSerial ||
        memcmp(targetId.fileId128, request.expectedFileId128, sizeof(targetId.fileId128)) != 0) {
      finalRc = ResultCode::PRECONDITION_FAILED;
      break;
    }

    ResultCode readRc = ReadAllThroughHandle(h, kMaxProposedBytes, &current);
    if (readRc != ResultCode::OK) {
      finalRc = readRc;
      break;
    }
    if (current.size() != request.expectedLength) {
      finalRc = ResultCode::PRECONDITION_FAILED;
      break;
    }
    if (!Sha256Hex(current.data(), current.size(), &actualHex)) {
      finalRc = ResultCode::INTERNAL_ERROR;
      break;
    }
    if (actualHex != request.expectedSha256Hex) {
      finalRc = ResultCode::PRECONDITION_FAILED;
      break;
    }

    // M4.8B.2A V2 (independent-review fix) - late-hardlink/identity
    // recheck, deliberately placed BACK-TO-BACK with the one remaining
    // mutating call below, with no I/O or hashing in between. M4.8B.0
    // already empirically proved CreateHardLinkW can succeed against a
    // target even while an exclusive share=0 handle is held (see lease.cc's
    // ApplyModify/CreateFileEntry "V2 hardening" comments) - the
    // reparse/hardlink/identity/content verification above all ran BEFORE
    // this point and could itself be raced by an external hardlink created
    // during that window (content reading + SHA-256 hashing is not
    // instantaneous). This mirrors B.0's own accepted mitigation exactly:
    // re-capture identity from the SAME still-open handle immediately
    // before the mutating call, and fail closed if anything changed. This
    // is the SAME minimum-window, best-effort mitigation B.0 already relies
    // on - never a claim of immunity to a deliberately malicious same-user
    // race (see this primitive's own file header and lease.cc's identical
    // caveat).
    if (!CaptureNativeIdentity(h, &recheckId)) {
      finalRc = ResultCode::INTERNAL_ERROR;
      break;
    }
    if (recheckId.linkCount > 1) {
      finalRc = ResultCode::HARDLINK_REJECTED;
      break;
    }
    if (recheckId.volumeSerial != request.expectedVolumeSerial ||
        memcmp(recheckId.fileId128, request.expectedFileId128, sizeof(recheckId.fileId128)) != 0) {
      finalRc = ResultCode::PRECONDITION_FAILED;
      break;
    }

    // Every check passed - delete through THIS SAME handle. Identical
    // mechanism to Lease::RollbackFile's CREATE branch (lease.cc): set
    // delete-on-close disposition, then CloseHandle (below, unconditionally)
    // actually performs the deletion.
    FILE_DISPOSITION_INFO disp{};
    disp.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(h, FileDispositionInfo, &disp, sizeof(disp))) {
      finalRc = ResultCode::IO_FAILED;
      break;
    }
    finalRc = ResultCode::OK;
  } while (false);

  // CloseHandle unconditionally: if the disposition flag was successfully
  // set above, this is what actually performs the delete; if any earlier
  // check failed, no disposition was ever set, so this is an ordinary close
  // that mutates nothing.
  CloseHandle(h);
  CloseChain(&ancestorChain);
  CloseGuardedDir(&root);

  if (finalRc != ResultCode::OK) {
    outcome->code = finalRc;
    return finalRc;
  }

  outcome->code = ResultCode::OK;
  outcome->sha256Hex = actualHex;
  outcome->length = current.size();
  // Reports the freshest identity actually observed (the late recheck,
  // immediately before the delete call) rather than the earlier `targetId`
  // capture - the more accurate evidence for what was truly deleted.
  outcome->nativeFileId128Hex = FormatFileId128Hex(recheckId);
  outcome->nativeVolumeSerial = recheckId.volumeSerial;
  return ResultCode::OK;
}

}  // namespace wsa
