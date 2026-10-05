# TEST SDK check prerequisites

Run from the repository root with its existing pinned Node 24.20.0, TypeScript
7.0.2 and Node types 24.13.3 packages. SDK prerequisite staging uses only public
archives; it runs no install scripts, upgrades or vendor edits. Missing inputs
fail the check; they are prerequisites, not permission to substitute declarations
or omit a governed command.

Clean CI and `./dev bootstrap` stage the finite compile prerequisite before
the existing unconditional root typecheck. Explicit reproduction is:

```sh
./dev bootstrap sdk-inputs --fetch
# A fresh offline checkout with the same verified public cache:
./dev bootstrap sdk-inputs --offline --cache /absolute/public/archive-cache
pnpm typecheck
```

The cache defaults to `.tools/downloads/test-sdk-inputs-v1`. The finite descriptor
is [`sdk-inputs/archives.json`](sdk-inputs/archives.json): 99 fixed placements and
95 distinct tarball names, matching the accepted TEST policy including dormant
`jayson/node_modules/ws`. Each placement's exact public HTTPS tarball URL and
SHA-512 SRI comes from the hash-pinned
[`sdk-inputs/provider-lock.json`](sdk-inputs/provider-lock.json).
For example, SDK 1.13.0 comes from
`https://registry.npmjs.org/@chainlink/ccip-sdk/-/ccip-sdk-1.13.0.tgz`.
There is no moving registry lookup or private snapshot service. The companion
[`sdk-inputs/provider-root.json`](sdk-inputs/provider-root.json) and lock
are byte-for-byte public root metadata, separately identified generated data.
The pinned `f65db5bc...` file is an **npm `package-lock.json`**, not a pnpm lock;
the workspace pnpm lock and dependency versions remain unchanged.

[`test-sdk-inputs.ts`](src/adapters/test-sdk-inputs.ts) reuses the existing
descriptor-safe toolchain file reads, path custody checks and unchanged
`readTestSdkPayload` SRI/default reader/three exact exception dispatches. General
toolchain extraction installs complete tools and does not implement this finite
npm declaration projection; Safe artifact staging owns a different archive.
The helper validates both root hashes and every selected archive before creating
the provider directory. It projects each selected package's original
`package.json` and all `.d.ts`, `.d.mts` and `.d.cts` bytes (1,426 declarations)
under `.local/INPUT/provider`, with files `0400` and directories `0500`.
It never evaluates provider packages. Root/lock/SRI authenticate these inputs;
observed installation hashes do not supply authenticity.

The existing rollback offline-checkout bootstrap also invokes this same helper
with `--offline --cache <sourceRoot>/.tools/downloads/test-sdk-inputs-v1` after
its frozen workspace install and before any survivor typecheck. This four-line
prerequisite call in `scripts/rollback/runtime/offline-environment.mjs` is
necessary: those separate clean checkouts otherwise inherit neither the outer
provider directory nor its cache. It changes only bootstrap staging; no rollback
manifest, admission, gate, authentication or candidate execution rule changes.
Fixture filenames deliberately avoid `*package.json`, so workspace package
discovery does not mistake public root metadata for a new workspace package.

`--fetch` retrieves only missing selected archives from `registry.npmjs.org`,
without credentials or redirects, bounded to 32 MiB/archive, 30 seconds/request
and eight minutes total. Existing corrupt caches fail SRI instead of being
replaced. `--offline` never fetches. Copy the 95 named archives from a verified
online cache to reproduce offline; `--cache` also retains verified copies in the
new checkout's default cache, so later focused tests and offline descendants use
the same input. Existing divergent retained bytes reject before publication.
The supplied public `.local/INPUT/archives`
uses the same basenames and also reproduces this command. Repeat staging checks
all cached SRI and the exact projected inventory/bytes/modes without rewriting.
Foreign or partial destinations fail closed and remain untouched. If an IO
failure interrupts new publication, its owned partial directory remains for
diagnosis; it cannot pass verification. Use a fresh checkout for reproduction.

This declaration projection supplies checks, not a 202-placement execution
installation. It contains no candidate JavaScript and cannot replace runtime
admission or the operator's complete read-only snapshot. Existing complete
operator mounts at the same path must be preserved; stage in a separate clean
checkout. File permissions do not prove read-only mount custody against owner
chmod/remount. Execution still requires the accepted operator lifetime custody
and the unchanged native admission checks below. Public online retrieval by the
new helper must be independently verified by the orchestrator; this isolated
worker's evidence uses the actual supplied archives offline.

