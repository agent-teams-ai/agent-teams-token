export type RpcMethod = "eth_chainId" | "eth_getBlockByNumber" | "eth_feeHistory" | "eth_estimateGas";

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
