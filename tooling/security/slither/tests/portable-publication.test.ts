import assert from "node:assert/strict";
import fs, { mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { SlitherCancellation } from "../src/application/ports.ts";
import { ExclusiveDirectoryPublication, copyStableExclusive, writeEnvironmentFailure } from "../src/adapters/evidence.ts";
import { schemaDirectory } from "./evidence-canonical-fixture.ts";
import { testPublication } from "./test-publication.ts";
import { makeTestDirectory } from "./test-directory.ts";

const precondition = async (): Promise<void> => {};

async function afterDestinationSync<T>(action: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  const probe = await open("/dev/null", "r"); const prototype = Object.getPrototypeOf(probe) as {sync(): Promise<void>}; const original = prototype.sync; await probe.close();
  prototype.sync = async function (): Promise<void> {await original.call(this); await action();};
  try {return await run();} finally {prototype.sync = original;}
}

test("descriptor transfer remains bound to the opened source when its pathname is replaced", async () => {
  const parent = await makeTestDirectory("descriptor-replace-");
  const source = join(parent, "source"); const destination = join(parent, "destination");
  try {
    await writeFile(source, "authenticated", {mode: 0o600});
    await assert.rejects(afterDestinationSync(async () => {await rm(source); await writeFile(source, "replacement", {mode: 0o600});}, async () => await copyStableExclusive(source, destination)), /staging entry changed/u);
    assert.equal(await readFile(destination, "utf8"), "authenticated");
    assert.equal(await readFile(source, "utf8"), "replacement");
  } finally {await rm(parent, {recursive: true, force: true});}
});

test("descriptor transfer rejects a destination collision without replacing or deleting it", async () => {
  const parent = await makeTestDirectory("descriptor-collision-");
  const source = join(parent, "source"); const destination = join(parent, "destination");
  try {
    await writeFile(source, "authenticated", {mode: 0o600}); await writeFile(destination, "foreign", {mode: 0o600});
    await assert.rejects(copyStableExclusive(source, destination));
    assert.equal(await readFile(destination, "utf8"), "foreign");
  } finally {await rm(parent, {recursive: true, force: true});}
});

test("descriptor transfer rejects source mutation after copying", async () => {
  const parent = await makeTestDirectory("descriptor-mutation-");
  const source = join(parent, "source"); const destination = join(parent, "destination");
  try {
    await writeFile(source, "original", {mode: 0o600});
    await assert.rejects(afterDestinationSync(async () => {await writeFile(source, "changed!", {mode: 0o600});}, async () => await copyStableExclusive(source, destination)), /staging entry changed/u);
    assert.equal(await readFile(destination, "utf8"), "original");
  } finally {await rm(parent, {recursive: true, force: true});}
});

test("publication accepts a stable parent alias and remains accessible through it", async () => {
  const parent = await makeTestDirectory("publication-alias-"); const canonical = join(parent, "canonical"); const alias = join(parent, "alias");
  try {
    await mkdir(canonical); await symlink(canonical, alias); const output = join(alias, "bundle");
    await writeEnvironmentFailure({output, candidateSha: "d".repeat(40), stage: "image-preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: precondition, publication: testPublication()});
    assert.equal((await readFile(join(output, "READY"))).length, 0);
    assert.equal(JSON.parse(await readFile(join(output, "environment-failure.json"), "utf8")).ready, true);
  } finally {await rm(parent, {recursive: true, force: true});}
});

const originals = {lstat: fs.lstat, open: fs.open, readdir: fs.readdir, rm: fs.rm, rmdir: fs.rmdir, link: fs.link};
type PublicationPhase = "acquisition" | "copy" | "validation" | "READY" | "staging-cleanup";

async function publicationFixture(t: TestContext) {
  const parent = await makeTestDirectory("publication-cancel-");
  const output = join(parent, "bundle");
  const controller = new AbortController();
  const reason = new SlitherCancellation("SIGTERM");
  const publication = new ExclusiveDirectoryPublication(controller.signal);
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await originals.rm(parent, {recursive: true, force: true});
  });
  return {parent, output, controller, reason, publication, run: async () => {
    await writeEnvironmentFailure({output, candidateSha: "d".repeat(40), stage: "image-preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: precondition, publication});
  }};
}

function atPublicationSeam(t: TestContext, output: string, phase: PublicationPhase, action: (path: string) => Promise<void>): void {
  let visited = false;
  const visit = async (path: string, matches: boolean): Promise<void> => {
    if (matches && !visited) { visited = true; await action(path); }
  };
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const result = await originals.lstat(...args);
    await visit(String(args[0]), phase === "acquisition" && String(args[0]) === output);
    return result;
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const result = await originals.open(...args);
    await visit(String(args[0]), phase === "copy" && String(args[0]) === join(output, "environment-failure.json"));
    return result;
  });
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const result = await originals.readdir(...args);
    await visit(String(args[0]), phase === "validation" && String(args[0]) === output);
    return result;
  });
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
    await originals.link(...args);
    await visit(String(args[1]), phase === "READY" && String(args[1]) === join(output, "READY"));
  });
  t.mock.method(fs, "rmdir", async (...args: Parameters<typeof fs.rmdir>) => {
    await visit(String(args[0]), phase === "staging-cleanup" && String(args[0]).includes(".bundle.staging-"));
    await originals.rmdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {assert.ok(visited, `actual ${phase} seam was reached`);});
}

