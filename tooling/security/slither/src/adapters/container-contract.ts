export const IMAGE = "ghcr.io/trailofbits/eth-security-toolbox:nightly-20260824@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0";
export const IMAGE_REVISION = "8cad443280f7eeb5920a901b5f58f5a91872d9aa";
export const CONTAINER_UID_GID = "1000:1000";
export const PINNED_PYTHONPATH = "/home/ethsec/.local/lib/python3.10/site-packages";

export interface ContainerPaths { readonly input: string; readonly output: string; readonly forge: string; readonly solc: string; readonly imagePath: string; readonly pythonPath: string; readonly containerName: string }

const securityPrelude = [
  "set -euo pipefail",
  "test \"$(id -u):$(id -g)\" = 1000:1000",
  "test ! -e /var/run/docker.sock",
  "test ! -w /input",
  "test ! -w /",
  "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
  "test \"$(ulimit -n)\" = 256",
  "test \"$(cat /sys/fs/cgroup/pids.max)\" = 128",
  "test \"$(cat /sys/fs/cgroup/memory.max)\" = 2147483648",
  "read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max",
  "test \"$cpu_quota\" != max",
  "test $((cpu_quota / cpu_period)) = 2",
  "test -z \"${GITHUB_TOKEN:-}${ACTIONS_RUNTIME_TOKEN:-}${AWS_ACCESS_KEY_ID:-}${SSH_AUTH_SOCK:-}${DOCKER_HOST:-}\"",
  "test -r /home/ethsec/.local/lib/python3.10/site-packages/slither/__init__.py",
  "/usr/bin/python3 -c 'import crytic_compile, slither'",
  "mkdir -m 0700 /work/gate-output",
  "cp -R /input/contracts /work/contracts",
  "cd /work/contracts/evm",
  "/tools/forge --version > /work/gate-output/forge.version 2>&1",
  "/tools/solc --version > /work/gate-output/solc.version 2>&1",
  "test \"$(command -v forge)\" = /tools/forge",
  "test \"$(command -v solc)\" = /tools/solc",
  "slither --fail-on pedantic --version > /work/gate-output/slither.version 2>&1",
  "crytic-compile --version > /work/gate-output/crytic-compile.version 2>&1",
  "slither --fail-on pedantic --list-detectors > /work/gate-output/detectors.txt 2>&1",
];

export function dockerRunArguments(paths: ContainerPaths): readonly string[] {
  const script = [
    ...securityPrelude,
    "targets=$(tr '\\n' ' ' < /input/tooling/security/slither/targets.txt)",
    "test -n \"$targets\"",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/tools/solc /tools/forge build --skip test --skip script --use /tools/solc $targets",
    "set +e",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/tools/solc slither . --fail-on pedantic --foundry-ignore-compile --foundry-out-directory /work/out --foundry-build-info-directory /work/out/build-info --config-file /input/tooling/security/slither/slither.config.json --json /work/gate-output/slither.json",
    "slither_status=$?",
    "set -e",
    "printf '%s\\n' \"$slither_status\" > /work/gate-output/slither.exit",
    "test -s /work/gate-output/slither.json",
    "set +e",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/tools/solc /usr/bin/python3 /input/tooling/security/slither/slither-inventory.py > /work/gate-output/slither-inventory.json",
    "inventory_status=$?",
    "set -e",
    "printf '%s\\n' \"$inventory_status\" > /work/gate-output/slither-inventory.exit",
    "test -s /work/gate-output/slither-inventory.json",
    "cp /work/out/AGTMAIToken.sol/AGTMAIToken.json /work/gate-output/AGTMAIToken.json",
    "cp /work/out/build-info/*.json /work/gate-output/build-info.json",
    "cp /work/gate-output/* /output/",
  ].join("\n");
  return hardenedDockerArguments(paths, script);
}

export function dockerVulnerableFixtureArguments(paths: ContainerPaths): readonly string[] {
  const script = [
    ...securityPrelude,
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/tools/solc /tools/forge build --skip test --skip script --use /tools/solc src/Vulnerable.sol",
    "set +e",
    "FOUNDRY_OUT=/work/out FOUNDRY_CACHE_PATH=/work/cache FOUNDRY_BUILD_INFO_PATH=/work/out/build-info SOLC=/tools/solc slither . --fail-on pedantic --foundry-ignore-compile --foundry-out-directory /work/out --foundry-build-info-directory /work/out/build-info --config-file /input/tooling/security/slither/slither.config.json --json /work/gate-output/slither.json",
    "slither_status=$?",
    "set -e",
    "printf '%s\\n' \"$slither_status\" > /work/gate-output/slither.exit",
    "test -s /work/gate-output/slither.json",
    "cp /work/gate-output/* /output/",
  ].join("\n");
  return hardenedDockerArguments(paths, script);
}

function hardenedDockerArguments(paths: ContainerPaths, script: string): readonly string[] {
  return [
    "run", "--rm", "--name", paths.containerName, "--platform", "linux/amd64", "--network", "none", "--read-only",
    "--user", CONTAINER_UID_GID, "--security-opt", "no-new-privileges=true", "--cap-drop", "ALL",
    "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
    "--ulimit", "nofile=256:256", "--stop-timeout", "5",
    "--tmpfs", "/work:rw,nosuid,nodev,size=768m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/home/gate:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
    "--mount", `type=bind,src=${paths.input},dst=/input,readonly`,
    "--mount", `type=bind,src=${paths.output},dst=/output`,
    "--mount", `type=bind,src=${paths.forge},dst=/tools/forge,readonly`,
    "--mount", `type=bind,src=${paths.solc},dst=/tools/solc,readonly`,
    "--entrypoint", "/usr/bin/env", IMAGE, "-i", "HOME=/home/gate", "TMPDIR=/tmp",
    `PATH=/tools:${paths.imagePath}`, `PYTHONPATH=${paths.pythonPath}`,
    "FOUNDRY_DISABLE_NIGHTLY_WARNING=1", "/bin/bash", "-ceu", script,
  ];
}
