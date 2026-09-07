const ZERO = "0x" + "0".repeat(40);
const REGISTRY = "0x95f29fee11c5c55d26cccf1db6772de953b37b82";
const MODULE = "0xa3c796d480638d7476792230da1e2ada86e031b0";
export interface RegistrationSnapshot {
  readonly chainId: "11155111";
  /** Caller reads all contracts at this same canonical finalized block. */
  readonly finalizedBlockHash: string;
  readonly token: string; readonly tokenAdmin: string;
  readonly administrator: string; readonly pendingAdministrator: string; readonly tokenPool: string;
  readonly poolToken: string; readonly poolOwner: string;
}
export interface RegistrationTarget {
  readonly testOnly: true; readonly token: string; readonly pool: string; readonly administrator: string;
}
export type RegistrationStep = { readonly kind: "complete" } | {
  readonly kind: "register-admin" | "accept-admin" | "set-pool";
  readonly chainId: "11155111"; readonly from: string; readonly to: string;
  readonly value: "0"; readonly data: string; readonly observedBlockHash: string;
};
function address(value: string, zero = false): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || (!zero && value.toLowerCase() === ZERO)) {
    throw new Error("Invalid registration address");
  }
  return value.toLowerCase();
}
const word = (value: string): string => value.slice(2).padStart(64, "0");
/** One next operation, based on finalized contract state; never silently replace a foreign admin/pool. */
export function nextRegistrationStep(snapshot: RegistrationSnapshot, target: RegistrationTarget): RegistrationStep {
  if (target.testOnly !== true || snapshot.chainId !== "11155111" ||
    !/^0x[0-9a-fA-F]{64}$/.test(snapshot.finalizedBlockHash)) { throw new Error("Finalized Sepolia evidence required"); }
  const token = address(target.token), pool = address(target.pool), admin = address(target.administrator);
  if (address(snapshot.token) !== token || address(snapshot.tokenAdmin) !== admin ||
    address(snapshot.poolToken) !== token || address(snapshot.poolOwner) !== admin) {
    throw new Error("Token/pool ownership does not match deployment");
  }
  const current = address(snapshot.administrator, true), pending = address(snapshot.pendingAdministrator, true);
  const currentPool = address(snapshot.tokenPool, true);
  if ((current !== ZERO && current !== admin) || (pending !== ZERO && pending !== admin) ||
    (currentPool !== ZERO && currentPool !== pool)) { throw new Error("Conflicting registration requires reconciliation"); }
  const base = { chainId: "11155111" as const, from: admin, value: "0" as const,
    observedBlockHash: snapshot.finalizedBlockHash.toLowerCase() };
  if (current === ZERO) {
    if (currentPool !== ZERO) { throw new Error("Pool configured without accepted administrator"); }
    return pending === ZERO
      ? { ...base, kind: "register-admin", to: MODULE, data: "0xff12c354" + word(token) }
      : { ...base, kind: "accept-admin", to: REGISTRY, data: "0x156194da" + word(token) };
  }
  if (pending !== ZERO) { throw new Error("Unexpected pending admin transfer"); }
  return currentPool === pool ? { kind: "complete" }
    : { ...base, kind: "set-pool", to: REGISTRY, data: "0x4e847fc7" + word(token) + word(pool) };
}
