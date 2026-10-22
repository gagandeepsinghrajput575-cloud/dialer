// Outbound SIP hardening: teardown must never throw an unhandled rejection, and every carrier
// rejection must reach the agent as a readable reason instead of a silent 'ended'.
//
// The fake inviter mirrors sip.js 0.21.2 (lib/api/inviter.js cancel(), session.js bye()): both
// reject with "Invalid session state <state>" outside the states they are legal in.
const assert = require('assert');
const { describeReject, NO_ANSWER } = require('../../src/sipReject.mjs');
const { endSession } = require('../../src/webrtcSignalling.js');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    ✓ ${msg}`); };

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e?.message || e)));
const tick = () => new Promise((r) => setTimeout(r, 20));

function fakeInviter(state) {
  const calls = [];
  const illegal = (name) => Promise.reject(new Error(`Invalid session state ${state}`));
  return {
    state,
    calls,
    cancel() { calls.push('cancel'); return (state === 'Initial' || state === 'Establishing') ? Promise.resolve() : illegal('cancel'); },
    bye() { calls.push('bye'); return state === 'Established' ? Promise.resolve() : illegal('bye'); },
    dispose() { calls.push('dispose'); return Promise.resolve(); },
  };
}

async function main() {
  console.log('\n[outbound-hardening] teardown guard');

  for (const st of ['Terminated', 'Terminating']) {
    const inv = fakeInviter(st);
    endSession(inv);
    await tick();
    assert.deepStrictEqual(inv.calls, ['dispose'], `${st}: only dispose, never cancel/bye`);
    assert.strictEqual(unhandled.length, 0, `${st}: no unhandled rejection`);
    ok(`${st}: teardown disposes without an illegal cancel/bye`);
  }

  {
    const inv = fakeInviter('Established');
    endSession(inv);
    await tick();
    assert.deepStrictEqual(inv.calls, ['bye']);
    ok('Established: BYE is sent');
  }

  {
    const inv = fakeInviter('Establishing');
    endSession(inv);
    await tick();
    assert.deepStrictEqual(inv.calls, ['cancel']);
    ok('Establishing: CANCEL is sent');
  }

  {
    // A cancel that is refused at the last instant must be swallowed, not thrown into the chain.
    const inv = fakeInviter('Establishing');
    inv.cancel = () => Promise.reject(new Error('Invalid session state Terminated'));
    assert.doesNotThrow(() => endSession(inv));
    await tick();
    assert.strictEqual(unhandled.length, 0, 'rejected cancel is caught');
    ok('a refused CANCEL is caught, not an unhandled rejection');
  }

  {
    assert.doesNotThrow(() => endSession(null));
    assert.doesNotThrow(() => endSession({ state: 'Established' }));
    ok('null or method-less handles are tolerated');
  }

  console.log('\n[outbound-hardening] carrier reject reasons');
  const expect = [
    [486, 'busy'], [603, 'declined'], [404, 'number'], [484, 'number'],
    [480, 'unavailable'], [487, 'cancel'], [488, 'media'], [503, 'unavailable'],
    [408, 'answer'], [401, 'credentials'], [407, 'credentials'], [403, 'refused'],
  ];
  for (const [code, word] of expect) {
    const msg = describeReject(code, 'Some Phrase');
    assert.ok(msg.toLowerCase().includes(word), `${code} message mentions "${word}": ${msg}`);
    assert.ok(msg.includes(String(code)), `${code} message carries the SIP code`);
    ok(`${code} → ${msg}`);
  }
  {
    const msg = describeReject(599, 'Weird Gateway');
    assert.ok(msg.includes('599') && msg.includes('Weird Gateway'), msg);
    ok(`unknown code keeps the exact reason phrase → ${msg}`);
  }
  {
    assert.ok(describeReject(undefined, undefined).length > 0);
    assert.ok(NO_ANSWER.length > 0);
    ok('missing status still yields a readable message');
  }

  await tick();
  assert.strictEqual(unhandled.length, 0, `no unhandled rejections overall: ${unhandled}`);
  console.log(`\n  [outbound-hardening] ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
