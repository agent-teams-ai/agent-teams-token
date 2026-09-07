import { spawn } from "node:child_process";
const [ledger, token] = process.argv.slice(2);
if (ledger === undefined || token === undefined) { throw new Error("missing zombie fixture arguments"); }
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], { env: { AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: "ignore" });
child.once("spawn", () => { process.send?.({ pid: child.pid }); });
process.once("message", () => { child.kill("SIGTERM"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); });
