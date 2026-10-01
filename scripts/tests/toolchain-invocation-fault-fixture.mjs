import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

// Observe actual owned files, not descriptor numbers which can be reused.
export function invocationFault({ cleanup = false, close } = {}) {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const files = [];
  const calls = [];
  const failures = [];
  let root;
  let reused;
  let injected = false;
  function fail(label) {
    const error = Object.assign(new Error(`injected ${label}`), { code: "EIO" });
    failures.push(error);
    throw error;
  }
  fs.openSync = (path, flags, ...args) => {
    if (cleanup && path === `${root}/npmrc` && flags === (fs.constants.O_RDONLY
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) {
      fail("npmrc cleanup open");
    }
    const fd = originalOpen(path, flags, ...args);
    if (typeof path === "string" && /\/agtmai-toolchain-exec-[^/]+\/[^/]+$/u.test(path)
      && (flags & fs.constants.O_CREAT) !== 0) {
      root = dirname(path);
      files.push({ fd, path, identity: fs.fstatSync(fd) });
    }
    return fd;
  };
  fs.closeSync = (fd) => {
    const current = fs.fstatSync(fd);
    const file = files.find((entry) => entry.fd === fd
      && entry.identity.dev === current.dev && entry.identity.ino === current.ino);
    if (file || fd === reused) { calls.push(fd); }
    if (close && !injected && file?.path.endsWith("/supervisor-status")) {
      injected = true;
      if (!cleanup) {
        assert.match(fs.readlinkSync(`/proc/self/fd/${fd}`), /\/supervisor-status \(deleted\)$/u);
      }
      if (close === "after") {
        originalClose(fd);
        // Fill lower holes so reuse is proven for this exact descriptor.
        const lower = [];
        do {
          reused = originalOpen("/dev/null", fs.constants.O_RDONLY);
          if (reused < fd) { lower.push(reused); }
        } while (reused < fd);
        for (const descriptor of lower) { originalClose(descriptor); }
        assert.equal(reused, fd);
      }
      fail(`status close ${close}`);
    }
    return originalClose(fd);
  };
  syncBuiltinESMExports();
  return {
    files, calls, failures,
    get root() { return root; },
    assertCloses() {
      assert.deepEqual(calls, files.map(({ fd }) => fd), "attempt every owned close exactly once");
      for (const file of files) {
        if (close && file.path.endsWith("/supervisor-status")) {
          const current = fs.fstatSync(file.fd);
          if (close === "before") {
            assert.equal(current.ino, file.identity.ino, "failed close left the original FD open");
            assert.equal(current.dev, file.identity.dev);
          } else {
            assert.ok(current.isCharacterDevice(), "uncertain close must not retry the reused FD");
          }
        } else {
          assert.throws(() => fs.fstatSync(file.fd), { code: "EBADF" });
        }
      }
    },
    release() {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
      syncBuiltinESMExports();
      // Fixture-only recovery: close only the independently verified identity.
      for (const file of files) {
        let current;
        try { current = fs.fstatSync(file.fd); } catch { continue; }
        if (current.dev === file.identity.dev && current.ino === file.identity.ino) {
          originalClose(file.fd);
        }
      }
      if (reused !== undefined) { originalClose(reused); }
      if (root !== undefined) { fs.rmSync(root, { recursive: true, force: true }); }
    },
  };
}

export function containsFailure(error, expected) {
  return error === expected || (error?.errors ?? []).some((child) => containsFailure(child, expected))
    || (error?.cause !== undefined && containsFailure(error.cause, expected));
}
