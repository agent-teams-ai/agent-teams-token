import assert from "node:assert/strict";
import {spawn, type ChildProcess} from "node:child_process";
import {mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {authenticateProcess, processStartIdentity} from "../../local-evm/process.ts";
import {createProvisionalRunDirectory, createRunLease, reclaimStaleRuns, registerRunAnvil} from "../../local-evm/run-lease.ts";
import {startupCustodyProbe} from "../../local-evm/tests/fixtures/startup-custody.ts";
import {loadProofFinalizer} from "./fixtures/proof-custody.ts";

const proofOwner = new URL("./fixtures/proof-custody.ts", import.meta.url);

for (const stopFails of [true, false]) {
  test(`proof startup publication failure ${stopFails ? "retains" : "removes"} custody after real supervisor cleanup`, {timeout: 20_000}, async context => {
    const {root, directory, identity} = await startupCustodyProbe(context, proofOwner, stopFails);
    assert.equal(await authenticateProcess(identity), stopFails ? "owned" : "absent");
    if (stopFails) {
      const lease = JSON.parse(await readFile(join(directory, "lease.v1.json"), "utf8"));
      assert.equal(lease.anvil, null);
      assert.equal(await authenticateProcess(lease.runner), "absent");
      await assert.rejects(reclaimStaleRuns(root), {code: "LOCAL_EVM_RUN_ANVIL_STILL_OWNED"});
      assert.equal(await readFile(join(directory, "custody-sentinel"), "utf8"), "retain");
    } else {await assert.rejects(readFile(join(directory, "lease.v1.json")), {code: "ENOENT"});}
  });
}

test("proof stop rejection retains custody even if the registered child has exited", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evm-proof-stop-")));
  const directory = await createProvisionalRunDirectory(root, "proof");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  assert(child.pid);
  const closed = new Promise<void>((resolve) => {child.once("close", () => resolve());});
  const stopFailure = new Error("stop rejected");
  // Real owned-run deletion must not be attempted after a rejected stop.
  await createRunLease(directory);
  await registerRunAnvil(directory, {pid: child.pid, processStart: await processStartIdentity(child.pid)});
  await reapSyntheticChild(child, closed);
  const proof = await loadProofFinalizer();
  try {
    await assert.rejects(proof({runDirectory: directory, anvil: {async stop() {throw stopFailure;}}}), cause => cause === stopFailure);
    assert.equal(JSON.parse(await readFile(join(directory, "lease.v1.json"), "utf8")).anvil.pid, child.pid);
  } finally {await reapSyntheticChild(child, closed); await rm(root, {recursive: true, force: true});}
});

async function reapSyntheticChild(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("synthetic child termination unconfirmed; retaining fixture")), 5_000);
      }),
    ]);
  } finally {clearTimeout(timer);}
}
