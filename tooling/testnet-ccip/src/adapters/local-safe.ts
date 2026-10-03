import assert from "node:assert/strict";
import type { Hex } from "@agent-teams/supply/deployment";
import { qualifySafeArtifacts, type SafeArtifactBytes, type SafeArtifactPins } from "./safe-artifacts.ts";
import { custodyKeccak, custodyTopic, custodySafeSetupOwners, verifyCustodySafeSetupEvent, verifyCustodySafe, safeInspectionCalls, type SafeReceiptLog } from "./safe-custody.ts";

export const ZERO = `0x${"0".repeat(40)}` as Hex;
export const word = (value: bigint) => value.toString(16).padStart(64, "0");
const execAbi = "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)";
const hashAbi = "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)";
export interface LocalSafePorts {
  readonly chainId: "1" | "31337";
  readonly relayer: Hex;
  readonly rpc: (method: string, params?: readonly unknown[]) => Promise<any>;
  readonly encode: (signature: string, args: string[]) => Promise<Hex>;
  readonly call: (to: Hex, signature: string, args?: string[], options?: { from?: Hex; block?: Hex }) => Promise<Hex>;
  readonly send: (to: Hex | null, data: Hex) => Promise<any>;
  readonly sign: (owner: Hex, hash: Hex) => Promise<Hex>;
  readonly verifySignature: (owner: Hex, hash: Hex, signature: Hex) => Promise<boolean>;
}
export interface LocalSafe {
  readonly safe: Hex; readonly owners: Hex[]; readonly setup: { status: string; transactionHash: Hex };
}

/** Drain launched signer work before the owning runner can clean up private custody. */
export async function settleOwnedSignerWork<T>(work: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(work);
  return results.map(result => {
    if (result.status === "rejected") { throw result.reason; }
    return result.value;
  });
}

/** Passive official-Safe reuse: all effects and key custody belong to the injected runner. */
export async function provisionLocalSafes(ports: LocalSafePorts, inventory: { pins: SafeArtifactPins; selected: Hex; bytes: SafeArtifactBytes }, groups: readonly Hex[][]) {
  const { pins, selected, bytes } = inventory;
  qualifySafeArtifacts(pins, selected, bytes, "0x0000000000000000000000000000000000000099");
  const deploy = async (data: Hex): Promise<Hex> => {
    const receipt = await ports.send(null, data);
    assert.equal(receipt.status, "0x1");
    return receipt.contractAddress.toLowerCase() as Hex;
  };
  const singleton = await deploy(JSON.parse(Buffer.from(bytes.singleton).toString()).bytecode);
  const profile = qualifySafeArtifacts(pins, selected, bytes, singleton);
  const safes: LocalSafe[] = [];
  for (const owners of groups) {
    const safe = await deploy(`${JSON.parse(Buffer.from(bytes.proxy).toString()).bytecode}${word(BigInt(singleton))}` as Hex);
    const data = await ports.encode("setup(address[],uint256,address,bytes,address,address,uint256,address)", [`[${owners.join(",")}]`, "2", ZERO, "0x", ZERO, ZERO, "0", ZERO]);
    assert.deepEqual([...custodySafeSetupOwners(safe, data)].toSorted(), [...owners].toSorted());
    const setup = await ports.send(safe, data);
    assert.equal(setup.status, "0x1");
    verifyCustodySafeSetupEvent(safe, ports.relayer, owners, setup.logs);
    const transaction = await ports.rpc("eth_getTransactionByHash", [setup.transactionHash]);
    assert.equal(transaction.from, ports.relayer); assert.equal(transaction.to, safe);
    assert.equal(transaction.input, data); assert.equal(transaction.blockHash, setup.blockHash);
    safes.push({ safe, owners, setup });
  }
  const inspect = async (selectedSafe: LocalSafe, block = "latest") => {
    const at = await ports.rpc("eth_getBlockByNumber", [block, false]);
    const read = (data: Hex) => ports.rpc("eth_call", [{ to: selectedSafe.safe, data }, at.number]);
    const inspection = { address: selectedSafe.safe, blockHash: at.hash,
      proxyCode: await ports.rpc("eth_getCode", [selectedSafe.safe, at.number]), singletonCode: await ports.rpc("eth_getCode", [singleton, at.number]),
      singletonStorage: await ports.rpc("eth_getStorageAt", [selectedSafe.safe, "0x0", at.number]),
      versionResult: await read(safeInspectionCalls.version), ownersResult: await read(safeInspectionCalls.owners),
      thresholdResult: await read(safeInspectionCalls.threshold), nonceResult: await read(safeInspectionCalls.nonce), modulesResult: await read(safeInspectionCalls.modules),
      guardStorage: await ports.rpc("eth_getStorageAt", [selectedSafe.safe, safeInspectionCalls.guardSlot, at.number]),
      fallbackStorage: await ports.rpc("eth_getStorageAt", [selectedSafe.safe, safeInspectionCalls.fallbackSlot, at.number]),
      ownerCode: await Promise.all(selectedSafe.owners.map(async address => ({ address, code: await ports.rpc("eth_getCode", [address, at.number]), blockHash: at.hash }))),
    };
    const configured = { address: selectedSafe.safe, owners: selectedSafe.owners, threshold: 2 as const };
    const checked = verifyCustodySafe(configured, profile, inspection);
    return { address: selectedSafe.safe, owners: checked.owners, threshold: 2 as const, nonce: checked.nonce, blockHash: at.hash,
      proxyCodeHash: custodyKeccak(Buffer.from(inspection.proxyCode.slice(2), "hex")), singletonCodeHash: custodyKeccak(Buffer.from(inspection.singletonCode.slice(2), "hex")),
      singletonAddress: singleton, singletonSlot: inspection.singletonStorage, modules: [] as Hex[], guard: null, fallbackHandler: null,
      guardStorage: inspection.guardStorage, fallbackStorage: inspection.fallbackStorage, setupProvenance: selectedSafe.setup.transactionHash };
  };
  for (const safe of safes) { assert.equal((await inspect(safe)).nonce, "0"); }
  return { safes, singleton, pins, inspect, safeExec: (safe: LocalSafe, to: Hex, data: Hex, count = 2) => executeLocalSafe(ports, safe, to, data, count) };
}

