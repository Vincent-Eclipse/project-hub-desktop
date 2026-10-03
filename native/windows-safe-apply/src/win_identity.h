#pragma once
// M4.8B.0 - strong native Windows file identity (FILE_ID_INFO: volume serial
// + 128-bit file id) and SHA-256 (via documented Win32 CNG/BCrypt - no third
// party crypto dependency), both used only against an already-open, already
// guarded HANDLE - never derived from a path string.

#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>
#include "common.h"

namespace wsa {

struct NativeIdentity {
  ULONGLONG volumeSerial = 0;
  uint8_t fileId128[16] = {};
  DWORD attributes = 0;
  DWORD reparseTag = 0;
  bool isReparsePoint = false;
  uint32_t linkCount = 0;
};

// Captures FILE_ID_INFO + FILE_ATTRIBUTE_TAG_INFO + BY_HANDLE_FILE_INFORMATION
// (link count) from an already-open handle. Returns false if any of the
// underlying documented Win32 calls fail (never fabricates identity).
bool CaptureNativeIdentity(HANDLE h, NativeIdentity* out);

bool SameNativeIdentity(const NativeIdentity& a, const NativeIdentity& b);

std::string FormatFileId128Hex(const NativeIdentity& id);

// SHA-256 over an in-memory buffer via BCrypt (Bcrypt.lib). Returns lowercase
// hex. Aborts to false on any BCrypt failure (never returns a fabricated
// digest).
bool Sha256Hex(const uint8_t* data, size_t len, std::string* outHex);

}  // namespace wsa
