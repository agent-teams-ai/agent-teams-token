import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
// Resolve the installed package's declared public executable, never sibling source.
const manifestUrl = import.meta.resolve('@agent-teams/engineering-foundation/package.json');
const installed = JSON.parse(await readFile(new URL(manifestUrl), 'utf8'));
const cli = fileURLToPath(new URL(installed.bin['agent-teams-foundation'], manifestUrl));
const capability = 'architecture.source-dependencies';
const policyPath = 'architecture/foundation/source-dependencies.yaml';
const rootConfig = `schemaVersion: 1
project: {id: agent-teams-token}
capabilities:
  architecture.source-dependencies:
    configPath: architecture/foundation/source-dependencies.yaml
`;
const policy = `schemaVersion: 2
workspace: {kind: pnpm, manifest: pnpm-workspace.yaml}
packageRoots: [packages]
governedRoots: [packages/domain/src]
boundaries:
  - id: token-domain
    dependencyMode: runtime
    roots: [packages/domain/src/supply.ts]
    entrypoints: [packages/domain/src/supply.ts]
    allow: {boundaries: [], packages: [], builtins: [], runtimeReferences: []}
  - id: token-domain-tests
    dependencyMode: development
    roots: [packages/domain/src/supply.test.ts]
    entrypoints: []
    allow:
      boundaries: [token-domain]
      packages: []
      builtins: [node:assert/strict, node:test]
      runtimeReferences: []
`;
const read = (dir, path) => readFile(resolve(dir, path), 'utf8');
async function put(dir, path, bytes) {
  await mkdir(dirname(resolve(dir, path)), { recursive: true });
  await writeFile(resolve(dir, path), bytes);
}
async function contract(dir) {
  // Deliberately independent accepted policy: an edited root cannot disable this gate.
  assert.equal(await read(dir, 'foundation.config.yaml'), rootConfig, 'required capability contract');
  assert.equal(await read(dir, policyPath), policy, 'required source universe and boundary contract');
}
async function fixture(run) {
  const dir = await mkdtemp(resolve(tmpdir(), 'token-foundation-gates-'));
  try {
    for (const path of ['foundation.config.yaml', policyPath, 'package.json', 'pnpm-workspace.yaml', 'packages']) {
      await mkdir(dirname(resolve(dir, path)), { recursive: true });
      await cp(resolve(root, path), resolve(dir, path), { recursive: true });
    }
    // Include future materialized apps instead of silently hiding them from discovery.
    try { await cp(resolve(root, 'apps'), resolve(dir, 'apps'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await contract(dir);
    await run(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function check(dir) {
  const result = spawnSync(process.execPath, [cli, 'check', '--consumer', dir, '--format', 'json'],
    { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok(result.stdout, result.stderr);
  return { code: result.status, report: JSON.parse(result.stdout) };
}
function passed(dir) {
  const { code, report } = check(dir);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.outcome, 'passed');
  assert.equal(report.coverage, 'full');
  assert.deepEqual(report.capabilities.map(c => [c.capabilityId, c.capabilityConfigSchemaVersion, c.outcome]),
    [[capability, 2, 'passed']]);
}
async function inventory(dir, path = 'packages') {
  const result = [];
  for (const entry of await readdir(resolve(dir, path), { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
    const name = `${path}/${entry.name}`;
    assert.equal(entry.isSymbolicLink(), false, `unexpected source symlink: ${name}`);
    if (entry.isDirectory()) result.push(...await inventory(dir, name));
    else if (entry.name === 'package.json' || /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(entry.name)) result.push(name);
  }
  return result.sort();
}
test('accepted Source v2 policy covers the actual package and both unchanged source files', async () => {
  await contract(root);
  assert.deepEqual(await inventory(root), ['packages/domain/package.json',
    'packages/domain/src/supply.test.ts', 'packages/domain/src/supply.ts']);
  await fixture(async dir => {
    const files = await inventory(dir);
    const before = await Promise.all(files.map(p => read(dir, p)));
    passed(dir);
    assert.deepEqual(await Promise.all(files.map(p => read(dir, p))), before);
    assert.deepEqual(await Promise.all(files.map(p => read(root, p))), before);
  });
});
const supply = 'packages/domain/src/supply.ts';
const scenarios = [
  ['network builtin', supply, 'import "node:http";\n', 'forbidden-builtin-dependency'],
  ['runtime imports test', supply, 'import "./supply.test.js";\n', 'runtime-boundary-imports-development-boundary'],
  ['Foundation in runtime', supply, 'import "@agent-teams/engineering-foundation";\n', 'forbidden-package-dependency'],
  ['unowned src', 'packages/domain/src/unowned.ts', 'export {};\n', 'unclassified-source-file'],
  ['source outside governed root', 'packages/domain/extra.ts', 'export {};\n', 'unclassified-source-file'],
  ['new package', 'packages/unowned/src/index.ts', 'export {};\n', 'uncovered-workspace-package-root'],
  ['excluded new package', 'packages/unowned/src/index.ts', 'export {};\n', 'uncovered-workspace-package-root'],
];
for (const [name, path, addition, rule] of scenarios) {
  test(`public full check refuses ${name}, then passes restored preimage`, async () => fixture(async dir => {
    passed(dir);
    const original = path === supply ? await read(dir, path) : null;
    const workspace = await read(dir, 'pnpm-workspace.yaml');
    if (name.includes('new package')) {
      await put(dir, 'packages/unowned/package.json', JSON.stringify({ name: '@agent-teams/unowned', private: true }));
    }
    if (name === 'excluded new package') {
      await put(dir, 'pnpm-workspace.yaml', workspace.replace('  - packages/*', "  - packages/*\n  - '!packages/unowned'"));
    }
    // Parsed as text only. Never import or execute these fixture modules.
    await put(dir, path, addition + (original ?? ''));
    const { code, report } = check(dir);
    assert.equal(code, 1, JSON.stringify(report));
    assert.equal(report.outcome, 'violations');
    assert.ok(report.capabilities.flatMap(c => c.diagnostics).some(d => d.ruleId === `${capability}.${rule}`), JSON.stringify(report));
    if (original !== null) await put(dir, path, original);
    else await rm(resolve(dir, name.includes('new package') ? 'packages/unowned' : path), { recursive: true });
    await put(dir, 'pnpm-workspace.yaml', workspace);
    await contract(dir);
    passed(dir);
  }));
}
for (const scenario of ['missing config', 'empty capabilities', 'replacement capability', 'narrowed roots']) {
  test(`consumer gate refuses ${scenario}`, async () => fixture(async dir => {
    passed(dir);
    if (scenario === 'missing config') await rm(resolve(dir, 'foundation.config.yaml'));
    if (scenario === 'empty capabilities') await put(dir, 'foundation.config.yaml', 'schemaVersion: 1\nproject: {id: agent-teams-token}\ncapabilities: {}\n');
    if (scenario === 'replacement capability') {
      await put(dir, 'foundation.config.yaml', rootConfig.replace(capability, 'documentation.local-references').replace(policyPath, 'references.yaml'));
      await put(dir, 'references.yaml', 'schemaVersion: 1\nmarkdownRoots: [docs]\nanchorProfile: github\n');
      await put(dir, 'docs/README.md', '# Fixture\n');
      assert.equal(check(dir).report.outcome, 'passed'); // Green alternate capability is insufficient.
    }
    if (scenario === 'narrowed roots') await put(dir, policyPath, policy.replace('governedRoots: [packages/domain/src]', 'governedRoots: [packages/domain/src/empty]'));
    await assert.rejects(() => contract(dir));
    if (scenario === 'missing config' || scenario === 'empty capabilities') {
      const { code, report } = check(dir);
      assert.equal(code, 2, JSON.stringify(report));
      assert.equal(report.outcome, 'invalid-input');
      if (scenario === 'missing config') assert.equal(report.problem.code, 'CONFIG_FILE_UNAVAILABLE');
    }
    await put(dir, 'foundation.config.yaml', rootConfig);
    await put(dir, policyPath, policy);
    await contract(dir);
    passed(dir);
  }));
}
test('all six public aliases and blocking CI routing remain explicit', async () => {
  const pkg = JSON.parse(await read(root, 'package.json'));
  for (const command of ['check', 'status', 'attach', 'detach', 'assert-dev-only', 'assert-registry']) {
    assert.equal(pkg.scripts[`foundation:${command}`], `agent-teams-foundation ${command}`);
  }
  assert.equal(pkg.scripts['test:foundation-gates'], 'node --test tests/foundation-gates.test.mjs');
  const ci = await read(root, '.github/workflows/ci.yml');
  for (const event of ['pull_request', 'merge_group', 'push']) assert.match(ci, new RegExp(`^  ${event}:`, 'm'));
  assert.match(ci, /- run: pnpm check\s*$/m);
  assert.doesNotMatch(ci, /continue-on-error:|paths-ignore:|paths:|\bif:/);
});

test('a materialized apps workspace cannot silently escape packageRoots', async () => fixture(async dir => {
  passed(dir);
  await put(dir, 'apps/future/package.json', JSON.stringify({ name: '@agent-teams/future', private: true }));
  await put(dir, 'apps/future/src/index.ts', 'export {};\n');
  const { code, report } = check(dir);
  assert.equal(code, 2, JSON.stringify(report));
  assert.match(JSON.stringify(report), /WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS/);
  await rm(resolve(dir, 'apps/future'), { recursive: true });
  passed(dir);
}));

function placement(dir) {
  const result = spawnSync(process.execPath, [cli, 'assert-dev-only', '--consumer', dir, '--json'],
    { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { code: result.status, report: JSON.parse(result.stdout) };
}
for (const scenario of ['runtime placement', 'floating version', 'local override']) {
  test(`public development assertion refuses ${scenario}`, async () => fixture(async dir => {
    const original = await read(dir, 'package.json');
    assert.equal(placement(dir).code, 0);
    const pkg = JSON.parse(original);
    if (scenario === 'runtime placement') {
      pkg.dependencies = { '@agent-teams/engineering-foundation': pkg.devDependencies['@agent-teams/engineering-foundation'] };
      delete pkg.devDependencies['@agent-teams/engineering-foundation'];
    } else if (scenario === 'floating version') pkg.devDependencies['@agent-teams/engineering-foundation'] = '^1.1.0';
    else pkg.pnpm = { overrides: { '@agent-teams/engineering-foundation': 'link:../foundation' } };
    await put(dir, 'package.json', JSON.stringify(pkg));
    const result = placement(dir);
    assert.equal(result.code, 2, JSON.stringify(result.report));
    assert.equal(result.report.outcome, 'invalid-input');
    assert.equal(result.report.error.code, 'CONSUMER_INVALID');
    const reason = { 'runtime placement': /must not be declared in dependencies/,
      'floating version': /must use an exact registry version/, 'local override': /must not use pnpm overrides/ };
    assert.match(result.report.error.message, reason[scenario]);
    await put(dir, 'package.json', original);
    assert.equal(placement(dir).code, 0);
  }));
}
