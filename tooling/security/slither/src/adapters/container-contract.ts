export const IMAGE = "ghcr.io/trailofbits/eth-security-toolbox:nightly-20260824@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0";
export const IMAGE_REVISION = "8cad443280f7eeb5920a901b5f58f5a91872d9aa";
export const CONTAINER_UID_GID = "1000:1000";
export const PINNED_PYTHONPATH = "/home/ethsec/.local/lib/python3.10/site-packages";

export interface ContainerPaths { readonly input: string; readonly forge: string; readonly solc: string; readonly imagePath: string; readonly pythonPath: string }
export const COMMON_OUTPUT_FILES = ["crytic-compile.version", "detectors.txt", "forge.version", "slither.exit", "slither.json", "slither.version", "solc.version"] as const;
export const PRODUCTION_OUTPUT_FILES = ["AGTMAIToken.json", "build-info.json", ...COMMON_OUTPUT_FILES, "slither-inventory.exit", "slither-inventory.json"] as const;
export const FIXTURE_OUTPUT_FILES = ["Vulnerable.json", "build-info.json", ...COMMON_OUTPUT_FILES] as const;

// Both rendezvous exist before authorization, even if PID 1 is still starting.
export const AUTHORIZE_ANALYSIS = "umask 077; mkfifo -m 0600 /work/gate-completion /work/gate-hold; /usr/bin/touch /work/host-authorized";
const retainOutputOnExit = [
  "gate_status=$?", "trap - EXIT", "set -e",
  "test -p /work/gate-completion", "test -p /work/gate-hold",
  "printf \"SLITHER_COMPLETED_V1 %s\\n\" \"$gate_status\" > /work/gate-completion",
  // A shell builtin retains tmpfs until exact-ID removal. Completion is an
  // analysis exit record, never policy acceptance or a claim of immutability.
  "IFS= read -r gate_reap < /work/gate-hold", "exit 125",
].join("; ");

const securityPrelude = [
  "set -euo pipefail", "umask 077", "mkdir -m 0700 /work/gate-output",
  "printf '%s\\n' container-execution > /work/gate-output/failure.stage", "while test ! -e /work/host-authorized; do sleep 0.05; done",
  `trap '${retainOutputOnExit}' EXIT`,
  "test \"$(id -u):$(id -g)\" = 1000:1000", "test ! -e /var/run/docker.sock", "test ! -w /input", "test ! -w /",
  "test \"$(readlink /proc/self/ns/pid)\" = \"$(readlink /proc/1/ns/pid)\"",
  "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status", "test \"$(ulimit -n)\" = 256",
  "test \"$(cat /sys/fs/cgroup/pids.max)\" = 128", "test \"$(cat /sys/fs/cgroup/memory.max)\" = 2147483648",
  "read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max", "test \"$cpu_quota\" != max", "test $((cpu_quota / cpu_period)) = 2",
  "test -z \"${GITHUB_TOKEN:-}${ACTIONS_RUNTIME_TOKEN:-}${AWS_ACCESS_KEY_ID:-}${SSH_AUTH_SOCK:-}${DOCKER_HOST:-}\"",
  "test -r /home/ethsec/.local/lib/python3.10/site-packages/slither/__init__.py", "/usr/bin/python3 -c 'import crytic_compile, slither'",
  "cp -R /work/input/contracts /work/contracts", "cd /work/contracts/evm", "printf '%s\\n' version-inventory > /work/gate-output/failure.stage",
  "/work/tools/forge --version > /work/gate-output/forge.version 2>&1", "/work/tools/solc --version > /work/gate-output/solc.version 2>&1",
  "test \"$(command -v forge)\" = /work/tools/forge", "test \"$(command -v solc)\" = /work/tools/solc",
  "slither --fail-pedantic --version > /work/gate-output/slither.version 2>&1", "crytic-compile --version > /work/gate-output/crytic-compile.version 2>&1",
  "printf '%s\\n' detector-inventory > /work/gate-output/failure.stage", "slither --fail-pedantic --list-detectors > /work/gate-output/detectors.txt 2>&1",
];

