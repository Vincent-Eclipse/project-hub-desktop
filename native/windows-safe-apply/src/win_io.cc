#include "win_io.h"

namespace wsa {

ResultCode ReadAllThroughHandle(HANDLE h, uint64_t maxLen, std::vector<uint8_t>* out) {
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(h, zero, nullptr, FILE_BEGIN)) return ResultCode::IO_FAILED;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(h, &size)) return ResultCode::IO_FAILED;
  if (size.QuadPart < 0 || static_cast<uint64_t>(size.QuadPart) > maxLen) return ResultCode::IO_FAILED;
  out->resize(static_cast<size_t>(size.QuadPart));
  size_t readTotal = 0;
  while (readTotal < out->size()) {
    DWORD readNow = 0;
    if (!ReadFile(h, out->data() + readTotal, static_cast<DWORD>(out->size() - readTotal), &readNow, nullptr)) {
      return ResultCode::IO_FAILED;
    }
    if (readNow == 0) break;
    readTotal += readNow;
  }
  if (readTotal != out->size()) return ResultCode::IO_FAILED;
  return ResultCode::OK;
}

}  // namespace wsa
