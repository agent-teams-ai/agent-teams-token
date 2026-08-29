import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LocalSolanaError, type EvidenceReport, type FixtureObservations } from "../domain/model.ts";
import type { RunPaths, RunStorePort } from "../application/ports.ts";

const PREFIX = "run-";
const MARKER = ".agtmai-local-solana-lease.json";

export class PrivateRunStore implements RunStorePort {
  private readonly root: string;
  private readonly outputRoot: string;
  public constructor(runRoot: string, outputRoot: string) { this.root = resolve(runRoot); this.outputRoot = resolve(outputRoot); }
  public async create(): Promise<RunPaths> {
    await ensurePrivateRoot(this.root);
    const directory = await mkdtemp(join(this.root, PREFIX));
    await chmod(directory, 0o700);
    const lease = { schemaVersion: 1, kind: "agtmai-local-solana", pid: process.pid, token: randomBytes(32).toString("hex") };
    await atomicWrite(join(directory, MARKER), `${JSON.stringify(lease)}\n`, 0o600);
    await atomicWrite(join(directory, "config.yml"), "json_rpc_url: http://127.0.0.1:0/\nwebsocket_url: ws://127.0.0.1:0/\n", 0o600);
    const ledger = join(directory, "ledger"); await mkdir(ledger, { mode: 0o700 });
    return { directory, ledger, config: join(directory, "config.yml"), payerKey: join(directory, "payer.json"), mintKey: join(directory, "mint.json"), ownerKey: join(directory, "owner.json"), freezeKey: join(directory, "freeze.json") };
  }
  public async cleanup(paths: RunPaths): Promise<void> {
    if (!await exists(paths.directory)) { return; }
    await validateOwnedRun(this.root, paths.directory, false);
    await rm(paths.directory, { recursive: true, force: false, maxRetries: 2 });
  }
  public async reclaimStale(): Promise<number> {
    await ensurePrivateRoot(this.root);
    const entries = await import("node:fs/promises").then(async ({ readdir }) => await readdir(this.root));
    let reclaimed = 0;
    for (const name of entries) {
      if (!name.startsWith(PREFIX)) { continue; }
      const directory = join(this.root, name);
      const lease = await validateOwnedRun(this.root, directory, true).catch(() => null);
      if (!lease || processAlive(lease.pid)) { continue; }
      await rm(directory, { recursive: true, force: false, maxRetries: 2 }); reclaimed += 1;
    }
    return reclaimed;
  }
  public async publish(_observations: FixtureObservations, verified: unknown): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
    const report = verified as EvidenceReport;
    await ensurePrivateRoot(this.outputRoot);
    const directory = await mkdtemp(join(this.outputRoot, "evidence-")); await chmod(directory, 0o700);
    const jsonPath = join(directory, "evidence-report.v1.json"); const markdownPath = join(directory, "evidence-report.v1.md");
    await atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 0o600);
    await atomicWrite(markdownPath, markdown(report), 0o600);
    await atomicWrite(join(directory, "READY"), `${report.genesisHash}\n`, 0o600);
    return { jsonPath, markdownPath };
  }
}

export async function ensurePrivateRoot(path: string): Promise<void> {
  const absolute = resolve(path); const parent = dirname(absolute);
  if (await realpath(parent).catch(() => null) !== parent) { throw new LocalSolanaError("SOLANA_DIRECTORY_PARENT", "directory parent is absent or substituted"); }
  try { await mkdir(absolute, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") { throw cause; } }
  const entry = await lstat(absolute); const resolved = await realpath(absolute); const expectedUid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink() || resolved !== absolute || (entry.mode & 0o077) !== 0 || (expectedUid !== undefined && entry.uid !== expectedUid)) {
    throw new LocalSolanaError("SOLANA_DIRECTORY_UNSAFE", "directory must be owned mode-0700 with no symlink substitution");
  }
}

async function validateOwnedRun(root: string, directory: string, allowStale: boolean): Promise<{ readonly pid: number }> {
  if (dirname(directory) !== root || !directory.split("/").at(-1)?.startsWith(PREFIX)) { throw new LocalSolanaError("SOLANA_CLEANUP_BOUNDARY", "refusing cleanup outside owned run root"); }
  const entry = await lstat(directory); const expectedUid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.nlink < 2 || (entry.mode & 0o077) !== 0 || await realpath(directory) !== directory || (expectedUid !== undefined && entry.uid !== expectedUid)) {
    throw new LocalSolanaError("SOLANA_CLEANUP_SUBSTITUTION", "owned run directory was substituted");
  }
  const markerPath = join(directory, MARKER); const markerEntry = await lstat(markerPath);
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink() || markerEntry.nlink !== 1 || (markerEntry.mode & 0o077) !== 0) { throw new LocalSolanaError("SOLANA_LEASE_UNSAFE", "lease must be a private singly-linked regular file"); }
  const raw = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.kind !== "agtmai-local-solana" || typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || typeof raw.token !== "string" || !/^[a-f0-9]{64}$/u.test(raw.token)) {
    throw new LocalSolanaError("SOLANA_LEASE_INVALID", "owned lease is invalid");
  }
  if (!allowStale && raw.pid !== process.pid) { throw new LocalSolanaError("SOLANA_LEASE_OWNER", "run belongs to another process"); }
  return { pid: raw.pid };
}

export async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return false; } throw cause; } }
function markdown(report: EvidenceReport): string { return `# Local Solana SPL fixture evidence\n\n- Status: READY\n- Mint: ${report.mintAuthority}\n- Program: ${report.programId}\n- Decimals: ${report.decimals}\n- Supply: ${report.initialSupply} -> ${report.intermediateSupply} -> ${report.finalSupply}\n- Freeze authority: None\n- Signed restore/freeze attempts: reached Token Program and failed\n- Public network: false\n- Real asset cost USD: 0\n- Mint authority revoked: false\n- Authority key retained: false\n- Remint possible until teardown: true\n- Production hard cap proven: false\n`;
}
