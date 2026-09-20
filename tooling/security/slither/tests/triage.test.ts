import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateFindingTriage } from "../src/application/triage.ts";
import { findingFingerprint, normalizedIdentityHash, sha256, sourceLocation } from "../src/adapters/fingerprint.ts";
import { assertSerializedAgainstSchema } from "../src/adapters/json-schema.ts";
import { parseSlitherJson } from "../src/adapters/slither-json.ts";
import type { Finding, FindingTriage, Suppression } from "../src/domain/model.ts";

const source = "contract A {}";
const base = { detectorId: "naming-convention", impact: "Informational" as const, confidence: "High", identity: "name", findingIdentityHash: normalizedIdentityHash("name"), location: sourceLocation("contracts/evm/src/A.sol", 0, 8, source) };
const finding: Finding = { ...base, fingerprint: findingFingerprint(base) };
const triage: FindingTriage = { schemaVersion: 1, fingerprint: finding.fingerprint, owner: "security", disposition: "accepted-design", rationale: "Public token constants intentionally follow Solidity constant naming.", reviewedAt: "2026-08-29T00:00:00Z" };

test("every visible lower-impact fingerprint requires exact current triage", () => {
  assert.deepEqual(validateFindingTriage([finding], [triage]), []);
  assert.match(validateFindingTriage([finding], [])[0] ?? "", /requires exactly one/u);
  assert.match(validateFindingTriage([], [triage])[0] ?? "", /stale/u);
  assert.match(validateFindingTriage([finding], [triage, triage])[0] ?? "", /unique/u);
});

