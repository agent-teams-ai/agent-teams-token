export type Direction = "ethereum-to-solana" | "solana-to-ethereum";
export type Chain = "ethereum" | "solana";

export interface TransferIdentity {
  readonly messageId: string;
  readonly direction: Direction;
  readonly amount: bigint;
  readonly sourceToken: string;
  readonly destinationToken: string;
  readonly recipient: string;
}

/** Facts must come from the configured lane's authenticated chain adapter. */
export interface TransferEvent extends TransferIdentity {
  readonly chain: Chain;
  readonly kind: "lock" | "mint" | "burn" | "release";
  readonly transactionId: string;
  readonly eventIndex: number;
  readonly blockHash: string;
  readonly blockHeight: bigint;
  readonly finality: "unfinalized" | "finalized" | "reorged";
}

export type TransferStatus = "pending" | "manual-execution" | "settled" |
  "unknown" | "inconsistent";

export interface MessageState {
  readonly identity: TransferIdentity;
  readonly status: TransferStatus;
  /** Null means reconciliation is required; it must never be summed as zero. */
  readonly pendingAmount: bigint | null;
  readonly reasons: readonly string[];
}

const fingerprint = (event: TransferEvent): string => JSON.stringify({
  messageId: event.messageId, direction: event.direction, amount: event.amount.toString(),
  sourceToken: event.sourceToken, destinationToken: event.destinationToken,
  recipient: event.recipient, chain: event.chain, kind: event.kind,
  transactionId: event.transactionId, eventIndex: event.eventIndex,
  blockHash: event.blockHash, blockHeight: event.blockHeight.toString(),
});

const matches = (a: TransferIdentity, b: TransferIdentity): boolean =>
  a.messageId === b.messageId && a.direction === b.direction && a.amount === b.amount &&
  a.sourceToken === b.sourceToken && a.destinationToken === b.destinationToken &&
  a.recipient === b.recipient;

const validIdentity = (identity: TransferIdentity): boolean =>
  identity.amount > 0n && Boolean(identity.messageId) && Boolean(identity.sourceToken) &&
  Boolean(identity.destinationToken) && Boolean(identity.recipient) &&
  ["ethereum-to-solana", "solana-to-ethereum"].includes(identity.direction);

const validEvent = (event: TransferEvent, identity: TransferIdentity): boolean =>
  matches(identity, event) && Boolean(event.transactionId) && Boolean(event.blockHash) &&
  Number.isSafeInteger(event.eventIndex) && event.eventIndex >= 0 && event.blockHeight >= 0n &&
  ["unfinalized", "finalized", "reorged"].includes(event.finality);

const roles = {
  "ethereum-to-solana": { sourceChain: "ethereum", sourceKind: "lock", destinationChain: "solana", destinationKind: "mint" },
  "solana-to-ethereum": { sourceChain: "solana", sourceKind: "burn", destinationChain: "ethereum", destinationKind: "release" },
} as const;

function collectEvents(identity: TransferIdentity, events: readonly TransferEvent[]): {
  error: string | null; events: readonly TransferEvent[];
} {
  const unique = new Map<string, TransferEvent>();
  for (const event of events) {
    if (!validEvent(event, identity)) {
      return { error: "event-identity-mismatch", events: [] };
    }
    const key = `${event.chain}:${event.transactionId}:${event.eventIndex}`;
    const previous = unique.get(key);
    if (previous && fingerprint(previous) !== fingerprint(event)) {
      return { error: "conflicting-event-observation", events: [] };
    }
    const rank = { unfinalized: 0, finalized: 1, reorged: 2 };
    if (!previous || rank[event.finality] > rank[previous.finality]) {
      unique.set(key, event);
    }
  }
  return { error: null, events: [...unique.values()] };
}

/**
 * Replays are idempotent; finality advances, while reorgs invalidate success.
 * After a reorg the adapter must replace invalidated observations using canonical
 * chain evidence. Appending a later finality flag cannot erase a reorg.
 */
export function projectMessage(
  identity: TransferIdentity,
  events: readonly TransferEvent[],
  manualExecutionRequired = false,
): MessageState {
  const result = (status: TransferStatus, reason: string, pendingAmount: bigint | null = null): MessageState =>
    ({ identity, status, pendingAmount, reasons: [reason] });
  if (!validIdentity(identity)) {
    return result("inconsistent", "invalid-transfer-identity");
  }
  const collected = collectEvents(identity, events);
  if (collected.error !== null) {
    return result("inconsistent", collected.error);
  }
  const observed = collected.events;
  if (observed.some(event => event.finality === "reorged")) {
    return result("unknown", "reorg-reconciliation-required");
  }
  const role = roles[identity.direction];
  const source = observed.filter(event => event.chain === role.sourceChain && event.kind === role.sourceKind);
  const destination = observed.filter(event => event.chain === role.destinationChain && event.kind === role.destinationKind);
  if (source.length + destination.length !== observed.length) {
    return result("inconsistent", "unexpected-event-kind-or-chain");
  }
  if (source.length > 1 || destination.length > 1) {
    return result("inconsistent", "duplicate-source-or-settlement");
  }
  if (!source.length) {
    return result(destination.length ? "inconsistent" : "unknown",
      destination.length ? "orphan-settlement" : "source-not-observed");
  }
  if (source[0]?.finality !== "finalized") {
    return result("unknown", "source-not-finalized");
  }
  if (destination[0]?.finality === "finalized") {
    return result("settled", "both-events-finalized", 0n);
  }
  return result(manualExecutionRequired ? "manual-execution" : "pending",
    manualExecutionRequired ? "manual-execution-required" : "awaiting-finalized-destination",
    identity.amount);
}
