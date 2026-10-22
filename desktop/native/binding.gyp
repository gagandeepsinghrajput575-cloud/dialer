{
  "targets": [
    {
      "target_name": "pulse_audio",
      "sources": [ "src/pulse_audio.mm", "src/coreaudio_impl.mm" ],
      "include_dirs": [ "<!(node -p \"require('node-addon-api').include_dir\")" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "cflags_cc": [ "-std=c++17", "-fobjc-arc", "-O2", "-Wall" ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": [ "-fobjc-arc", "-O2", "-Wall" ]
      },
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "link_settings": {
              "libraries": [
                "-framework CoreAudio",
                "-framework CoreFoundation",
                "-framework AudioToolbox",
                "-framework AVFoundation"
              ]
            },
            "xcode_settings": { "ONLY_ACTIVE_ARCH": "NO" }
          }
        ],
        [
          "target_arch=='arm64' and OS=='mac'",
          { "xcode_settings": { "ARCHS": "arm64" } }
        ]
      ]
    }
  ]
}
