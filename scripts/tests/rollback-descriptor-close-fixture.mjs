import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
} from "node:fs";

import {
  setDescriptorCloseImplementationForTest,
} from "../rollback/runtime/descriptor-close.mjs";

export function injectedUncertainClose(failureSelector) {
  const calls = [];
  let reusedDescriptor;
  let invocation = 0;
  const restore = setDescriptorCloseImplementationForTest((descriptor) => {
    const current = invocation;
    invocation += 1;
    calls.push(descriptor);
    closeSync(descriptor);
    const fail = typeof failureSelector === "function"
      ? failureSelector(current, descriptor)
      : current === failureSelector;
    if (fail) {
      // Earlier closes may have released lower descriptor numbers. Occupy
      // those holes temporarily to exercise exact FD reuse when available.
      // A runtime acquisition can own the released slot; retain only the FD
      // we actually open, without asserting ownership of that competing FD.
      const lowerDescriptors = [];
      do {
        reusedDescriptor = openSync("/dev/null", constants.O_RDONLY);
        if (reusedDescriptor < descriptor) {
          lowerDescriptors.push(reusedDescriptor);
        }
      } while (reusedDescriptor < descriptor);
      for (const lower of lowerDescriptors) {
        closeSync(lower);
      }
      const error = new Error("injected uncertain close");
      error.code = "EINTR";
      throw error;
    }
  });
  return {
    calls,
    restore,
    reusedDescriptor() {
      return reusedDescriptor;
    },
  };
}

export function assertOtherDescriptorsClosed(descriptors, reusedDescriptor) {
  for (const descriptor of descriptors) {
    if (descriptor !== reusedDescriptor) {
      assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
    }
  }
}
