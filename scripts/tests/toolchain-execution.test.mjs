import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeSupervisedCommand } from "../toolchain-execution.mjs";
import { invocationFault } from "./toolchain-invocation-fault-fixture.mjs";

// Observed failures: earlier acquisitions stay open, cleanup errors disappear,
// and a failed acquisition's own close masks its primary error.
for (const fault of [
  { acquisition: "npm-globalrc" },
  { acquisition: "supervisor-status" },
  { acquisition: "supervisor-status", close: "before", closeLeaf: "npmrc" },
  { acquisition: "supervisor-status", close: "after", closeLeaf: "npmrc" },
  { acquisitionWrite: "supervisor-status", close: "before" },
  { acquisitionWrite: "supervisor-status", close: "after" },
]) {
  test(`partial invocation acquisition ${JSON.stringify(fault)}`, () => {
    const injection = invocationFault(fault);
    try {
      let failure;
      try { executeSupervisedCommand({ command: process.execPath, env: {} }); }
      catch (error) { failure = error; }
      assert.ok(failure);
      if (fault.close) {
        assert.equal(failure.cause, injection.failures[0], "preserve acquisition primary");
        assert.deepEqual(failure.errors, injection.failures, "ordered acquisition and close causes");
      } else { assert.equal(failure, injection.failures[0]); }
      injection.assertCloses();
      assert.ok(fs.existsSync(injection.root), "retain partial directory custody");
    } finally { injection.release(); }
  });
}

// Execute the actual private acquisition code with two real authenticated files;
// public entrypoints currently supply only one Darwin snapshot.
const sourceUrl = new URL("../toolchain-execution.mjs", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8").replace(
  /from "(\.[^"]+)"/gu,
  (_match, specifier) => `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`,
);
const { createInvocation } = await import(`data:text/javascript;base64,${Buffer.from(
  source + "\nexport { createInvocation };\n",
).toString("base64")}`);
for (const fault of [
  { acquisition: "second.mjs" },
  { acquisitionWrite: "second.mjs", close: "after", closeLeaf: "second.mjs" },
]) {
  test(`partial Darwin snapshot acquisition ${JSON.stringify(fault)}`, () => {
    const injection = invocationFault(fault);
    const fd = fs.openSync(new URL(import.meta.url), "r");
    const opened = { fd, identity: fs.fstatSync(fd),
      expectedHash: createHash("sha256").update(fs.readFileSync(fd)).digest("hex") };
    try {
      let failure;
      try {
        createInvocation(["first.mjs", "second.mjs"].map((leaf) => ({
          leaf, opened, expectedHash: opened.expectedHash, snapshotOnDarwin: true,
        })), "darwin");
      } catch (error) { failure = error; }
      if (fault.close) {
        assert.equal(failure.cause, injection.failures[0]);
        assert.deepEqual(failure.errors, injection.failures);
      } else { assert.equal(failure, injection.failures[0]); }
      const snapshots = injection.acquisitions.filter((file) => file.path.endsWith("/first.mjs"));
      assert.equal(snapshots.length, 2, "separate snapshot writer and authenticated reader acquisitions");
      const [writer, reader] = snapshots;
      assert.notEqual(writer.flags & fs.constants.O_CREAT, 0);
      assert.equal(reader.flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), fs.constants.O_RDONLY);
      assert.equal(reader.identity.dev, writer.identity.dev);
      assert.equal(reader.identity.ino, writer.identity.ino);
      injection.assertCloses();
    } finally { fs.closeSync(fd); injection.release(); }
  });
}