/** Verify an independently calculated EIP-712 hash, owner signatures and exact inner event. */
export async function executeLocalSafe(ports: LocalSafePorts, safe: LocalSafe, to: Hex, data: Hex, signatureCount = 2): Promise<{ receipt: any; success: boolean; transactionHash: Hex; nonce: string }> {
  const nonce = BigInt(await ports.call(safe.safe, "nonce()"));
  const fields = [to, "0", data, "0", "4000000", "0", "0", ZERO, ZERO];
  const hash = await ports.call(safe.safe, hashAbi, [...fields, nonce.toString()]);
  const struct = hashBytes(`${custodyTopic("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)").slice(2)}${word(BigInt(to))}${word(0n)}${hashBytes(data).slice(2)}${[0n, 4000000n, 0n, 0n, 0n, 0n, nonce].map(word).join("")}`);
  const domain = hashBytes(`${custodyTopic("EIP712Domain(uint256 chainId,address verifyingContract)").slice(2)}${word(BigInt(ports.chainId))}${word(BigInt(safe.safe))}`);
  assert.equal(hash, hashBytes(`1901${domain.slice(2)}${struct.slice(2)}`));
  const signatures = await settleOwnedSignerWork(safe.owners.slice(0, signatureCount).map(async owner => ({ owner, signature: await ports.sign(owner, hash) })));
  for (const signed of signatures) {
    assert.match(signed.signature, /^0x[0-9a-f]{128}(1b|1c)$/);
    assert.ok(await ports.verifySignature(signed.owner, hash, signed.signature), "actual owner signature");
  }
  const packed = `0x${signatures.toSorted((a, b) => a.owner < b.owner ? -1 : 1).map(s => s.signature.slice(2)).join("")}`;
  const calldata = await ports.encode(execAbi, [...fields, packed]);
  if (signatureCount < 2) {
    const before = await Promise.all(["getOwners()", "getThreshold()"].map(s => ports.call(safe.safe, s)));
    const denial = await ports.encode("Error(string)", ["GS020"]);
    await assert.rejects(ports.rpc("eth_call", [{ to: safe.safe, data: calldata }, "latest"]), (e: any) => (e.code === 3 || e.rpcCode === 3) && e.data === denial);
    assert.equal(BigInt(await ports.call(safe.safe, "nonce()")), nonce);
    assert.deepEqual(await Promise.all(["getOwners()", "getThreshold()"].map(s => ports.call(safe.safe, s))), before);
    return { receipt: null, success: false, transactionHash: hash, nonce: nonce.toString() };
  }
  const receipt = await ports.send(safe.safe, calldata);
  assert.equal(receipt.status, "0x1");
  assert.equal(BigInt(await ports.call(safe.safe, "nonce()")), nonce + 1n);
  const inner = receipt.logs.filter((log: SafeReceiptLog) => log.address === safe.safe && [custodyTopic("ExecutionSuccess(bytes32,uint256)"), custodyTopic("ExecutionFailure(bytes32,uint256)")].includes(log.topics[0]!));
  assert.equal(inner.length, 1); assert.equal(inner[0].topics.length, 2); assert.equal(inner[0].topics[1], hash);
  assert.equal(inner[0].data, `0x${word(0n)}`); assert.equal(inner[0].removed, false);
  return { receipt, success: inner[0].topics[0] === custodyTopic("ExecutionSuccess(bytes32,uint256)"), transactionHash: hash, nonce: nonce.toString() };
}

const hashBytes = (value: string) => custodyKeccak(Buffer.from(value.replace(/^0x/, ""), "hex"));
