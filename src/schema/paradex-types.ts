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

// API Response Types
export interface AccountInfo {
  address: string;
  balance: string;
  free_collateral: string;
  [key: string]: unknown;
}

export interface Market {
  symbol: string;
  base_currency: string;
  quote_currency: string;
  [key: string]: unknown;
}

export interface Position {
  market: string;
  side: string;
  size: string;
  [key: string]: unknown;
}

export interface Order {
  id: string;
  market: string;
  side: string;
  type: string;
  size: string;
  price?: string;
  [key: string]: unknown;
}

export interface Fill {
  id: string;
  market: string;
  side: string;
  size: string;
  price: string;
  [key: string]: unknown;
}

export interface OrderBook {
  market: string;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  [key: string]: unknown;
}

export interface MarketStats {
  market: string;
  volume_24h: string;
  price_change_24h: string;
  [key: string]: unknown;
}

export interface FundingPayment {
  market: string;
  amount: string;
  timestamp: number;
  [key: string]: unknown;
}

// Request Types
export interface OrderRequest {
  market: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  size: string;
  price?: string;
  trigger_price?: string;
  instruction?: "GTC" | "POST_ONLY" | "IOC" | "RPI";
  flags?: Array<
    "REDUCE_ONLY" | "STOP_CONDITION_BELOW_TRIGGER" | "STOP_CONDITION_ABOVE_TRIGGER" | "INTERACTIVE"
  >;
  stp?: "EXPIRE_MAKER" | "EXPIRE_TAKER" | "EXPIRE_BOTH";
  client_id?: string;
  [key: string]: unknown;
}

export interface OrderModification {
  price?: string;
  size?: string;
  trigger_price?: string;
  [key: string]: unknown;
}
