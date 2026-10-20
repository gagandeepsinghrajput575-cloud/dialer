// macOS menu bar, dock badge and native incoming-call notifications.
const { Menu, app, Notification, clipboard, shell } = require('electron');
const { CARRIER } = require('./config');

function setBadge(count = 0) {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setBadge(count > 0 ? String(count) : '');
}

function notifyIncoming({ callerPhone = '', callerName = '' } = {}) {
  if (!Notification.isSupported()) return;
  const note = new Notification({
    title: callerName ? `${callerName} is calling` : 'Incoming call',
    subtitle: CARRIER.displayDid,
    body: callerPhone || 'Unknown caller',
    urgency: 'critical',
    silent: false,
  });
  note.on('click', () => app.focus({ steal: true }));
  note.show();
}

// `send` drives the renderer (dial/answer/hangup); `openSoftphone` is the Option E/A escape hatch.
function buildMenu({ send, openSoftphone, isDev = false }) {
  const template = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    {
      label: 'Call',
      submenu: [
        {
          label: 'Dial clipboard number',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => send('dial', { phone: String(clipboard.readText() || '').trim() }),
        },
        { label: 'Answer', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('answer') },
        { label: 'Hang up', accelerator: 'CmdOrCtrl+Shift+H', click: () => send('hangup') },
        { type: 'separator' },
        { label: 'Dial clipboard in Linphone', click: () => openSoftphone(String(clipboard.readText() || '').trim()) },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Telnyx Mission Control', click: () => shell.openExternal('https://portal.telnyx.com') },
        ...(isDev ? [{ label: 'Toggle DevTools', accelerator: 'Alt+CmdOrCtrl+I', click: () => send('devtools') }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, setBadge, notifyIncoming };