function flatten(error: unknown): unknown[] { return error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]; }

for (const phase of ["acquisition", "copy", "validation", "READY", "staging-cleanup"] as const) {
  test(`real publication cancels at async ${phase} and leaves no failure READY`, async (t) => {
    const fixture = await publicationFixture(t);
    atPublicationSeam(t, fixture.output, phase, async () => {
      await new Promise<void>((resolve) => {setImmediate(resolve);});
      fixture.controller.abort(fixture.reason);
      fixture.controller.abort(new SlitherCancellation("SIGINT"));
    });
    await assert.rejects(fixture.run(), (error: unknown) => {
      assert.deepEqual(flatten(error), [fixture.reason]); return true;
    });
    assert.equal(fixture.controller.signal.reason.exitCode, 143);
    await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
    assert.equal((await fs.readdir(fixture.parent)).some((name) => name.includes(".staging-")), false);
  });
}

for (const replacement of ["marker", "output", "ancestor"] as const) {
  test(`READY revocation preserves a substituted ${replacement} and reports uncertainty`, async (t) => {
    const fixture = await publicationFixture(t);
    const moved = join(fixture.parent, "retained");
    const ancestorMoved = `${fixture.parent}-retained`;
    t.after(async () => {await originals.rm(ancestorMoved, {recursive: true, force: true});});
    atPublicationSeam(t, fixture.output, "READY", async (marker) => {
      if (replacement === "marker") {await rename(marker, moved);}
      else if (replacement === "output") {await rename(fixture.output, moved); await mkdir(fixture.output, {mode: 0o700});}
      else {await rename(fixture.parent, ancestorMoved); await mkdir(fixture.parent, {mode: 0o700}); await mkdir(fixture.output, {mode: 0o700});}
      await writeFile(marker, "foreign", {mode: 0o600});
      fixture.controller.abort(fixture.reason);
    });
    await assert.rejects(fixture.run(), (error: unknown) => {
      assert.ok(flatten(error).includes(fixture.reason));
      assert.ok(flatten(error).some((entry) => entry instanceof Error && /changed/u.test(entry.message)));
      return true;
    });
    assert.equal(await readFile(join(fixture.output, "READY"), "utf8"), "foreign");
  });
}

test("revocation authority survives successful writer return without retaining file descriptors", async (t) => {
  const fixture = await publicationFixture(t);
  await fixture.run();
  assert.equal(await readFile(join(fixture.output, "READY"), "utf8"), "");
  assert.equal((await fs.lstat(join(fixture.output, "READY"))).nlink, 1);
  fixture.controller.abort(fixture.reason);
  await fixture.publication.revoke();
  await fixture.publication.revoke();
  await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
});

test("staging cleanup failure revokes READY and retains the original error", async (t) => {
  const fixture = await publicationFixture(t);
  const failure = new Error("synthetic staging cleanup failure");
  atPublicationSeam(t, fixture.output, "staging-cleanup", async () => {throw failure;});
  await assert.rejects(fixture.run(), (error: unknown) => error === failure);
  await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
});

test("staging path replacement is preserved while the owned output marker is revoked", async (t) => {
  const fixture = await publicationFixture(t);
  let substituted = "";
  const publish = fixture.publication.publishNoReplace.bind(fixture.publication);
  t.mock.method(fixture.publication, "publishNoReplace", async (...args: Parameters<typeof publish>) => {
    await publish(...args);
    substituted = args[0];
    await rename(substituted, join(fixture.parent, "retained-staging"));
    await mkdir(substituted, {mode: 0o700});
    await writeFile(join(substituted, "foreign"), "preserved");
  });
  await assert.rejects(fixture.run(), /publication staging changed/u);
  assert.equal(await readFile(join(substituted, "foreign"), "utf8"), "preserved");
  await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
});

