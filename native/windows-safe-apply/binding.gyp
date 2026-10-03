{
  "targets": [
    {
      "target_name": "windows_safe_apply",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/napi_entry.cc",
            "src/win_path.cc",
            "src/win_identity.cc",
            "src/win_io.cc",
            "src/lease.cc",
            "src/recovery_delete.cc"
          ],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "defines": ["NAPI_VERSION=8", "_UNICODE", "UNICODE", "WSA_ENABLE_TEST_HOOKS"],
          "cflags_cc": ["-std=c++17"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/EHsc"] }
          },
          "libraries": ["Shlwapi.lib", "Bcrypt.lib"]
        }, {
          "sources": ["src/unsupported_platform.cc"],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "defines": ["NAPI_VERSION=8"],
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    },
    {
      "target_name": "windows_safe_apply_production",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/napi_entry.cc",
            "src/win_path.cc",
            "src/win_identity.cc",
            "src/win_io.cc",
            "src/lease.cc",
            "src/recovery_delete.cc"
          ],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "defines": ["NAPI_VERSION=8", "_UNICODE", "UNICODE"],
          "cflags_cc": ["-std=c++17"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/EHsc"] }
          },
          "libraries": ["Shlwapi.lib", "Bcrypt.lib"]
        }, {
          "sources": ["src/unsupported_platform.cc"],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "defines": ["NAPI_VERSION=8"],
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    }
  ]
}
