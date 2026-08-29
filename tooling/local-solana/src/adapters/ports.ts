import { createServer } from "node:net";
import { LocalSolanaError } from "../domain/model.ts";
import type { PortAllocator } from "../application/ports.ts";

export class LoopbackPortAllocator implements PortAllocator {
  public async allocate(): Promise<{ readonly rpcPort: number; readonly faucetPort: number }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rpcPort = await availablePort(); const faucetPort = await availablePort();
      if (rpcPort !== faucetPort) { return { rpcPort, faucetPort }; }
    }
    throw new LocalSolanaError("SOLANA_PORT_ALLOCATION", "could not allocate distinct private loopback ports");
  }
}
async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer(); server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (typeof address === "string" || address === null) { server.close(); reject(new LocalSolanaError("SOLANA_PORT_ADDRESS", "loopback allocator returned no TCP port")); return; }
      server.close((cause) => cause ? reject(cause) : resolve(address.port));
    });
  });
}
