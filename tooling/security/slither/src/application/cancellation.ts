import type { ProcessResult } from "./ports.ts";

/** An interruption is sticky; cleanup may add causes, but cannot replace it. */
export class SlitherCancellation extends Error {
  readonly code = "SLITHER_CANCELLED";
  readonly exitCode: number;
  readonly signalName: "SIGINT" | "SIGTERM";

  constructor(signalName: "SIGINT" | "SIGTERM") {
    super(`SLITHER_CANCELLED: ${signalName}`);
    this.signalName = signalName;
    this.exitCode = signalName === "SIGINT" ? 130 : 143;
  }
}

export function assertNotCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Finalization consumes the original deadline; cancellation never extends it. */
export const CANCELLATION_FINALIZATION_MS = 60_000;

/** Bounded captured bytes survive a process cleanup error for exact-ID custody. */
export class ProcessFailure extends AggregateError {
  readonly result: ProcessResult;
  readonly stdoutComplete: boolean;

  constructor(errors: readonly unknown[], result: ProcessResult, stdoutComplete: boolean) {
    super(errors, errors.length === 1 && errors[0] instanceof Error ? errors[0].message : "PROCESS_FAILED: execution and cleanup errors");
    this.result = result;
    this.stdoutComplete = stdoutComplete;
  }
}
