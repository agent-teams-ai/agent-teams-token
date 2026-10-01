import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

// Observe actual owned files, not descriptor numbers which can be reused.
export function invocationFault({ cleanup = false, close, acquisition, acquisitionWrite, exhaust = false,
  closeLeaf = "supervisor-status" } = {}) {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalChmod = fs.fchmodSync;
  const fillers = [];
  const files = [];
  const acquisitions = [];
  const active = new Map();
  const calls = [];
  const failures = [];
  let root;
  let reused;
  let uncertain;
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
    if (acquisition && String(path).endsWith(`/${acquisition}`)) { fail(`${acquisition} acquisition`); }
    const fd = originalOpen(path, flags, ...args);
    if (typeof path === "string" && /\/agtmai-toolchain-exec-[^/]+\/[^/]+$/u.test(path)) {
      root = dirname(path);
      const acquired = { fd, path, flags, identity: fs.fstatSync(fd) };
      acquisitions.push(acquired);
      active.set(fd, acquired);
      if ((flags & fs.constants.O_CREAT) !== 0) { files.push(acquired); }
      if (exhaust && path.endsWith("/npmrc") && (flags & fs.constants.O_CREAT) !== 0) {
        try { while (true) { fillers.push(originalOpen("/dev/null", fs.constants.O_RDONLY)); } }
        catch (error) { assert.equal(error.code, "EMFILE"); }
      }
    }
    return fd;
  };
  fs.fchmodSync = (fd, mode) => {
    if (files.find((file) => file.fd === fd)?.path.endsWith(`/${acquisitionWrite}`)) {
      fail(`${acquisitionWrite} acquisition write`);
    }
    return originalChmod(fd, mode);
  };
  fs.closeSync = (fd) => {
    const current = fs.fstatSync(fd);
    const file = files.find((entry) => entry.fd === fd
      && entry.identity.dev === current.dev && entry.identity.ino === current.ino);
    if (active.has(fd) || fd === reused) { calls.push(active.get(fd)); }
    if (close && !injected && file?.path.endsWith(`/${closeLeaf}`)) {
      injected = true;
      uncertain = active.get(fd);
      if (!cleanup && !acquisition && !acquisitionWrite && !exhaust) {
        assert.equal(current.nlink, 0, "owned status file was unlinked before close");
      }
      if (close === "after") {
        originalClose(fd);
        active.delete(fd);
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
    const result = originalClose(fd);
    active.delete(fd);
    return result;
  };
  syncBuiltinESMExports();
  return {
    files, acquisitions, calls, failures,
    get root() { return root; },
    assertCloses() {
      assert.equal(calls.length, acquisitions.length, "no close of a consumed/reused FD");
      for (const acquired of acquisitions) {
        assert.equal(calls.filter((called) => called === acquired).length, 1,
          `attempt each owned acquisition close exactly once: ${acquired.path}`);
      }
      for (const file of acquisitions) {
        if (file === uncertain) {
          const current = fs.fstatSync(file.fd);
          if (close === "before") {
            assert.equal(current.ino, file.identity.ino, "failed close left the original FD open");
            assert.equal(current.dev, file.identity.dev);
          } else {
            assert.ok(current.isCharacterDevice(), "uncertain close must not retry the reused FD");
          }
        } else {
          assert.notEqual(active.get(file.fd), file, "successful close released this acquisition");
          let current;
          try { current = fs.fstatSync(file.fd); }
          catch (error) { assert.equal(error.code, "EBADF"); continue; }
          assert.ok(current.dev !== file.identity.dev || current.ino !== file.identity.ino,
            "closed acquisition must not retain its original file identity");
        }
      }
    },
    release() {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
      fs.fchmodSync = originalChmod;
      syncBuiltinESMExports();
      for (const fd of fillers) { originalClose(fd); }
      // Fixture-only recovery: close only the independently verified identity.
      for (const file of acquisitions) {
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
