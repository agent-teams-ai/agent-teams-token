import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const trustedNodeEnvironmentKeys = Object.freeze([
  "AGTMAI_ANVIL_BINARY",
  "AGTMAI_FORGE_BINARY",
  "AGTMAI_LOCAL_EVM_FAULT",
  "AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY",
  "AGTMAI_ROLLBACK_TMPDIR",
  "AGTMAI_SOLANA_REAL_TESTS_REQUIRED",
  "AGTMAI_SOLC_BINARY",
  "ALLOW_MAINNET_BROADCAST",
  "ALLOW_PUBLIC_NETWORK",
  "CI",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_ENABLE_PROJECT_SPEC",
  "ENABLE_PUBLIC_RPC",
  "FOUNDRY_PROFILE",
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_JOB",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW",
  "LANG",
  "LC_ALL",
  "MAINNET_ENABLED",
  "PATH",
  "SLITHER_CANDIDATE_SHA",
  "SLITHER_DOCKER_PATH",
  "SLITHER_EVIDENCE_DIRECTORY",
  "SLITHER_FAILURE_CODE",
  "SLITHER_FORGE_PATH",
  "SLITHER_REPOSITORY_ROOT",
  "SLITHER_SOLC_PATH",
  "SOLANA_EVIDENCE_DIRECTORY",
  "TZ",
]);

const PRIVATE_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

const CANONICAL_NPM_ENVIRONMENT = Object.freeze({
  NPM_CONFIG_GLOBALCONFIG: "/dev/null",
  NPM_CONFIG_USERCONFIG: "/dev/null",
  npm_config_globalconfig: "/dev/null",
  npm_config_userconfig: "/dev/null",
});

const GIT_IDENTITY_KEYS = Object.freeze([
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
]);

export const canonicalGitArguments = Object.freeze([
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
  "-c", "credential.helper=",
  "-c", "credential.interactive=never",
]);

export function allowlistedChildEnvironment(source = process.env, overrides = {}) {
  const environment = {};
  for (const key of trustedNodeEnvironmentKeys) {
    if (source[key] !== undefined) {environment[key] = String(source[key]);}
  }
  for (const [key, value] of Object.entries(overrides)) {
    if ((!trustedNodeEnvironmentKeys.includes(key) && !PRIVATE_ENVIRONMENT_KEYS.includes(key)
      && !GIT_IDENTITY_KEYS.includes(key))
      || value === undefined) {
      throw new Error(`TOOLCHAIN_CHILD_ENVIRONMENT_OVERRIDE_FORBIDDEN key=${key}`);
    }
    environment[key] = String(value);
  }
  environment.LANG ??= "C";
  environment.LC_ALL ??= "C";
  environment.PATH ??= "/usr/bin:/bin";
  environment.TZ ??= "UTC";
  environment.HOME ??= "/nonexistent";
  environment.TMPDIR ??= "/tmp";
  environment.XDG_CACHE_HOME ??= "/nonexistent";
  environment.XDG_CONFIG_HOME ??= "/nonexistent";
  environment.XDG_DATA_HOME ??= "/nonexistent";
  environment.XDG_RUNTIME_DIR ??= "/nonexistent";
  Object.assign(environment, CANONICAL_NPM_ENVIRONMENT);
  return environment;
}

export function canonicalGitEnvironment(source = process.env) {
  const environment = allowlistedChildEnvironment(source);
  for (const key of GIT_IDENTITY_KEYS) {
    if (source[key] !== undefined) {environment[key] = String(source[key]);}
  }
  return {
    ...environment,
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "/bin/false",
  };
}

