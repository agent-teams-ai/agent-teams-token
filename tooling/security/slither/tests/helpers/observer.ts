import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

const realExecFile = childProcess.execFile;
const realKill = process.kill;

interface Observation {
  readonly child: ChildProcess;
  readonly timeoutMs: number;
  readonly closed: Promise<void>;
  readonly deliveries: { error: unknown; stdout: string; at: number }[];
}

export function substituteObserver(t: TestContext, fixture: { children: ChildProcess[]; groups: Set<number> }, script: string): Observation[] {
  const observations: Observation[] = [];
  // Force an observation even on hosts whose init promptly reaps orphan zombies.
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (signal === 0 && fixture.groups.has(-pid)) { return true; }
    return realKill(pid, signal);
  });
  t.mock.method(childProcess, "execFile", (...args: unknown[]): ChildProcess => {
    assert.equal(args[0], "/bin/ps");
    const deliveries: Observation["deliveries"] = [];
    const observer = Reflect.apply(realExecFile, childProcess, [process.execPath, ["-e", script], args[2], (error: unknown, stdout: string, stderr: string) => {
      deliveries.push({ error, stdout, at: performance.now() });
      Reflect.apply(args[3] as (...values: unknown[]) => void, undefined, [error, stdout, stderr]);
    }]) as ChildProcess;
    fixture.children.push(observer);
    observations.push({ child: observer, timeoutMs: (args[2] as { timeout: number }).timeout,
      closed: new Promise<void>((resolve) => { observer.once("close", resolve); }), deliveries });
    return observer;
  });
  syncBuiltinESMExports();
  return observations;
}

export async function assertObserverReaped(observation: Observation): Promise<void> {
  await observation.closed;
  assert.ok(observation.child.exitCode !== null || observation.child.signalCode !== null, "real observer was reaped");
  for (const stream of [observation.child.stdout, observation.child.stderr]) {
    assert.equal(stream?.destroyed, true);
    assert.equal(stream?.closed, true);
  }
}

export function assertDeliveredObservation(observations: Observation[], failure: unknown, errorCode: string | undefined): number {
  assert.ok(failure instanceof Error, "the delivered response reached the inspection failure branch");
  assert.equal(observations.length, 1, "exactly one real observer was started");
  const observation = observations[0]!;
  assert.equal(observation.deliveries.length, 1, "the real execFile callback delivered the response");
  const delivery = observation.deliveries[0]!;
  if (errorCode === undefined) {
    assert.equal(delivery.error, null);
    assert.equal(delivery.stdout, "not a process table");
    assert.ok(failure.cause instanceof Error);
    assert.equal(failure.cause.message, "PROCESS_GROUP_INSPECTION_INVALID");
  } else {
    assert.ok(delivery.error instanceof Error && "code" in delivery.error);
    assert.equal(String(delivery.error.code), errorCode);
    assert.equal(failure.cause, delivery.error, "retain the actual subprocess failure as cause");
  }
  return delivery.at;
}

export function assertDeadlineObservation(observations: Observation[], failures: readonly unknown[]): string {
  assert.equal(observations.length, 1, "exactly one real observer was started");
  const observation = observations[0]!;
  assert.ok(observation.timeoutMs > 0 && observation.timeoutMs <= 250);
  assert.equal(observation.child.killed, true, "production timeout/finalization signalled the owned observer");
  assert.equal(observation.child.stdout!.destroyed, true);
  assert.equal(observation.child.stderr!.destroyed, true);
  assert.equal(failures.length, 1, "only deadline uncertainty or the real killed-observer error is allowed");
  const failure = failures[0];
  assert.ok(failure instanceof Error);
  // The caller timer and execFile timeout share a deadline. Either can win;
  // a killed-observer callback is not delivery of the scripted delayed response.
  if (failure.message === "PROCESS_CLEANUP_UNCONFIRMED: deadline reached before group, pipes and reap were confirmed") {
    assert.equal(failure.cause, undefined);
    assert.ok(observation.deliveries.length <= 1);
    if (observation.deliveries.length === 1) { assertKilledDelivery(observation); }
    return "caller deadline";
  }
  assert.equal(failure.message, "PROCESS_GROUP_INSPECTION_FAILED: cleanup is unconfirmed");
  assertKilledDelivery(observation);
  assert.equal(failure.cause, observation.deliveries[0]!.error, "inspection failure came from the killed observer");
  return "observer timeout";
}

function assertKilledDelivery(observation: Observation): void {
  assert.equal(observation.deliveries.length, 1);
  const delivery = observation.deliveries[0]!;
  assert.ok(delivery.error instanceof Error);
  for (const [key, expected] of [["code", null], ["signal", "SIGKILL"], ["killed", true]] as const) {
    assert.equal(Reflect.get(delivery.error, key), expected, `real observer termination: ${key}`);
  }
  assert.equal(delivery.stdout, "", "no delayed response was interpreted as absence");
}

export async function assertDeadlineObserverReaped(observation: Observation): Promise<void> {
  await assertObserverReaped(observation);
  assert.equal(observation.child.exitCode, null);
  assert.equal(observation.child.signalCode, "SIGKILL");
  assertKilledDelivery(observation);
}
