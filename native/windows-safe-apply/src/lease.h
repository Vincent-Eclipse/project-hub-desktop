#pragma once
// M4.8B.0 V2 - the guarded-mutation Lease itself. This is the ONLY place that
// performs an actual mutating Win32 call (WriteFile/SetEndOfFile/CREATE_NEW/
// delete-on-close). Every entry is bounded, pre-validated, and fully resolved
// before this object exists - there is no path here that accepts a fresh
// arbitrary path/flag/command from JS.

#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>
#include "common.h"
#include "win_identity.h"
#include "win_path.h"

namespace wsa {

constexpr size_t kMaxEntriesPerKind = 16;
constexpr size_t kMaxRelativePathChars = 240;
constexpr size_t kMaxProposedBytes = 1024 * 1024;  // 1 MiB - fixture-only bound, not a production limit.

struct ModifyPlanEntry {
  std::wstring relPath;
  std::string expectedSha256Hex;
  uint64_t expectedLength = 0;
  std::vector<uint8_t> proposedBytes;
};

struct CreatePlanEntry {
  std::wstring relPath;
  std::vector<uint8_t> proposedBytes;
};

struct SourcePlanEntry {
  std::wstring relPath;
};

struct Plan {
  std::wstring root;
  std::vector<SourcePlanEntry> sources;
  std::vector<ModifyPlanEntry> modifies;
  std::vector<CreatePlanEntry> creates;
};

struct EntryOutcome {
  ResultCode code = ResultCode::INTERNAL_ERROR;
  std::string sha256Hex;
  uint64_t length = 0;
  std::string nativeFileId128Hex;
  ULONGLONG nativeVolumeSerial = 0;
};

class Lease {
 public:
  Lease();
  ~Lease();

  ResultCode Prepare(const Plan& plan, std::vector<EntryOutcome>* modifyOutcomes, EntryOutcome* rootOutcome);

  ResultCode ApplyModify(size_t index, EntryOutcome* outcome);
  ResultCode CreateFileEntry(size_t index, EntryOutcome* outcome);
  ResultCode VerifyFile(size_t index, bool isCreate, EntryOutcome* outcome);
  ResultCode RollbackFile(size_t index, bool isCreate, EntryOutcome* outcome);

  void SetFaultPoint(size_t index, bool isCreate, FaultPoint fp);

  void Close();

  bool closed() const { return closed_; }

 private:
  // V2: every ancestor directory opened while resolving an entry's parent is
  // retained (ancestorChain) for the full lease lifetime, not just the
  // immediate parent - see win_path.h's WalkGuardedAncestorChain. An empty
  // ancestorChain means the entry's immediate parent IS the root itself
  // (root_ is already held separately for the whole lease).
  struct ModifyState {
    ModifyPlanEntry plan;
    std::vector<GuardedDir> ancestorChain;
    HANDLE handle = INVALID_HANDLE_VALUE;
    std::vector<uint8_t> originalBytes;
    NativeIdentity identity;
    bool prepared = false;
    // Set to true the moment the FIRST potentially-mutating Win32 call
    // (WriteFile) is about to be attempted under the exclusive handle - even
    // if that call, or any step after it, then fails. A failure return from
    // WriteFile/SetEndOfFile/FlushFileBuffers is NEVER treated as proof that
    // nothing changed on disk, so rollback eligibility is gated on this flag,
    // not on full success.
    bool mayHaveMutated = false;
    // Set to true only after the FULL sequence (write, exact final length,
    // flush, guarded readback, hash/length verification) has completed
    // successfully.
    bool verifiedApplied = false;
    FaultPoint faultPoint = FaultPoint::NONE;
  };
  struct CreateState {
    CreatePlanEntry plan;
    std::vector<GuardedDir> ancestorChain;
    HANDLE handle = INVALID_HANDLE_VALUE;
    NativeIdentity identity;
    bool parentReady = false;
    // Set to true immediately once CREATE_NEW itself succeeds - the lease
    // now exclusively owns a real, newly-created filesystem object via this
    // handle, regardless of whether the subsequent content write succeeds.
    bool createdOwned = false;
    // Set to true only after the full write+flush+readback+verify sequence
    // succeeds.
    bool createdVerified = false;
    FaultPoint faultPoint = FaultPoint::NONE;
  };
  struct SourceState {
    SourcePlanEntry plan;
    std::vector<GuardedDir> ancestorChain;
    HANDLE handle = INVALID_HANDLE_VALUE;
  };

  GuardedDir root_;
  bool rootReady_ = false;
  std::vector<ModifyState> modifies_;
  std::vector<CreateState> creates_;
  std::vector<SourceState> sources_;
  bool closed_ = false;

  ResultCode ResolveParent(const std::wstring& relPath, std::vector<std::wstring>* segmentsOut,
                           std::vector<GuardedDir>* ancestorChainOut, HANDLE* parentHandleOut);
  std::wstring AbsoluteChildPath(HANDLE parentHandle, const std::wstring& leaf);
};

}  // namespace wsa
