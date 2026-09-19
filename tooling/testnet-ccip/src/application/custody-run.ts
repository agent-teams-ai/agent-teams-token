import { deploymentBytes, isDigest, validateDeployment, type DeploymentManifest, type Hex } from "@agent-teams/supply/deployment";
import { canonicalCustodyIntent, type CustodyIntent, type CustodyOperation } from "../domain/custody-intent.ts";
import { custodyNextAction, verifyCustodySnapshot, type CustodySnapshot } from "../domain/custody.ts";
import { runCustodyJournal, type CustodyJournalPorts, type CustodyJournalRecord } from "./evm-journal.ts";

export interface CustodySelection { readonly operationId: string; readonly operation: CustodyOperation; readonly grantId: string | null }
export interface CustodyRunRecord {
  readonly schema: "agtmai-custody-run-v2"; readonly configurationSha256: Hex;
  readonly current: { readonly selection: CustodySelection; readonly intent: CustodyIntent } | null;
  readonly completed: readonly { readonly selection: CustodySelection; readonly intent: CustodyIntent; readonly transactionHash: Hex; readonly evidenceSha256: Hex }[];
  readonly failure: { readonly operationId: string; readonly transactionHash: Hex; readonly reason: string } | null;
}
export interface CustodyRunPorts {
  /** One process exclusion covers selection, nonce preparation, durable journal and publication. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<CustodyRunRecord | null>;
  write(record: CustodyRunRecord): Promise<void>;
  /** Inspect current chain plus every historical operation. Incomplete/reorged history throws; no selection follows. */
  inspect(record: CustodyRunRecord): Promise<{ readonly manifest: DeploymentManifest; readonly snapshot: CustodySnapshot | null }>;
  prepare(selection: CustodySelection, manifest: DeploymentManifest, snapshot: CustodySnapshot | null): Promise<CustodyIntent>;
  journal(intent: CustodyIntent): CustodyJournalPorts;
  readJournal(intent: CustodyIntent): Promise<CustodyJournalRecord | null>;
  /** Runs before initial signing only; checks code, role, fees, nonce, balance, time and any Safe signatures. */
  preflight(intent: CustodyIntent, selection: CustodySelection): Promise<void>;
  /** Authenticate finalized native effects, persist public evidence, then return its digest. Never signs/submits. */
  prove(selection: CustodySelection, intent: CustodyIntent, transactionHash: Hex): Promise<{ readonly status: "verified" | "failed"; readonly reason: string; readonly evidenceSha256: Hex }>;
}
export interface CustodyRunResult {
  readonly status: "prepared" | "waiting" | "unresolved" | "verified" | "failed" | "complete";
  readonly reason: string; readonly configurationSha256: Hex; readonly operationId: string | null;
  readonly transactionHash: Hex | null; readonly broadcastAllowed: false | "owned-testnet-only" | "local-only";
}
const fail = (reason: string): never => { throw new Error(`CUSTODY_RUN_${reason}`); };
const same = (a: unknown, b: unknown): boolean => new TextDecoder().decode(deploymentBytes(a)) === new TextDecoder().decode(deploymentBytes(b));
export function selectCustodyOperation(manifest: DeploymentManifest, snapshot: CustodySnapshot | null, record: CustodyRunRecord): CustodySelection | "wait" | "complete" {
  if (!manifest.token) { return { operationId: "deploy-token", operation: "deploy-token", grantId: null }; }
  const missing = manifest.configuration.grants.find(g => !manifest.grants.some(d => d.grantId === g.id));
  if (missing) { return { operationId: `deploy-${missing.id}`, operation: "deploy-grant", grantId: missing.id }; }
  if (!snapshot) { return fail("SNAPSHOT_REQUIRED"); }
  verifyCustodySnapshot(manifest, snapshot);
  const selections = manifest.configuration.grants.map(g => {
    const state = snapshot.grants.find(s => s.grantId === g.id)!;
    const rejected = record.completed.some(c => c.selection.grantId === g.id && c.selection.operation === "reject-founder-cancel");
    return { grant: g, state, action: custodyNextAction(g, state, snapshot.block.timestamp, rejected) };
  });
  // Complete deployment/funding before entering any vesting window.
  const next = selections.find(s => !s.state.funded) ?? selections.find(s => s.action !== "complete" && s.action !== "wait");
  if (!next) { return selections.every(s => s.action === "complete") ? "complete" : "wait"; }
  if (next.action === "complete" || next.action === "wait") { return next.action; }
  return { operationId: `${next.grant.id}-${next.action}`, operation: next.action, grantId: next.grant.id };
}
function validateRun(record: CustodyRunRecord, configurationSha256: Hex): void {
  if (record.schema !== "agtmai-custody-run-v2" || record.configurationSha256 !== configurationSha256 || !Array.isArray(record.completed)
    || record.completed.length > 256 || new Set(record.completed.map(c => c.selection.operationId)).size !== record.completed.length) { fail("RECORD_BINDING"); }
  const entries = [...record.completed, ...(record.current ? [record.current] : [])];
  for (const entry of entries) {
    canonicalCustodyIntent(entry.intent);
    if (entry.intent.configurationSha256 !== configurationSha256 || entry.intent.operation !== entry.selection.operation || entry.intent.operationId !== entry.selection.operationId) { fail("OPERATION_BINDING"); }
  }
  for (const completed of record.completed) {
    if (!isDigest(completed.transactionHash) || !isDigest(completed.evidenceSha256)) { fail("EVIDENCE_BINDING"); }
  }
  if (record.current && record.completed.some(c => c.selection.operationId === record.current!.selection.operationId)) { fail("OPERATION_REUSE"); }
}
/** One invocation prepares or advances one exact operation; publication recovery never replaces an economic operation. */
export async function runCustody(mode: "prepare" | "next" | "reconcile" | "status", manifest: DeploymentManifest, ports: CustodyRunPorts): Promise<CustodyRunResult> {
  const config = validateDeployment(manifest.configuration).value;
  if (!config || config.environment.mode === "mainnet-dry-run" || config.status !== "test-only" || !["prepare", "next", "reconcile", "status"].includes(mode)
    || !config.grants.some(g => g.kind === "team") || !config.grants.some(g => g.kind === "founder")) { return fail("TEST_CONFIGURATION_REQUIRED"); }
  return ports.exclusive(async () => {
    let record: CustodyRunRecord = await ports.read() ?? { schema: "agtmai-custody-run-v2", configurationSha256: manifest.configurationSha256, current: null, completed: [], failure: null };
    validateRun(record, manifest.configurationSha256);
    const result = (status: CustodyRunResult["status"], reason: string, hash: Hex | null = null): CustodyRunResult => ({ status, reason,
      configurationSha256: record.configurationSha256, operationId: record.current?.selection.operationId ?? null, transactionHash: hash,
      broadcastAllowed: mode === "next" ? config.environment.mode === "local-test" ? "local-only" : "owned-testnet-only" : false });
    if (record.failure) { return result("failed", record.failure.reason, record.failure.transactionHash); }
    let inspected: Awaited<ReturnType<CustodyRunPorts["inspect"]>>;
    try { inspected = await ports.inspect(record); } catch { return result("unresolved", "canonical-history-unavailable"); }
    if (inspected.manifest.configurationSha256 !== record.configurationSha256 || !same(inspected.manifest.configuration, config)) { return fail("MANIFEST_CHANGED"); }
    if (!record.current) {
      const selection = selectCustodyOperation(inspected.manifest, inspected.snapshot, record);
      if (selection === "wait" || selection === "complete") { return result(selection === "wait" ? "waiting" : "complete", selection === "wait" ? "chain-time-window" : "all-operations-proven"); }
      if (record.completed.some(c => c.selection.operationId === selection.operationId)) { return fail("COMPLETED_STATE_CONFLICT"); }
      if (mode === "reconcile" || mode === "status") { return result("waiting", "preparation-required"); }
      const intent = await ports.prepare(selection, inspected.manifest, inspected.snapshot);
      record = { ...record, current: { selection, intent } }; validateRun(record, manifest.configurationSha256);
      await ports.write(record);
    }
    return advanceCurrent(mode, record, ports, result);
  });
}

