// Synthetic artifact integrity tests only. Never official Safe execution evidence.
import { createHash } from "node:crypto";
import { deploymentBytes, type Hex } from "@agent-teams/supply/deployment";
import { custodyKeccak } from "../../src/adapters/safe-custody.ts";
import { qualifySafeArtifacts, type SafeArtifactPins } from "../../src/adapters/safe-artifacts.ts";
const sha = (bytes: Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`;
export function syntheticSafeArtifacts(singleton: Hex = "0x0000000000000000000000000000000000000099") {
  const code = "0x6000", compiler = "0.7.6+commit.7338295f";
  const sourceName = "contracts/Synthetic.sol", content = "// SYNTHETIC: not official Safe source";
  const abi: unknown[] = [];
  const proxy = deploymentBytes({ _format: "hh-sol-artifact-1", contractName: "SafeProxy", sourceName, abi, bytecode: code, deployedBytecode: code, linkReferences: {}, deployedLinkReferences: {} });
  const safe = deploymentBytes({ _format: "hh-sol-artifact-1", contractName: "Safe", sourceName, abi, bytecode: code, deployedBytecode: code, linkReferences: {}, deployedLinkReferences: {} });
  const compiled = { abi, evm: { bytecode: { object: code.slice(2) }, deployedBytecode: { object: code.slice(2) } },
    metadata: JSON.stringify({ compiler: { version: compiler }, sources: { [sourceName]: { keccak256: custodyKeccak(new TextEncoder().encode(content)) } } }) };
  const buildInfo = deploymentBytes({ _format: "hh-sol-build-info-1", solcVersion: "0.7.6", solcLongVersion: compiler,
    input: { language: "Solidity", sources: { [sourceName]: { content } } }, output: { contracts: { [sourceName]: { SafeProxy: compiled, Safe: compiled } } } });
  const pin = { sourceName, abiSha256: sha(deploymentBytes(abi)), runtimeKeccak256: custodyKeccak(Buffer.from(code.slice(2), "hex")) };
  const pins: SafeArtifactPins = { schema: "agtmai-safe-artifact-pins-v1", source: "safe-global/safe-smart-account", sourceRevision: "1".repeat(40), version: "1.4.1",
    compilerVersion: compiler, buildInfoSha256: sha(buildInfo), proxy: { ...pin, contractName: "SafeProxy", artifactSha256: sha(proxy) }, singleton: { ...pin, contractName: "Safe", artifactSha256: sha(safe) } };
  const bytes = { proxy, singleton: safe, buildInfo }, selected = sha(deploymentBytes(pins));
  return { pins, bytes, selected, profile: qualifySafeArtifacts(pins, selected, bytes, singleton) };
}
