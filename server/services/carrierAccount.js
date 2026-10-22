// Which carrier account the app dials, registers and stamps, and where its SIP gateway lives.
//
// FlyNumber is the default carrier: the Danish DID +45 32 33 16 10 is hosted there, so a call placed
// from FlyNumber's own SIP servers is not subject to the cross-carrier caller-ID blocks that stopped
// the Telnyx route. Telnyx keys are NOT deleted: they stay readable (existing databases load unchanged)
// and are used only when telephony_provider is explicitly set back to 'telnyx'.
const settings = require('../repositories/settingsRepo');
const { TELEPHONY_PROVIDERS } = require('../config/defaults');

const TELNYX_SIP_DOMAIN = 'sip.telnyx.com';
const TELNYX_WEBRTC_WS = 'wss://rtc.telnyx.com';
const FLYNUMBER_SIP_DEFAULT = 'sip.flynumber.com';
const COPENHAGEN_DEFAULT_DID = '+4532331610';

const text = (key) => String(settings.get(key) || '').trim();

const provider = () => {
  const p = String(settings.get('telephony_provider') || 'flynumber').toLowerCase();
  return TELEPHONY_PROVIDERS.includes(p) ? p : 'flynumber';
};

// The one SIP account the app dials, registers and stamps. Telnyx has a fixed WebSocket gateway
// default; FlyNumber does not, so its browser gateway is only what the operator explicitly sets.
// Falling back to rtc.telnyx.com for FlyNumber would hand a FlyNumber account to Telnyx's gateway.
function carrier() {
  if (provider() === 'telnyx') {
    return {
      provider: 'telnyx',
      server: text('telnyx_sip_server') || TELNYX_SIP_DOMAIN,
      user: text('telnyx_sip_user'),
      password: String(settings.get('telnyx_sip_password') || ''),
      wsUrl: text('webrtc_ws_url') || TELNYX_WEBRTC_WS,
      wsUrlSource: text('webrtc_ws_url') ? 'settings' : 'telnyx_default',
    };
  }
  return {
    provider: 'flynumber',
    server: text('flynumber_sip_server') || FLYNUMBER_SIP_DEFAULT,
    user: text('flynumber_sip_user'),
    password: String(settings.get('flynumber_sip_password') || ''),
    wsUrl: text('webrtc_ws_url'),
    wsUrlSource: text('webrtc_ws_url') ? 'settings' : '',
  };
}

module.exports = { provider, carrier, text, TELEPHONY_PROVIDERS, FLYNUMBER_SIP_DEFAULT, COPENHAGEN_DEFAULT_DID, TELNYX_SIP_DOMAIN, TELNYX_WEBRTC_WS };
