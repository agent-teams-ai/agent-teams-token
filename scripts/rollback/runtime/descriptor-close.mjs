import { closeSync } from "node:fs";

let closeDescriptorImplementation = closeSync;
const descriptorCloseAggregates = new WeakSet();

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
  let cause = primaryFailure;
  let errors = failures;
  if (primaryFailure !== undefined) {
    if (descriptorCloseAggregates.has(primaryFailure)) {
      cause = primaryFailure.cause ?? primaryFailure;
      errors = [...primaryFailure.errors, ...failures];
    } else {
      errors = [primaryFailure, ...failures];
    }
  }
  const aggregate = new AggregateError(
    errors,
    message,
    cause === undefined ? undefined : { cause },
  );
  descriptorCloseAggregates.add(aggregate);
  throw aggregate;
}
