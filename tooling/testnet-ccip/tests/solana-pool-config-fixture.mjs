import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createSolanaPoolConfigSdk } from "../src/adapters/solana-pool-config-sdk.mjs";
import { BURNMINT_PROGRAM } from "../src/domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../src/domain/solana-registration.ts";
import { REMOTE_POOL, REMOTE_TOKEN, ALT_PROGRAM, altAddresses, remoteBytes } from "../src/domain/solana-pool-config.ts";
  const anchor = (name, size) => { const bytes = Buffer.alloc(size); createHash("sha256").update("account:" + name).digest().copy(bytes, 0, 0, 8); bytes[8] = 1; return bytes; };
  const raw = (data, owner) => ({ data: [data.toString("base64"), "base64"], owner, executable: false, lamports: 10_000_000, rentEpoch: 0 });
export async function poolConfigFixture(provider) {
  const sdk = await createSolanaPoolConfigSdk(provider), require = createRequire(resolve(provider, "package.json"));
  const web3 = require("@solana/web3.js"), spl = require("@solana/spl-token");
  const { PublicKey, Keypair, Transaction } = web3;
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(27)), mint = Keypair.fromSeed(new Uint8Array(32).fill(28)).publicKey;
  const program = new PublicKey(BURNMINT_PROGRAM), router = new PublicKey(ROUTER_PROGRAM);
  const expected = sdk.derive({ testOnly: true, cluster: "solana-devnet", operation: "init-chain-remote-config", payer: payer.publicKey.toBase58(),
    mint: mint.toBase58(), pool: PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], program)[0].toBase58() });
  const latest = { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(29)).publicKey.toBase58(), lastValidBlockHeight: "100" };
  const key = (data, offset, address) => new PublicKey(address).toBuffer().copy(data, offset);
  const mintBytes = Buffer.alloc(82); mintBytes.writeUInt32LE(1, 0); key(mintBytes, 4, expected.signer); mintBytes[44] = 9; mintBytes[45] = 1;
  const pool = anchor("State", 368); pool[73] = 9;
  for (const [offset, address] of [[9, spl.TOKEN_PROGRAM_ID], [41, mint], [74, expected.signer], [106, expected.ata], [138, expected.payer],
    [202, expected.payer], [234, PublicKey.findProgramAddressSync([Buffer.from("external_token_pools_signer"), program.toBuffer()], router)[0]],
    [266, ROUTER_PROGRAM], [336, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7"]]) { key(pool, offset, address); }
  const ata = Buffer.alloc(165); key(ata, 0, mint); key(ata, 32, expected.signer); ata[108] = 1;
  const global = anchor("PoolConfig", 74); global[9] = 1; key(global, 10, ROUTER_PROGRAM); key(global, 42, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7");
  const config = anchor("Config", 210); config[9] = 1; config.writeBigUInt64LE(16423721717087811551n, 10);
  key(config, 82, "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi"); key(config, 114, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7");
  const registry = anchor("TokenAdminRegistry", 170); registry[8] = 2; key(registry, 41, expected.payer); key(registry, 137, expected.mint);
  const registryAccepted = Buffer.from(registry); registryAccepted.fill(0, 41, 73); key(registryAccepted, 9, expected.payer);
  const values = (e, phase) => {
    const operation = e.operation, before = phase === "before";
    const count = operation === "init-chain-remote-config" || operation === "append-remote-pool-addresses" && before ? 0 : 1;
    const chain = Buffer.alloc(147 + count * 36); createHash("sha256").update("account:ChainConfig").digest().copy(chain, 0, 0, 8);
    chain.writeUInt32LE(count, 8); let offset = 12;
    if (count) { chain.writeUInt32LE(32, offset); remoteBytes(REMOTE_POOL).copy(chain, offset + 4); offset += 36; }
    chain.writeUInt32LE(32, offset); remoteBytes(REMOTE_TOKEN).copy(chain, offset + 4); chain[offset + 36] = 9; offset += 37;
    const enabled = ["create-lookup-table", "set-pool"].includes(operation) || operation === "set-chain-rate-limit" && !before;
    if (enabled) {
      for (const at of [offset, offset + 33]) { chain[at + 16] = 1; chain.writeBigUInt64LE(10_000_000_000n, at + 17); chain.writeBigUInt64LE(1_000_000_000n, at + 25); }
    }
    const reg = Buffer.from(registryAccepted);
    if (operation === "set-pool" && !before) { key(reg, 73, e.alt); reg[120] = 0x19; }
    const result = [raw(mintBytes, spl.TOKEN_PROGRAM_ID.toBase58()), raw(pool, BURNMINT_PROGRAM), raw(ata, spl.TOKEN_PROGRAM_ID.toBase58()),
      raw(reg, ROUTER_PROGRAM), raw(global, BURNMINT_PROGRAM), raw(config, ROUTER_PROGRAM),
      before && operation === "init-chain-remote-config" ? null : raw(chain, BURNMINT_PROGRAM)];
    if (e.alt) {
      const alt = Buffer.alloc(376); alt.writeUInt32LE(1, 0); alt.writeBigUInt64LE((1n << 64n) - 1n, 4); alt.writeBigUInt64LE(150n, 12);
      alt[21] = 1; key(alt, 22, e.payer); altAddresses(e).forEach((address, i) => key(alt, 56 + i * 32, address));
      result.push(before && operation === "create-lookup-table" ? null : raw(alt, ALT_PROGRAM));
    }
    return result;
  };
  return { sdk, expected, latest, payer, mint, web3, spl, Transaction, values };
}
