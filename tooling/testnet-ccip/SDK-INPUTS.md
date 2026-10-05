# TEST SDK check prerequisites

Run from the repository root with its existing pinned Node 24.20.0, TypeScript
7.0.2 and Node types 24.13.3 packages. No install, upgrade or vendor edit is part
of this checkpoint. Missing public inputs fail the check; they are prerequisites,
not permission to substitute declarations or omit a governed command.

The operator supplies a complete, canonical, read-only npm snapshot at
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

The normal workspace links must expose Supply's pinned yaml 2.9.0 and
`@noble/hashes` 2.4.0; missing links/build output are environment prerequisites.
Authenticate the supplied snapshot by running the existing native runner with
`--phase admission` and absolute `--root`, `--archives`, `--fixture`, `--captures`
and owned ignored `--out` paths. The fixture is the exact selected replacement
fixture. Admission checks are offline; they do not require invented captures.
Full `--phase forward` still requires genuine hash-bound new-pair captures and
independent expectations. Until the replacement pool/registry/remote setup and
those public inputs exist, that qualification remains **UNQUALIFIED**.
