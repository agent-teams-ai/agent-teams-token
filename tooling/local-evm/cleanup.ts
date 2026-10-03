const CLEANUP_ERRORS = Symbol("localEvmCleanupErrors");

export type CleanupAction = () => void | Promise<void>;

export async function finishWithCleanup(
  primary: unknown,
  actions: readonly CleanupAction[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (primary !== undefined) {
    if (failures.length === 0) {
      throw primary;
    }
    if (attachCleanupFailures(primary, failures)) {
      throw primary;
    }
    throw new AggregateError(
      [primary, ...failures],
      "local EVM operation and cleanup failed",
      {cause: primary},
    );
  }
  if (failures.length === 1) {
    // A thrown undefined primary uses the cleanup-only branch. Carry its stop
    // debt into the caller's finalizer even when the single failure is returned.
    attachCleanupFailures(failures[0], failures);
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "multiple local EVM cleanup operations failed",
    );
  }
}

export function cleanupFailures(primary: unknown): readonly unknown[] {
  if ((typeof primary !== "object" && typeof primary !== "function")
    || primary === null) {
    return [];
  }
  const attached = (primary as {[CLEANUP_ERRORS]?: readonly unknown[]})[CLEANUP_ERRORS];
  if (attached !== undefined) {return attached;}
  // Frozen/primitive primaries cannot carry the symbol. finishWithCleanup
  // preserves them as the aggregate's cause and first entry instead.
  if (primary instanceof AggregateError) {
    return primary.errors.slice(Object.hasOwn(primary, "cause") && primary.errors[0] === primary.cause ? 1 : 0);
  }
  return [];
}

function attachCleanupFailures(
  primary: object | Function | unknown,
  failures: readonly unknown[],
): boolean {
  if ((typeof primary !== "object" && typeof primary !== "function")
    || primary === null) {
    return false;
  }
  try {
    Object.defineProperty(primary, CLEANUP_ERRORS, {
      configurable: false,
      enumerable: false,
      value: Object.freeze([...failures]),
      writable: false,
    });
    return true;
  } catch {
    return false;
  }
}
