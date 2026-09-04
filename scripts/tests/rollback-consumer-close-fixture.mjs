import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { assertCustodyDescriptor } from "../rollback/runtime/custody.mjs";
import { setDescriptorCloseImplementationForTest } from "../rollback/runtime/descriptor-close.mjs";

// Observe both legacy raw closes and the managed boundary so the regressions
// exercise the actual pre-fix consumers as well as their migrated versions.
export function observeConsumerDescriptors(options = {}) {
  const native = Object.fromEntries(
    ["openSync", "closeSync", "fstatSync", "readSync", "readFileSync"].map((key) => [key, fs[key]]),
  );
  const state = { records: [], active: new Map(), reused: [], closeErrors: [], primaryInjected: false };
  fs.openSync = (path, ...arguments_) => {
    const descriptor = native.openSync(path, ...arguments_);
    const canonical = fs.realpathSync(path);
    const record = {
      descriptor,
      path: canonical,
      requestedPath: String(path),
      occurrence: state.records.filter((entry) => entry.path === canonical).length + 1,
      identity: native.fstatSync(descriptor, { bigint: true }),
      statCalls: 0,
      closeCalls: 0,
    };
    state.records.push(record);
    state.active.set(descriptor, record);
    return descriptor;
  };
  const close = (descriptor) => {
    const record = state.active.get(descriptor);
    if (record !== undefined) {
      record.closeCalls += 1;
      state.active.delete(descriptor);
    }
    native.closeSync(descriptor);
    if (record !== undefined && options.closeTarget?.(record, state)) {
      const lower = [];
      let reused;
      do {
        reused = native.openSync("/dev/null", fs.constants.O_RDONLY);
        if (reused < descriptor) { lower.push(reused); }
      } while (reused < descriptor);
      for (const entry of lower) { native.closeSync(entry); }
      assert.equal(reused, descriptor);
      state.reused.push(reused);
      const error = Object.assign(new Error("injected consumer close after reuse"), { code: "EINTR" });
      state.closeErrors.push(error);
      throw error;
    }
  };
  fs.closeSync = close;
  fs.fstatSync = (descriptor, ...arguments_) => {
    const record = state.active.get(descriptor);
    if (record !== undefined) {
      record.statCalls += 1;
      options.beforeStat?.(record, state);
    }
    return native.fstatSync(descriptor, ...arguments_);
  };
  for (const key of ["readSync", "readFileSync"]) {
    fs[key] = (descriptor, ...arguments_) => {
      const record = state.active.get(descriptor);
      if (record !== undefined) { options.beforeRead?.(record, state); }
      return native[key](descriptor, ...arguments_);
    };
  }
  syncBuiltinESMExports();
  const restoreManaged = setDescriptorCloseImplementationForTest(close);
  let restored = false;
  return {
    state,
    restore() {
      if (restored) { return; }
      restored = true;
      restoreManaged();
      Object.assign(fs, native);
      syncBuiltinESMExports();
    },
    assertReleased() {
      assert.ok(state.records.length > 0);
      for (const record of state.records) {
        assert.equal(record.closeCalls, 1, `close count: ${record.path} #${record.occurrence}`);
        assert.throws(() => assertCustodyDescriptor(record.descriptor), {
          message: "ROLLBACK_CUSTODY_DESCRIPTOR_UNREGISTERED",
        });
      }
      for (const descriptor of state.reused) {
        assert.doesNotThrow(() => native.fstatSync(descriptor));
      }
      assert.equal(state.active.size, 0);
    },
    cleanupLeakedTestDescriptors() {
      // Only fixtures owned by this observer; never close a replaced FD.
      for (const [descriptor, record] of state.active) {
        let identity;
        try { identity = native.fstatSync(descriptor, { bigint: true }); } catch { continue; }
        if (identity.dev === record.identity.dev && identity.ino === record.identity.ino) {
          native.closeSync(descriptor);
        }
      }
      for (const descriptor of state.reused) {
        try { native.fstatSync(descriptor); } catch { continue; }
        native.closeSync(descriptor);
      }
    },
  };
}