export function trustedChildInvocation(
  command,
  arguments_,
  source = process.env,
  { workingDirectory } = {},
) {
  if (command === "/usr/bin/git") {
    if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
      throw new Error("TOOLCHAIN_GIT_WORKING_DIRECTORY_INVALID");
    }
    const safeDirectory = resolve(workingDirectory);
    assertRecoveryGitAuthority(safeDirectory);
    return {
      arguments: [
        ...canonicalGitArguments,
        "-c", `safe.directory=${safeDirectory}`,
        ...arguments_,
      ],
      environment: canonicalGitEnvironment(source),
    };
  }
  return {
    arguments: [...arguments_],
    environment: allowlistedChildEnvironment(source),
  };
}

export function assertEnvironmentIsAllowlisted(environment) {
  const forbidden = Object.keys(environment).find((key) =>
    !trustedNodeEnvironmentKeys.includes(key)
    && !PRIVATE_ENVIRONMENT_KEYS.includes(key)
    && !GIT_IDENTITY_KEYS.includes(key)
    && CANONICAL_NPM_ENVIRONMENT[key] === undefined
    && ![
      "GCM_INTERACTIVE", "GIT_ASKPASS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_NO_REPLACE_OBJECTS",
      "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "SSH_ASKPASS",
    ].includes(key));
  if (forbidden !== undefined) {
    throw new Error(`TOOLCHAIN_CHILD_ENVIRONMENT_FORBIDDEN key=${forbidden}`);
  }
}

export function assertRecoveryGitAuthority(workingDirectory) {
  if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
    throw new Error("TOOLCHAIN_GIT_WORKING_DIRECTORY_INVALID");
  }
  const repository = findRepositoryAuthority(resolve(workingDirectory));
  if (repository === undefined) {return;}
  const environment = canonicalGitEnvironment({});
  const result = spawnSync("/usr/bin/git", [
    ...canonicalGitArguments,
    "-c", `safe.directory=${repository.worktree}`,
    // A malformed marker must not fall through to another ancestor's config.
    "--git-dir", repository.gitDirectory,
    "config", "--local", "--no-includes", "--null", "--list",
  ], {
    cwd: workingDirectory,
    encoding: null,
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("TOOLCHAIN_GIT_LOCAL_CONFIG_UNAVAILABLE", { cause: result.error });
  }
  const records = Buffer.from(result.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0");
  records.pop();
  for (const record of records) {
    const separator = record.indexOf("\n");
    if (separator <= 0) {throw new Error("TOOLCHAIN_GIT_LOCAL_CONFIG_INVALID");}
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (!allowedLocalGitConfig(key, value)) {
      throw new Error(`TOOLCHAIN_GIT_LOCAL_CONFIG_FORBIDDEN key=${key}`);
    }
  }
  assertGitAdministrativeFiles(repository.commonDirectory);
  const worktreeConfig = join(repository.gitDirectory, "config.worktree");
  if (existsSync(worktreeConfig)) {
    throw new Error("TOOLCHAIN_GIT_WORKTREE_CONFIG_FORBIDDEN");
  }
}

function findRepositoryAuthority(workingDirectory) {
  const initialDirectory = realpathSync(workingDirectory);
  let candidate = initialDirectory;
  const root = parse(candidate).root;
  while (true) {
    const dotGit = join(candidate, ".git");
    const entry = lstatSync(dotGit, { bigint: true, throwIfNoEntry: false });
    if (entry && !isEmptyGitAncestor(dotGit, entry, candidate !== initialDirectory)) {
      let gitDirectory;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        gitDirectory = realpathSync(dotGit);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(readFileSync(dotGit, "utf8"));
        if (!match) {throw new Error("TOOLCHAIN_GIT_DIRECTORY_UNSAFE");}
        gitDirectory = realpathSync(resolve(candidate, match[1]));
      } else {
        throw new Error("TOOLCHAIN_GIT_DIRECTORY_UNSAFE");
      }
      const commonFile = join(gitDirectory, "commondir");
      const commonDirectory = existsSync(commonFile)
        ? realpathSync(resolve(gitDirectory, readFileSync(commonFile, "utf8").trim()))
        : gitDirectory;
      return { commonDirectory, gitDirectory, worktree: candidate };
    }
    if (candidate === root) {return;}
    candidate = dirname(candidate);
  }
}

