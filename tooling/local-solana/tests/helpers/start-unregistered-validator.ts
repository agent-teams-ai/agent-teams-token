import { writeFile } from "node:fs/promises";
import { PrivateRunStore } from "../../src/adapters/filesystem.ts";
import { OwnedValidatorAdapter } from "../../src/adapters/process.ts";

const [runRoot, outputRoot, readyPath, executable] = process.argv.slice(2);
if (runRoot === undefined || outputRoot === undefined || readyPath === undefined || executable === undefined) { throw new Error("missing helper arguments"); }

const store = new PrivateRunStore(runRoot, outputRoot);
const paths = await store.create();
await new OwnedValidatorAdapter().start({
  executable,
  ledger: paths.ledger,
  config: paths.config,
  genesisMint: "5".repeat(32),
  tokenProgram: executable,
  associatedTokenProgram: executable,
  rpcPort: 30_000,
  faucetPort: 30_002,
  gossipPort: 30_010,
  dynamicPortRange: "30010-30137",
  env: { PATH: "/usr/bin:/bin" },
  signal: new AbortController().signal,
  leaseToken: paths.leaseToken,
  registerIdentity: async (identity) => {
    await writeFile(readyPath, `${JSON.stringify({ validatorPid: identity.pid, runDirectory: paths.directory })}\n`, { mode: 0o600 });
    await new Promise(() => {});
  },
});
