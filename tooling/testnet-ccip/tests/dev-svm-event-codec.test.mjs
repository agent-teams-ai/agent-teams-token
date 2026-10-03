import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeDevSvmEvent } from '../src/adapters/dev-svm-event-codec.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dev-svm-event-goldens.json', import.meta.url)));
const sent = fixture.vectors.find(vector => vector.expected.eventName === 'CCIPMessageSent');
const executed = fixture.vectors.find(vector => vector.expected.state === 2);
const raw = vector => Buffer.from(vector.dataBase64, 'base64');
// Only renders actual output for comparison with independently recorded literals.
function render(value) {
  if (typeof value === 'bigint') { return value.toString(); }
  if (Buffer.isBuffer(value)) { return value.toString('hex'); }
  if (Array.isArray(value)) { return value.map(render); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
  }
  return value;
}

// Regression: reduced bytes must never be presented as the complete original
// capture or a historical replay. The full recapture digests remain traceable.
test('retained wire fixture declares its lossy recapture provenance', () => {
  assert.equal(fixture.evidenceClass, 'fixture-only');
  assert.equal(fixture.lossy, true);
  assert.equal(fixture.vectors.length, 5);
  for (const vector of fixture.vectors) {
    assert.match(vector.recaptureResponseSha256, /^[0-9a-f]{64}$/);
    assert.match(vector.recaptureResponsePath, /^\.local\/PUBLIC-HISTORICAL-RECAPTURE\//);
  }
});

// Regression: instruction layouts, EVM field ordering, BE amounts or skipped
// vectors must not substitute for actual emitted Router/OffRamp Borsh fields.
// Full object comparison also prevents adding settlement/authentication flags
// or inventing an amount/receiver in an OffRamp event. No provider is evaluated.
for (const vector of fixture.vectors) {
  test(`independent Program data golden: ${vector.label}`, () => {
    const wire = raw(vector);
    assert.equal(wire.toString('base64'), vector.dataBase64);
    assert.equal(wire.length, vector.encodedBytes);
    assert.equal(createHash('sha256').update(wire).digest('hex'), vector.rawSha256);
    const event = decodeDevSvmEvent(wire);
    assert.deepEqual(render(event), vector.expected);
    assert.equal(typeof event.sequenceNumber, 'bigint');
    if (event.eventName === 'CCIPMessageSent') {
      assert.equal(typeof event.message.header.nonce, 'bigint');
      assert.equal(typeof event.message.tokenAmounts[0].amount, 'bigint');
      for (const bytes of [event.message.sender, event.message.feeToken,
        event.message.tokenAmounts[0].sourcePoolAddress]) {
        assert.ok(Buffer.isBuffer(bytes));
        assert.equal(bytes.length, 32);
      }
      for (const bytes of [event.message.data, event.message.receiver,
        event.message.extraArgs, event.message.tokenAmounts[0].destTokenAddress,
        event.message.tokenAmounts[0].extraData, event.message.tokenAmounts[0].destExecData]) {
        assert.ok(Buffer.isBuffer(bytes));
      }
    }
  });
}

// Regression: do not silently accept base64, typed objects or caller DTOs as wire.
test('requires a raw Buffer', () => {
  for (const value of [null, undefined, sent.dataBase64, [], new Uint8Array(raw(sent)), {}]) {
    assert.throws(() => decodeDevSvmEvent(value), /must be a Buffer/);
  }
});

// Regression: every field boundary is required; a decoder that stops early or
// tolerates a second event/unused payload fails. Check every truncation point.
test('rejects every truncated golden and trailing bytes', () => {
  for (const vector of fixture.vectors) {
    const wire = raw(vector);
    for (let length = 0; length < wire.length; length++) {
      assert.throws(() => decodeDevSvmEvent(wire.subarray(0, length)), `prefix ${vector.label}:${length}`);
    }
    for (const tail of [Buffer.from([0]), raw(executed)]) {
      assert.throws(() => decodeDevSvmEvent(Buffer.concat([wire, tail])), /Trailing|exactly 89/);
    }
  }
});

// Regression: compare all eight discriminator bytes, not a partial prefix, and
// do not autodetect a supported payload behind an instruction/transport prefix.
test('accepts only the canonical two discriminators', () => {
  for (const vector of [sent, executed]) {
    for (let index = 0; index < 8; index++) {
      const wire = raw(vector);
      wire[index] ^= 1;
      assert.throws(() => decodeDevSvmEvent(wire), /discriminator/);
    }
    const wire = raw(vector);
    wire.fill(0, 0, 8);
    assert.throws(() => decodeDevSvmEvent(wire), /discriminator/);
    assert.throws(() => decodeDevSvmEvent(Buffer.concat([Buffer.alloc(8), raw(vector)])), /discriminator/);
  }
});

// Regression: raw Untouched is valid even though SDK receipt normalization may
// reject it. All four enum tags remain raw states; unknown tags are never Success.
test('decodes exactly enum tags 0-3 and rejects unknown tags', () => {
  for (const state of [0, 1, 2, 3]) {
    const wire = raw(executed);
    wire[88] = state;
    assert.deepEqual(render(decodeDevSvmEvent(wire)), { ...executed.expected, state });
  }
  for (const state of [4, 128, 255]) {
    const wire = raw(executed);
    wire[88] = state;
    assert.throws(() => decodeDevSvmEvent(wire), /Unknown MessageExecutionState/);
  }
});

// Regression: outer and header copies cannot disagree and later bind two lanes
// or two sequences. Independently mutate each representation, not just one copy.
test('rejects mismatched duplicate destination selector and sequence', () => {
  for (const offset of [8, 64, 16, 72]) {
    const wire = raw(sent);
    wire[offset] ^= 1;
    assert.throws(() => decodeDevSvmEvent(wire), /outer selector\/sequence/);
  }
});

// These literal offsets belong to the independently inspected 429-byte golden:
// bytes lengths at 120/124/160/253/289/357; token count at 217; amount at 325.
// Regression: attacker lengths must be rejected against wire availability before
// allocating a claimed 4 GiB byte array or entering an unbounded token loop.
test('bounds all byte vectors and the token vector', () => {
  for (const offset of [120, 124, 160, 253, 289, 357]) {
    for (const length of [65537, 0xffffffff]) {
      const wire = raw(sent);
      wire.writeUInt32LE(length, offset);
      assert.throws(() => decodeDevSvmEvent(wire), /Truncated/);
    }
  }
  for (const count of [2, 1000, 0xffffffff]) {
    const wire = raw(sent);
    wire.writeUInt32LE(count, 217);
    assert.throws(() => decodeDevSvmEvent(wire), /Token vector length/);
  }
  const wire = raw(sent);
  wire.writeUInt32LE(0, 217);
  assert.throws(() => decodeDevSvmEvent(wire), /Trailing/);
});

// Regression: a positive one-token capture must not impose route policy on a raw
// Vec. Reuse retained token bytes directly; no event encoder supplies the oracle.
test('preserves empty and multiple token vectors', () => {
  const wire = raw(sent), token = wire.subarray(221, 365), fees = wire.subarray(365);
  const empty = Buffer.concat([wire.subarray(0, 217), Buffer.from('00000000', 'hex'), fees]);
  const multiple = Buffer.concat([wire.subarray(0, 217), Buffer.from('02000000', 'hex'), token, token, fees]);
  assert.deepEqual(render(decodeDevSvmEvent(empty)), {
    ...sent.expected, message: { ...sent.expected.message, tokenAmounts: [] },
  });
  assert.deepEqual(render(decodeDevSvmEvent(multiple)), {
    ...sent.expected, message: { ...sent.expected.message,
      tokenAmounts: [sent.expected.message.tokenAmounts[0], sent.expected.message.tokenAmounts[0]] },
  });
});

// Regression: fixed keys and variable address bytes must survive changed routes.
// Nonzero EVM padding is preserved here; the later selected-route matcher owns
// padding/width admission. This decoder cannot normalize it away or call it valid.
test('preserves changed identity bytes without padding policy', () => {
  const wire = raw(sent);
  wire.fill(0x11, 24, 56); // message ID
  wire.fill(0x22, 88, 120); // sender key
  wire[128] = 0xab; // receiver's first byte, inside its declared Vec
  wire.fill(0x33, 221, 253); // pool key
  wire[257] = 0xcd; // destination token's first byte
  wire.fill(0x44, 185, 217); // fee token key
  const event = decodeDevSvmEvent(wire);
  assert.equal(event.message.header.messageId, '0x' + '11'.repeat(32));
  assert.deepEqual(event.message.sender, Buffer.alloc(32, 0x22));
  assert.deepEqual(event.message.tokenAmounts[0].sourcePoolAddress, Buffer.alloc(32, 0x33));
  assert.deepEqual(event.message.feeToken, Buffer.alloc(32, 0x44));
  assert.equal(event.message.receiver.toString('hex'),
    'ab0000000000000000000000275ee728c49100b56d4aa37c00e2dc8ffc5e5df6');
  assert.equal(event.message.tokenAmounts[0].destTokenAddress.toString('hex'),
    'cd0000000000000000000000bee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9');
  assert.equal(event.message.tokenAmounts[0].amount, 1000000000n);
  const executionWire = raw(executed);
  executionWire.fill(0x55, 24, 56);
  executionWire.fill(0x66, 56, 88);
  const execution = decodeDevSvmEvent(executionWire);
  assert.equal(execution.messageId, '0x' + '55'.repeat(32));
  assert.equal(execution.messageHash, '0x' + '66'.repeat(32));
});

// Regression: variable bytes are actual Vec payloads, not fixed ABI32 addresses
// or zero-filled sentinels. Splice bytes into the independently retained wire.
test('preserves nonempty data and an odd-width receiver', () => {
  const wire = raw(sent);
  const changed = Buffer.concat([
    wire.subarray(0, 120), Buffer.from('03000000aabbcc050000000001020304', 'hex'), wire.subarray(160),
  ]);
  const event = decodeDevSvmEvent(changed);
  assert.equal(event.message.data.toString('hex'), 'aabbcc');
  assert.equal(event.message.receiver.toString('hex'), '0001020304');
  assert.equal(event.message.extraArgs.toString('hex'), sent.expected.message.extraArgs);
  assert.deepEqual(render(event.message.tokenAmounts), sent.expected.message.tokenAmounts);
});

// Regression: a Number intermediate loses the final base unit. The mutation is
// literal little-endian bytes and the expectation is independently literal.
test('keeps amount 9007199254740993 above Number safe integer exactly', () => {
  const wire = raw(sent);
  Buffer.from('0100000000002000000000000000000000000000000000000000000000000000', 'hex').copy(wire, 325);
  const amount = decodeDevSvmEvent(wire).message.tokenAmounts[0].amount;
  assert.equal(amount, 9007199254740993n);
  assert.equal(amount.toString(), '9007199254740993');
});

// Regression: CrossChainAmount is full u256 LE for tokens AND both fees, not u64,
// while selectors/sequence/nonce are full u64. Use literal maximum expectations.
test('retains full-width unsigned integers', () => {
  const wire = raw(sent);
  for (const offset of [8, 16, 56, 64, 72, 80]) { wire.fill(0xff, offset, offset + 8); }
  for (const offset of [325, 365, 397]) { wire.fill(0xff, offset, offset + 32); }
  const event = decodeDevSvmEvent(wire);
  for (const value of [event.destChainSelector, event.sequenceNumber,
    event.message.header.sourceChainSelector, event.message.header.destChainSelector,
    event.message.header.sequenceNumber, event.message.header.nonce]) {
    assert.equal(value, 18446744073709551615n);
  }
  for (const value of [event.message.tokenAmounts[0].amount,
    event.message.feeTokenAmount, event.message.feeValueJuels]) {
    assert.equal(value, 115792089237316195423570985008687907853269984665640564039457584007913129639935n);
  }
});

// Regression: 64 KiB is an inclusive wire ceiling, not an accidental low cap or
// an unbounded allocation allowance. A data-only expansion keeps other fields.
test('accepts exactly 64 KiB and rejects one byte above', () => {
  const wire = raw(sent), data = Buffer.alloc(65107, 0x5a);
  const atLimit = Buffer.concat([wire.subarray(0, 120), Buffer.from('53fe0000', 'hex'), data, wire.subarray(124)]);
  assert.equal(atLimit.length, 65536);
  const event = decodeDevSvmEvent(atLimit);
  assert.deepEqual(event.message.data, data);
  assert.equal(event.message.header.messageId, sent.expected.message.header.messageId);
  assert.equal(event.message.tokenAmounts[0].amount, 1000000000n);
  assert.throws(() => decodeDevSvmEvent(Buffer.concat([atLimit, Buffer.from([0])])), /exceeds 64 KiB/);
});

// Regression: caller mutation must not change already decoded fields or later
// calls. Mutable output bytes must not alias the supplied wire or each other.
test('does not mutate input or share output byte storage', () => {
  const wire = raw(sent), original = Buffer.from(wire);
  const first = decodeDevSvmEvent(wire), second = decodeDevSvmEvent(wire);
  assert.deepEqual(wire, original);
  first.message.sender.fill(0);
  first.message.receiver.fill(0xff);
  first.message.tokenAmounts[0].extraData.fill(0);
  assert.deepEqual(wire, original);
  assert.deepEqual(render(second), sent.expected);
  wire.fill(0);
  assert.deepEqual(render(second), sent.expected);
});
