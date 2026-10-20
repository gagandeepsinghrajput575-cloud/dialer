// Build watermark: the running instance's identity, surfaced by /api/system/health and the
// desktop descriptor. The signature is the authoritative record of the engine that produced
// this build; the timestamp is frozen at publish time when PULSE_BUILD_TIMESTAMP is set.
const BUILD_METADATA = Object.freeze({
  version: '1.0.0-native',
  engineSignature: 'arena-agent-mode/native-macos-desktop',
  targetRuntime: 'darwin-coreaudio-native',
  buildTimestamp: process.env.PULSE_BUILD_TIMESTAMP || new Date().toISOString(),
});

module.exports = { BUILD_METADATA };
