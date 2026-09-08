import { createHash } from "node:crypto";
import { BURNMINT_PROGRAM } from "../domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../domain/solana-registration.ts";
import { ALT_PROGRAM, FEE_QUOTER_PROGRAM, REMOTE_POOL, REMOTE_TOKEN, altAddresses, remoteBytes } from "../domain/solana-pool-config.ts";
const discriminator = name => createHash("sha256").update("account:" + name).digest().subarray(0, 8);
function data(raw, owner) {
  if (!raw || raw.owner !== owner || raw.executable !== false || !Array.isArray(raw.data) || raw.data.length !== 2 ||
    raw.data[1] !== "base64" || typeof raw.data[0] !== "string") { throw new Error("Wrong pool config account"); }
  const bytes = Buffer.from(raw.data[0], "base64");
  if (bytes.toString("base64") !== raw.data[0]) { throw new Error("Noncanonical account data"); }
  return bytes;
}
function layout(bytes, name, size) {
  if (bytes.length !== size || !bytes.subarray(0, 8).equals(discriminator(name))) { throw new Error("Wrong " + name + " layout"); }
}
function rate(bytes, offset, enabled) {
  const tokens = bytes.readBigUInt64LE(offset), flag = bytes[offset + 16], capacity = bytes.readBigUInt64LE(offset + 17), speed = bytes.readBigUInt64LE(offset + 25);
  if (flag !== Number(enabled) || capacity !== (enabled ? 10_000_000_000n : 0n) || speed !== (enabled ? 1_000_000_000n : 0n) || tokens > capacity) {
    throw new Error("Wrong chain rate limit");
  }
}
function chainRates(bytes, offset, before, op) {
  const enabled = ["create-lookup-table", "set-pool"].includes(op) || op === "set-chain-rate-limit" && !before;
  const effective = !before && ["init-chain-remote-config", "append-remote-pool-addresses"].includes(op) ? bytes[offset + 16] === 1 : enabled;
  rate(bytes, offset, effective); rate(bytes, offset + 33, effective);
}
function verifyChain(raw, expected, phase) {
  const before = phase === "before", op = expected.operation;
  if (before && op === "init-chain-remote-config") {
    if (raw !== null) { throw new Error("Remote chain already exists; reconcile journal"); }
    return;
  }
  const bytes = data(raw, BURNMINT_PROGRAM);
  if (bytes.length < 115 || !bytes.subarray(0, 8).equals(discriminator("ChainConfig"))) { throw new Error("Wrong chain layout"); }
  const count = bytes.readUInt32LE(8);
  if (count > 1 || bytes.length !== 115 + count * 36) { throw new Error("Wrong bounded remote pool vector"); }
  let offset = 12;
  if (count === 1) {
    if (bytes.readUInt32LE(offset) !== 32 || !bytes.subarray(offset + 4, offset + 36).equals(remoteBytes(REMOTE_POOL))) { throw new Error("Wrong padded remote pool"); }
    offset += 36;
  }
  if (bytes.readUInt32LE(offset) !== 32 || !bytes.subarray(offset + 4, offset + 36).equals(remoteBytes(REMOTE_TOKEN)) || bytes[offset + 36] !== 9) {
    throw new Error("Wrong remote token or decimals");
  }
  if (before && op === "append-remote-pool-addresses" ? count !== 0 : op !== "init-chain-remote-config" && count !== 1) { throw new Error("Wrong remote pool phase"); }
  offset += 37;
  chainRates(bytes, offset, before, op);
}
  function altTiming(extended, e, slot, transactionSlot, phase) {
    if (phase === "after" && (!Number.isSafeInteger(transactionSlot) || transactionSlot <= 0 || transactionSlot > slot)) { throw new Error("Exact finalized ALT transaction slot required"); }
    if (phase === "after" && e.operation === "set-pool" && BigInt(transactionSlot) <= extended) { throw new Error("Set pool transaction must be in a later actual slot"); }
    if (extended < BigInt(e.recentSlot) || extended > BigInt(slot) || e.operation === "set-pool" && extended >= BigInt(slot) ||
      e.operation === "create-lookup-table" && transactionSlot > 0 && extended !== BigInt(transactionSlot)) { throw new Error("ALT requires finalized extension and a later actual slot before use"); }
  }
