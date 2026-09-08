import { once } from "node:events";
import { PrivateRunStore } from "../../src/adapters/filesystem.ts";
import { NodeCommandAdapter, OwnedValidatorAdapter } from "../../src/adapters/process.ts";
import { SolanaCliAdapter } from "../../src/adapters/cli.ts";
import { allowlistedEnvironment } from "../../src/application/runner.ts";
import type { ToolPaths } from "../../src/application/ports.ts";

const [runRoot, outputRoot] = process.argv.slice(2);
if (runRoot === undefined || outputRoot === undefined) { throw new Error("missing genuine recovery arguments"); }
const paths = await new PrivateRunStore(runRoot, outputRoot).create();
process.send?.({ type: "run", paths });
const [request] = await once(process, "message") as [{ tools: ToolPaths; rpcPort: number; faucetPort: number; gossipPort: number; dynamicPortRange: string }];
const signal = new AbortController().signal;
const env = allowlistedEnvironment({}, paths.directory);
const keys = await new SolanaCliAdapter(new NodeCommandAdapter()).createKeys({ paths, tools: request.tools, env, signal });
await new OwnedValidatorAdapter().start({
  executable: request.tools.validator, ledger: paths.ledger, config: paths.config,
  genesisMint: keys.payer, tokenProgram: request.tools.tokenProgram, associatedTokenProgram: request.tools.associatedTokenProgram,
  rpcPort: request.rpcPort, faucetPort: request.faucetPort, gossipPort: request.gossipPort, dynamicPortRange: request.dynamicPortRange,
  env, signal, leaseToken: paths.leaseToken,
  registerIdentity: async (identity) => {
    process.send?.({ type: "captured", identity });
    await new Promise(() => {});
  },
});
