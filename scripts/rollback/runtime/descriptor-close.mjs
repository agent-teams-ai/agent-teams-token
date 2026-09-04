import { closeSync } from "node:fs";

let closeDescriptorImplementation = closeSync;

export function closeDescriptorOnce(descriptor) {
  closeDescriptorImplementation(descriptor);
}

export function setDescriptorCloseImplementationForTest(implementation) {
  if (typeof implementation !== "function") {
    throw new Error("ROLLBACK_DESCRIPTOR_CLOSE_IMPLEMENTATION_INVALID");
  }
  const previous = closeDescriptorImplementation;
  closeDescriptorImplementation = implementation;
  let restored = false;
  return () => {
    if (!restored) {
      restored = true;
      closeDescriptorImplementation = previous;
    }
  };
}

export function throwDescriptorCloseFailures(failures, message, primaryFailure) {
  if (failures.length === 0) {
    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
    return;
  }
  throw new AggregateError(
    primaryFailure === undefined ? failures : [primaryFailure, ...failures],
    message,
    primaryFailure === undefined ? undefined : { cause: primaryFailure },
  );
}
