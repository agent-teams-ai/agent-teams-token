import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkPassport, checkPassportFreshness, generatePassport, type PassportObservation, type TokenPassport } from "../src/features/genesis-manifest/application/passport.js";
import { renderAuthorityRegistry, renderPassport } from "../src/features/genesis-manifest/adapters/passport-render.js";
import type { DeploymentManifest } from "../src/features/genesis-manifest/application/deployment-manifest.js";

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
  assert.match(first.markdown, /vault `unresolved`/);
  assert.ok(first.authorityRegistry.entries.every(entry => entry.expected !== null));
  assert.equal(new TextDecoder().decode(renderPassport(first)), first.markdown);
  assert.match(new TextDecoder().decode(renderAuthorityRegistry(first)), /agtmai-authority-registry-v1/);
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