for (const failureAt of ["stat", "close"] as const) {
  test(`READY ${failureAt} failure uses pre-acquired identity and closes each descriptor once`, async (t) => {
    const fixture = await publicationFixture(t);
    const failure = new Error(`synthetic READY ${failureAt} failure`);
    let closeCalls = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originals.open(...args);
      if (String(args[0]).endsWith("/READY") && args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) {
        const stat = handle.stat.bind(handle); let stats = 0;
        t.mock.method(handle, "stat", async (...values: Parameters<typeof handle.stat>) => {
          stats++;
          if (failureAt === "stat" && stats === 2) {throw failure;}
          return await stat(...values);
        });
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          closeCalls++; await close();
          if (failureAt === "close") {throw failure;}
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(fixture.run(), (error: unknown) => error === failure);
    assert.equal(closeCalls, 1);
    await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
  });
}

test("cancellation and revocation failure both survive independent finalization", async (t) => {
  const fixture = await publicationFixture(t);
  const failure = new Error("synthetic revocation denial");
  const unlink = fs.unlink;
  atPublicationSeam(t, fixture.output, "staging-cleanup", async () => {fixture.controller.abort(fixture.reason);});
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]) === join(fixture.output, "READY")) {throw failure;}
    await unlink(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(fixture.run(), (error: unknown) => {
    assert.deepEqual(flatten(error), [fixture.reason, failure]); return true;
  });
  assert.equal(await readFile(join(fixture.output, "READY"), "utf8"), "");
});

for (const replacement of ["output", "ancestor"] as const) {
  test(`publication rejects an acquired ${replacement} substitution before READY`, async (t) => {
    const fixture = await publicationFixture(t);
    const moved = `${fixture.parent}-moved`;
    t.after(async () => {await originals.rm(moved, {recursive: true, force: true});});
    atPublicationSeam(t, fixture.output, "acquisition", async () => {
      if (replacement === "output") {await rename(fixture.output, join(fixture.parent, "retained-output"));}
      else {await rename(fixture.parent, moved); await mkdir(fixture.parent, {mode: 0o700});}
      await mkdir(fixture.output, {mode: 0o700});
      await writeFile(join(fixture.output, "foreign"), "preserved");
    });
    await assert.rejects(fixture.run());
    assert.equal(await readFile(join(fixture.output, "foreign"), "utf8"), "preserved");
    await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
  });
}

test("staging file replacement is preserved and cannot retain a success marker", async (t) => {
  const fixture = await publicationFixture(t);
  const publish = fixture.publication.publishNoReplace.bind(fixture.publication);
  let foreign = "";
  t.mock.method(fixture.publication, "publishNoReplace", async (...args: Parameters<typeof publish>) => {
    await publish(...args);
    foreign = join(args[0], "environment-failure.json");
    await rename(foreign, join(fixture.parent, "retained-evidence"));
    await writeFile(foreign, "foreign", {mode: 0o600});
  });
  await assert.rejects(fixture.run(), /staging entry changed/u);
  assert.equal(await readFile(foreign, "utf8"), "foreign");
  await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
});

test("post-copy output mutation is rejected before READY", async (t) => {
  const fixture = await publicationFixture(t);
  atPublicationSeam(t, fixture.output, "validation", async () => {
    await writeFile(join(fixture.output, "environment-failure.json"), "changed", {mode: 0o600});
  });
  await assert.rejects(fixture.run(), /publication entry changed/u);
  await assert.rejects(readFile(join(fixture.output, "READY")), {code: "ENOENT"});
});

test("cancellation preserves both copy descriptor close failures and closes each once", async (t) => {
  const fixture = await publicationFixture(t);
  const source = join(fixture.parent, "source"); const destination = join(fixture.parent, "destination");
  await writeFile(source, "authenticated", {mode: 0o600});
  const failures = [new Error("source close failed"), new Error("destination close failed")];
  const closed: string[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originals.open(...args);
    const path = String(args[0]);
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      closed.push(path); await close(); throw failures[path === source ? 0 : 1];
    });
    if (path === destination) {fixture.controller.abort(fixture.reason);}
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(copyStableExclusive(source, destination, fixture.controller.signal), (error: unknown) => {
    assert.deepEqual(flatten(error), [fixture.reason, failures[1], failures[0]]); return true;
  });
  assert.deepEqual(closed, [destination, source]);
});
