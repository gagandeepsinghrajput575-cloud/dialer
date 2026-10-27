// pulse_audio — the JavaScript surface of the CoreAudio addon.
//
// This file is only bindings: it turns N-API arguments into calls on the device layer in
// coreaudio_impl.mm, and turns failures into readable JavaScript errors. The realtime audio code
// lives in that other file so "the audio thread never touches V8" can be checked by reading one
// file instead of two.
//
// Exported surface (see desktop/daemon/lib/audio/coreaudio.js for the consumer):
//   open({ sampleRate, channels, inputDevice, outputDevice }) -> handle
//   start(handle, onFrame)   onFrame(Buffer<Int16, 160 samples>) — one call per 20 ms of mic audio
//   write(handle, int16)     Buffer or Int16Array; frames are queued for the speaker
//   stop(handle) / close(handle)
//   devices() -> { inputs: [{id,name}], outputs: [{id,name}] }
//   sampleRate() / inputDevice() / outputDevice()  — what the last open() actually got
//
// On a non-Apple build every export throws the same honest error, so the daemon can be built and
// tested anywhere and simply reports "coreaudio: not available" through its `null` fallback.
#include "pulse_audio.h"

#if defined(__APPLE__)
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#endif

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <string>

namespace pulse {
namespace {

const char* const kNotBuilt = "pulse_audio: this build has no CoreAudio — compile it on macOS "
                              "(bash desktop/scripts/build-daemon.sh)";

Unit* unitFrom(const Napi::CallbackInfo& info, size_t index) {
  const Napi::Env env = info.Env();
  if (info.Length() <= index || !info[index].IsExternal()) {
    Napi::TypeError::New(env, "Expected an audio unit handle from open()").ThrowAsJavaScriptException();
    return nullptr;
  }
  return static_cast<Unit*>(info[index].As<Napi::External<Unit>>().Data());
}

}  // namespace
// Only kNotBuilt and unitFrom above are file-private helpers. Everything below is DECLARED in
// pulse_audio.h at `namespace pulse` scope, so it must have external linkage: `Init` at the bottom
// of this file binds those exact symbols into the export table, and the daemon's
// lib/audio/coreaudio.js calls them through it.
//
// They used to be defined inside the anonymous namespace opened above, which created nine DIFFERENT
// internal entities. Nothing in this translation unit called those, so -O2 discarded them and the
// addon was left with pulse::Open/Start/Write/Stop/Close/Devices/SampleRate/InputDevice/OutputDevice
// undefined at link time — a second, independent linkage failure alongside the one in
// coreaudio_impl.mm. Per-file compilation cannot show this; test/native/macho-symbols.py can.

#if defined(__APPLE__)

Napi::Value Open(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  std::string inputDevice;
  std::string outputDevice;
  if (info.Length() > 0 && info[0].IsObject()) {
    const Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("inputDevice") && opts.Get("inputDevice").IsString()) inputDevice = opts.Get("inputDevice").As<Napi::String>();
    if (opts.Has("outputDevice") && opts.Get("outputDevice").IsString()) outputDevice = opts.Get("outputDevice").As<Napi::String>();
  }

