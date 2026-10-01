import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cases = [
  {
    name: "tool snapshot",
    setup: 'const fifo = join(root, "tool");',
    action: "stableRead(fifo)",
    diagnostic: "SOLANA_TOOL_MISSING",
  },
  {
    name: "lease cleanup",
    setup: `const store = new PrivateRunStore(join(root, "runs"), join(root, "output"));
      const paths = await store.create();
      const fifo = join(paths.directory, ".agtmai-local-solana-lease.json");
      unlinkSync(fifo);`,
    action: "store.cleanup(paths)",
    diagnostic: "SOLANA_LEASE_UNSAFE",
  },
  {
    name: "startup custody",
    setup: 'const fifo = join(root, ".agtmai-validator-startup.json");',
    action: 'startupCustodySettled(root, "test-token")',
    diagnostic: "SOLANA_STARTUP_CUSTODY",
  },
];

for (const entry of cases) {
  test(`${entry.name} rejects a writerless FIFO without hanging or removing it`, () => {
    const root = mkdtempSync(join(tmpdir(), "agtmai-solana-fifo-"));
    const source = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { lstatSync, unlinkSync } from "node:fs";
      import { join } from "node:path";
      import { stableRead } from ${JSON.stringify(new URL("../src/adapters/tool-snapshots.ts", import.meta.url).href)};
      import { PrivateRunStore } from ${JSON.stringify(new URL("../src/adapters/filesystem.ts", import.meta.url).href)};
      import { startupCustodySettled } from ${JSON.stringify(new URL("../src/adapters/startup-custody.ts", import.meta.url).href)};
      const root = process.argv[1];
      ${entry.setup}
      execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
      const identity = lstatSync(fifo);
      assert.equal(identity.isFIFO(), true);
      console.log("admitting writerless FIFO");
      await assert.rejects(() => ${entry.action}, /${entry.diagnostic}/u);
      const retained = lstatSync(fifo);
      assert.equal(retained.isFIFO(), true);
      assert.equal(retained.ino, identity.ino);
      assert.equal(retained.dev, identity.dev);
      console.log("rejected and preserved");
    `;
    // The outer process can kill even a child blocked in a synchronous syscall
    // or an asynchronous open whose libuv worker cannot be cancelled.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
      encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL",
    });
    const diagnostic = JSON.stringify({status: result.status, signal: result.signal,
      error: (result.error as NodeJS.ErrnoException | undefined)?.code, stdout: result.stdout, stderr: result.stderr});
    try {
      assert.equal(result.signal, null, diagnostic);
      assert.equal(result.status, 0, diagnostic);
      assert.match(result.stdout, /admitting writerless FIFO\nrejected and preserved/u);
    } finally {
      if (typeof result.status === "number" || typeof result.signal === "string") {
        rmSync(root, { recursive: true, force: true });
      } else { console.error(`FIFO fixture preserved: ${root}`); }
    }
  });
}
