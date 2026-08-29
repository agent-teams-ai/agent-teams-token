import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createLocalRpc } from "../src/adapters/rpc.ts";

test("only exact IPv4 loopback HTTP root URLs are accepted", () => {
  const rejected = [
    "https://127.0.0.1:8545/",
    "http://localhost:8545/",
    "http://127.0.0.1:8545/path",
    "http://user@127.0.0.1:8545/",
  ];
  for (const value of rejected) {
    assert.throws(() => createLocalRpc(value), /only/u);
  }
});

test("fixed method allowlist rejects before transport", async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.end("{}");
  });
  const port = await listen(server);
  try {
    const rpc = createLocalRpc(`http://127.0.0.1:${port}/`);
    await assert.rejects(rpc.request("eth_accounts" as never, []), /allowlist/u);
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test("redirect is rejected and never followed", async () => {
  let targetCalls = 0;
  const target = createServer((_request, response) => {
    targetCalls += 1;
    response.end("{}");
  });
  const targetPort = await listen(target);
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` });
    response.end();
  });
  const redirectPort = await listen(redirect);
  try {
    await assert.rejects(
      createLocalRpc(`http://127.0.0.1:${redirectPort}/`).request("eth_chainId", []),
      /redirect/u,
    );
    assert.equal(targetCalls, 0);
  } finally {
    await Promise.all([close(redirect), close(target)]);
  }
});

test("a changed final response URL is rejected", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7a69" }),
      { status: 200 },
    );
    Object.defineProperty(response, "url", { value: "http://127.0.0.1:9999/" });
    return response;
  };
  try {
    await assert.rejects(
      createLocalRpc("http://127.0.0.1:8545/").request("eth_chainId", []),
      /final URL/u,
    );
  } finally {
    globalThis.fetch = original;
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
