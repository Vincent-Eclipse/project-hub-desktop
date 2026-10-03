#include "win_identity.h"
#include <bcrypt.h>
#include <cstring>
#include <cstdio>

#pragma comment(lib, "bcrypt.lib")

namespace wsa {

bool CaptureNativeIdentity(HANDLE h, NativeIdentity* out) {
  FILE_ID_INFO idInfo{};
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &idInfo, sizeof(idInfo))) return false;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag))) return false;
  BY_HANDLE_FILE_INFORMATION legacy{};
  if (!GetFileInformationByHandle(h, &legacy)) return false;

  out->volumeSerial = idInfo.VolumeSerialNumber;
  static_assert(sizeof(out->fileId128) == sizeof(idInfo.FileId.Identifier), "FILE_ID_128 size mismatch");
  memcpy(out->fileId128, idInfo.FileId.Identifier, sizeof(out->fileId128));
  out->attributes = tag.FileAttributes;
  out->reparseTag = tag.ReparseTag;
  out->isReparsePoint = (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  out->linkCount = legacy.nNumberOfLinks;
  return true;
}

bool SameNativeIdentity(const NativeIdentity& a, const NativeIdentity& b) {
  return a.volumeSerial == b.volumeSerial && memcmp(a.fileId128, b.fileId128, sizeof(a.fileId128)) == 0;
}

std::string FormatFileId128Hex(const NativeIdentity& id) {
  static const char* hexDigits = "0123456789abcdef";
  std::string out;
  out.reserve(32);
  for (uint8_t b : id.fileId128) {
    out.push_back(hexDigits[(b >> 4) & 0xF]);
    out.push_back(hexDigits[b & 0xF]);
  }
  return out;
}

bool Sha256Hex(const uint8_t* data, size_t len, std::string* outHex) {
  bool ok = false;
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  PBYTE hashObject = nullptr;
  do {
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) break;
    DWORD hashObjectLen = 0, cb = 0;
    if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PBYTE>(&hashObjectLen), sizeof(DWORD), &cb, 0) != 0) break;
    DWORD hashLen = 0;
    if (BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, reinterpret_cast<PBYTE>(&hashLen), sizeof(DWORD), &cb, 0) != 0) break;
    hashObject = new BYTE[hashObjectLen];
    if (BCryptCreateHash(alg, &hash, hashObject, hashObjectLen, nullptr, 0, 0) != 0) break;
    if (len > 0) {
      if (BCryptHashData(hash, const_cast<PUCHAR>(data), static_cast<ULONG>(len), 0) != 0) break;
    }
    std::vector<uint8_t> digest(hashLen);
    if (BCryptFinishHash(hash, digest.data(), hashLen, 0) != 0) break;
    static const char* hexDigits = "0123456789abcdef";
    std::string hex;
    hex.reserve(static_cast<size_t>(hashLen) * 2);
    for (uint8_t b : digest) {
      hex.push_back(hexDigits[(b >> 4) & 0xF]);
      hex.push_back(hexDigits[b & 0xF]);
    }
    *outHex = hex;
    ok = true;
  } while (false);
  if (hash) BCryptDestroyHash(hash);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  delete[] hashObject;
  return ok;
}

}  // namespace wsa
