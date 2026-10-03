import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cases = [
  { name: "verified bytes", action: "readVerifiedBytes(fifo)", diagnostic: "TOOLCHAIN_FILE_IDENTITY_INVALID" },
  { name: "verified executable", action: 'executeVerifiedFile({path: fifo, expectedSha256: "0".repeat(64)})', diagnostic: "TOOLCHAIN_FILE_IDENTITY_INVALID" },
  { name: "verified archive", action: "prepareVerifiedPayload(request)", diagnostic: "TOOLCHAIN_ARCHIVE_UNSAFE" },
  { name: "archive snapshot substitution", action: "prepareVerifiedPayload(request)", diagnostic: "TOOLCHAIN_ARCHIVE_SNAPSHOT_UNVERIFIED", snapshot: true },
];

export function registerToolchainFifoTests() {
for (const entry of cases) {
  test(`${entry.name} rejects a writerless FIFO before reading or executing it`, () => {
    const root = mkdtempSync(join(tmpdir(), "agtmai-toolchain-fifo-"));
    const source = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import fs from "node:fs";
      import { createHash } from "node:crypto";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { readVerifiedBytes } from ${JSON.stringify(new URL("../toolchain-files.mjs", import.meta.url).href)};
      import { executeVerifiedFile } from ${JSON.stringify(new URL("../toolchain-execution.mjs", import.meta.url).href)};
      import { prepareVerifiedPayload } from ${JSON.stringify(new URL("../toolchain-archive.mjs", import.meta.url).href)};
      const root = process.argv[1];
      const fifo = join(root, "input");
      const bytes = Buffer.from("authenticated bytes");
      const request = {name: "fixture", platform: "linux-x64", archive: fifo, toolsRoot: root,
        missingCode: "TEST_MISSING", artifact: {archive: "executable", expectedFiles: ["tool"],
          sha256: createHash("sha256").update(bytes).digest("hex")}};
      ${entry.snapshot ? `
        fs.writeFileSync(fifo, bytes);
        const originalOpen = fs.openSync;
        fs.openSync = (...args) => {
          if (String(args[0]).endsWith("/.archive-snapshot") && fs.existsSync(args[0])) {
            fs.unlinkSync(args[0]);
            execFileSync("/usr/bin/mkfifo", ["-m", "600", args[0]]);
          }
          return originalOpen(...args);
        };
        syncBuiltinESMExports();
      ` : 'execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]); assert.equal(fs.lstatSync(fifo).isFIFO(), true);'}
      console.log("admitting writerless FIFO");
      assert.throws(() => ${entry.action}, ${entry.snapshot
        ? `(error) => {
            assert.equal(error.message, "TOOLCHAIN_PREPARATION_FAILED");
            assert.equal(error.cause.message, "TOOLCHAIN_ARCHIVE_SNAPSHOT_UNVERIFIED");
            assert.match(error.errors[1].message, /ROLLBACK_CLEANUP_ENTRY_TYPE_UNSAFE/u);
            return true;
          }`
        : `/${entry.diagnostic}/u`});
      ${entry.snapshot ? "" : 'assert.equal(fs.lstatSync(fifo).isFIFO(), true);'}
      ${entry.snapshot ? `
        const stages = fs.readdirSync(root).filter((name) => name.startsWith(".install-part-"));
        assert.equal(stages.length, 1);
        const payload = join(root, stages[0], "payload");
        assert.deepEqual(fs.readdirSync(payload), [".archive-snapshot"]);
        assert.equal(fs.lstatSync(join(payload, ".archive-snapshot")).isFIFO(), true);
      ` : 'assert.deepEqual(fs.readdirSync(root), ["input"]);'}
      console.log("rejected without payload or invocation");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
      encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
    });
    const diagnostic = JSON.stringify({status: result.status, signal: result.signal,
      error: result.error?.code, stdout: result.stdout, stderr: result.stderr});
    try {
      assert.equal(result.signal, null, diagnostic);
      assert.equal(result.status, 0, diagnostic);
      assert.match(result.stdout, /admitting writerless FIFO\nrejected without payload or invocation/u);
    } finally {
      if (typeof result.status === "number" || typeof result.signal === "string") {
        rmSync(root, { recursive: true, force: true });
      } else { console.error(`FIFO fixture preserved: ${root}`); }
    }
  });
}

for (const boundary of ["invocation file", "environment tree"]) {
  test(`${boundary} FIFO substitution rejects cleanup and retains uncertain custody`, () => {
    const root = mkdtempSync(join(tmpdir(), "agtmai-invocation-fifo-"));
    const source = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import fs from "node:fs";
      import { createHash } from "node:crypto";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { executeVerifiedFile } from ${JSON.stringify(new URL("../toolchain-execution.mjs", import.meta.url).href)};
      const root = process.argv[1];
      const path = join(root, "tool");
      const bytes = '#!/bin/sh\\nprintf authenticated > "$XDG_CACHE_HOME/probe"\\n';
      fs.writeFileSync(path, bytes, {mode: 0o700});
      const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
      let fifo; let identity;
      const replace = (path) => {
        fifo = path;
        fs.unlinkSync(path);
        execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
        identity = fs.lstatSync(path);
        console.log("admitting writerless FIFO");
      };
      ${boundary === "invocation file" ? `
        const originalOpen = fs.openSync;
        fs.openSync = (...args) => {
          if (String(args[0]).endsWith("/npmrc") && args[1] !== undefined
            && (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === fs.constants.O_RDONLY && !fifo) {
            replace(args[0]);
          }
          return originalOpen(...args);
        };
      ` : `
        const originalStat = fs.lstatSync;
        fs.lstatSync = (...args) => {
          const stat = originalStat(...args);
          if (String(args[0]).endsWith("/cache/probe") && stat.isFile() && !fifo) {
            replace(args[0]);
          }
          return stat;
        };
      `}
      syncBuiltinESMExports();
      assert.throws(() => executeVerifiedFile({path, expectedSha256}), /TOOLCHAIN_INVOCATION_CLEANUP_UNCERTAIN/u);
      assert.equal(typeof fifo, "string");
      const retained = fs.lstatSync(fifo);
      assert.equal(retained.isFIFO(), true);
      assert.equal(retained.ino, identity.ino);
      assert.equal(retained.dev, identity.dev);
      console.log("rejected and retained custody");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
      encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", env: {...process.env, TMPDIR: root},
    });
    const diagnostic = JSON.stringify({status: result.status, signal: result.signal,
      error: result.error?.code, stdout: result.stdout, stderr: result.stderr});
    try {
      assert.equal(result.signal, null, diagnostic);
      assert.equal(result.status, 0, diagnostic);
      assert.match(result.stdout, /admitting writerless FIFO\nrejected and retained custody/u);
    } finally {
      if (typeof result.status === "number" || typeof result.signal === "string") {
        rmSync(root, { recursive: true, force: true });
      } else { console.error(`FIFO fixture preserved: ${root}`); }
    }
  });
}

}
