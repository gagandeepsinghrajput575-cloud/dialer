// The only bridge between the React bundle and the native shell. Frozen, no Node in the
// renderer, and every method is an explicit invoke — never a raw ipcRenderer passthrough.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const api = {
  isDesktop: true,
  platform: process.platform,
  version: process.env.PULSE_DESKTOP_VERSION || '',
  status: () => ipcRenderer.invoke('pulse:status'),
  dial: (payload) => ipcRenderer.invoke('pulse:dial', payload),
  answer: () => ipcRenderer.invoke('pulse:answer'),
  decline: () => ipcRenderer.invoke('pulse:decline'),
  hangup: () => ipcRenderer.invoke('pulse:hangup'),
  dtmf: (digit) => ipcRenderer.invoke('pulse:dtmf', { digit }),
  openSoftphone: (phone) => ipcRenderer.invoke('pulse:open-softphone', { phone }),
  state: (payload) => ipcRenderer.invoke('pulse:state', payload),
  onEvent: (handler) => listen('pulse:event', handler),
  onCommand: (handler) => listen('pulse:command', handler),
};

contextBridge.exposeInMainWorld('pulseDesktop', Object.freeze(api));
