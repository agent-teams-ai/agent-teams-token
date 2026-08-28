import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestVector = JSON.parse(
  await readFile(new URL("../packages/contexts/supply/tests/fixtures/local.golden.json", import.meta.url), "utf8"),
);
const solidityVector = JSON.parse(
  await readFile(new URL("../contracts/evm/evidence/shared-test-vector.json", import.meta.url), "utf8"),
);

assert.equal(solidityVector.schema, "agtmai-allocation-vector-v1");
assert.equal(solidityVector.name, "Agent Teams AI");
assert.equal(solidityVector.symbol, "AGTMAI");
assert.equal(solidityVector.decimals, 9);
assert.equal(manifestVector.rawAllocationAbi, solidityVector.rawAbiBytes);
assert.equal(manifestVector.genesisAllocationHash, solidityVector.keccak256);
assert.equal((solidityVector.rawAbiBytes.length - 2) / 2, solidityVector.rawAbiByteLength);

const normalizedForSolidity = manifestVector.normalizedAllocations.map(
  ({ idBytes32, recipient, amountBaseUnits }) => ({
    id: idBytes32,
    recipient,
    amount: amountBaseUnits,
  }),
);
assert.deepEqual(normalizedForSolidity, solidityVector.allocations);

process.stdout.write(`${JSON.stringify({
  valid: true,
  allocationCount: solidityVector.allocations.length,
  rawAbiByteLength: solidityVector.rawAbiByteLength,
  genesisAllocationHash: solidityVector.keccak256,
})}\n`);