test("production triage pins the exact current captured findings without suppressing them", async () => {
  const raw = await readFile("tooling/security/slither/triage.v1.json", "utf8");
  await assertSerializedAgainstSchema(raw, "tooling/security/slither/triage-ledger.schema.v1.json");
  const document = JSON.parse(raw) as {
    schemaVersion: number;
    findings: FindingTriage[];
  };
  const suppressions = JSON.parse(await readFile("tooling/security/slither/suppressions.v1.json", "utf8")) as {
    suppressions: { fingerprint: string; detectorId: string; sourceHash: string }[];
  };
  // Exact lower-impact tuples from the Linux/Docker 545ec35c4f8e6526338a5911a68cfca7d0bd34ed capture.
  const expected = [
    "sha256:140af649035e807216f8c00445e94afd9bc7ead2c6e488c07a055e1a9f4351cb",
    "sha256:14d28e3d595e6c0183a7aa9af6506913ff42e526ababa720b0740d32c25076bb",
    "sha256:3e9bbd4f4becbedeaf399132a78aae873c16832f014081535116f8d9a71b58bf",
    "sha256:41a24f69881fa7e61a657184f095cca8f63b0294157d67d51f53c35fa205be6a",
    "sha256:6968e5dfe430c2af75b3853c25e887ca502f113bf9bda91f9534c82162306811",
    "sha256:8263a454f64d24c9db2b6ba6d64e2f87cd69bd6a25d40eeb480da1133e77acfa",
    "sha256:83f6581c3996d4e9b5968b277ce1ff495a578911f308179538cc8f86ed788d8c",
    "sha256:8dcdc97543baa44ed283ce33a2c4fc42bc59911a37b8b2d132787666173d54ff",
    "sha256:9d8ec352a3f51ab1633f119d920d738e74bfeac64ffdcae6a3f53ae7bcf64272",
    "sha256:cf3dec3433de4ea4c848ce18b2dcf0c2b034f800f9d37f47f038d32f767ebad1",
    "sha256:fb34e078e26432fff83d02582abcd0a15d915cf968edc1caa59ceb40a395ba82",
    "sha256:1b33a698b01a9588c2bfec6ab5c8d99b225d34821f174554f641cea86ff593a2",
    "sha256:5a4b67c294acc3ba734748554fb15f29296b9891f20cd24cd62e61f05cb908b0",
    "sha256:6a9eb1b35262e570240d647216f6240aaf9f3eb1c0b615e3542f48e96da43396",
    "sha256:6cba562ee91147d937d6c16b1094a83f333df909e852a027a4c6a4a463777443",
    "sha256:7ea3b090f6f4b90c801214b373cbbc46e2cca220e127347e382744940042cb50",
    "sha256:9f0e4495f3006b7bb7fed724098975f75fd3bcccff3280c5adb0df856aca2dcf",
    "sha256:ce70f4037558f57df4f3b299af5765113c5fa6ada98b6b6a94d33fd6d36d1d26",
    "sha256:d5b879fba117edb58befc8d6fc53ae3adf138e611a7327c5332e65a692664ccc",
    "sha256:efd8f5efafa87c1fad1e76342676ba8f2eb7122649f114a86e52179845e748c5",
    "sha256:03811eb0729f1b47fa5d6cc36b162e3201d5605cf0cc697eb924c69c4c5bbefa",
    "sha256:0f1d1c70209c5a29a2a0a0969a4e11db4873f900ece437fbe18c6046930becad",
    "sha256:28f7103fa97fa3384f7e4a34e1cb5e888d24a6cd887580063a28d87601fc80d4",
    "sha256:475ac45ba5b092391c7ff99a3f85070b1d139f60fad980a153f566b1b064aafa",
    "sha256:003f4189357671c77ad24948da07946de03f4ebcb69ed7d421dfde7eb06ee861",
    "sha256:7401973b9268b84a98fb8aaeee22a9d2bc8768c98fc79d239e36958736c98e32",
    "sha256:7ba28f1a745ec296842bb58a3b031fad40c857450e551b1376434d2b483e02b2",
    "sha256:b350056771ccd86c45901ba4efdcd3c8a3464ce6f03d85423144a9b59a7a04cd",
    "sha256:bf758266512a4c93aab2a313ae2604ecbd732624e1546f8ed413946b79e51fd2",
    "sha256:c9d6c5db026446d352bc82a40e2aff339aeb764aeeca2e828300c25ad9b352f0",
    "sha256:d59a459510dbbd608781cecfe1224b5fd2dd2100c5b454cd3ec954851f709c5c",
    "sha256:c0733ba38c14da5a9d324c802dd805bcc8a45546848291ed757360f735669575"
  ];
  const reviewedDates = [
    "2026-08-29T00:00:00.000Z",
    "2026-09-20T00:00:00Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-09-20T00:00:00Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z",
    "2026-09-20T00:00:00Z"
  ];

  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.findings.map(({ fingerprint }) => fingerprint), expected);
  assert.ok(document.findings.every(({ owner }) => owner === "project-security"));
  assert.deepEqual(document.findings.map(({ reviewedAt }) => reviewedAt), reviewedDates);
  assert.ok(document.findings.every(({ rationale }) => rationale.trim().length >= 20));
  assert.deepEqual(suppressions.suppressions.map(({ fingerprint, detectorId, sourceHash }) => ({ fingerprint, detectorId, sourceHash })), [
    {
      fingerprint: "sha256:704c6fd405b64b61d8f0712240be87d8ce8b180287dc75322e25459bd3cea098",
      detectorId: "divide-before-multiply",
      sourceHash: "sha256:52b9f943411da5187a7660d8125f2801f6ade1dc0271c660f4b6ee49b5efe13d",
    },
    {
      fingerprint: "sha256:4827979f6c7702c447c128b9ee3a92daf133e21a3c4c1ae04ea84b73db49d20c",
      detectorId: "arbitrary-send-erc20",
      sourceHash: "sha256:673cad0516c8e0068aa495e8fa5e93ae43cc84547b57c9bd824daec292e56a80",
    },
    {
      fingerprint: "sha256:215db270cb5c8b1b79276042836966fc232c64b95ebd3085077f64010c970d75",
      detectorId: "incorrect-equality",
      sourceHash: "sha256:000656119ee066eedb72da76ef58f92025babfbb1ba364cd6f2d50638e5de0eb"
    },
    {
      fingerprint: "sha256:2349fcc51da883d63261f98dc18fd31a99186bb09f260f76fd38d97ea5232cfe",
      detectorId: "incorrect-equality",
      sourceHash: "sha256:000656119ee066eedb72da76ef58f92025babfbb1ba364cd6f2d50638e5de0eb"
    },
    {
      fingerprint: "sha256:6b496e82a330be04da27ab83300479b7359bc41222809ffa97153abed467ae28",
      detectorId: "incorrect-equality",
      sourceHash: "sha256:000656119ee066eedb72da76ef58f92025babfbb1ba364cd6f2d50638e5de0eb"
    },
    {
      fingerprint: "sha256:183d2d275f060287166d43e5a3fe689cabc763a4505a248ffbcd6ac2e3b958db",
      detectorId: "divide-before-multiply",
      sourceHash: "sha256:471174e40cbc33a761285f6d6e327cf25c337c76b612d785f644026dfbc30986"
    },
    {
      fingerprint: "sha256:a0ea426b4266d3b089c430ac69847e2b78db0e8ee14816a09824dd37064a9f30",
      detectorId: "incorrect-equality",
      sourceHash: "sha256:000656119ee066eedb72da76ef58f92025babfbb1ba364cd6f2d50638e5de0eb"
    },
    {
      fingerprint: "sha256:d9136af21e57d4b9adffe88e9577b07ad6df4ebf350a5ed388e24719c4e73ac6",
      detectorId: "uninitialized-local",
      sourceHash: "sha256:000656119ee066eedb72da76ef58f92025babfbb1ba364cd6f2d50638e5de0eb"
    },
    {
      fingerprint: "sha256:e8e7464fb50f08c474434449f181f8daacda04e35fcc631afee1b47a12ed03f0",
      detectorId: "reentrancy-no-eth",
      sourceHash: "sha256:000656119ee066eedb72da76ef58f92025babfbb1ba364cd6f2d50638e5de0eb"
    },
  ]);
});