For native execution qualification, the operator supplies a complete,
canonical, read-only npm snapshot at
`.local/INPUT/provider`, retaining custody through execution and review. Its
root `package.json` SHA256 is
`9bc50499bd486b1457bb2efb85951ed8b90d15faf13b39d36d3bb97a2338ccc4` and
`package-lock.json` SHA256 is
`f65db5bc0003f0cfe4545ab853a991cea43ec7b172ad52e5002e7f25dd7ce8c1`.
Use the existing 202-placement snapshot, SDK 1.13.0 and ethers 6.17.0. Supply
the retained 95 unique public archives under `.local/INPUT/archives`; its
`index.json` uses `agtmai-test-sdk-archive-locator-v1` and maps the 99 policy
owners to relative tarball filenames. The index locates bytes; the pinned lock
SRI and exact source exception hashes authenticate them.

Type-only relative imports map repository paths into that fixed snapshot:

| Under `.local/INPUT/provider/node_modules/` | Real declaration resolution |
| --- | --- |
| `@chainlink/ccip-sdk/dist/{evm,solana,api}/index.js` | Corresponding `index.d.ts` |
| `@chainlink/ccip-sdk/dist/types.js` | `dist/types.d.ts` |
| `ethers/lib.esm/{abi,contract}/index.js`, `ethers/lib.esm/index.js` | Corresponding `index.d.ts` |
| `ethers/lib.commonjs/abi/index.js` (native unit oracle) | `lib.commonjs/abi/index.d.ts` |

NodeNext follows the snapshot's own transitive declarations. This mapping has
no external absolute host path and does not evaluate the SDK root. Both testnet
configs inherit `skipLibCheck` for declaration diagnostics: this snapshot has
Aptos/eventemitter constructor errors, an absent Canton generated declaration
and absent bn.js types. TypeScript applies that switch to all `.d.ts`/`.d.mts`
inputs; it cannot scope it per vendor. We qualify authored contracts against
these real declarations, not correctness of upstream declaration bodies.
Strict authored TS/MTS, checked `evm-forward-sdk.mjs`, and all eight negative
contracts remain checked by `tsconfig.sdk-execution.json` in the root typecheck.
The ordinary root-invoked testnet check retains its entire source inclusion.

Build unchanged Domain/Supply exports before checking the ordinary testnet
config or existing forward tests, using the already installed pinned packages:

```sh
SDK_NODE=.tools/node-v24.20.0-linux-x64/bin/node
"$SDK_NODE" node_modules/typescript/lib/tsc.js --build --pretty false
"$SDK_NODE" node_modules/typescript/lib/tsc.js -p tooling/testnet-ccip/tsconfig.sdk-execution.json --pretty false
"$SDK_NODE" node_modules/typescript/lib/tsc.js -p tooling/testnet-ccip/tsconfig.json --pretty false
```

The focused staging test starts with an exact tracked parent checkout without
INPUT (strict RED), stages actual SRI-verified public declarations (strict GREEN),
builds unchanged Domain/Supply and checks ordinary testnet types. Removing only
the eight negative directives produces exactly eight intended errors; all nine
existing forward/admission units still pass. Separate real-archive cases reject
a late corrupted yaml archive before publication/evaluation or fetch, reject
root metadata drift, and retain foreign destination bytes. Run it after staging:

```sh
.tools/bin/node --test tooling/testnet-ccip/tests/test-sdk-inputs.test.ts
```

The normal workspace links must expose Supply's pinned yaml 2.9.0 and
`@noble/hashes` 2.4.0; missing links/build output are environment prerequisites.
Authenticate the supplied snapshot by running the existing native runner with
`--phase admission` and absolute `--root`, `--archives`, `--fixture`, `--captures`
and owned ignored `--out` paths. The fixture is the exact selected replacement
fixture. Admission checks are offline; they do not require invented captures.
Full `--phase forward` still requires genuine hash-bound new-pair captures and
independent expectations. Until the replacement pool/registry/remote setup and
those public inputs exist, that qualification remains **UNQUALIFIED**.