export function dockerCreateArguments(paths: ContainerPaths): readonly string[] {
  return hardenedCreateArguments(paths, [
    ...securityPrelude, "printf '%s\\n' manifest-validation > /work/gate-output/failure.stage",
    "mapfile -t targets < /work/input/tooling/security/slither/targets.txt", "test \"${#targets[@]}\" -gt 0",
    "for target in \"${targets[@]}\"; do [[ \"$target\" =~ ^src/[A-Za-z0-9._/-]+[.]sol$ ]] && [[ \"$target\" != *..* ]] && [[ \"$target\" != -* ]]; done",
    "printf '%s\\n' compiler-build > /work/gate-output/failure.stage",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/work/tools/solc /work/tools/forge build --offline --no-auto-detect --skip test --skip script --use /work/tools/solc \"${targets[@]}\"",
    "printf '%s\\n' analysis-runtime > /work/gate-output/failure.stage", "set +e",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/work/tools/solc slither . --fail-pedantic --foundry-ignore-compile --foundry-out-directory /work/out --foundry-build-info-directory /work/out/build-info --config-file /work/input/tooling/security/slither/slither.config.json --json /work/gate-output/slither.json",
    "slither_status=$?", "set -e", "printf '%s\\n' \"$slither_status\" > /work/gate-output/slither.exit", "test -s /work/gate-output/slither.json",
    "printf '%s\\n' detector-inventory > /work/gate-output/failure.stage", "set +e",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/work/tools/solc /usr/bin/python3 /work/input/tooling/security/slither/slither-inventory.py > /work/gate-output/slither-inventory.json",
    "inventory_status=$?", "set -e", "printf '%s\\n' \"$inventory_status\" > /work/gate-output/slither-inventory.exit", "test -s /work/gate-output/slither-inventory.json",
    "printf '%s\\n' artifact-validation > /work/gate-output/failure.stage", "test \"$(find /work/out/build-info -maxdepth 1 -type f -name '*.json' | wc -l)\" = 1",
    "cp /work/out/AGTMAIToken.sol/AGTMAIToken.json /work/gate-output/AGTMAIToken.json", "cp /work/out/build-info/*.json /work/gate-output/build-info.json",
    "rm /work/gate-output/failure.stage",
  ].join("\n"));
}

export function dockerVulnerableFixtureCreateArguments(paths: ContainerPaths): readonly string[] {
  return hardenedCreateArguments(paths, [
    ...securityPrelude, "printf '%s\\n' compiler-build > /work/gate-output/failure.stage",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/work/tools/solc /work/tools/forge build --offline --no-auto-detect --skip test --skip script --use /work/tools/solc src/Vulnerable.sol",
    "printf '%s\\n' analysis-runtime > /work/gate-output/failure.stage", "set +e",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/work/tools/solc slither . --fail-pedantic --foundry-ignore-compile --foundry-out-directory /work/out --foundry-build-info-directory /work/out/build-info --config-file /work/input/tooling/security/slither/slither.config.json --json /work/gate-output/slither.json",
    "slither_status=$?", "set -e", "printf '%s\\n' \"$slither_status\" > /work/gate-output/slither.exit", "test -s /work/gate-output/slither.json",
    "printf '%s\\n' artifact-validation > /work/gate-output/failure.stage", "test \"$(find /work/out/build-info -maxdepth 1 -type f -name '*.json' | wc -l)\" = 1",
    "cp /work/out/Vulnerable.sol/Vulnerable.json /work/gate-output/Vulnerable.json", "cp /work/out/build-info/*.json /work/gate-output/build-info.json",
    "rm /work/gate-output/failure.stage",
  ].join("\n"));
}

function hardenedCreateArguments(paths: ContainerPaths, script: string): readonly string[] {
  return ["create", "--pull", "never", "--platform", "linux/amd64", "--network", "none", "--read-only", "--user", CONTAINER_UID_GID,
    "--security-opt", "no-new-privileges=true", "--cap-drop", "ALL", "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
    "--ulimit", "nofile=256:256", "--stop-timeout", "5", "--tmpfs", "/work:rw,nosuid,nodev,size=768m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/home/gate:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
    "--mount", `type=bind,src=${paths.input},dst=/input,readonly`, "--mount", `type=bind,src=${paths.forge},dst=/tools/forge,readonly`,
    "--mount", `type=bind,src=${paths.solc},dst=/tools/solc,readonly`, "--entrypoint", "/usr/bin/env", IMAGE, "-i", "HOME=/home/gate", "TMPDIR=/tmp",
    `PATH=/work/tools:${paths.imagePath}`, `PYTHONPATH=${paths.pythonPath}`, "FOUNDRY_DISABLE_NIGHTLY_WARNING=1", "/bin/bash", "-ceu", script];
}