function isEmptyGitAncestor(dotGit, entry, isAncestor) {
  if (!isAncestor || !entry.isDirectory() || entry.isSymbolicLink()) {return false;}
  // Git skips an empty ancestor .git directory and continues upward. Read at
  // most one entry; never infer absence from a failed Git command or filesystem
  // operation. Current-directory markers and gitdir pointers remain authority.
  const directory = opendirSync(dotGit, { bufferSize: 1 });
  let empty;
  try {
    empty = directory.readSync() === null;
  } finally {
    directory.closeSync();
  }
  const after = lstatSync(dotGit, { bigint: true });
  if (["dev", "ino", "mode", "mtimeNs", "ctimeNs"].some((key) => entry[key] !== after[key])) {
    throw new Error("TOOLCHAIN_GIT_DIRECTORY_UNSAFE");
  }
  if (empty) {assertNoBareGitAncestor(dirname(dotGit));}
  // This is a pathname observation, not custody through the later Git spawn;
  // concurrent hostile replacement after this check remains outside the trust boundary.
  return empty;
}

function assertNoBareGitAncestor(candidate) {
  const present = (name) => lstatSync(join(candidate, name), { throwIfNoEntry: false }) !== undefined;
  // Git can also discover bare administration beside the empty .git marker.
  // Such a layout is outside this non-repository exception, even if malformed.
  if (present("HEAD") && (present("commondir") || (present("objects") && present("refs")))) {
    throw new Error("TOOLCHAIN_GIT_DIRECTORY_UNSAFE");
  }
}

function allowedLocalGitConfig(key, value) {
  // actions/checkout v7.0.1 disables automatic GC; no other GC authority is allowed.
  if (key === "gc.auto") {return value === "0";}
  const boolean = /^(?:true|false)$/u;
  const exact = new Map([
    ["core.repositoryformatversion", /^(?:0|1)$/u],
    ["core.filemode", boolean],
    ["core.bare", boolean],
    ["core.logallrefupdates", boolean],
    ["core.ignorecase", boolean],
    ["core.precomposeunicode", boolean],
  ]);
  if (exact.has(key)) {return exact.get(key).test(value);}
  if (/^user\.(?:name|email)$/u.test(key)) {return value.length > 0 && !/[\0\r\n]/u.test(value);}
  if (/^remote\.[a-zA-Z0-9._/-]+\.url$/u.test(key)) {
    return value.length > 0 && !/[\0\r\n]/u.test(value);
  }
  if (/^remote\.[a-zA-Z0-9._/-]+\.fetch$/u.test(key)) {
    return /^\+?refs\/heads\/\*:refs\/remotes\/[a-zA-Z0-9._/-]+\/\*$/u.test(value);
  }
  if (/^branch\..+\.remote$/u.test(key)) {return /^[a-zA-Z0-9._/-]+$/u.test(value);}
  if (/^branch\..+\.merge$/u.test(key)) {return /^refs\/heads\/.+$/u.test(value);}
  return false;
}

function assertGitAdministrativeFiles(commonDirectory) {
  const hooks = join(commonDirectory, "hooks");
  if (existsSync(hooks)) {
    for (const name of readdirSync(hooks)) {
      const entry = lstatSync(join(hooks, name));
      if (!name.endsWith(".sample") || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`TOOLCHAIN_GIT_HOOK_FORBIDDEN name=${name}`);
      }
    }
  }
  const info = join(commonDirectory, "info");
  if (existsSync(info)) {
    for (const name of readdirSync(info)) {
      const entry = lstatSync(join(info, name));
      if (name !== "exclude" || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`TOOLCHAIN_GIT_INFO_AUTHORITY_FORBIDDEN name=${name}`);
      }
    }
  }
}