async function advanceCurrent(mode: "prepare" | "next" | "reconcile" | "status", record: CustodyRunRecord, ports: CustodyRunPorts,
  result: (status: CustodyRunResult["status"], reason: string, hash?: Hex | null) => CustodyRunResult): Promise<CustodyRunResult> {
    const current = record.current!;
    const previous = await ports.readJournal(current.intent);
    if (mode === "prepare" || mode === "status") {
      return previous === null ? result("prepared", "unsigned-operation-selected") : result("unresolved", `journal-${previous.phase}`, previous.signed.hash as Hex);
    }
    if (previous === null) {
      if (mode !== "next") { return result("unresolved", "no-signed-journal"); }
    }
    if (mode === "next" && (previous === null || previous.phase === "signed")) { await ports.preflight(current.intent, current.selection); }
    const journalPorts = ports.journal(current.intent);
    // Reconciliation is observe-only, including a persisted signed-but-never-submitted record.
    const readOnly = { ...journalPorts, sign: async (): Promise<never> => fail("RECONCILE_CANNOT_SIGN"), broadcast: async (): Promise<never> => fail("RECONCILE_CANNOT_BROADCAST") };
    const journal = await runCustodyJournal(current.intent, current.intent, mode === "next" ? journalPorts : readOnly, mode === "next" ? "execute" : "observe");
    const hash = journal.record.signed.hash as Hex;
    if (journal.status === "unresolved") { return result("unresolved", journal.reason, hash); }
    if (journal.status === "reverted") {
      record = { ...record, failure: { operationId: current.selection.operationId, transactionHash: hash, reason: "finalized-revert" } };
      await ports.write(record); return result("failed", "finalized-revert", hash);
    }
    let proof: Awaited<ReturnType<CustodyRunPorts["prove"]>>;
    try { proof = await ports.prove(current.selection, current.intent, hash); } catch { return result("unresolved", "effects-or-publication-unavailable", hash); }
    if (!isDigest(proof.evidenceSha256) || !/^[a-z][a-z0-9-]{0,95}$/.test(proof.reason)) { return fail("PROOF_RESULT"); }
    if (proof.status === "failed") {
      record = { ...record, failure: { operationId: current.selection.operationId, transactionHash: hash, reason: proof.reason } };
      await ports.write(record); return result("failed", proof.reason, hash);
    }
    const outcome = result("verified", proof.reason, hash);
    record = { ...record, current: null, completed: [...record.completed, { ...current, transactionHash: hash, evidenceSha256: proof.evidenceSha256 }] };
    await ports.write(record); return outcome;
}
