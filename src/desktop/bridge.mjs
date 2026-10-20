// Renderer facade for the native shell. Everything returns null/undefined in a normal browser,
// so the web app (and its tests) never has to branch on "am I in Electron?".
export const desktopBridge = () => (typeof window !== 'undefined' ? window.pulseDesktop || null : null);

export const isDesktop = () => !!desktopBridge();

export function onDesktopCommand(handler) {
  const bridge = desktopBridge();
  if (!bridge || typeof bridge.onCommand !== 'function') return () => {};
  return bridge.onCommand(handler);
}

export function pushDesktopState(state) {
  const bridge = desktopBridge();
  if (bridge && typeof bridge.state === 'function') Promise.resolve(bridge.state(state)).catch(() => {});
}

// Option E/A: ask the shell to hand the number to Linphone / the default SIP handler.
export function openInSoftphone(phone) {
  const bridge = desktopBridge();
  if (!bridge || typeof bridge.openSoftphone !== 'function') return false;
  Promise.resolve(bridge.openSoftphone(String(phone || ''))).catch(() => {});
  return true;
}
