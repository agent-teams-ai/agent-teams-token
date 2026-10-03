import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const boundary of ["READY", "copy substitution"]) {
  test(`publication ${boundary} rejects a writerless FIFO before publishing success`, () => {
    const root = mkdtempSync(join(tmpdir(), "agtmai-slither-fifo-"));
    const source = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { lstatSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { ExclusiveDirectoryPublication, copyStableExclusive } from ${JSON.stringify(new URL("../src/adapters/evidence.ts", import.meta.url).href)};
      const root = process.argv[1];
      const staging = join(root, "staging"); const output = join(root, "output");
      mkdirSync(staging, {mode: 0o700});
      const fifo = join(staging, ${JSON.stringify(boundary === "READY" ? "READY" : "evidence.json")});
      const replace = () => execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
      ${boundary === "READY" ? "replace();" : `
        writeFileSync(fifo, "authenticated", {mode: 0o600});
        const originalOpen = fs.open;
        fs.open = async (...args) => {
          if (args[0] === fifo) { unlinkSync(fifo); replace(); }
          return originalOpen(...args);
        };
        syncBuiltinESMExports();
      `}
      console.log("admitting writerless FIFO");
      await assert.rejects(() => ${boundary === "READY"
        ? 'new ExclusiveDirectoryPublication().publishNoReplace(staging, output, ["READY"])'
        : 'copyStableExclusive(fifo, join(output, "evidence.json"))'}, {code: "PUBLICATION_UNAVAILABLE"});
      assert.equal(lstatSync(fifo).isFIFO(), true);
      assert.equal(existsSync(join(output, "READY")), false);
      ${boundary === "copy substitution" ? 'assert.equal(existsSync(output), false);' : ""}
      console.log("rejected without success");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
      encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL",
    });
    const diagnostic = JSON.stringify({status: result.status, signal: result.signal,
      error: (result.error as NodeJS.ErrnoException | undefined)?.code, stdout: result.stdout, stderr: result.stderr});
    try {
      assert.equal(result.signal, null, diagnostic);
      assert.equal(result.status, 0, diagnostic);
      assert.match(result.stdout, /admitting writerless FIFO\nrejected without success/u);
    } finally {
      if (typeof result.status === "number" || typeof result.signal === "string") {
        rmSync(root, { recursive: true, force: true });
      } else { console.error(`FIFO fixture preserved: ${root}`); }
    }
  });
}
