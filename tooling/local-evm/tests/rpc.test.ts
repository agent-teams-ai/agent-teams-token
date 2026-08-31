import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { assertPrivateRpcUrl, bootstrapRpcRequest, createRpcClient } from "../rpc.ts";

const servers = new Set<Server>();
const execute = promisify(execFile);

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  })));
  servers.clear();
});

test("RPC URLs require the exact canonical local literal before opening a socket", async () => {
  const accepted = [
    "http://127.0.0.1:1/",
    "http://127.0.0.1:80/",
    "http://127.0.0.1:65535/",
  ] as const;
  const rejected = [
    ["short IPv4", "http://127.1:8545/"],
    ["short three-part IPv4", "http://127.0.1:8545/"],
    ["single decimal IPv4", "http://2130706433:8545/"],
    ["single octal IPv4", "http://017700000001:8545/"],
    ["single hexadecimal IPv4", "http://0x7f000001:8545/"],
    ["uppercase hexadecimal IPv4", "http://0X7F000001:8545/"],
    ["dotted octal IPv4", "http://0177.0.0.1:8545/"],
    ["dotted hexadecimal IPv4", "http://0x7f.0.0.1:8545/"],
    ["zero-padded IPv4", "http://127.000.000.001:8545/"],
    ["trailing-dot host", "http://127.0.0.1.:8545/"],
    ["uppercase scheme", "HTTP://127.0.0.1:8545/"],
    ["mixed-case scheme", "Http://127.0.0.1:8545/"],
    ["leading space", " http://127.0.0.1:8545/"],
    ["trailing space", "http://127.0.0.1:8545/ "],
    ["leading tab", "\thttp://127.0.0.1:8545/"],
    ["trailing newline", "http://127.0.0.1:8545/\r\n"],
    ["encoded host digits", "http://%31%32%37.0.0.1:8545/"],
    ["encoded host dots", "http://127%2e0%2e0%2e1:8545/"],
    ["encoded path slash", "http://127.0.0.1:8545/%2f"],
    ["backslash separators", "http:\\\\127.0.0.1:8545\\"],
    ["username", "http://user@127.0.0.1:8545/"],
    ["password", "http://user:password@127.0.0.1:8545/"],
    ["query", "http://127.0.0.1:8545/?rpc=1"],
    ["fragment", "http://127.0.0.1:8545/#rpc"],
    ["localhost", "http://localhost:8545/"],
    ["IPv6 loopback", "http://[::1]:8545/"],
    ["unspecified host", "http://0.0.0.0:8545/"],
    ["non-exact loopback", "http://127.0.0.2:8545/"],
    ["public host", "http://example.com:8545/"],
    ["path", "http://127.0.0.1:8545/rpc"],
    ["double slash path", "http://127.0.0.1:8545//"],
    ["missing port", "http://127.0.0.1:/"],
    ["zero port", "http://127.0.0.1:0/"],
    ["negative port", "http://127.0.0.1:-1/"],
    ["signed port", "http://127.0.0.1:+80/"],
    ["hexadecimal port", "http://127.0.0.1:0x50/"],
    ["octal zero-padded port", "http://127.0.0.1:0100/"],
    ["zero-padded port", "http://127.0.0.1:08545/"],
    ["decimal port", "http://127.0.0.1:80.0/"],
    ["exponent port", "http://127.0.0.1:8e1/"],
    ["encoded port", "http://127.0.0.1:%38%30/"],
    ["port whitespace", "http://127.0.0.1: 80/"],
    ["port above range", "http://127.0.0.1:65536/"],
    ["six-digit port", "http://127.0.0.1:100000/"],
    ["missing trailing slash", "http://127.0.0.1:8545"],
  ] as const;

  const connect = Socket.prototype.connect;
  let socketAttempts = 0;
  Socket.prototype.connect = (() => {
    socketAttempts += 1;
    throw new Error("RPC URL validation reached the socket boundary");
  }) as typeof Socket.prototype.connect;
  try {
    for (const rpcUrl of accepted) {
      assert.doesNotThrow(() => assertPrivateRpcUrl(rpcUrl));
      assert.doesNotThrow(() => createRpcClient(rpcUrl));
    }
    for (const [label, rpcUrl] of rejected) {
      assert.throws(() => assertPrivateRpcUrl(rpcUrl), isRpcUrlRejection, label);
      await assert.rejects(async () => await createRpcClient(rpcUrl).request("eth_chainId"), isRpcUrlRejection, label);
      await assert.rejects(bootstrapRpcRequest(rpcUrl, "eth_chainId", []), isRpcUrlRejection, label);
    }
  } finally {
    Socket.prototype.connect = connect;
    assert.equal(socketAttempts, 0, "RPC URL validation or client construction attempted to open a socket");
  }
});

test("runner bootstrap and verifier RPC reject redirects without requesting the second loopback endpoint", async () => {
  let redirectRequests = 0;
  let targetRequests = 0;
  const target = await listen(createServer((_request, response) => {
    targetRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"jsonrpc":"2.0","id":1,"result":"0x7a69"}');
  }));
  const redirect = await listen(createServer((_request, response) => {
    redirectRequests += 1;
    response.writeHead(307, { location: target });
    response.end();
  }));

  await assert.rejects(bootstrapRpcRequest(redirect, "eth_chainId", []), hasCode("LOCAL_EVM_RPC_REDIRECT_FORBIDDEN"));
  await assert.rejects(createRpcClient(redirect).request("eth_chainId"), hasCode("VERIFY_RPC_REDIRECT_FORBIDDEN"));
  assert.equal(redirectRequests, 2);
  assert.equal(targetRequests, 0);
});

