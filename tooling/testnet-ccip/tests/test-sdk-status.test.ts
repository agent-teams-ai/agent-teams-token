import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { runStatus, finalizeStatusReport, type StatusSettings } from '../src/composition/transfer-status.mjs';
import { TEST_SDK_PROFILE } from '../src/adapters/test-sdk-policy.ts';
import { replacementFixture } from '../src/domain/replacement-fixture.ts';
import type { StatusPorts, TestStatusOptions } from '../src/adapters/test-sdk-status.ts';
import type { StatusSnapshot, StatusTransferReport } from '../src/domain/transfer-status.mjs';

// Pure ingress counterevidence. This file never opens/evaluates an SDK or sends RPC.
const fixture = replacementFixture('0x812c4dcbc459a55f8517e87e825b8c728cee7316', '0x8472aa06661671e7e4af43048f0d0446eff2e97d');
const directory = '/absent-phase3-status-provider';
function settings(): StatusSettings { return { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture,
  fixtureIdentity: fixture.identity, providerArchives: '/absent-phase3-status-archives', sdkDirectory: directory, transfers: [] }; }

test('status ingress rejects explicit profile, alias, transport and transfer mutations before fixture binding/provider IO', async () => {
  let bindReads = 0, providerReads = 0, transportReads = 0;
  const replayFetch: typeof fetch = () => { transportReads++; throw new Error('Unexpected operation transport'); };
  mock.method(fs, 'lstatSync', () => { providerReads++; throw new Error('Unexpected provider IO'); });
  syncBuiltinESMExports();
  try {
    const cases: { input: StatusSettings; reason: RegExp }[] = [
      ...[undefined, null, '', false, 'legacy', 'unknown'].map(providerProfile => ({ input: { ...settings(), providerProfile }, reason: /Unknown or non-TEST SDK profile/ })),
      { input: { ...settings(), testOnly: false }, reason: /Unknown or non-TEST SDK profile/ },
      { input: { ...settings(), fixtureIdentity: 'wrong' }, reason: /fixture identity/ },
      { input: { ...settings(), sdkDirectory: directory + '/..' }, reason: /Canonical TEST SDK directory/ },
      { input: { ...settings(), providerDirectory: '/other' }, reason: /Divergent or invalid/ },
      { input: { ...settings(), ccipProviderDirectory: directory + '/' }, reason: /Divergent or invalid/ },
      { input: settings(), reason: /Explicit TEST status replay fetch/ },
      { input: { ...settings(), replayFetch, transfers: [{ direction: 'solana-to-ethereum', recipient: 'QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV', sourceHash: '1'.repeat(64) }] }, reason: /only recipient A/ },
      { input: { ...settings(), replayFetch, transfers: [{ direction: 'ethereum-to-solana', sourceHash: '0x' + '11'.repeat(32) },
        { direction: 'ethereum-to-solana', sourceHash: '0x' + '22'.repeat(32) }] }, reason: /Duplicate fixture transfer/ },
    ];
    for (const { input, reason } of cases) {
      Object.defineProperty(input, 'expected', { get() { bindReads++; throw new Error('Unexpected fixture binding'); } });
      await assert.rejects(runStatus(input), reason);
    }
    const ownUndefined = { ...settings(), replayFetch };
    Object.defineProperty(ownUndefined, 'providerDirectory', { value: undefined });
    await assert.rejects(runStatus(ownUndefined), /Divergent or invalid/);
    assert.deepEqual({ bindReads, providerReads, transportReads }, { bindReads: 0, providerReads: 0, transportReads: 0 });
    // The positive ingress control reaches the actual binding boundary, rather
    // than succeeding because every attempt was rejected by an earlier guard.
    const accepted = { ...settings(), replayFetch };
    Object.defineProperty(accepted, 'expected', { get() { bindReads++; throw new Error('Reached fixture binding'); } });
    await assert.rejects(runStatus(accepted), /Reached fixture binding/);
    assert.equal(bindReads, 1); assert.equal(providerReads, 0); assert.equal(transportReads, 0);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('only profile absence reaches the retained legacy installation branch', async () => {
  const input = settings(); Reflect.deleteProperty(input, 'providerProfile');
  await assert.rejects(runStatus(input), error => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Finalizer = Parameters<typeof finalizeStatusReport>;
export type CheckedContracts = [
  Assert<Equal<Finalizer[0], () => Promise<{ transfers: readonly StatusTransferReport[]; snapshot: StatusSnapshot }>>>,
  Assert<Equal<Finalizer[4], typeof fixture | undefined>>,
  Assert<Equal<IsAny<StatusPorts['chains']['ethereum']>, false>>,
  Assert<Equal<IsAny<StatusPorts['api']>, false>>,
  Assert<Equal<IsAny<StatusPorts['native']>, false>>,
  Assert<Equal<'sign' extends keyof StatusPorts['chains']['ethereum'] ? true : false, false>>,
  Assert<Equal<'destroy' extends keyof StatusPorts['chains']['solana'] ? true : false, false>>,
  Assert<Equal<'provider' extends keyof StatusPorts['chains']['ethereum'] ? true : false, false>>,
  Assert<Equal<TestStatusOptions['fetcher'], typeof fetch>>,
];