  AudioComponentDescription desc = {};
  desc.componentType = kAudioUnitType_Output;
  // HALOutput, not RemoteIO: a dialler has to be able to send audio to a headset while the
  // microphone stays on the desk, which RemoteIO's fixed default device cannot express.
  desc.componentSubType = kAudioUnitSubType_HALOutput;
  desc.componentManufacturer = kAudioUnitManufacturer_Apple;
  AudioComponent component = AudioComponentFindNext(nullptr, &desc);
  if (!component) {
    Napi::Error::New(env, "CoreAudio: no HAL output component on this Mac").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto* unit = new Unit();
  unit->allocate();

  const AudioDeviceID pickedIn = detail::pickDevice(inputDevice, true);
  const AudioDeviceID useIn = pickedIn != kAudioObjectUnknown
      ? pickedIn : detail::fallbackDevice(kAudioHardwarePropertyDefaultInputDevice);
  const AudioDeviceID pickedOut = detail::pickDevice(outputDevice, false);
  const AudioDeviceID useOut = pickedOut != kAudioObjectUnknown
      ? pickedOut : detail::fallbackDevice(kAudioHardwarePropertyDefaultOutputDevice);
  if (useIn == kAudioObjectUnknown || useOut == kAudioObjectUnknown) {
    delete unit;
    Napi::Error::New(env, useIn == kAudioObjectUnknown
        ? "CoreAudio: this Mac reports no input device (microphone)"
        : "CoreAudio: this Mac reports no output device (speaker)").ThrowAsJavaScriptException();
    return env.Null();
  }

  const double outRate = detail::rateOf(useOut);
  const double inRate = detail::rateOf(useIn);
  unit->inRate = inRate > 0 ? inRate : 48000.0;
  unit->outRate = outRate > 0 ? outRate : 48000.0;
  g_deviceRate = unit->outRate;
  g_inputName = detail::nameOf(useIn);
  g_outputName = detail::nameOf(useOut);

  UInt32 enable = 1;
  UInt32 disable = 0;

  // 1. Configure inAU (microphone)
  if (AudioComponentInstanceNew(component, &unit->inAU) != noErr || !unit->inAU) {
    delete unit;
    Napi::Error::New(env, "CoreAudio: could not create microphone audio unit").ThrowAsJavaScriptException();
    return env.Null();
  }
  OSStatus errIn = AudioUnitSetProperty(unit->inAU, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enable, sizeof(enable));
  if (errIn == noErr) errIn = AudioUnitSetProperty(unit->inAU, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &disable, sizeof(disable));
  if (errIn == noErr) errIn = AudioUnitSetProperty(unit->inAU, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &useIn, sizeof(useIn));

  AudioStreamBasicDescription inFmt = {};
  inFmt.mSampleRate = unit->inRate;
  inFmt.mFormatID = kAudioFormatLinearPCM;
  inFmt.mFormatFlags = kLinearPCMFormatFlagIsFloat | kLinearPCMFormatFlagIsPacked;
  inFmt.mBytesPerPacket = sizeof(Float32);
  inFmt.mFramesPerPacket = 1;
  inFmt.mBytesPerFrame = sizeof(Float32);
  inFmt.mChannelsPerFrame = 1;
  inFmt.mBitsPerChannel = 32;
  if (errIn == noErr) errIn = AudioUnitSetProperty(unit->inAU, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &inFmt, sizeof(inFmt));
  AURenderCallbackStruct inputCb = { detail::inputProc, unit };
  if (errIn == noErr) errIn = AudioUnitSetProperty(unit->inAU, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &inputCb, sizeof(inputCb));
  if (errIn == noErr) errIn = AudioUnitInitialize(unit->inAU);
  if (errIn != noErr) {
    AudioComponentInstanceDispose(unit->inAU);
    delete unit;
    Napi::Error::New(env, std::string("CoreAudio: could not configure microphone unit (OSStatus ") + std::to_string(errIn) + ")").ThrowAsJavaScriptException();
    return env.Null();
  }

  // 2. Configure outAU (speaker)
  if (AudioComponentInstanceNew(component, &unit->outAU) != noErr || !unit->outAU) {
    AudioUnitUninitialize(unit->inAU);
    AudioComponentInstanceDispose(unit->inAU);
    delete unit;
    Napi::Error::New(env, "CoreAudio: could not create speaker audio unit").ThrowAsJavaScriptException();
    return env.Null();
  }
  OSStatus errOut = AudioUnitSetProperty(unit->outAU, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &enable, sizeof(enable));
  if (errOut == noErr) errOut = AudioUnitSetProperty(unit->outAU, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &disable, sizeof(disable));
  if (errOut == noErr) errOut = AudioUnitSetProperty(unit->outAU, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &useOut, sizeof(useOut));

  AudioStreamBasicDescription outFmt = {};
  outFmt.mSampleRate = unit->outRate;
  outFmt.mFormatID = kAudioFormatLinearPCM;
  outFmt.mFormatFlags = kLinearPCMFormatFlagIsFloat | kLinearPCMFormatFlagIsPacked;
  outFmt.mBytesPerPacket = sizeof(Float32);
  outFmt.mFramesPerPacket = 1;
  outFmt.mBytesPerFrame = sizeof(Float32);
  outFmt.mChannelsPerFrame = 1;
  outFmt.mBitsPerChannel = 32;
  if (errOut == noErr) errOut = AudioUnitSetProperty(unit->outAU, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &outFmt, sizeof(outFmt));
  AURenderCallbackStruct renderCb = { detail::renderProc, unit };
  if (errOut == noErr) errOut = AudioUnitSetProperty(unit->outAU, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &renderCb, sizeof(renderCb));
  if (errOut == noErr) errOut = AudioUnitInitialize(unit->outAU);
  if (errOut != noErr) {
    AudioUnitUninitialize(unit->inAU);
    AudioComponentInstanceDispose(unit->inAU);
    AudioComponentInstanceDispose(unit->outAU);
    delete unit;
    Napi::Error::New(env, std::string("CoreAudio: could not configure speaker unit (OSStatus ") + std::to_string(errOut) + ")").ThrowAsJavaScriptException();
    return env.Null();
  }

  unit->au = unit->outAU;
  unit->down.configure(unit->inRate, kRate);
  unit->up.configure(kRate, unit->outRate);
  // One 20 ms frame at 8 kHz is 160 samples and expands to 160 * deviceRate / 8000 device samples:
  // 960 at 48 kHz, 882 at 44.1 kHz, 441 at 22.05 kHz.
  const double ratio = (unit->outRate > 0.0) ? unit->outRate / static_cast<double>(kRate) : 1.0;
  unit->expand = static_cast<size_t>(static_cast<double>(kFrame) * ratio + 0.5);
  if (unit->expand < 1) unit->expand = 1;
  if (unit->expand > unit->upScratch.size()) unit->expand = unit->upScratch.size();
  g_units.push_back(unit);
  return Napi::External<Unit>::New(env, unit);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  Unit* unit = unitFrom(info, 0);
  if (!unit) return env.Undefined();
  if (info.Length() > 1 && info[1].IsFunction()) {
    unit->tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "pulse-audio-in", 0, 1);
    unit->tsfnReady = true;
  }
  unit->outRing.reset();
  unit->have = 0;
  unit->consumed = 0;
  unit->carryLen = 0;      // a stale surplus from the last call must not start the new one
  unit->tailLen = 0;       // nor a half-assembled frame from a write that never completed
  unit->downPos = 0.0;
  unit->downLast = 0.0f;
  unit->up.reset();        // clear the FIR history so the new call starts from silence
  unit->down.reset();
  unit->running = true;
  const OSStatus errIn = unit->inAU ? AudioOutputUnitStart(unit->inAU) : noErr;
  const OSStatus errOut = unit->outAU ? AudioOutputUnitStart(unit->outAU) : (unit->au ? AudioOutputUnitStart(unit->au) : noErr);
  if (errIn != noErr || errOut != noErr) {
    unit->running = false;
    if (unit->inAU) AudioOutputUnitStop(unit->inAU);
    if (unit->outAU) AudioOutputUnitStop(unit->outAU);
    Napi::Error::New(env, std::string("CoreAudio: the device would not start (inOSStatus ") + std::to_string(errIn)
        + ", outOSStatus " + std::to_string(errOut) + "). macOS may still be asking for microphone permission.").ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

#endif  // __APPLE__

// Accepts a Buffer or an Int16Array and queues whole 20 ms frames. A partial tail is held until
// the next write completes it, so the ring only ever contains exactly one frame per slot — which
// is what lets the render callback treat "a frame" and "20 ms" as the same thing.
Napi::Value Write(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
#if defined(__APPLE__)
  Unit* unit = unitFrom(info, 0);
  if (!unit) return Napi::Boolean::New(env, false);
#else
  Napi::Error::New(env, kNotBuilt).ThrowAsJavaScriptException();
  return Napi::Boolean::New(env, false);
#endif
  const int16_t* data = nullptr;
  size_t samples = 0;
  if (info.Length() > 1 && info[1].IsBuffer()) {
    auto buf = info[1].As<Napi::Buffer<int16_t>>();
    data = buf.Data();
    samples = buf.Length();
  } else if (info.Length() > 1 && info[1].IsTypedArray()) {
    const Napi::TypedArray arr = info[1].As<Napi::TypedArray>();
    if (arr.TypedArrayType() == napi_int16_array) {
      const Napi::Int16Array i16 = arr.As<Napi::Int16Array>();
      data = i16.Data();
      samples = i16.ElementLength();
    }
  }
  if (!data || samples == 0) return Napi::Boolean::New(env, false);
#if defined(__APPLE__)
  // Framing lives in pulse_audio.h as queueFrames() so a host build can exercise the real code;
  // see the comment there for why the tail is per-unit and is never zeroed.
  queueFrames(unit, data, samples);
#endif
  return Napi::Boolean::New(env, true);
}

#if defined(__APPLE__)

Napi::Value Stop(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  Unit* unit = unitFrom(info, 0);
  if (!unit) return env.Undefined();
  unit->running = false;
  if (unit->inAU) AudioOutputUnitStop(unit->inAU);
  if (unit->outAU) AudioOutputUnitStop(unit->outAU);
  else if (unit->au) AudioOutputUnitStop(unit->au);
  if (unit->tsfnReady) { unit->tsfn.Release(); unit->tsfnReady = false; }
  return env.Undefined();
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  Unit* unit = unitFrom(info, 0);
  if (!unit) return env.Undefined();
  unit->running = false;
  if (unit->inAU) {
    AudioOutputUnitStop(unit->inAU);
    AudioUnitUninitialize(unit->inAU);
    AudioComponentInstanceDispose(unit->inAU);
    unit->inAU = nullptr;
  }
  if (unit->outAU) {
    AudioOutputUnitStop(unit->outAU);
    AudioUnitUninitialize(unit->outAU);
    AudioComponentInstanceDispose(unit->outAU);
    unit->outAU = nullptr;
  }
  unit->au = nullptr;
  if (unit->tsfnReady) { unit->tsfn.Release(); unit->tsfnReady = false; }
  for (auto it = g_units.begin(); it != g_units.end(); ++it) {
    if (*it == unit) { g_units.erase(it); break; }
  }
  delete unit;
  return env.Undefined();
}

Napi::Value Devices(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  Napi::Array inputs = Napi::Array::New(env);
  Napi::Array outputs = Napi::Array::New(env);
  for (AudioDeviceID id : detail::devices()) {
    const std::string uid = detail::uidOf(id);
    if (uid.empty()) continue;
    const std::string name = detail::nameOf(id);
    const bool in = detail::hasStreams(id, kAudioDevicePropertyScopeInput);
    const bool out = detail::hasStreams(id, kAudioDevicePropertyScopeOutput);
    if (!in && !out) continue;
    Napi::Object o = Napi::Object::New(env);
    o.Set("id", uid);
    o.Set("name", name.empty() ? uid : name);
    if (in) inputs.Set(inputs.Length(), o);
    if (out) outputs.Set(outputs.Length(), o);
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("inputs", inputs);
  result.Set("outputs", outputs);
  return result;
}

#else

Napi::Value Devices(const Napi::CallbackInfo& info) {
  Napi::Object result = Napi::Object::New(info.Env());
  result.Set("inputs", Napi::Array::New(info.Env()));
  result.Set("outputs", Napi::Array::New(info.Env()));
  result.Set("error", kNotBuilt);
  return result;
}

#endif  // __APPLE__

Napi::Value SampleRate(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), g_deviceRate); }
Napi::Value InputDevice(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), g_inputName); }
Napi::Value OutputDevice(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), g_outputName); }

