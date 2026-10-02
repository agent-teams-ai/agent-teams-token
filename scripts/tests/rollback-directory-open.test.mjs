import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDirectoryDescriptor } from "../rollback/runtime/common.mjs";
import {
  assertCustodyDescriptor,
  closeCustodyDescriptor,
} from "../rollback/runtime/custody.mjs";
import { injectedUncertainClose } from "./rollback-descriptor-close-fixture.mjs";

function installAcquisitionFault(root, boundary) {
  const original = {
    open: fs.openSync,
    stat: fs.fstatSync,
    realpath: fs.realpathSync,
  };
  const failure = new Error("injected directory acquisition failure: " + boundary);
  let descriptor;
  let injected = false;
  fs.openSync = (path, ...arguments_) => {
    const opened = original.open(path, ...arguments_);
    if (path === root) { descriptor = opened; }
    return opened;
  };
  fs.fstatSync = (opened, ...arguments_) => {
    if (opened === descriptor && boundary === "fstat-before") {
      injected = true;
      throw failure;
    }
    const result = original.stat(opened, ...arguments_);
    if (opened === descriptor && boundary === "fstat-after") {
      injected = true;
      throw failure;
    }
    return result;
  };
  fs.realpathSync = (path, ...arguments_) => {
    if (path === root && boundary === "realpath-before") {
      injected = true;
      throw failure;
    }
    const result = original.realpath(path, ...arguments_);
    if (path === root && boundary === "realpath-after") {
      injected = true;
      throw failure;
    }
    if (path === root && boundary === "registration") {
      injected = true;
      return "invalid-relative-custody-path";
    }
    return result;
  };
  syncBuiltinESMExports();
  return {
    descriptor: () => descriptor,
    injected: () => injected,
    failure,
    restore() {
      fs.openSync = original.open;
      fs.fstatSync = original.stat;
      fs.realpathSync = original.realpath;
      syncBuiltinESMExports();
    },
  };
}

function releaseDirectoryFixture(root, fault, injection) {
  fault.restore();
  injection?.restore();
  const reused = injection?.reusedDescriptor();
  const descriptor = fault.descriptor();
  let current;
  try { current = fs.fstatSync(descriptor, { bigint: true }); } catch { /* already closed */ }
  if (current !== undefined) {
    const expected = fs.lstatSync(root, { bigint: true });
    if (current.dev === expected.dev && current.ino === expected.ino) {
      closeCustodyDescriptor(descriptor);
    }
  }
  if (Number.isInteger(reused)) { fs.closeSync(reused); }
  fs.rmSync(root, { recursive: true, force: true });
}

for (const boundary of ["fstat-before", "fstat-after", "realpath-before", "realpath-after", "registration"]) {
  for (const uncertainClose of [false, true]) {
    test(`directory acquisition ${boundary} closes once, uncertain close=${uncertainClose}`, () => {
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agtmai-directory-open-")));
      const fault = installAcquisitionFault(root, boundary);
      const injection = uncertainClose ? injectedUncertainClose(0) : undefined;
      try {
        assert.throws(() => openDirectoryDescriptor(root), (error) => {
          const primary = uncertainClose ? error.errors?.[0] : error;
          if (boundary === "registration") {
            assert.equal(primary.message, "ROLLBACK_CUSTODY_DESCRIPTOR_INVALID");
          } else {
            assert.equal(primary, fault.failure);
          }
          if (uncertainClose) {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.message, "ROLLBACK_DIRECTORY_OPEN_CLOSE_FAILED");
            assert.equal(error.cause, primary);
            assert.equal(error.errors.length, 2);
            assert.equal(error.errors[1].code, "EINTR");
          }
          return true;
        });
        fault.restore();
        assert.equal(fault.injected(), true);
        assert.ok(Number.isInteger(fault.descriptor()));
        if (injection !== undefined) {
          assert.deepEqual(injection.calls, [fault.descriptor()]);
          assert.equal(fs.fstatSync(injection.reusedDescriptor()).isCharacterDevice(), true);
        } else {
          assert.throws(() => fs.fstatSync(fault.descriptor()), { code: "EBADF" });
        }
        assert.throws(() => assertCustodyDescriptor(fault.descriptor()), {
          message: "ROLLBACK_CUSTODY_DESCRIPTOR_UNREGISTERED",
        });
      } finally {
        releaseDirectoryFixture(root, fault, injection);
      }
    });
  }
}

test("directory acquisition preserves EINTR when a competing acquisition occupies the released slot", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agtmai-directory-open-competing-")));
  const competingPath = join(root, "competing.txt");
  fs.writeFileSync(competingPath, "competing descriptor\n");
  const fault = installAcquisitionFault(root, "fstat-after");
  const competingDescriptors = [];
  const injection = injectedUncertainClose((_index, descriptor) => {
    // The selector runs after the real close. Hold only descriptors we open;
    // a runtime acquisition may already own the released numeric slot.
    let competing;
    do {
      competing = fs.openSync(competingPath, fs.constants.O_RDONLY);
      competingDescriptors.push(competing);
    } while (competing < descriptor);
    return true;
  });
  let released = false;
  try {
    assert.throws(() => openDirectoryDescriptor(root), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "ROLLBACK_DIRECTORY_OPEN_CLOSE_FAILED");
      assert.equal(error.cause, fault.failure);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], fault.failure);
      assert.equal(error.errors[1].code, "EINTR");
      return true;
    });
    fault.restore();
    assert.equal(fault.injected(), true);
    assert.deepEqual(injection.calls, [fault.descriptor()]);
    assert.ok(injection.reusedDescriptor() > fault.descriptor());
    assert.equal(fs.fstatSync(injection.reusedDescriptor()).isCharacterDevice(), true);
    assert.throws(() => assertCustodyDescriptor(fault.descriptor()), {
      message: "ROLLBACK_CUSTODY_DESCRIPTOR_UNREGISTERED",
    });
    releaseDirectoryFixture(root, fault, injection);
    released = true;
    for (const descriptor of competingDescriptors) {
      assert.equal(fs.readFileSync(descriptor, "utf8"), "competing descriptor\n");
    }
  } finally {
    try {
      if (!released) { releaseDirectoryFixture(root, fault, injection); }
    } finally {
      for (const descriptor of competingDescriptors) { fs.closeSync(descriptor); }
    }
  }
});

test("successful directory acquisition transfers a registered open descriptor", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agtmai-directory-open-success-")));
  let descriptor;
  try {
    descriptor = openDirectoryDescriptor(root);
    assert.equal(fs.fstatSync(descriptor).isDirectory(), true);
    assert.doesNotThrow(() => assertCustodyDescriptor(descriptor));
  } finally {
    if (Number.isInteger(descriptor)) { closeCustodyDescriptor(descriptor); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
