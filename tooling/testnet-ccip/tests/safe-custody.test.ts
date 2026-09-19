import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath, join } from "node:path";
import type { DeploymentSafe, Hex } from "@agent-teams/supply/deployment";
import type { CustodySafeCall } from "../src/domain/custody-intent.ts";
import { custodySafeHash, custodySafeCalldata, custodySafeResult, custodyKeccak, custodyTopic, verifyCustodySafe,
  type SafeInspection, type SafeProfile } from "../src/adapters/safe-custody.ts";
import { createCastSignatureVerifier } from "../src/adapters/evm-cast.ts";
const hash = `0x${"a".repeat(64)}` as Hex;
const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const zero = "0x0000000000000000000000000000000000000000";
const safe: DeploymentSafe = { id: "custody", address: address(10), owners: [address(11), address(12), address(13)], threshold: 2, beneficialControl: "solo-founder", disclosure: "Synthetic single operator." };
const call: CustodySafeCall = { address: safe.address, nonce: "7", transactionHash: hash, to: address(20), value: "0", data: "0xea8a1af0", operation: "CALL", safeTxGas: "100000",
  baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero };
const binary = resolvePath(".tools/foundry-v1.8.0-linux-x64/cast");
const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => { execFile(binary, args, { timeout: 30000, maxBuffer: 1000000,
  env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } }, (error, stdout) => error ? reject(new Error(`Pinned cast ${args[0]} ${args[1]} test operation failed`)) : resolve(stdout.trim())); });
