export interface SystemConfig {
  readonly apiBaseUrl: string;
  readonly starknet: {
    readonly chainId: string;
  };
}

export interface Account {
  address: string;
  privateKey: string;
  jwtToken?: string;
}

/** Unix time in seconds
 * @example 1657627258
 */
export type UnixTime = number;