// A live ledger update must never silently re-authorize historical captured output.
test("historical captured findings require retained triage and reject current triage", async () => {
  const historicalRaw = await readFile("tooling/security/slither/tests/fixtures/triage.8977f78.json", "utf8");
  assert.equal(sha256(historicalRaw), "da21f8a8a21ef827e4c96afc0d1a6a4527c63c5f66c6c1f7d46a915ad34c2cfe");
  const historical = JSON.parse(historicalRaw) as { findings: FindingTriage[] };
  const current = JSON.parse(await readFile("tooling/security/slither/triage.v1.json", "utf8")) as { findings: FindingTriage[] };
  const parsed = await parseSlitherJson(await readFile("tooling/security/slither/tests/fixtures/slither-0.11.6-production.json", "utf8"), process.cwd());
  assert.deepEqual(validateFindingTriage(parsed.findings, historical.findings), []);
  const errors = validateFindingTriage(parsed.findings, current.findings);
  assert.equal(errors.length, 22);
  assert.ok(errors.some((error) => error.includes("467424bcf1a60111645314c6c00da8f7fba5ddeb991f55d82eae0cd5b54c4742 requires exactly one")));
  assert.ok(errors.some((error) => error.includes("7ba28f1a745ec296842bb58a3b031fad40c857450e551b1376434d2b483e02b2 is stale")));
});