test("native stdio preserves inherited destinations, ignored sinks and caller FD ownership", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "agtmai-stdio-test-"));
  const paths = ["foreign-stdout", "foreign-stderr", "caller-stdout"].map((leaf) => join(root, leaf));
  const fds = [];
  try {
    for (const path of paths) {fds.push(fs.openSync(path, "w+"));}
    fs.writeSync(fds[0], "foreign stdout\n");
    fs.writeSync(fds[1], "foreign stderr\n");
    const script = join(root, "writer.mjs");
    fs.writeFileSync(script, `import { writeSync } from "node:fs";
      writeSync(1, process.argv[2] + "-stdout\\n");
      writeSync(2, process.argv[2] + "-stderr\\n");\n`);
    const program = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { createHash } from "node:crypto";
      import { executeOpenedNode, executeSupervisedCommand } from ${JSON.stringify(sourceUrl.href)};
      const script = ${JSON.stringify(script)};
      const digest = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
      const before = [3, 4, 5].map(fd => fs.fstatSync(fd));
      assert.equal(executeOpenedNode({
        node: { path: process.execPath, sha256: digest(process.execPath) },
        script: { path: script, sha256: digest(script) }, args: ["inherited"],
        stdio: "inherit", timeoutMs: 5000,
      }), 0);
      for (const [label, stdio] of [
        ["ignored", ["ignore", "ignore", "ignore"]],
        ["caller", ["ignore", 5, "ignore"]],
      ]) {
        const result = executeSupervisedCommand({
          command: process.execPath, args: [script, label], env: {}, stdio, timeoutMs: 5000,
        });
        assert.equal(result.status, 0);
        assert.equal(result.error, undefined);
        assert.equal(result.stdout, null);
        assert.equal(result.stderr, null);
        assert.equal(result.targetStatus.quiescent, true);
        assert.equal(result.custody, "completed");
        assert.equal(result.uncertainty, null);
      }
      for (const [index, fd] of [3, 4, 5].entries()) {
        const after = fs.fstatSync(fd);
        assert.equal(after.dev, before[index].dev);
        assert.equal(after.ino, before[index].ino);
      }
      fs.writeSync(5, "caller-still-open\\n");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env: {}, encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe", ...fds],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "inherited-stdout\n");
    assert.equal(result.stderr, "inherited-stderr\n");
    assert.equal(fs.readFileSync(paths[0], "utf8"), "foreign stdout\n");
    assert.equal(fs.readFileSync(paths[1], "utf8"), "foreign stderr\n");
    assert.equal(fs.readFileSync(paths[2], "utf8"), "caller-stdout\ncaller-still-open\n");
  } finally {
    for (const fd of fds) {fs.closeSync(fd);}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignored sink acquisition preserves primary and consumed-close causes without retrying a reused FD", () => {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const acquisition = Object.assign(new Error("injected second sink acquisition"), { code: "EIO" });
  const close = Object.assign(new Error("injected consumed sink close"), { code: "EIO" });
  let opens = 0;
  let sink;
  let reused;
  let closes = 0;
  fs.openSync = (path, ...args) => {
    if (path === "/dev/null") {
      if (++opens === 2) {throw acquisition;}
      sink = originalOpen(path, ...args);
      return sink;
    }
    return originalOpen(path, ...args);
  };
  fs.closeSync = (fd) => {
    if (fd !== sink) {return originalClose(fd);}
    closes++;
    originalClose(fd);
    const lower = [];
    do {
      reused = originalOpen("/dev/null", fs.constants.O_WRONLY);
      if (reused < fd) {lower.push(reused);}
    } while (reused < fd);
    for (const descriptor of lower) {originalClose(descriptor);}
    assert.equal(reused, fd);
    throw close;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => executeSupervisedCommand({
      command: process.execPath, env: {}, stdio: ["ignore", "ignore", "ignore"],
    }), (error) => {
      assert.equal(error.cause, acquisition);
      assert.deepEqual(error.errors, [acquisition, close]);
      assert.deepEqual(error.execution, { launched: false, quiescent: true });
      assert.equal(Object.hasOwn(error, "result"), false);
      return true;
    });
    assert.equal(opens, 2);
    assert.equal(closes, 1, "one attempt for the consumed sink; no close of its successor");
    assert.ok(fs.fstatSync(reused).isCharacterDevice());
    assert.equal(fs.writeSync(reused, "caller successor"), 16);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
    if (reused !== undefined) {originalClose(reused);}
  }
});
