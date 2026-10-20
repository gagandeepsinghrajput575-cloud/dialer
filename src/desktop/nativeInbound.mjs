// Rings the CRM for calls the native engine owns.
//
// The browser engine hands an `incomingCall` object to the provider directly; a native call
// arrives as an IPC event instead, and before this hook existed nothing subscribed to it, so a
// ringing phone was invisible: the caller heard ringback, nothing appeared on screen, and the
// call was logged as missed a couple of seconds later when they gave up.
import { useCallback, useEffect, useState } from 'react';
import { desktopBridge } from './bridge.mjs';

// The event fan-out, free of React so it can be tested without a renderer. A native shell that
// never subscribes here is a phone that rings in the caller's ear and nowhere else.
export function subscribeNative(bridge, { onRinging, onLedger, onAnswered, onEnded } = {}) {
  if (!bridge || typeof bridge.onEvent !== 'function') return () => {};
  return bridge.onEvent((event) => {
    if (!event) return;
    if (event.type === 'incoming_call') onRinging?.(event);
    else if (event.type === 'ledger') onLedger?.(event);
    else if (event.type === 'answered') onAnswered?.(event);
    else if (event.type === 'ended') onEnded?.(event);
  });
}

export function useNativeInbound({ enabled, onRinging, onLedger, onAnswered, onEnded } = {}) {
  const [incomingCall, setIncomingCall] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeNative(desktopBridge(), {
      onRinging: (event) => {
        setIncomingCall({
          callerNumber: event.callerPhone || 'Unknown',
          callId: event.callId || null,
          canAnswer: event.canAnswer !== false,
          handoffUri: event.handoffUri || '',
          answered: false,
          native: true,
        });
        onRinging?.(event);
      },
      onLedger,
      onAnswered: (event) => {
        setIncomingCall((cur) => (cur ? { ...cur, answered: true, callId: event.callId || cur.callId } : cur));
        onAnswered?.(event);
      },
      onEnded: (event) => {
        setIncomingCall(null);
        onEnded?.(event);
      },
    });
  }, [enabled, onRinging, onLedger, onAnswered, onEnded]);

  // Answering forwards to the engine that owns the call. It never rejects on the agent's behalf.
  const answer = useCallback(async () => {
    const bridge = desktopBridge();
    if (!bridge || !incomingCall) return { ok: false, reason: 'no-incoming' };
    if (!incomingCall.canAnswer) return { ok: false, reason: 'no-media-engine', handoffUri: incomingCall.handoffUri };
    const result = await bridge.answer();
    if (result && result.ok) setIncomingCall((cur) => (cur ? { ...cur, answered: true } : cur));
    return result || { ok: false, reason: 'no-answer' };
  }, [incomingCall]);

  const decline = useCallback(async () => {
    const bridge = desktopBridge();
    setIncomingCall(null);
    if (!bridge || typeof bridge.decline !== 'function') return { ok: false, reason: 'no-engine' };
    return bridge.decline();
  }, []);

  return { incomingCall, answer, decline };
}
