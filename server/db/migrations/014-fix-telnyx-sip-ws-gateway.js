// Migration 14: Ensure Standard SIP over WSS gateway (wss://sip.telnyx.com:7443)
// replaces any legacy proprietary Telnyx RTC WebSocket endpoint in settings.

function up(db) {
  db.prepare(`
    UPDATE settings
    SET value = ''
    WHERE key = 'webrtc_ws_url'
      AND LOWER(TRIM(value)) IN ('wss://rtc.telnyx.com', 'wss://rtc.telnyx.com/', 'ws://rtc.telnyx.com', 'ws://rtc.telnyx.com/')
  `).run();
}

module.exports = { version: 14, name: 'fix-telnyx-sip-ws-gateway', up };