export function createPoolConfigStateVerifier(provider, poolSdk, registrationSdk) {
  const { PublicKey, SystemProgram } = provider.web3;
  const { TOKEN_PROGRAM_ID, unpackMint, unpackAccount } = provider.spl;
  const key = (bytes, offset) => new PublicKey(bytes.subarray(offset, offset + 32)).toBase58();
  const zero = SystemProgram.programId.toBase58(), tokenProgram = TOKEN_PROGRAM_ID.toBase58();
  function tokenAccounts(mintRaw, ataRaw, e) {
    const mintBytes = data(mintRaw, tokenProgram), ataBytes = data(ataRaw, tokenProgram);
    if (mintBytes.length !== 82 || mintBytes.readUInt32LE(0) !== 1 || mintBytes[45] !== 1 || mintBytes.readUInt32LE(46) !== 0 ||
      ataBytes.length !== 165 || ataBytes[108] !== 1) { throw new Error("Wrong initialized SPL account layout"); }
    const mint = unpackMint(new PublicKey(e.mint), { ...mintRaw, owner: TOKEN_PROGRAM_ID, data: mintBytes });
    if (mint.decimals !== 9 || mint.supply !== 0n || mint.mintAuthority?.toBase58() !== e.signer || mint.freezeAuthority !== null) {
      throw new Error("Pool mint authority prerequisite not met");
    }
    const ata = unpackAccount(new PublicKey(e.ata), { ...ataRaw, owner: TOKEN_PROGRAM_ID, data: ataBytes });
    if (ata.mint.toBase58() !== e.mint || ata.owner.toBase58() !== e.signer || ata.amount !== 0n || ata.delegate !== null || ata.delegatedAmount !== 0n ||
      ata.isNative || ata.closeAuthority !== null) { throw new Error("Wrong empty pool ATA"); }
  }
  function routerConfig(raw) {
    const bytes = data(raw, ROUTER_PROGRAM); layout(bytes, "Config", 210);
    if (bytes[8] !== 1 || bytes[9] !== 1 || bytes.readBigUInt64LE(10) !== 16423721717087811551n || key(bytes, 82) !== FEE_QUOTER_PROGRAM ||
      key(bytes, 114) !== "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7") { throw new Error("Wrong router configuration"); }
  }
  function registry(raw, e, phase) {
    const decoded = registrationSdk.decodeRegistry(raw);
    const attached = phase === "after" && e.operation === "set-pool";
    const bitmap = Buffer.alloc(32); if (attached) { bitmap[15] = 0x19; }
    if (decoded.administrator !== e.payer || decoded.pendingAdministrator !== zero || decoded.mint !== e.mint || decoded.supportsAutoDerivation !== false ||
      decoded.lookupTable !== (attached ? e.alt : zero) || decoded.writableIndexes !== "0x" + bitmap.toString("hex")) { throw new Error("Wrong accepted registry phase"); }
  }
  function alt(raw, e, phase, slot, transactionSlot) {
    if (!e.alt) { return; }
    if (phase === "before" && e.operation === "create-lookup-table") {
      if (raw !== null || BigInt(slot) < BigInt(e.recentSlot) || BigInt(slot) - BigInt(e.recentSlot) >= 512n) { throw new Error("ALT exists or persisted recentSlot is not recent"); }
      return;
    }
    const bytes = data(raw, ALT_PROGRAM);
    if (bytes.length !== 376 || bytes.readUInt32LE(0) !== 1 || bytes.readBigUInt64LE(4) !== (1n << 64n) - 1n ||
      bytes[20] !== 0 || bytes[21] !== 1 || key(bytes, 22) !== e.payer || bytes.readUInt16LE(54) !== 0) { throw new Error("Wrong active ALT metadata"); }
    const extended = bytes.readBigUInt64LE(12);
    altTiming(extended, e, slot, transactionSlot, phase);
    if (altAddresses(e).some((address, i) => key(bytes, 56 + i * 32) !== address)) { throw new Error("Wrong canonical ALT address order"); }
  }
  return function verifySnapshot(values, e, phase, slot, transactionSlot) {
    if (!["before", "after"].includes(phase) || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(values) || values.length !== (e.alt ? 8 : 7)) {
      throw new Error("Incomplete pool config snapshot");
    }
    const [mintRaw, poolRaw, ataRaw, registryRaw, globalRaw, configRaw, chainRaw, altRaw] = values;
    tokenAccounts(mintRaw, ataRaw, e);
    poolSdk.verifyState(data(poolRaw, BURNMINT_PROGRAM).toString("base64"), e);
    poolSdk.verifyGlobal(data(globalRaw, BURNMINT_PROGRAM).toString("base64"));
    routerConfig(configRaw); registry(registryRaw, e, phase); verifyChain(chainRaw, e, phase); alt(altRaw, e, phase, slot, transactionSlot);
    return { operation: e.operation, mint: e.mint, verified: true };
  };
}
