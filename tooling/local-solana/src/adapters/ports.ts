import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { LocalSolanaError } from "../domain/model.ts";
import type { PortAllocator, PortLease } from "../application/ports.ts";

const RANGE_WIDTH = 128;
const claimedRanges = new Set<number>();
const claimedPorts = new Set<number>();

export class LoopbackPortAllocator implements PortAllocator {
  public async allocate(): Promise<PortLease> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rangeStart = randomInt(20_000, 60_000 - RANGE_WIDTH);
      if (rangeCollides(rangeStart)) { continue; }
      const rpcPort = await availablePort();
      const faucetPort = await availablePortExcluding(new Set([rpcPort, rpcPort + 1]));
      const reservedPorts = [rpcPort, rpcPort + 1, faucetPort];
      if (new Set(reservedPorts).size !== reservedPorts.length
        || reservedPorts.some((port) => port > 65_535 || claimedPorts.has(port) || inRange(port, rangeStart))
        || !await canListen(rpcPort + 1)) { continue; }
      claimedRanges.add(rangeStart);
      for (const port of reservedPorts) { claimedPorts.add(port); }
      let released = false;
      return {
        rpcPort,
        faucetPort,
        gossipPort: rangeStart,
        dynamicPortRange: `${rangeStart}-${rangeStart + RANGE_WIDTH}`,
        release: () => {
          if (released) { return; }
          released = true; claimedRanges.delete(rangeStart);
          for (const port of reservedPorts) { claimedPorts.delete(port); }
        },
      };
    }
    throw new LocalSolanaError("SOLANA_PORT_ALLOCATION", "could not allocate distinct private loopback ports");
  }
}

function inRange(port: number, start: number): boolean { return port >= start && port < start + RANGE_WIDTH; }

function rangeCollides(start: number): boolean {
  for (const claimedStart of claimedRanges) {
    if (start < claimedStart + RANGE_WIDTH && claimedStart < start + RANGE_WIDTH) { return true; }
  }
  for (const port of claimedPorts) { if (inRange(port, start)) { return true; } }
  return false;
}

async function availablePort(): Promise<number> {
  return await listenOn(0);
}

async function availablePortExcluding(excluded: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await availablePort();
    if (!excluded.has(port)) { return port; }
  }
  throw new LocalSolanaError("SOLANA_PORT_DISTINCT", "operating system did not provide a distinct loopback port");
}

async function canListen(port: number): Promise<boolean> {
  try { await listenOn(port); return true; } catch { return false; }
}

async function listenOn(port: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer(); server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      if (typeof address === "string" || address === null) { server.close(); reject(new LocalSolanaError("SOLANA_PORT_ADDRESS", "loopback allocator returned no TCP port")); return; }
      server.close((cause) => { if (cause) { reject(cause); } else { resolve(address.port); } });
    });
  });
}
