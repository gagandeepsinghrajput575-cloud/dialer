// What the carrier said, in words an agent can act on.
//
// sip.js reports a rejected INVITE only as a session-state transition (`Terminated`): its
// Inviter hands the final response to a private handler that keeps the state and throws the
// status code away. So the codes that actually explain a failed outbound call — 486 busy, 503
// no route, 408 timeout — never reach the UI unless we read them off the response ourselves.
// This module is that translation, kept pure so it can be tested without a carrier.

const CREDENTIALS = 'The provider rejected the SIP credentials — check the username and password in Settings → Telephony.';

/**
 * @param {{statusCode?: number, reasonPhrase?: string, number?: string}} [response]
 * @returns {{code: number, message: string}}
 */
export function describeReject({ statusCode, reasonPhrase, number } = {}) {
  const code = Number(statusCode) || 0;
  const target = number ? ` ${number}` : ' that number';
  switch (code) {
    case 400:
      return { code, message: 'The carrier rejected the call request (400). Check the number and the caller ID.' };
    case 401:
    case 403:
      return { code, message: CREDENTIALS };
    case 404:
      return { code, message: `The carrier does not recognise${target}.` };
    case 408:
      return { code, message: 'Nobody answered in time (408) — the network gave up on the call.' };
    case 480:
      return { code, message: 'That number is unavailable right now (480).' };
    case 486:
      return { code, message: 'That number is busy (486). Try again in a few minutes.' };
    case 487:
      return { code, message: 'The call was cancelled before it connected.' };
    case 488:
      return { code, message: 'The carrier could not agree on audio formats (488) — check the softphone codecs.' };
    case 491:
      return { code, message: 'Another call is already being set up on this line (491). Dial again in a moment.' };
    case 503:
      return { code, message: 'The carrier has no route to that number right now (503). Check the prefix.' };
    case 600:
      return { code, message: 'That number is busy (600).' };
    case 603:
      return { code, message: 'The other end declined the call (603).' };
    case 604:
      return { code, message: 'That number does not exist (604).' };
    default:
      return {
        code,
        message: code
          ? `The call failed (SIP ${code}${reasonPhrase ? ` ${reasonPhrase}` : ''}).`
          : 'The call failed before it connected.',
      };
  }
}

/**
 * The sip.js `requestDelegate` for an outbound INVITE.
 *
 * Without it a rejection is only a `Terminated` state change — indistinguishable from the
 * agent hanging up — and a 180 is indistinguishable from an INVITE that was merely sent.
 *
 * @param {object}   opts
 * @param {string}   [opts.remoteNumber] the number being dialled, for the message
 * @param {function} [opts.onRinging]    a 180/183 arrived: the far end is actually ringing
 * @param {function} [opts.onReject]     (message, code) the carrier refused the call
 */
export function rejectionDelegate({ remoteNumber, onRinging, onReject } = {}) {
  return {
    onProgress: (response) => {
      const code = Number(response?.statusCode);
      if (code === 180 || code === 183) onRinging?.();
    },
    onReject: (response) => {
      const { code, message } = describeReject({
        statusCode: response?.statusCode,
        reasonPhrase: response?.reasonPhrase,
        number: remoteNumber,
      });
      onReject?.(message, code);
    },
  };
}

// States in which nothing is on the wire any more. A `Terminated` reported in one of these is
// either our own hang-up (already torn down) or the tail of a failure we have already handled,
// so running the teardown again would fire onEnded twice and reopen a closed disposition.
const RESTING = new Set(['idle', 'standby', 'ended', 'error']);

export function isRestingState(state) {
  return RESTING.has(String(state));
}
