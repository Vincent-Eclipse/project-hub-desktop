#pragma once
// M4.8B.2A - tiny shared bounded-read helper.
//
// Extracted from lease.cc, where it previously lived as a local
// anonymous-namespace helper used by every MODIFY/CREATE/VerifyFile/
// RollbackFile content-reading path. Moved here UNCHANGED (every existing
// lease.cc call site already passed kMaxProposedBytes as `maxLen`, so this
// is byte-for-byte behavior-identical for all of them - see lease.cc) so the
// new recovery-delete primitive (recovery_delete.cc) can reuse the exact
// same bounded-read discipline instead of maintaining a second,
// independently-fallible copy of this logic.

#include <windows.h>
#include <cstdint>
#include <vector>
#include "common.h"

namespace wsa {

// Reads the ENTIRE current contents of an already-open, already-guarded
// HANDLE into `out`, bounded by `maxLen`. Fails closed (IO_FAILED) if the
// on-disk size exceeds `maxLen`, if any ReadFile call fails, or if fewer
// bytes are read overall than the file's reported size.
ResultCode ReadAllThroughHandle(HANDLE h, uint64_t maxLen, std::vector<uint8_t>* out);

}  // namespace wsa
