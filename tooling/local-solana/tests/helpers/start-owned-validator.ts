import { spawn } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { PrivateRunStore } from "../../src/adapters/filesystem.ts";
import { captureValidatorIdentity } from "../../src/adapters/process-identity.ts";

const [runRoot, outputRoot, readyPath] = process.argv.slice(2);
if (runRoot === undefined || outputRoot === undefined || readyPath === undefined) { throw new Error("missing helper arguments"); }
const store = new PrivateRunStore(runRoot, outputRoot); const paths = await store.create();
const executable = await realpath(process.execPath);
const child = spawn(executable, ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], {
  env: { PATH: "/usr/bin:/bin", AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: paths.leaseToken }, stdio: "ignore",
});
if (child.pid === undefined) { throw new Error("validator helper child has no PID"); }
await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
await store.registerValidator(paths, await captureValidatorIdentity(child.pid, executable, paths.ledger, paths.leaseToken));
await writeFile(readyPath, `${JSON.stringify({ parentPid: process.pid, validatorPid: child.pid, runDirectory: paths.directory })}\n`, { mode: 0o600 });
await new Promise(() => {});
