import { constants, lstat, mkdir, open, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { SlitherGateError } from "../domain/model.ts";

interface Entry { readonly handle: FileHandle; readonly directory: boolean }

/** Inventory is acquired at creation, never inferred from a cleanup-time walk. */
export class ScratchCustody {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  readonly root: string;

  private constructor(root: string) { this.root = root; }

  static async acquire(root: string): Promise<ScratchCustody> {
    const custody = new ScratchCustody(root);
    try { await custody.retain(root, true); return custody; }
    catch (cause) {
      const failures: unknown[] = [cause];
      for (const { handle } of custody.entries.values()) {
        try { await handle.close(); } catch (close) { failures.push(close); }
      }
      throw new AggregateError(failures, "scratch acquisition failed", { cause });
    }
  }

  async assert(path: string): Promise<void> {
    if (this.closed) { throw unsafe(); }
    const entry = this.entries.get(path);
    if (!entry) { throw unsafe(); }
    if (path !== this.root) { await this.assert(dirname(path)); }
    const [held, named] = await Promise.all([entry.handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (held.dev !== named.dev || held.ino !== named.ino || named.isSymbolicLink()
      || held.uid !== BigInt(process.getuid?.() ?? -1)
      || (entry.directory ? !named.isDirectory() : !named.isFile() || named.nlink !== 1n)) { throw unsafe(); }
  }

  async assertHandle(path: string, acquired: FileHandle): Promise<void> {
    await this.assert(path);
    const [held, opened] = await Promise.all([
      this.entries.get(path)!.handle.stat({ bigint: true }), acquired.stat({ bigint: true }),
    ]);
    if (held.dev !== opened.dev || held.ino !== opened.ino) { throw unsafe(); }
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.assert(path);
    await this.entries.get(path)!.handle.chmod(mode);
  }

  async directory(path: string, mode = 0o755): Promise<void> {
    if (this.entries.has(path)) { await this.assert(path); return; }
    await this.assert(dirname(path));
    await mkdir(path, { mode: 0o700 });
    await this.retain(path, true);
    await this.entries.get(path)!.handle.chmod(mode);
  }

  async file(path: string, acquired: FileHandle): Promise<void> {
    await this.assert(dirname(path));
    await this.retain(path, false, acquired);
  }

  private async retain(path: string, directory: boolean, acquired?: FileHandle): Promise<void> {
    if (this.closed || this.entries.has(path)) { throw unsafe(); }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
    this.entries.set(path, { handle, directory });
    if (acquired) {
      const [original, held] = await Promise.all([acquired.stat({ bigint: true }), handle.stat({ bigint: true })]);
      if (original.dev !== held.dev || original.ino !== held.ino) {
        this.entries.delete(path);
        await handle.close();
        throw unsafe();
      }
    }
    await this.assert(path);
  }

  private async assertDirectoryMembership(path: string): Promise<void> {
    for (const name of await readdir(path)) {
      if (!this.entries.has(`${path}/${name}`)) { throw unsafe(); }
    }
  }

  async cleanup(): Promise<void> {
    if (this.closed) { throw unsafe(); }
    const failures: unknown[] = [];
    try {
      // Validate the complete known tree and membership before changing modes.
      for (const [path, entry] of this.entries) {
        await this.assert(path);
        if (entry.directory) {
          await this.assertDirectoryMembership(path);
        }
      }
      for (const [path, entry] of this.entries) {
        if (entry.directory) { await this.assert(path); await entry.handle.chmod(0o700); }
      }
      for (const [path, entry] of [...this.entries].toReversed()) {
        await this.assert(path);
        if (entry.directory) { await rmdir(path); } else { await unlink(path); }
      }
    } catch (cause) { failures.push(cause); }
    finally {
      this.closed = true;
      for (const { handle } of this.entries.values()) {
        try { await handle.close(); } catch (cause) { failures.push(cause); }
      }
    }
    if (failures.length !== 0) {
      const failure = unsafe();
      failure.cause = new AggregateError(failures, "scratch cleanup failures");
      throw failure;
    }
  }
}

function unsafe(): SlitherGateError {
  return new SlitherGateError("TEMP_ROOT_INVALID", "scratch custody or cleanup is unconfirmed; unknown entries are preserved");
}

export async function finalizeScratch(custody: ScratchCustody, primaryFailures: readonly unknown[]): Promise<void> {
  try { await custody.cleanup(); }
  catch (cleanup) {
    if (primaryFailures.length !== 0) { throw new AggregateError([...primaryFailures, cleanup], "analysis and scratch cleanup failed", { cause: cleanup }); }
    throw cleanup;
  }
}
