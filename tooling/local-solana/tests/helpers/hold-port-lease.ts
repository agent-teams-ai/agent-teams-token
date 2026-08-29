import { LoopbackPortAllocator } from "../../src/adapters/ports.ts";

const root = process.argv[2];
if (root === undefined) { throw new Error("lease root required"); }
const lease = await new LoopbackPortAllocator(root).allocate();
process.stdout.write(`${JSON.stringify({ rpcPort: lease.rpcPort, faucetPort: lease.faucetPort, gossipPort: lease.gossipPort, dynamicPortRange: lease.dynamicPortRange })}\n`);
await new Promise<void>((resolve) => { process.stdin.once("end", resolve); process.stdin.resume(); });
await lease.release();
