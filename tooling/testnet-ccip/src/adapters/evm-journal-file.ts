import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvmJournalPorts, EvmJournalRecord } from "../application/evm-journal.ts";

/** Caller supplies a private, owned directory. Crash locks require explicit reconciliation. */
export function createJournalFile(path: string): Pick<EvmJournalPorts, "exclusive" | "read" | "write"> {
  if (!isAbsolute(path)) { throw new Error("Journal path must be absolute"); }
  const directory = dirname(path);
  let held = false;
  const assertHeld = (): void => { if (!held) { throw new Error("Journal lock required"); } };
  return {
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
      if (held) { throw new Error("Journal is already locked"); }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const owner = await lstat(directory);
      if (!owner.isDirectory() || owner.isSymbolicLink() || (owner.mode & 0o077) !== 0 ||
        (process.getuid && owner.uid !== process.getuid())) {
        throw new Error("Journal directory must be private and owned by this user");
      }
      const lock = await open(`${path}.lock`, "wx", 0o600);
      held = true;
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        await lock.sync();
        return await work();
      } finally {
        held = false;
        await lock.close();
        await unlink(`${path}.lock`);
      }
    },
    async read(): Promise<EvmJournalRecord | null> {
      assertHeld();
      let handle;
      try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { return null; }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 2_000_000 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
          throw new Error("Journal must be a private regular file");
        }
        return JSON.parse(await handle.readFile("utf8")) as EvmJournalRecord;
      } finally { await handle.close(); }
    },
    async write(record: EvmJournalRecord): Promise<void> {
      assertHeld();
      const temporary = `${path}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(record) + "\n");
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, path);
        const parent = await open(directory, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}
