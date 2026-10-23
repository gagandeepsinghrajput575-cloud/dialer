// Minimal Napi surface for the host DSP harness — just enough that pulse_audio.h and
// coreaudio_impl.mm compile unchanged off macOS.
//
// coreaudio_impl.mm touches very little of N-API: an Env and a Function compared against nullptr, a
// HandleScope, Buffer<int16_t>::Copy, and a ThreadSafeFunction it calls NonBlockingCall on. The
// realtime callbacks reach JavaScript ONLY through that ThreadSafeFunction, so intercepting it is what
// lets the harness see every microphone frame the real inputProc assembles.
//
// Nothing here is on the code path under test. The DSP, the rings, the resampler and the framing are
// all product code; this file only stands in for the JavaScript boundary.
#ifndef PULSE_HOST_NAPI_STUB_H_
#define PULSE_HOST_NAPI_STUB_H_

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <vector>

namespace Napi {

class Value {};
class CallbackInfo {};

class Env {
 public:
  Env() = default;
  explicit Env(void* p) : p_(p) {}
  bool operator==(std::nullptr_t) const { return p_ == nullptr; }
  bool operator!=(std::nullptr_t) const { return p_ != nullptr; }

 private:
  void* p_ = nullptr;
};

class Function {
 public:
  Function() = default;
  bool operator==(std::nullptr_t) const { return true; }   // the harness never installs a callback
  bool operator!=(std::nullptr_t) const { return false; }
  Value Call(std::initializer_list<Value>) { return Value(); }
};

class HandleScope {
 public:
  explicit HandleScope(Env) {}
};

template <typename T>
class Buffer {
 public:
  static Buffer Copy(Env, const T*, size_t) { return Buffer(); }
  operator Value() const { return Value(); }
};

// Every microphone frame the real inputProc assembles is handed here. The harness reads this back to
// measure what the resampler actually produced. `len` defaults to pulse::kFrame (160); the harness
// static_asserts that so the two cannot silently disagree.
extern std::vector<std::vector<int16_t>> g_capturedFrames;
extern size_t g_captureLen;

class ThreadSafeFunction {
 public:
  ThreadSafeFunction() = default;

  // Called on the (simulated) realtime thread with a malloc'd copy of one frame, exactly as the
  // product does. Capture it, then run the product's own callback, which frees the copy.
  template <typename T, typename Fn>
  int NonBlockingCall(T* data, Fn&& fn) {
    if (data) {
      g_capturedFrames.emplace_back(data, data + g_captureLen);
      fn(Env(), Function(), data);
    }
    return 0;
  }

  void Release() {}
  void Abort() {}
};

}  // namespace Napi

#endif  // PULSE_HOST_NAPI_STUB_H_
