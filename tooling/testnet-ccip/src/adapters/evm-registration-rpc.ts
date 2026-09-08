import type { RegistrationSnapshot, RegistrationTarget } from "../domain/evm-registration.ts";
const REGISTRY = "0x95f29fee11c5c55d26cccf1db6772de953b37b82";
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { throw new Error("Invalid registry RPC response"); }
  return value as Record<string, unknown>;
}
function addresses(value: unknown, count: number): string[] {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(value)) {
    throw new Error("Invalid registry ABI response");
  }
  return Array.from({ length: count }, (_, index) => {
    const word = value.slice(2 + index * 64, 66 + index * 64);
    if (word.slice(0, 24) !== "0".repeat(24)) { throw new Error("Noncanonical ABI address"); }
    return "0x" + word.slice(24).toLowerCase();
  });
}
/** Read-only snapshot; all eth_call/getCode reads bind to the same canonical finalized hash. */
export async function readRegistrationSnapshot(target: RegistrationTarget, fetcher: typeof fetch = globalThis.fetch): Promise<RegistrationSnapshot> {
  if (target.testOnly !== true || ![target.token, target.pool, target.administrator].every(value =>
    /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0+$/.test(value))) { throw new Error("Invalid test registration target"); }
  let sequence = 0;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const id = ++sequence;
    const response = await fetcher("https://ethereum-sepolia-rpc.publicnode.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    const body = object(await response.json());
    if (!response.ok || body.id !== id || body.jsonrpc !== "2.0" || "error" in body || !("result" in body)) {
      throw new Error("Registry RPC unavailable");
    }
    return body.result;
  }
  if (await rpc("eth_chainId", []) !== "0xaa36a7") { throw new Error("Wrong registry chain"); }
  const block = object(await rpc("eth_getBlockByNumber", ["finalized", false]));
  if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
    typeof block.number !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(block.number)) {
    throw new Error("Finalized block unavailable");
  }
  const at = { blockHash: block.hash, requireCanonical: true };
  for (const account of [target.token, target.pool, REGISTRY]) {
    const code = await rpc("eth_getCode", [account, at]);
    if (typeof code !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(code)) { throw new Error("Registration contract not deployed"); }
  }
  const call = (to: string, data: string): Promise<unknown> => rpc("eth_call", [{ to, data }, at]);
  const [administrator, pendingAdministrator, tokenPool] = addresses(await call(REGISTRY,
    "0xcb67e3b1" + target.token.slice(2).toLowerCase().padStart(64, "0")), 3);
  const [tokenAdmin] = addresses(await call(target.token, "0x8fd6a6ac"), 1);
  const [poolToken] = addresses(await call(target.pool, "0x21df0da7"), 1);
  const [poolOwner] = addresses(await call(target.pool, "0x8da5cb5b"), 1);
  const canonical = object(await rpc("eth_getBlockByNumber", [block.number, false]));
  if (canonical.hash !== block.hash || canonical.number !== block.number || await rpc("eth_chainId", []) !== "0xaa36a7") {
    throw new Error("Registry snapshot changed chain/block");
  }
  return { chainId: "11155111", finalizedBlockHash: block.hash, token: target.token,
    tokenAdmin: tokenAdmin!, administrator: administrator!, pendingAdministrator: pendingAdministrator!,
    tokenPool: tokenPool!, poolToken: poolToken!, poolOwner: poolOwner! };
}
