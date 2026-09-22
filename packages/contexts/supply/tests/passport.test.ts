import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkPassport as checkWithHash, checkPassportFreshness, generatePassport as generateWithHash, type PassportObservation, type TokenPassport } from "../src/features/genesis-manifest/application/passport.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { deploymentBytes } from "../src/features/genesis-manifest/application/compile-deployment.js";
import { renderAuthorityRegistry, renderPassport } from "../src/features/genesis-manifest/adapters/passport-render.js";
import type { DeploymentManifest } from "../src/features/genesis-manifest/application/deployment-manifest.js";

const generatePassport = (manifest: DeploymentManifest, observations: PassportObservation) => generateWithHash(manifest, observations, { sha256 });
const checkPassport = (manifest: DeploymentManifest, observations: PassportObservation, passport: TokenPassport, now?: string) => checkWithHash(manifest, observations, passport, { sha256 }, now);

const config = JSON.parse(readFileSync("tests/fixtures/deployment/local-test.json", "utf8"));
const manifest: DeploymentManifest = { schema: "agtmai-deployment-manifest-v1", sourceRevision: "17136dc08fc928f3cebc6af89215e31f6f2bb537", broadcastAllowed: false,
  configurationSha256: `0x${"11".repeat(32)}`, preparedSha256: `0x${"22".repeat(32)}`, evidenceSha256: `0x${"33".repeat(32)}`, configuration: config,
  status: "not-deployed", token: null, grants: [], observationTrust: "selected RPC captures; hashes establish reproducibility, not independent consensus truth" };
const observations: PassportObservation = { schema: "agtmai-deployment-observations-v1", observedAt: "1700000000", validUntil: "1700003600",
  reconciliation: { status: "unresolved" }, estimates: { status: "unresolved" }, unresolved: ["token deployment", "bridge authority"] };