// Observed tuples from the real pinned host capture at 545ec35; no Docker replay here.
test("founder reserve capture binds every refreshed tuple to exact current source bytes", async () => {
  const captured: Finding[] = [
    {
      "detectorId": "naming-convention",
      "impact": "Informational",
      "confidence": "High",
      "identity": "Variable FounderGrantReserve.TOKEN (src/features/contributor-grants/FounderGrantReserve.sol#17) is not in mixedCase",
      "findingIdentityHash": "sha256:7740b5a101f72167bfb26f440d5669aced16d888f516cbb308888a78e27a58c4",
      "location": {
        "path": "contracts/evm/src/features/contributor-grants/FounderGrantReserve.sol",
        "start": 717,
        "length": 34,
        "sourceHash": "sha256:471174e40cbc33a761285f6d6e327cf25c337c76b612d785f644026dfbc30986",
        "snippetHash": "sha256:9f0f3b238caccc0e3e705a88569e4a73e6e88bc175b4a94311ae197e5960b922"
      },
      "fingerprint": "sha256:003f4189357671c77ad24948da07946de03f4ebcb69ed7d421dfde7eb06ee861"
    },
    {
      "detectorId": "divide-before-multiply",
      "impact": "Medium",
      "confidence": "Medium",
      "identity": "FounderGrantReserve.constructor(AGTMAIToken,address,address,GrantAccounting.Terms) (src/features/contributor-grants/FounderGrantReserve.sol#20-35) performs a multiplication on the result of a division: - supply == 0 || supply % 100 != 0 || terms.allocation != supply / 100 * 3 || terms.kind != GrantAccounting.Kind.Founder (src/features/contributor-grants/FounderGrantReserve.sol#29-30)",
      "findingIdentityHash": "sha256:7136a5da976f1a788ddfda5f66d7879dfd2ed4098263d04808ea2d0b21831619",
      "location": {
        "path": "contracts/evm/src/features/contributor-grants/FounderGrantReserve.sol",
        "start": 797,
        "length": 658,
        "sourceHash": "sha256:471174e40cbc33a761285f6d6e327cf25c337c76b612d785f644026dfbc30986",
        "snippetHash": "sha256:2cbb7207769bea32178008ce64f526c70b96372d3ee26055c4e2cd19bf288784"
      },
      "fingerprint": "sha256:183d2d275f060287166d43e5a3fe689cabc763a4505a248ffbcd6ac2e3b958db"
    },
    {
      "detectorId": "naming-convention",
      "impact": "Informational",
      "confidence": "High",
      "identity": "Variable FounderGrantReserve.VAULT (src/features/contributor-grants/FounderGrantReserve.sol#18) is not in mixedCase",
      "findingIdentityHash": "sha256:aea3a54dc8e2252456f1eea724769e47cf42ff2eb3670d8b4701a6c0e2e2b8a6",
      "location": {
        "path": "contracts/evm/src/features/contributor-grants/FounderGrantReserve.sol",
        "start": 757,
        "length": 33,
        "sourceHash": "sha256:471174e40cbc33a761285f6d6e327cf25c337c76b612d785f644026dfbc30986",
        "snippetHash": "sha256:edfc3776533ca134e98bb501afc16778c6256659862a5e57c5a463800312c158"
      },
      "fingerprint": "sha256:c0733ba38c14da5a9d324c802dd805bcc8a45546848291ed757360f735669575"
    }
  ];
  const { suppressions } = JSON.parse(await readFile("tooling/security/slither/suppressions.v1.json", "utf8")) as {
    suppressions: Suppression[];
  };
  const { findings: currentTriage } = JSON.parse(await readFile("tooling/security/slither/triage.v1.json", "utf8")) as {
    findings: FindingTriage[];
  };
  for (const observed of captured) {
    const { path, start, length } = observed.location;
    assert.deepEqual(sourceLocation(path, start, length, await readFile(path, "utf8")), observed.location);
    assert.equal(normalizedIdentityHash(observed.identity), observed.findingIdentityHash);
    assert.equal(findingFingerprint(observed), observed.fingerprint);
    if (observed.impact === "Medium") {
      const matches = suppressions.filter(({ path: sourcePath }) => sourcePath === path);
      assert.equal(matches.length, 1);
      const { fingerprint, detectorId, findingIdentityHash, path: sourcePath, start: suppressionStart, length: suppressionLength, sourceHash, snippetHash } = matches[0]!;
      assert.deepEqual({ fingerprint, detectorId, findingIdentityHash, location: { path: sourcePath, start: suppressionStart, length: suppressionLength, sourceHash, snippetHash } }, {
        fingerprint: observed.fingerprint, detectorId: observed.detectorId,
        findingIdentityHash: observed.findingIdentityHash, location: observed.location,
      });
    } else {
      assert.deepEqual(validateFindingTriage([observed], currentTriage.filter(({ fingerprint }) => fingerprint === observed.fingerprint)), []);
    }
  }
});