test("streaming redirect and error responses are destroyed instead of escaping transport bounds", async () => {
  const scenarios = [
    {
      status: 307,
      code: "LOCAL_EVM_RPC_REDIRECT_FORBIDDEN",
      request: async (url: string) => await bootstrapRpcRequest(url, "eth_chainId", []),
    },
    {
      status: 500,
      code: "VERIFY_RPC_HTTP_FAILURE",
      request: async (url: string) => await createRpcClient(url).request("eth_chainId"),
    },
  ] as const;

  for (const scenario of scenarios) {
    let interval: NodeJS.Timeout | undefined;
    let peer: Socket | undefined;
    let observedClose!: () => void;
    const closed = new Promise<void>((resolve) => {observedClose = resolve;});
    const server = createServer((_request, response) => {
      response.writeHead(scenario.status, scenario.status === 307
        ? {location: "http://127.0.0.1:1/"}
        : {"content-type": "application/json"});
      response.write(Buffer.alloc(8192));
      interval = setInterval(() => {response.write(Buffer.alloc(8192));}, 5);
    });
    server.on("connection", (socket) => {
      peer = socket;
      socket.once("close", () => {
        if (interval !== undefined) {clearInterval(interval);}
        observedClose();
      });
    });
    const url = await listen(server);
    try {
      await assert.rejects(scenario.request(url), hasCode(scenario.code));
      await Promise.race([
        closed,
        delay(1_000).then(() => assert.fail(`HTTP ${scenario.status} response socket remained open`)),
      ]);
      assert.equal(peer?.destroyed, true);
    } finally {
      if (interval !== undefined) {clearInterval(interval);}
      peer?.destroy();
    }
  }
});

test("verifier RPC correlates overlapping requests with their captured identifiers", async () => {
  const pending: Array<{readonly id: number; readonly method: string; readonly response: ServerResponse}> = [];
  const url = await listen(createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {chunks.push(chunk);});
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {id: number; method: string};
      pending.push({id: body.id, method: body.method, response});
      if (pending.length !== 2) {return;}
      for (const item of pending) {
        item.response.writeHead(200, {"content-type": "application/json"});
        item.response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: item.id,
          result: item.method === "eth_chainId" ? "0x7a69" : "0x6000",
        }));
      }
    });
  }));
  const rpc = createRpcClient(url);
  const [chainId, code] = await Promise.all([
    rpc.request("eth_chainId"),
    rpc.request("eth_getCode", ["0x7000000000000000000000000000000000000001", "latest"]),
  ]);
  assert.equal(chainId, "0x7a69");
  assert.equal(code, "0x6000");
});

test("explicit HTTP transport ignores ambient proxy configuration in a child process", async () => {
  let targetRequests = 0;
  let proxyRequests = 0;
  const target = await listen(createServer((request, response) => {
    targetRequests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {id: number};
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({jsonrpc: "2.0", id: body.id, result: "0x7a69"}));
    });
  }));
  const proxyServer = createServer((_request, response) => {
    proxyRequests += 1;
    response.writeHead(502);
    response.end();
  });
  proxyServer.on("connect", (_request, socket) => {
    proxyRequests += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const proxy = await listen(proxyServer);
  const moduleUrl = new URL("../rpc.ts", import.meta.url).href;
  const child = [
    `import {bootstrapRpcRequest, createRpcClient} from ${JSON.stringify(moduleUrl)};`,
    `const url = ${JSON.stringify(target)};`,
    `let proxyBlocked = false;`,
    `try { const control = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"}); proxyBlocked = !control.ok; } catch { proxyBlocked = true; }`,
    `if (!proxyBlocked) process.exit(1);`,
    `if (await bootstrapRpcRequest(url, "eth_chainId", []) !== "0x7a69") process.exit(2);`,
    `if (await createRpcClient(url).request("eth_chainId") !== "0x7a69") process.exit(3);`,
  ].join("\n");
  // Model a hostile inherited lower-case bypass, then explicitly sanitize and
  // set every proxy/no-proxy spelling. The vulnerable fetch control above must
  // prove that Node's ambient proxy mode is genuinely active.
  const inherited = {...process.env, no_proxy: "127.0.0.1"};
  await execute(process.execPath, ["--input-type=module", "--eval", child], {
    env: {
      ...inherited,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: "",
      no_proxy: "",
    },
    timeout: 10_000,
  });
  assert.equal(targetRequests, 2);
  assert.equal(proxyRequests, 1);
});

test("transport rejects malformed methods and bounded oversized responses", async () => {
  const oversized = await listen(createServer((_request, response) => {
    response.writeHead(200, {"content-type": "application/json", "content-length": String(1024 * 1024 + 1)});
    response.end();
  }));
  await assert.rejects(bootstrapRpcRequest(oversized, "bad method", []), hasCode("LOCAL_EVM_RPC_METHOD_INVALID"));
  await assert.rejects(bootstrapRpcRequest(oversized, "eth_sendRawTransaction", []), hasCode("LOCAL_EVM_RPC_METHOD_INVALID"));
  await assert.rejects(createRpcClient(oversized).request("eth_sendRawTransaction"), hasCode("VERIFY_RPC_METHOD_INVALID"));
  await assert.rejects(createRpcClient(oversized).request("eth_chainId"), hasCode("VERIFY_RPC_RESPONSE_TOO_LARGE"));
});

async function listen(server: Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/`;
}

function hasCode(code: string): (cause: unknown) => boolean {
  return (cause) => cause instanceof Error && "code" in cause && cause.code === code;
}

function isRpcUrlRejection(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause
    && (cause.code === "VERIFY_PUBLIC_RPC_FORBIDDEN"
      || cause.code === "VERIFY_RPC_URL_INVALID");
}