function inspectionFixture() {
  // Synthetic bytecode hashes test only the inspection policy. Official artifact qualification is a separate gate.
  const code = "0x6000" as Hex, runtime = custodyKeccak(Buffer.from("6000", "hex"));
  const profile: SafeProfile = { schema: "agtmai-official-safe-profile-v1", version: "1.4.1", source: "safe-global/safe-smart-account", sourceRevision: "1".repeat(40),
    proxyArtifactSha256: hash, singletonArtifactSha256: hash, proxyRuntimeKeccak256: runtime, singletonRuntimeKeccak256: runtime, singleton: address(99) };
  const inspection: SafeInspection = { ownerCode: safe.owners.map(owner => ({ address: owner, code: "0x", blockHash: hash })), address: safe.address, blockHash: hash, proxyCode: code, singletonCode: code, singletonStorage: `0x${word(99n)}`,
    versionResult: `0x${word(32n)}${word(5n)}${Buffer.from("1.4.1").toString("hex").padEnd(64, "0")}`,
    ownersResult: `0x${word(32n)}${word(3n)}${[11n, 12n, 13n].map(word).join("")}`, thresholdResult: `0x${word(2n)}`, nonceResult: `0x${word(7n)}`,
    modulesResult: `0x${word(64n)}${word(1n)}${word(0n)}`, guardStorage: `0x${word(0n)}`, fallbackStorage: `0x${word(0n)}` };
  return { profile, inspection };
}
test("Safe inspection checks proxy/singleton, initialization, exact threshold, complete modules, guard and handler", () => {
  const { profile, inspection } = inspectionFixture();
  assert.equal(verifyCustodySafe(safe, profile, inspection).nonce, "7");
  for (const patch of [{ proxyCode: "0x6001" }, { singletonCode: "0x6001" }, { singletonStorage: `0x${word(98n)}` },
    { ownerCode: [] }, { ownerCode: safe.owners.map(owner => ({ address: owner, code: "0x6000", blockHash: hash })) },
    { ownerCode: safe.owners.map(owner => ({ address: owner, code: "0x", blockHash: `0x${"b".repeat(64)}` })) },
    { thresholdResult: `0x${word(1n)}` }, { thresholdResult: `0x${word(0n)}` }, { ownersResult: `0x${word(32n)}${word(3n)}${[11n, 11n, 13n].map(word).join("")}` },
    { modulesResult: `0x${word(64n)}${word(2n)}${word(0n)}` }, { guardStorage: `0x${word(2n)}` }, { fallbackStorage: `0x${word(2n)}` }]) {
    assert.throws(() => verifyCustodySafe(safe, profile, { ...inspection, ...patch } as SafeInspection), /CUSTODY_SAFE/);
  }
});
test("successful outer receipt cannot hide Safe inner failure, wrong transaction hash or emitter", () => {
  const signedCall = { ...call, transactionHash: custodySafeHash("31337", call) };
  const success = custodyTopic("ExecutionSuccess(bytes32,uint256)"), failure = custodyTopic("ExecutionFailure(bytes32,uint256)");
  for (const [topic, result] of [[success, "success"], [failure, "failure"]] as const) {
    const log = { address: safe.address, topics: [topic, signedCall.transactionHash], data: `0x${word(0n)}` as Hex, removed: false };
    assert.equal(custodySafeResult("31337", signedCall, [log]), result);
    assert.throws(() => custodySafeResult("31337", call, [{ ...log, topics: [topic, hash] }]), /TRANSACTION_IDENTITY/);
    assert.throws(() => custodySafeResult("11155111", signedCall, [log]), /TRANSACTION_IDENTITY/);
    for (const logs of [[], [log, log], [log, { ...log, topics: [topic === success ? failure : success, signedCall.transactionHash] }],
      [{ ...log, address: address(9) }], [{ ...log, removed: true }],
      ...[[], [topic], [topic, signedCall.transactionHash, hash], [hash, signedCall.transactionHash], [topic, hash], [topic, "0x"]]
        .map(topics => [{ ...log, topics: topics as Hex[] }]),
      [{ ...log, topics: [topic], data: `${signedCall.transactionHash}${word(0n)}` as Hex }],
      ...["0x", "0x00", `0x${"0".repeat(63)}`, `0x${"0".repeat(65)}`, `0x${word(1n)}`, `0x${word(0n)}${word(0n)}`, `${signedCall.transactionHash}${word(0n)}`, `0x${"g".repeat(64)}`]
        .map(data => [{ ...log, data: data as Hex }]),
    ]) {
      assert.throws(() => custodySafeResult("31337", signedCall, logs), /INNER_RESULT_UNPROVEN/);
    }
  }
});
test("two ephemeral keystore signatures independently agree with cast EIP-712 and exact execTransaction ABI", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-safe-signatures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const signedCall = { ...call, transactionHash: custodySafeHash("31337", call) };
  const typed = { types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    SafeTx: [["to", "address"], ["value", "uint256"], ["data", "bytes"], ["operation", "uint8"], ["safeTxGas", "uint256"], ["baseGas", "uint256"], ["gasPrice", "uint256"], ["gasToken", "address"], ["refundReceiver", "address"], ["nonce", "uint256"]].map(([name, type]) => ({ name, type })) }, primaryType: "SafeTx",
    domain: { chainId: "31337", verifyingContract: safe.address }, message: { to: call.to, value: "0", data: call.data, operation: 0, safeTxGas: call.safeTxGas, baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero, nonce: call.nonce } };
  const typedPath = join(directory, "typed-data.json"); await writeFile(typedPath, JSON.stringify(typed));
  const signatures = [];
  for (const id of ["one", "two"]) {
    await run(["wallet", "new", directory, id, "--unsafe-password", "local-test-only"]);
    const keyfile = join(directory, id), owner = (await run(["wallet", "address", "--keystore", keyfile, "--password", "local-test-only"])).toLowerCase() as Hex;
    const signature = await run(["wallet", "sign", "--data", "--from-file", typedPath, "--keystore", keyfile, "--password", "local-test-only"]) as Hex;
    signatures.push({ owner, signature });
  }
  const selected = { ...safe, owners: [...signatures.map(s => s.owner), address(13)] };
  const verify = createCastSignatureVerifier({ executable: binary, executableSha256: createHash("sha256").update(await readFile(binary)).digest("hex") });
  const calldata = await custodySafeCalldata("31337", signedCall, selected, signatures, verify);
  const packed = signatures.toSorted((a, b) => a.owner < b.owner ? -1 : 1).map(s => s.signature.slice(2)).join("");
  const oracle = await run(["calldata", "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", call.to, "0", call.data, "0", call.safeTxGas, "0", "0", zero, zero, `0x${packed}`]);
  assert.equal(calldata, oracle);
  await assert.rejects(custodySafeCalldata("31337", signedCall, selected, signatures.slice(0, 1), verify), /TRANSACTION_IDENTITY/);
  await assert.rejects(custodySafeCalldata("31337", signedCall, selected, [signatures[0]!, signatures[0]!], verify), /DUPLICATE_OWNER/);
  for (const change of [{ nonce: "8" }, { to: address(21) }, { safeTxGas: "100001" }]) {
    const changed = { ...signedCall, ...change }, transactionHash = custodySafeHash("31337", changed);
    await assert.rejects(custodySafeCalldata("31337", { ...changed, transactionHash }, selected, signatures, verify), /SIGNATURE_INVALID/);
  }
  assert.notEqual(custodySafeHash("11155111", call), signedCall.transactionHash);
});


test("sentinel and Safe-self owner are rejected even when listed in the selected configuration", () => {
  for (const owner of [address(1), safe.address]) {
    const { profile, inspection } = inspectionFixture();
    const owners = [owner, address(12), address(13)];
    assert.throws(() => verifyCustodySafe({ ...safe, owners }, profile, { ...inspection,
      ownersResult: `0x${word(32n)}${word(3n)}${owners.map(o => word(BigInt(o))).join("")}`,
      ownerCode: owners.map(member => ({ address: member, code: "0x", blockHash: hash })),
    }), /THRESHOLD_OR_OWNERS/);
  }
});
