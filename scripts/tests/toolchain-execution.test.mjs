import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
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
      // A failed file closes locally before the previously acquired files.
      if (fault.acquisitionWrite) {
        const [npmrc, globalrc, status] = injection.files;
        assert.deepEqual(injection.calls, [status.fd, npmrc.fd, globalrc.fd]);
      } else { assert.deepEqual(injection.calls, injection.files.map(({ fd }) => fd)); }
      for (const file of injection.files) {
        if (fault.close && file.path.endsWith(`/${fault.closeLeaf ?? "supervisor-status"}`)) {
          const current = fs.fstatSync(file.fd);
          if (fault.close === "before") {
            assert.equal(current.dev, file.identity.dev);
            assert.equal(current.ino, file.identity.ino);
          } else { assert.ok(current.isCharacterDevice(), "do not retry consumed/reused FD"); }
        } else { assert.throws(() => fs.fstatSync(file.fd), { code: "EBADF" }); }
      }
      assert.ok(fs.existsSync(injection.root), "retain partial directory custody");
    } finally { injection.release(); }
  });
}

// Execute the actual private acquisition code with two real authenticated files;
// public entrypoints currently supply only one Darwin snapshot.
const source = fs.readFileSync(new URL("../toolchain-execution.mjs", import.meta.url), "utf8");
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
      const snapshot = injection.files.find((file) => file.path.endsWith("/first.mjs"));
      assert.equal(injection.calls.filter((value) => value === snapshot.fd).length, 2,
        "snapshot writer and authenticated reader each close once");
      assert.throws(() => fs.fstatSync(snapshot.fd), { code: "EBADF" });
      for (const file of injection.files.slice(0, 3)) {
        assert.equal(injection.calls.filter((value) => value === file.fd).length, 1);
        assert.throws(() => fs.fstatSync(file.fd), { code: "EBADF" });
      }
      if (fault.close) {
        const failed = injection.files.at(-1);
        assert.equal(injection.calls.filter((value) => value === failed.fd).length, 1);
        assert.ok(fs.fstatSync(failed.fd).isCharacterDevice());
      }
    } finally { fs.closeSync(fd); injection.release(); }
  });
}
