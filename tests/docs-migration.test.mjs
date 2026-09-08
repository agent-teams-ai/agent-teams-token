import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { docsCheckV2 } from '@agent-teams/docs-protocol';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillPath = '.agents/skills/docs-authoring/SKILL.md';
const profilePath = 'architecture/foundation/docs-protocol.yaml';
const read = (path) => readFile(resolve(root, path), 'utf8');
const desiredSkill = await read(skillPath);
const authorityPaths = ['architecture/foundation/document-authoring.yaml', 'docs/owners.yaml',
  'docs/document-metadata.yaml', 'docs/document-metadata.schema.json'];
async function inspectSkill(skill, route) {
  route ??= await read('AGENTS.md');
  const consumerRoot = await mkdtemp(resolve(tmpdir(), 'token-docs-adoption-'));
  try {
    await cp(resolve(root, 'docs'), resolve(consumerRoot, 'docs'), { recursive: true });
    for (const [path, bytes] of [[skillPath, skill], ['AGENTS.md', route],
      ...await Promise.all([profilePath, ...authorityPaths].map(async (p) => [p, await read(p)]))]) {
      await mkdir(dirname(resolve(consumerRoot, path)), { recursive: true });
      await writeFile(resolve(consumerRoot, path), bytes);
    }
    return await docsCheckV2({ consumerRoot, profilePath });
  } finally { await rm(consumerRoot, { recursive: true, force: true }); }
}

test('public check accepts the executable consumer workflow and complete catalog', async () => {
  const result = await inspectSkill(desiredSkill);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(desiredSkill, /--apply --expect "\$PLAN_DIGEST"/);
  assert.match(desiredSkill, /pnpm docs:protocol:check/);
});

for (const scenario of ['historical Skill', 'missing context', 'duplicate route']) {
  test(`public check refuses ${scenario} with adoption diagnostics`, async () => {
    let skill = desiredSkill;
    let route = await read('AGENTS.md');
    if (scenario === 'historical Skill') {
      skill = await readFile(new URL('./fixtures/docs-migration/skill-before.md', import.meta.url), 'utf8');
    } else if (scenario === 'missing context') {
      skill = skill.split('\n').filter(line => !line.includes('docs-protocol context')).join('\n');
    } else {
      route += `Use [${skillPath}](${skillPath}) for documentation.\n`;
    }
    const result = await inspectSkill(skill, route);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert.ok(result.envelope.diagnostics.some(d => d.ruleId === 'docs.adoption.invalid'), JSON.stringify(result));
  });
}

test('exactly three managed development roots and age exceptions retain all existing gates', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const roots = {
    '@agent-teams/docs-protocol': '0.6.0',
    '@agent-teams/docs-protocol-agent-teams': '0.2.0',
    '@agent-teams/engineering-foundation': '1.1.0',
  };
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.devDependencies)
    .filter(([name]) => name.startsWith('@agent-teams/'))), roots);
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(Object.keys(manifest[section] ?? {}).filter(name => name.startsWith('@agent-teams/')), []);
  }
  // Authoring 0.3.0 and Mutation 0.2.0 belong to the separately verified
  // transitive archive closure and require exact age exceptions; unused MCP stays absent.
  const workspace = await read('pnpm-workspace.yaml');
  assert.equal(workspace, "packages:\n  - apps/*\n  - packages/*\nminimumReleaseAgeExclude:\n"
    + Object.entries(roots).filter(([name]) => name !== '@agent-teams/docs-protocol-agent-teams')
      .map(([name, version]) => `  - '${name}@${version}'\n`).join('')
    + "  - '@agent-teams/docs-protocol-agent-teams@0.2.0'\n"
    + "  - '@agent-teams/document-authoring@0.3.0'\n"
    + "  - '@agent-teams/repository-mutation@0.2.0'\n");
  assert.equal(manifest.packageManager, 'pnpm@11.24.0');
  assert.equal(manifest.scripts['test:docs-migration'], 'node --test tests/docs-migration.test.mjs');
  assert.equal(manifest.scripts.check, 'pnpm foundation:assert-dev-only && pnpm foundation:assert-registry && pnpm foundation:check && pnpm test:foundation-gates && pnpm docs:protocol:check && pnpm test:docs-migration && pnpm lint && pnpm typecheck && pnpm test');
  assert.equal(JSON.parse(await read('architecture/foundation/docs-protocol-qualification.json')).schemaVersion, 2);
});
test('portable change is exact and Authoring stays v3 with all three types', async () => {
  const portable = await read(profilePath);
  const before = await readFile(new URL('./fixtures/docs-migration/portable-before.yaml', import.meta.url), 'utf8');
  assert.equal(portable, before.replace('schemaVersion: 2', 'schemaVersion: 3')
    .replace('agentWorkflow:\n', 'agentWorkflow:\n  adoption: portable-v1\n'));
  const authoring = await read('architecture/foundation/document-authoring.yaml');
  assert.match(authoring, /^schemaVersion: 3\n/);
  assert.deepEqual([...authoring.matchAll(/^    - type: (.*)$/gm)].map(m => m[1]),
    ['adr', 'architecture', 'open-decision']);
});
