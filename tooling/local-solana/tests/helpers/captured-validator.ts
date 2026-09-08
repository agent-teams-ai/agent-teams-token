import { fork } from "node:child_process";
import { PrivateRunStore } from "../../src/adapters/filesystem.ts";
const [runRoot, outputRoot] = process.argv.slice(2);
if (runRoot === undefined || outputRoot === undefined) { throw new Error("missing custody fixture arguments"); }
import { reserveStartupCustody } from "../../src/adapters/startup-custody.ts";
const paths = await new PrivateRunStore(runRoot, outputRoot).create();
const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
const supervisor = fork(new URL("../../src/adapters/validator-supervisor.ts", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
supervisor.on("message", (message: { type: string; pid?: number }) => {
  if (message.type === "spawned") { process.send?.({ pid: message.pid, supervisor: supervisor.pid, directory: paths.directory }); }
});
supervisor.send({ type: "start", executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], env: {}, custody, leaseToken: paths.leaseToken });
