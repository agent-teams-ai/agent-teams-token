import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LoopbackPortAllocator } from "../src/adapters/ports.ts";

async function childLease(root: string): Promise<{ readonly child: ChildProcess; readonly ports: { readonly rpcPort: number; readonly dynamicPortRange: string } }> {
  const child = spawn(process.execPath, [join(import.meta.dirname, "helpers/hold-port-lease.ts"), root], { stdio: ["pipe", "pipe", "pipe"] });
  const line = await new Promise<string>((resolve, reject) => { let stdout = ""; let stderr = ""; child.stdout?.on("data", (chunk) => { stdout += String(chunk); const end = stdout.indexOf("\n"); if (end >= 0) { resolve(stdout.slice(0, end)); } }); child.stderr?.on("data", (chunk) => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code) => { reject(new Error(`lease helper exited ${code}: ${stderr}`)); }); });
  return { child, ports: JSON.parse(line) as { readonly rpcPort: number; readonly dynamicPortRange: string } };
}

test("cross-process leases reserve disjoint validator blocks until release", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-port-processes-")); await chmod(boundary, 0o700); const root = join(boundary, "leases");
  const children: ChildProcess[] = [];
  try {
    const [one, two] = await Promise.all([childLease(root), childLease(root)]); children.push(one.child, two.child);
    assert.notEqual(one.ports.rpcPort, two.ports.rpcPort); assert.notEqual(one.ports.dynamicPortRange, two.ports.dynamicPortRange);
    for (const child of children) { child.stdin?.end(); }
    await Promise.all(children.map(async (child) => await new Promise<void>((resolve) => { child.once("close", () => resolve()); })));
  } finally { for (const child of children) { if (child.exitCode === null) { child.kill("SIGKILL"); } } await rm(boundary, { recursive: true, force: true }); }
});

test("release rejects hardlinked markers and can safely retry after repair", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-port-hardlink-")); await chmod(boundary, 0o700); const root = join(boundary, "leases");
  try {
    const lease = await new LoopbackPortAllocator(root).allocate();
    const [block] = await readdir(root); assert.ok(block);
    const marker = join(root, block, "lease.json"); const duplicate = join(root, block, "lease-copy");
    await link(marker, duplicate);
    await assert.rejects(lease.release(), /SOLANA_PORT_LEASE_MARKER_UNSAFE/u);
    assert.equal((await lstat(join(root, block))).isDirectory(), true);
    await unlink(duplicate); await lease.release(); await assert.rejects(lstat(join(root, block)));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("release refuses a substituted block without deleting either directory", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-port-substitution-")); await chmod(boundary, 0o700); const root = join(boundary, "leases");
  try {
    const lease = await new LoopbackPortAllocator(root).allocate();
    const [block] = await readdir(root); assert.ok(block);
    const original = join(root, block); const moved = join(root, `${block}-original`); await rename(original, moved); await mkdir(original, { mode: 0o700 }); await writeFile(join(original, "sentinel"), "do-not-delete", { mode: 0o600 });
    await assert.rejects(lease.release(), /SOLANA_PORT_LEASE_SUBSTITUTION/u);
    assert.equal((await lstat(moved)).isDirectory(), true); assert.equal((await lstat(join(original, "sentinel"))).isFile(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("release refuses a substituted lease root without chmod or deletion", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-port-root-")); await chmod(boundary, 0o700); const root = join(boundary, "leases");
  try {
    const lease = await new LoopbackPortAllocator(root).allocate(); const preserved = join(boundary, "preserved");
    await rename(root, preserved); await mkdir(root, { mode: 0o700 }); await writeFile(join(root, "sentinel"), "do-not-delete", { mode: 0o600 });
    await assert.rejects(lease.release(), /SOLANA_PORT_LEASE_ROOT_UNSAFE/u);
    assert.equal((await lstat(preserved)).isDirectory(), true); assert.equal((await lstat(join(root, "sentinel"))).isFile(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("stale reclaim refuses a hardlinked marker, then reclaims after repair", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-port-reclaim-link-")); await chmod(boundary, 0o700); const root = join(boundary, "leases");
  let child: ChildProcess | undefined;
  try {
    ({ child } = await childLease(root)); const [block] = await readdir(root); assert.ok(block); const directory = join(root, block); const marker = join(directory, "lease.json");
    child.kill("SIGKILL"); await new Promise<void>((resolve) => { child!.once("close", () => resolve()); });
    const duplicate = join(directory, "lease-copy"); await link(marker, duplicate);
    const other = await new LoopbackPortAllocator(root).allocate(); assert.equal((await lstat(marker)).nlink, 2); await other.release();
    await unlink(duplicate); const fresh = await new LoopbackPortAllocator(root).allocate();
    const remaining = await readFile(marker, "utf8").then((raw) => JSON.parse(raw) as { readonly pid: number }).catch(() => null);
    assert.equal(remaining === null || remaining.pid === process.pid, true); await fresh.release();
  } finally { if (child?.exitCode === null) { child.kill("SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("stale reclaim refuses a copied marker in a substituted block", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-port-reclaim-swap-")); await chmod(boundary, 0o700); const root = join(boundary, "leases");
  let child: ChildProcess | undefined;
  try {
    ({ child } = await childLease(root)); const [block] = await readdir(root); assert.ok(block); const directory = join(root, block); const markerBytes = await readFile(join(directory, "lease.json"));
    child.kill("SIGKILL"); await new Promise<void>((resolve) => { child!.once("close", () => resolve()); });
    const preserved = join(root, `${block}-preserved`); await rename(directory, preserved); await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, "lease.json"), markerBytes, { mode: 0o600 });
    const other = await new LoopbackPortAllocator(root).allocate();
    assert.equal((await lstat(join(directory, "lease.json"))).isFile(), true); assert.equal((await lstat(preserved)).isDirectory(), true); await other.release();
  } finally { if (child?.exitCode === null) { child.kill("SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});
