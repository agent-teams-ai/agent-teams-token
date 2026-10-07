import { isAbsolute, resolve } from "node:path";
import { selectedFixture, validateReplacementFixture, type FixtureSelection, type ReplacementFixture } from "../domain/replacement-fixture.ts";
export const TEST_SDK_PROFILE = "agtmai-test-sdk-execution-v1";
export const TEST_SDK_ROOT_HASHES = Object.freeze({
  "package.json": "9bc50499bd486b1457bb2efb85951ed8b90d15faf13b39d36d3bb97a2338ccc4",
  "package-lock.json": "f65db5bc0003f0cfe4545ab853a991cea43ec7b172ad52e5002e7f25dd7ce8c1",
});
export const TEST_SDK_NODE_HASH = "89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7";
/** The finite oracle allowance; the last owner is authenticated but dormant. */
export const TEST_SDK_PACKAGES: readonly string[] = Object.freeze([
  "@adraffy/ens-normalize",
  "@chainlink/ccip-sdk",
  "@coral-xyz/anchor",
  "@coral-xyz/anchor/node_modules/@noble/hashes",
  "@coral-xyz/anchor/node_modules/base-x",
  "@coral-xyz/anchor/node_modules/bs58",
  "@coral-xyz/anchor/node_modules/eventemitter3",
  "@coral-xyz/borsh",
  "@noble/curves",
  "@noble/curves/node_modules/@noble/hashes",
  "@solana/buffer-layout",
  "@solana/buffer-layout-utils",
  "@solana/codecs",
  "@solana/codecs-core",
  "@solana/codecs-data-structures",
  "@solana/codecs-numbers",
  "@solana/codecs-strings",
  "@solana/errors",
  "@solana/options",
  "@solana/spl-token",
  "@solana/spl-token-group",
  "@solana/spl-token-metadata",
  "@solana/web3.js",
  "@solana/web3.js/node_modules/@noble/hashes",
  "@solana/web3.js/node_modules/@solana/codecs-core",
  "@solana/web3.js/node_modules/@solana/codecs-numbers",
  "@solana/web3.js/node_modules/@solana/errors",
  "@solana/web3.js/node_modules/base-x",
  "@solana/web3.js/node_modules/borsh",
  "@solana/web3.js/node_modules/bs58",
  "@solana/web3.js/node_modules/superstruct",
  "abitype",
  "aes-js",
  "agent-base",
  "asynckit",
  "axios",
  "base-x",
  "bigint-buffer",
  "bignumber.js",
  "bindings",
  "bn.js",
  "borsh",
  "bs58",
  "buffer-layout",
  "call-bind-apply-helpers",
  "camelcase",
  "combined-stream",
  "cross-fetch",
  "debug",
  "delayed-stream",
  "dot-case",
  "dunder-proto",
  "es-define-property",
  "es-errors",
  "es-object-atoms",
  "es-set-tostringtag",
  "ethers",
  "ethers/node_modules/@noble/curves",
  "ethers/node_modules/@noble/hashes",
  "eventemitter3",
  "fast-equals",
  "fast-stringify",
  "file-uri-to-path",
  "follow-redirects",
  "form-data",
  "function-bind",
  "get-intrinsic",
  "get-proto",
  "gopd",
  "has-symbols",
  "has-tostringtag",
  "hasown",
  "https-proxy-agent",
  "jayson",
  "lower-case",
  "math-intrinsics",
  "micro-memoize",
  "mime-db",
  "mime-types",
  "ms",
  "no-case",
  "node-fetch",
  "pako",
  "proxy-from-env",
  "rpc-websockets",
  "rpc-websockets/node_modules/uuid",
  "safe-buffer",
  "snake-case",
  "superstruct",
  "text-encoding-utf-8",
  "toml",
  "tr46",
  "tslib",
  "uuid",
  "webidl-conversions",
  "whatwg-url",
  "ws",
  "yaml",
  "jayson/node_modules/ws",
 ].map(name => "node_modules/" + name));
