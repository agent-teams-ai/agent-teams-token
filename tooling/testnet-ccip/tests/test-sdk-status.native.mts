import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_RPC_RESPONSE_LIMIT } from '../src/adapters/test-rpc.ts';
import { present, object } from './support/native-status-controls.mts';
import { scenario } from './support/native-status-scenarios.mts';
import { legacyComposition } from './support/legacy-status-scenarios.mts';
const selected = process.argv[2];
if (selected) { if (selected.startsWith('legacy-')) { await legacyComposition(selected); } else { await scenario(selected); } }
else {
  for (const name of ['observer', 'decoders', 'svm-decoders', 'composition', 'retry', 'byte-utf8', 'byte-limit', 'rpc-reply-id', 'rpc-reply-batch', 'rpc-redirect', 'api-error-body', 'partial', 'api-headers', 'api-body', 'native-body', 'sdk-body', 'deadline', 'cleanup-failure', 'unexpected', 'causal-cpi', 'causal-cancel', 'causal-cancel-header', 'causal-cancel-pending', 'causal-reverse', 'legacy-a', 'legacy-b', 'legacy-reverse', 'legacy-inventory']) {
    test((name.startsWith('legacy-') ? 'controlled actual legacy composition status unit: ' : 'controlled actual admitted SDK status unit: ') + name, () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * TEST_RPC_RESPONSE_LIMIT });
      assert.equal(child.status, 0, child.error?.message ?? child.stdout + child.stderr);
      const evidence: unknown = JSON.parse(present(child.stdout.trim().split('\n').at(-1)));
      assert.equal(object(evidence).qualification, 'UNQUALIFIED'); assert.equal(object(evidence).scenario, name);
    });
  }
}
