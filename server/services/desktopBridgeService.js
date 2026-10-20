// The contract the native macOS shell and the Linphone fallback read. It is a descriptor, not a
// credential: no SIP password, no API key. The route that serves it demands x-pulse-token.
const settings = require('../repositories/settingsRepo');
const telephony = require('./telephonyService');
const { BUILD_METADATA } = require('../config/buildInfo');
const { CARRIER, RUNTIME, forwardingUri } = require('../../desktop/config');

function descriptor() {
  const user = String(settings.get('telnyx_sip_user') || '').trim() || CARRIER.user;
  const host = String(settings.get('telnyx_sip_server') || '').trim() || CARRIER.domain;
  const transport = String(settings.get('softphone_transport') || CARRIER.transport).toLowerCase() === 'tcp' ? 'tcp' : 'udp';
  const did = telephony.normalizePhone(settings.get('flynumber_did')) || CARRIER.did;

  return {
    runtime: RUNTIME,
    build: BUILD_METADATA,
    sip: {
      provider: CARRIER.provider,
      host,
      port: CARRIER.port,
      transport,
      user,
      register: true,
      fromUri: `sip:${user}@${host}`,
    },
    inbound: {
      did,
      display: CARRIER.displayDid,
      forwardingUri: forwardingUri(user, host),
      mode: String(settings.get('inbound_routing_mode') || 'webrtc'),
    },
    engines: [
      { id: 'webrtc', label: 'In-app audio (CoreAudio)', default: true, autoplayUnlocked: true, command: null },
      { id: 'native-sip', label: 'Native SIP signalling', media: 'os-handoff', command: null },
      { id: 'linphone', label: 'Linphone softphone', media: 'external', command: `sip:<number>@${host}` },
    ],
    fallback: {
      sipUriTemplate: `sip:<number>@${host}`,
      telUriTemplate: 'tel:<number>',
      linphone: {
        username: user,
        domain: `${host}:${CARRIER.port}`,
        transport,
        callerId: CARRIER.displayDid,
        inboundUri: forwardingUri(user, host),
      },
    },
    guards: {
      sessionHeader: 'x-pulse-token',
      tokenEndpoint: '/api/session',
    },
  };
}

module.exports = { descriptor };
