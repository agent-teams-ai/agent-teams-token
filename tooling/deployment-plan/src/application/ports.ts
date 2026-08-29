export type RpcMethod =
  | "eth_chainId"
  | "eth_getBlockByNumber"
  | "eth_getTransactionCount"
  | "eth_feeHistory"
  | "eth_estimateGas";

export interface DeploymentRpc {
  request(method: RpcMethod, params: readonly unknown[]): Promise<unknown>;
}

export interface ArtifactInputs {
  readonly buildInfoBytes: Uint8Array;
  readonly artifactBytes: Uint8Array;
  readonly abiBytes: Uint8Array;
  readonly fixtureBytes: Uint8Array;
  readonly constructorValues: unknown;
}

export interface TrustRoots {
  readonly schemaVersion: 2;
  readonly testOnly: true;
  readonly productionApproved: false;
  readonly mainnetAllowed: false;
  readonly chainId: "31337";
  readonly contractFqn: string;
  readonly buildProfile: string;
  readonly from: `0x${string}`;
  readonly maximumWorstCaseWei: string;
  readonly gasBufferBps: string;
  readonly quoteTtlSeconds: string;
  readonly maximumHeadLag: string;
  readonly buildInfoSolcVersion: string;
  readonly compilerInputSha256: `0x${string}`;
  readonly compilerSettings: Record<string, unknown>;
  readonly artifactSha256: `0x${string}`;
  readonly abiSha256: `0x${string}`;
  readonly fixtureSha256: `0x${string}`;
  readonly fixtureReadySha256: `0x${string}`;
  readonly constructorArgumentsHash: `0x${string}`;
  readonly creationInputHash: `0x${string}`;
  readonly sourceDependencyClosure: Readonly<Record<string, `0x${string}`>>;
}

export interface ApprovedArtifact {
  readonly buildInfoSha256: `0x${string}`;
  readonly artifactSha256: `0x${string}`;
  readonly abiSha256: `0x${string}`;
  readonly fixtureSha256: `0x${string}`;
  readonly sourceDependencyClosure: Readonly<Record<string, `0x${string}`>>;
  readonly buildInfoSolcVersion: string;
  readonly compilerInputSha256: `0x${string}`;
  readonly compilerSettings: Record<string, unknown>;
  readonly creationBytecode: `0x${string}`;
  readonly creationBytecodeHash: `0x${string}`;
  readonly constructorAbiBytes: `0x${string}`;
  readonly constructorAbiHash: `0x${string}`;
  readonly constructorArguments: `0x${string}`;
  readonly constructorArgumentsHash: `0x${string}`;
  readonly creationInput: `0x${string}`;
  readonly creationInputHash: `0x${string}`;
}