test("passport and registry are deterministic and retain unresolved deployment facts", () => {
  const first = generatePassport(manifest, observations), second = generatePassport(structuredClone(manifest), structuredClone(observations));
  assert.deepEqual(first, second);
  assert.match(first.markdown, /Ethereum token: `unresolved`/);
  assert.match(first.markdown, /## Allocations/);
  assert.match(first.markdown, new RegExp(config.allocations[0].recipient));
  assert.match(first.markdown, /## Configured custody/);
  assert.match(first.markdown, new RegExp(config.custodySafes[0].owners[0]));
  assert.match(first.markdown, /live balances, ownership and extensions require separate observations/);
  assert.match(first.markdown, /vault `unresolved`/);
  assert.match(first.markdown, /No deployment transactions recorded/);
  assert.ok(first.authorityRegistry.entries.every(entry => entry.expected !== null));
  assert.equal(new TextDecoder().decode(renderPassport(first)), first.markdown);
  assert.match(new TextDecoder().decode(renderAuthorityRegistry(first)), /agtmai-authority-registry-v1/);
  assert.equal(first.manifestSha256, sha256(deploymentBytes(manifest)));
  assert.equal(first.observationsSha256, sha256(deploymentBytes(observations)));
});

test("passport publishes manifest-bound deployment transaction and artifact identities", () => {
  const transactionHash = `0x${"44".repeat(32)}` as const;
  const block = { number: "42", hash: `0x${"55".repeat(32)}` as const, timestamp: "1700000000" };
  const deployed: DeploymentManifest = { ...manifest, status: "deployed",
    token: { address: "0x0000000000000000000000000000000000000080", transactionHash, block,
      constructorArgs: "0x", artifactSha256: manifest.preparedSha256,
      compilerInputSha256: manifest.configurationSha256, genesisAllocationHash: manifest.configurationSha256 },
    grants: [{ grantId: config.grants[0].id, address: "0x0000000000000000000000000000000000000081",
      transactionHash: `0x${"66".repeat(32)}`, block, constructorArgs: "0x",
      artifactSha256: manifest.preparedSha256, compilerInputSha256: manifest.configurationSha256 }],
  };
  const passport = generatePassport(deployed, observations);
  assert.match(passport.markdown, new RegExp(transactionHash));
  assert.match(passport.markdown, new RegExp(`0x${"66".repeat(32)}`));
  assert.match(passport.markdown, /block 42/);
  assert.match(passport.markdown, /Explorer source verification and live contract state require separate checks/);
  assert.doesNotMatch(passport.markdown, /No deployment transactions recorded/);
  checkPassport(deployed, observations, passport, "1700000100");
});

test("public deployment import and passport generation need only the injected SHA-256 port", () => {
  assert.equal(sha256(new TextEncoder().encode("abc")), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const digests = [manifest.configurationSha256, manifest.preparedSha256], captured: Uint8Array[] = [];
  const passport = generateWithHash(manifest, observations, { sha256: bytes => { captured.push(bytes); return digests[captured.length - 1]!; } });
  assert.deepEqual(captured, [deploymentBytes(manifest), deploymentBytes(observations)]);
  assert.equal(passport.manifestSha256, digests[0]);
  assert.equal(passport.observationsSha256, digests[1]);
  const entrypoint = new URL("../src/features/genesis-manifest/deployment.js", import.meta.url).href;
  const script = `import { registerHooks, isBuiltin } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (isBuiltin(specifier)) throw new Error("Pure deployment imported " + specifier);
      return next(specifier, context);
    } });
    const { generatePassport } = await import(${JSON.stringify(entrypoint)});
    const result = generatePassport(${JSON.stringify(manifest)}, ${JSON.stringify(observations)}, { sha256: () => ${JSON.stringify(manifest.configurationSha256)} });
    if (result.schema !== "agtmai-token-passport-v1") throw new Error("Passport missing");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("passport checking rejects edited output and stale current observations", () => {
  const passport = generatePassport(manifest, observations);
  checkPassport(manifest, observations, passport, "1700000100");
  assert.throws(() => checkPassport(manifest, observations, { ...passport, markdown: `${passport.markdown}tampered` }, "1700000100"), /PASSPORT_MISMATCH/);
  assert.throws(() => checkPassportFreshness(observations, "1700003601"), /PASSPORT_OBSERVATIONS_EXPIRED/);
  assert.throws(() => generatePassport(manifest, { ...observations, rpcPassword: "never-publish" }), /PASSPORT_PRIVATE_FIELD/);
});

test("passport output contains no operational settings or credentials", () => {
  const passport: TokenPassport = generatePassport(manifest, observations);
  assert.doesNotMatch(passport.markdown, /password|private.?key|mnemonic|keystore/i);
  assert.doesNotMatch(JSON.stringify(passport.authorityRegistry), /password|private.?key|mnemonic|keystore/i);
});

test("authority evidence binds capability, chain and controlled contract to the manifest", () => {
  const tokenAddress = "0x0000000000000000000000000000000000000080";
  const deployed: DeploymentManifest = { ...manifest, status: "partial", token: { address: tokenAddress,
    transactionHash: manifest.evidenceSha256, block: { number: "1", hash: manifest.evidenceSha256, timestamp: "1700000000" },
    constructorArgs: "0x", artifactSha256: manifest.preparedSha256, compilerInputSha256: manifest.preparedSha256, genesisAllocationHash: manifest.configurationSha256 } };
  const safe = config.custodySafes[0];
  const authorities = [
    { capability: "token.ccip-admin", chain: "31337", controlled: tokenAddress, observed: config.token.initialCCIPAdmin },
    { capability: `custody.safe.${safe.id}`, chain: "31337", controlled: safe.address, observed: safe.address },
  ];
  const observed = { ...observations, authorities }, passport = generatePassport(deployed, observed);
  checkPassport(deployed, observed, passport, "1700000100");
  assert.equal(passport.authorityRegistry.entries.find(e => e.capability === "token.ccip-admin")!.observed, config.token.initialCCIPAdmin);
  for (const index of [0, 1]) {
    for (const patch of [{ chain: "11155111" }, { controlled: "0x0000000000000000000000000000000000000099" }, { controlled: index === 0 ? safe.address : tokenAddress }]) {
      const changed = { ...observed, authorities: authorities.map((a, i) => i === index ? { ...a, ...patch } : a) };
      assert.throws(() => generatePassport(deployed, changed), /PASSPORT_AUTHORITY_BINDING/);
      assert.throws(() => checkPassport(deployed, changed, passport), /PASSPORT_AUTHORITY_BINDING/);
    }
  }
  assert.throws(() => generatePassport(manifest, observed), /PASSPORT_AUTHORITY_BINDING/);
  assert.throws(() => generatePassport(deployed, { ...observed, authorities: [...authorities, authorities[0]!] }), /PASSPORT_AUTHORITY_DUPLICATE/);
  const unresolved = { ...authorities[0]!, capability: "token.unconfigured-authority" };
  assert.equal(generatePassport(deployed, { ...observations, authorities: [unresolved] }).authorityRegistry.entries.find(e => e.capability === unresolved.capability)!.expected, null);
  assert.throws(() => generatePassport(deployed, { ...observations, authorities: [{ ...unresolved, chain: "11155111" }] }), /PASSPORT_AUTHORITY_BINDING/);
});
