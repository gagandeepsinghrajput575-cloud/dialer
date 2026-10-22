// Turns a SIP final response (or the lack of one) into the sentence the agent reads.
//
// WHY this exists as its own module: sip.js reports a rejected INVITE as a Terminated state
// change and nothing else. The status code and reason phrase only arrive on the request
// delegate, and the old engine dropped both, so a 486 Busy Here looked identical to a 603
// Decline. Keeping the mapping pure means the wording can be unit-tested without a SIP stack.

export const NO_ANSWER = 'The call ended before anyone answered.';

// Codes the agent can act on get a specific sentence. Anything else keeps the code and the
// carrier's own reason phrase verbatim, so nothing the network said is ever silently lost.
const SPECIFIC = {
  403: 'The carrier refused this call (403 Forbidden). Check the SIP credential\'s outbound permissions.',
  404: 'The carrier could not route this number (404 Not Found). Check the number.',
  408: 'No answer from the carrier (408 Request Timeout). Try again.',
  480: 'The callee is unavailable right now (480 Temporarily Unavailable).',
  484: 'The number is incomplete or invalid (484 Address Incomplete). Check the number.',
  486: 'The line is busy (486 Busy Here).',
  487: 'The call was cancelled before it was answered (487 Request Terminated).',
  488: 'The carrier rejected the media offer (488 Not Acceptable Here). Check the codec settings.',
  491: 'Another call is being set up at the same moment. Try again in 2 seconds (491 Request Pending).',
  503: 'The carrier is temporarily unavailable (503 Service Unavailable). Try again shortly.',
  600: 'The callee is busy (600 Busy Everywhere).',
  603: 'The callee declined the call (603 Decline).',
};

const AUTH = {
  401: 'The carrier rejected the SIP credentials (401 Unauthorized). Check the username and password.',
  407: 'The carrier rejected the SIP credentials (407 Proxy Authentication Required). Check the username and password.',
};

/**
 * @param {number|string} statusCode  SIP final status, e.g. 486
 * @param {string} [reasonPhrase]     the carrier's own reason phrase, e.g. "Busy Here"
 * @returns {string} an actionable sentence for the agent
 */
export function describeReject(statusCode, reasonPhrase) {
  const code = Number(statusCode);
  const phrase = String(reasonPhrase || '').trim();
  if (AUTH[code]) return AUTH[code];
  if (SPECIFIC[code]) return SPECIFIC[code];
  if (Number.isInteger(code) && code >= 100 && code <= 699) {
    return `The carrier rejected the call (${code}${phrase ? ` ${phrase}` : ''}).`;
  }
  return phrase ? `The call was rejected: ${phrase}.` : 'The call was rejected by the carrier.';
}
