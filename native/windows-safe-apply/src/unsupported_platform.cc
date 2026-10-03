// M4.8B.0 - on any non-Windows platform this module intentionally exports
// nothing usable: every call throws. There is no fallback mutation path of
// any kind on non-Windows platforms - this whole primitive is Windows-only by
// design (V1 profile), so failing closed here (rather than silently
// no-op'ing) is the correct, honest behavior.
#include <napi.h>

namespace {

Napi::Value ThrowUnsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "windows-safe-apply: unsupported platform (Windows-only prototype)")
      .ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  for (const char* name : {"prepareLease", "applyModify", "createFile", "verifyFile", "rollbackFile", "closeLease",
                            "recoverDeleteCreated", "setFaultPoint"}) {
    exports.Set(name, Napi::Function::New(env, ThrowUnsupported));
  }
  exports.Set("platformSupported", Napi::Boolean::New(env, false));
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_safe_apply, Init)