// One honest error for every export on a platform with no CoreAudio. Defined outside the Apple
// branch so the `#else` in Init() can point at it.
Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), kNotBuilt).ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

}  // namespace pulse

Napi::Object Init(Napi::Env env, Napi::Object exports) {
#if defined(__APPLE__)
  exports.Set("open", Napi::Function::New(env, pulse::Open));
  exports.Set("start", Napi::Function::New(env, pulse::Start));
  exports.Set("stop", Napi::Function::New(env, pulse::Stop));
  exports.Set("close", Napi::Function::New(env, pulse::Close));
#else
  exports.Set("open", Napi::Function::New(env, pulse::Unsupported));
  exports.Set("start", Napi::Function::New(env, pulse::Unsupported));
  exports.Set("stop", Napi::Function::New(env, pulse::Unsupported));
  exports.Set("close", Napi::Function::New(env, pulse::Unsupported));
#endif
  exports.Set("write", Napi::Function::New(env, pulse::Write));
  exports.Set("devices", Napi::Function::New(env, pulse::Devices));
  exports.Set("sampleRate", Napi::Function::New(env, pulse::SampleRate));
  exports.Set("inputDevice", Napi::Function::New(env, pulse::InputDevice));
  exports.Set("outputDevice", Napi::Function::New(env, pulse::OutputDevice));
  return exports;
}

NODE_API_MODULE(pulse_audio, Init)
