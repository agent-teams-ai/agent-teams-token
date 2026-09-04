export const EXPECTED_CHAIN_ID = "31337";
export const REPORT_SCHEMA_VERSION = 1;
export const APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256 = "0x1a5c8647212a264368c1f9223d7edf6fdf3018278ea48fe505f7252071e518bd" as const;
export const APPROVED_CONTRACT_ARTIFACT_SHA256 = "0x0eab21f9aa412c52aff557eeaf8a802306b57e21067c02748c9b6f9f7a87cb7c" as const;
export const APPROVED_ABI_SHA256 = "0x437d23540c29545d78a654ffe3df8c45136eee6d9954fb7ebdce34ba922b4645" as const;
export const APPROVED_SOURCE_SHA256 = "0xeae1b3bbeeb2d31168592805970abe03baa2775b30d9cab6561632a101188989" as const;

export class LocalEvmError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalEvmError";
    this.code = code;
  }
}

export interface Allocation {
  readonly id: string;
  readonly idBytes32: `0x${string}`;
  readonly recipient: `0x${string}`;
  readonly amountBaseUnits: string;
  readonly bps?: number;
}

export interface LocalManifest {
  readonly schemaVersion: 1;
  readonly purpose: "local-fixture-artifact";
  readonly status: "test-only";
  readonly network: { readonly kind: "local-evm"; readonly chainId: "31337" };
  readonly token: {
    readonly name: "Agent Teams AI";
    readonly symbol: "AGTMAI";
    readonly decimals: 9;
    readonly initialSupplyBaseUnits: string;
  };
  readonly allocations: readonly Allocation[];
  readonly sourceSha256: `0x${string}`;
  readonly rawAllocationAbi: `0x${string}`;
  readonly genesisAllocationHash: `0x${string}`;
  readonly tool: {
    readonly name: "@agent-teams/supply";
    readonly feature: "genesis-manifest";
    readonly version: "1";
  };
  readonly localFixtureArtifactSha256: `0x${string}`;
}

export interface ConstructorInputs {
  readonly schemaVersion: 1;
  readonly initialSupplyBaseUnits: string;
  readonly allocations: readonly Pick<Allocation, "idBytes32" | "recipient" | "amountBaseUnits">[];
}

export interface DeploymentReport {
  readonly schemaVersion: 1;
  readonly chainId: "31337";
  readonly targetAddress: `0x${string}`;
  readonly transactionHash: `0x${string}`;
  readonly deployerAddress: `0x${string}`;
  readonly factoryAddress: null;
  readonly creationInputBytesSha256: `0x${string}`;
  readonly localFixtureArtifactSha256: `0x${string}`;
  readonly buildInfoSha256: `0x${string}`;
  readonly contractArtifactSha256: `0x${string}`;
  readonly constructorInputsSha256: `0x${string}`;
}

export interface VerificationInput {
  readonly rpcUrl: string;
  readonly manifestPath: string;
  readonly readyPath: string;
  readonly approvedArtifactSha256: `0x${string}`;
  readonly buildInfoPath: string;
  readonly expectedBuildInfoSha256: `0x${string}`;
  readonly contractArtifactPath: string;
  readonly expectedContractArtifactSha256: `0x${string}`;
  readonly abiPath: string;
  readonly expectedAbiSha256: `0x${string}`;
  readonly approvedBuildProfilePath: string;
  readonly expectedApprovedBuildProfileSha256: `0x${string}`;
  readonly constructorInputsPath: string;
  readonly expectedConstructorInputsSha256: `0x${string}`;
  readonly deploymentReportPath: string;
  readonly expectedDeploymentReportSha256: `0x${string}`;
  readonly targetAddress: `0x${string}`;
  readonly deployerAddress: `0x${string}`;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly reportOutputRoot: string;
  readonly runId: string;
}

export interface ApprovedBuildProfile {
  readonly schemaVersion: 1;
  readonly purpose: "local-evm-verifier-build-approval";
  readonly status: "test-only";
  readonly sourceName: "src/features/token-genesis/AGTMAIToken.sol";
  readonly contractName: "AGTMAIToken";
  readonly solcVersion: "0.8.36+commit.8a079791";
  readonly settings: {
    readonly evmVersion: "paris";
    readonly optimizerEnabled: true;
    readonly optimizerRuns: 200;
    readonly metadataBytecodeHash: "ipfs";
    readonly appendCbor: true;
  };
  readonly sourceSha256: `0x${string}`;
  readonly contractArtifactSha256: `0x${string}`;
  readonly abiSha256: `0x${string}`;
  readonly immutableReferences: {
    readonly GENESIS_ALLOCATION_HASH: readonly { readonly start: number; readonly length: 32 }[];
    readonly INITIAL_SUPPLY: readonly { readonly start: number; readonly length: 32 }[];
  };
}

export interface EvidenceCheck {
  readonly id: string;
  readonly status: "passed" | "failed";
  readonly expected?: string;
  readonly actual?: string;
  readonly diagnostic?: string;
}

export interface VerificationEvidence {
  readonly schemaVersion: 1;
  readonly kind: "agtmai-local-evm-verification";
  readonly claims: {
    readonly proven: readonly string[];
    readonly simulated: readonly string[];
    readonly deferred: readonly string[];
    readonly notProven: readonly string[];
  };
  readonly inputs: Readonly<Record<string, string>>;
  readonly chain: { readonly kind: "local-evm"; readonly chainId: "31337" };
  readonly tools: Readonly<Record<string, string>>;
  readonly checks: readonly EvidenceCheck[];
  readonly exit: { readonly status: "passed" | "failed"; readonly code: string };
  readonly normalizedEvidenceSha256: `0x${string}`;
  readonly volatile: {
    readonly runId: string;
    readonly targetAddress: `0x${string}`;
    readonly deployerAddress: `0x${string}`;
    readonly transactionHash: `0x${string}`;
  };
}

export function asError(cause: unknown): LocalEvmError {
  if (cause instanceof LocalEvmError) {return cause;}
  const message = cause instanceof Error ? cause.message : "unknown failure";
  return new LocalEvmError("LOCAL_EVM_INTERNAL_FAILURE", message);
}
