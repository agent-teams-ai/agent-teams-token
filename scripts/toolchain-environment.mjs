import { isAbsolute, resolve } from "node:path";

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
  "HOME",
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
  "TMPDIR",
  "TOKEN_BOOTSTRAP_TEST_MODE",
  "TOKEN_TOOLCHAIN_LOCK",
  "TOKEN_TOOLS_ROOT",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

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
  "-c", "credential.helper=",
  "-c", "credential.interactive=never",
]);

export function allowlistedChildEnvironment(source = process.env, overrides = {}) {
  const environment = {};
  for (const key of trustedNodeEnvironmentKeys) {
    if (source[key] !== undefined) {environment[key] = String(source[key]);}
  }
  for (const [key, value] of Object.entries(overrides)) {
    if ((!trustedNodeEnvironmentKeys.includes(key) && !GIT_IDENTITY_KEYS.includes(key))
      || value === undefined) {
      throw new Error(`TOOLCHAIN_CHILD_ENVIRONMENT_OVERRIDE_FORBIDDEN key=${key}`);
    }
    environment[key] = String(value);
  }
  environment.LANG ??= "C";
  environment.LC_ALL ??= "C";
  environment.PATH ??= "/usr/bin:/bin";
  environment.TZ ??= "UTC";
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
    && !GIT_IDENTITY_KEYS.includes(key)
    && ![
      "GCM_INTERACTIVE", "GIT_ASKPASS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_NO_REPLACE_OBJECTS",
      "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "SSH_ASKPASS",
    ].includes(key));
  if (forbidden !== undefined) {
    throw new Error(`TOOLCHAIN_CHILD_ENVIRONMENT_FORBIDDEN key=${forbidden}`);
  }
}