export const TEST_SDK_ENTRIES = Object.freeze({
  evm: ["@chainlink/ccip-sdk/dist/evm/index.js", "dist/evm/index.js", "EVMChain"],
  solana: ["@chainlink/ccip-sdk/dist/solana/index.js", "dist/solana/index.js", "SolanaChain"],
  api: ["@chainlink/ccip-sdk/dist/api/index.js", "dist/api/index.js", "CCIPAPIClient"],
  types: ["@chainlink/ccip-sdk/dist/types.js", "dist/types.js", "ExecutionState"],
} as const);
// Authenticated source imports, including inert HTTP functions and bindings' fs probes.
// This is bounded evaluation of trusted pinned source, not a hostile-code sandbox.
export const TEST_SDK_BUILTINS: readonly string[] = Object.freeze([
  "assert", "buffer", "crypto", "events", "fs", "http", "http2", "https", "net", "os", "path", "process", "punycode",
  "stream", "string_decoder", "tls", "tty", "url", "util", "zlib",
]);
// debug@4.4.3 src/node.js has a caught, declaration-free supports-color import.
// Its authenticated source needs one more explicit absence, not another admitted package.
export const TEST_SDK_EXTRA_ABSENCES: readonly (readonly [string, string])[] = Object.freeze([
  ["node_modules/debug/src/node.js", "supports-color"],
]);
// bindings@1.5.0's thirteen pinned Linux searches for bigint-buffer's JS fallback.
export const TEST_SDK_NATIVE_ABSENCES: readonly string[] = Object.freeze([
  "build/bigint_buffer.node", "build/Debug/bigint_buffer.node", "build/Release/bigint_buffer.node",
  "out/Debug/bigint_buffer.node", "Debug/bigint_buffer.node", "out/Release/bigint_buffer.node", "Release/bigint_buffer.node",
  "build/default/bigint_buffer.node", "compiled/24.20.0/linux/x64/bigint_buffer.node",
  "addon-build/release/install-root/bigint_buffer.node", "addon-build/debug/install-root/bigint_buffer.node",
  "addon-build/default/install-root/bigint_buffer.node", "lib/binding/node-v137-linux-x64/bigint_buffer.node",
]);
export interface TestSdkSelection extends FixtureSelection {
  readonly providerProfile?: unknown; readonly testOnly?: boolean;
  readonly providerArchives?: string; readonly providerDirectory?: string;
  readonly ccipProviderDirectory?: string; readonly sdkDirectory?: string;
  readonly replayFetch?: typeof fetch;
}
export interface ExplicitTestSdkSelection extends TestSdkSelection {
  readonly providerProfile: typeof TEST_SDK_PROFILE; readonly testOnly: true;
  readonly fixture: ReplacementFixture; readonly fixtureIdentity: string; readonly providerArchives: string;
}
export interface TestSdkForwardSelection extends TestSdkSelection {}
export interface SelectedTestSdk { readonly fixture: Readonly<ReplacementFixture>; readonly archives: string }
function canonicalDirectory(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}
/** Presence alone chooses the explicit route, before any asynchronous IO. */
export function selectTestSdk(selection: TestSdkSelection, directory: string, fixture?: ReplacementFixture): SelectedTestSdk | undefined {
  if (!Object.hasOwn(selection, "providerProfile")) { return undefined; }
  if (selection.providerProfile !== TEST_SDK_PROFILE || selection.testOnly !== true) {
    throw new Error("Unknown or non-TEST SDK profile");
  }
  if (!canonicalDirectory(directory)) { throw new Error("Canonical TEST SDK directory required"); }
  const selected = selectedFixture(selection), supplied = fixture === undefined ? undefined : validateReplacementFixture(fixture);
  if (!selected || supplied?.identity !== selected.identity || typeof selection.providerArchives !== "string" || !selection.providerArchives.startsWith("/")) {
    throw new Error("TEST SDK requires exact selected fixture and retained archives");
  }
  for (const key of ["providerDirectory", "ccipProviderDirectory", "sdkDirectory"] as const) {
    if (Object.hasOwn(selection, key) && (!canonicalDirectory(selection[key]) || selection[key] !== directory)) {
      throw new Error("Divergent or invalid TEST SDK root alias");
    }
  }
  return Object.freeze({ fixture: selected, archives: selection.providerArchives });
}
