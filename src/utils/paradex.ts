// most stuff here is taken from
// https://github.com/tradeparadex/code-samples/tree/main/typescript

import BigNumber from "bignumber.js";
import type {
  Account,
  SystemConfig,
  UnixTime,
  AccountInfo,
  Market,
  Position,
  Order,
  Fill,
  OrderBook,
  MarketStats,
  FundingPayment,
  OrderRequest,
  OrderModification,
} from "../schema/paradex-types";
import { ec, shortString, type TypedData, typedData as starkTypedData, constants } from "starknet";
import { StarknetConfigStore } from "../agents/utils";
import { getCurrentAgentId } from "./starknet";
import { getUnixTime } from "date-fns";

interface AuthRequest extends Record<string, unknown> {
  method: string;
  path: string;
  body: string;
  timestamp: UnixTime;
  expiration: UnixTime;
}

const DOMAIN_TYPES = {
  StarkNetDomain: [
    { name: "name", type: "felt" },
    { name: "chainId", type: "felt" },
    { name: "version", type: "felt" },
  ],
};
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Environment configuration
const PARADEX_ENVIRONMENTS = {
  TESTNET: {
    apiBaseUrl: "https://api.testnet.paradex.trade/v1",
    chainId: "PRIVATE_SN_POTC_SEPOLIA",
  },
  MAINNET: {
    apiBaseUrl: "https://api.prod.paradex.trade/v1",
    chainId: "PRIVATE_SN_PARACLEAR_MAINNET",
  },
} as const;

type ParadexEnvironment = keyof typeof PARADEX_ENVIRONMENTS;

//
// public
//

/**
 * Determines the Paradex environment based on the Starknet RPC URL
 * @param rpcUrl The Starknet RPC URL
 * @returns The corresponding Paradex environment
 */
function getEnvironmentFromRpcUrl(rpcUrl: string): ParadexEnvironment {
  if (rpcUrl.includes("sepolia") || rpcUrl.includes("testnet")) {
    return "TESTNET";
  }
  if (rpcUrl.includes("mainnet")) {
    return "MAINNET";
  }
  // Default to testnet for safety
  console.warn(`Could not determine environment from RPC URL: ${rpcUrl}. Defaulting to TESTNET.`);
  return "TESTNET";
}

/**
 * Gets agent configuration and validates it
 * @throws {Error} If agent configuration is missing or invalid
 */
function getAgentConfiguration(): {
  environment: ParadexEnvironment;
  account: {
    address: string;
    privateKey: string;
  };
} {
  const currentAgentId = getCurrentAgentId();
  const agentConfig = StarknetConfigStore.getInstance().getConfig(currentAgentId);

  if (!agentConfig) {
    throw new Error(
      `No configuration found for agent ${currentAgentId}. Please ensure the agent is properly initialized with Starknet configuration.`
    );
  }

  if (!agentConfig.address || !agentConfig.privateKey || !agentConfig.rpcUrl) {
    throw new Error(
      `Incomplete configuration for agent ${currentAgentId}. Required: address, privateKey, and rpcUrl.`
    );
  }

  const environment = getEnvironmentFromRpcUrl(agentConfig.rpcUrl);

  return {
    environment,
    account: {
      address: agentConfig.address,
      privateKey: agentConfig.privateKey,
    },
  };
}

/**
 * Validates numeric input parameters
 */
function validateNumericInput(value: string, fieldName: string): void {
  if (!value || value === "0") {
    throw new Error(`${fieldName} must be specified and greater than 0`);
  }

  try {
    const num = new BigNumber(value);
    if (num.isNaN() || num.lte(0)) {
      throw new Error(`${fieldName} must be a valid positive number`);
    }
  } catch (error) {
    throw new Error(
      `${fieldName} must be a valid number: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Validates order parameters with enhanced support for advanced order types
 */
function validateOrderParameters(orderDetails: OrderRequest): void {
  if (!orderDetails.market) {
    throw new Error("Market symbol is required");
  }

  if (!orderDetails.side || !["BUY", "SELL"].includes(orderDetails.side)) {
    throw new Error("Side must be either 'BUY' or 'SELL'");
  }

  if (
    !orderDetails.type ||
    !["MARKET", "LIMIT", "STOP", "STOP_LIMIT"].includes(orderDetails.type)
  ) {
    throw new Error("Type must be one of: 'MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'");
  }

  validateNumericInput(orderDetails.size, "Size");

  if (orderDetails.type === "LIMIT" || orderDetails.type === "STOP_LIMIT") {
    if (!orderDetails.price) {
      throw new Error("Price is required for LIMIT and STOP_LIMIT orders");
    }
    validateNumericInput(orderDetails.price, "Price");
  }

  if (orderDetails.type === "STOP" || orderDetails.type === "STOP_LIMIT") {
    if (!orderDetails.trigger_price) {
      throw new Error("Trigger price is required for STOP and STOP_LIMIT orders");
    }
    validateNumericInput(orderDetails.trigger_price, "Trigger price");
  }

  // Validate instruction if provided
  if (
    orderDetails.instruction &&
    !["GTC", "POST_ONLY", "IOC", "RPI"].includes(orderDetails.instruction)
  ) {
    throw new Error("Instruction must be one of: 'GTC', 'POST_ONLY', 'IOC', 'RPI'");
  }

  // Validate flags if provided
  if (orderDetails.flags && Array.isArray(orderDetails.flags)) {
    const validFlags = [
      "REDUCE_ONLY",
      "STOP_CONDITION_BELOW_TRIGGER",
      "STOP_CONDITION_ABOVE_TRIGGER",
      "INTERACTIVE",
    ];
    for (const flag of orderDetails.flags) {
      if (!validFlags.includes(flag)) {
        throw new Error(`Invalid flag: ${flag}. Valid flags are: ${validFlags.join(", ")}`);
      }
    }
  }

  // Validate STP (Self Trade Prevention) if provided
  if (
    orderDetails.stp &&
    !["EXPIRE_MAKER", "EXPIRE_TAKER", "EXPIRE_BOTH"].includes(orderDetails.stp)
  ) {
    throw new Error("STP must be one of: 'EXPIRE_MAKER', 'EXPIRE_TAKER', 'EXPIRE_BOTH'");
  }
}

/**
 * Validates API response and throws descriptive errors
 */
function validateApiResponse(response: Response, operation: string): void {
  if (!response.ok) {
    const statusMessages: Record<number, string> = {
      400: "Bad Request - Invalid parameters",
      401: "Unauthorized - Invalid or expired authentication",
      403: "Forbidden - Insufficient permissions",
      404: "Not Found - Resource does not exist",
      429: "Rate Limited - Too many requests",
      500: "Internal Server Error - Paradex server error",
      503: "Service Unavailable - Paradex temporarily unavailable",
    };

    const message = statusMessages[response.status] || `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${message}`);
  }
}

export async function paradexLogin(): Promise<{ config: SystemConfig; account: Account }> {
  const { environment, account: accountData } = getAgentConfiguration();
  const envConfig = PARADEX_ENVIRONMENTS[environment];

  const config: SystemConfig = {
    apiBaseUrl: envConfig.apiBaseUrl,
    starknet: {
      chainId: shortString.encodeShortString(envConfig.chainId),
    },
  };

  const account: Account = {
    address: accountData.address,
    privateKey: accountData.privateKey,
  };
  console.log(`Authenticating Paradex account ${account.address} on ${environment}`);

  try {
    account.jwtToken = await authenticate(config, account);
    return { config, account };
  } catch (error) {
    throw new Error(
      `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}\nPlease check your account credentials and network connection.`
    );
  }
}

export async function authenticate(config: SystemConfig, account: Account): Promise<string> {
  const { signature, timestamp, expiration } = signAuthRequest(config, account);
  const headers = {
    Accept: "application/json",
    "PARADEX-STARKNET-ACCOUNT": account.address,
    "PARADEX-STARKNET-SIGNATURE": signature,
    "PARADEX-TIMESTAMP": timestamp.toString(),
    "PARADEX-SIGNATURE-EXPIRATION": expiration.toString(),
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/auth`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    validateApiResponse(response, "Authentication");

    const data = await response.json();

    if (!data.jwt_token) {
      throw new Error("Authentication response missing JWT token");
    }

    return data.jwt_token;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Authentication failed: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/account/get-info
export async function getAccountInfo(config: SystemConfig, account: Account): Promise<AccountInfo> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/account/info`, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get account info");

    const data = await response.json();
    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get account info: ${error}`);
  }
}

// https://docs.paradex.trade/api/prod/markets/get-markets
export async function listAvailableMarkets(
  config: SystemConfig,
  market?: string
): Promise<Market[]> {
  const headers = {
    Accept: "application/json",
  };

  try {
    const url = market
      ? `${config.apiBaseUrl}/markets?market=${encodeURIComponent(market)}`
      : `${config.apiBaseUrl}/markets`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "List available markets");

    const data = await response.json();

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid response format: expected {results: [...]} structure");
    }

    return data.results;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to list available markets: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/account/get-positions
export async function getPositions(config: SystemConfig, account: Account): Promise<Position[]> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/positions`, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get positions");

    const data = await response.json();

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid response format: missing or invalid results array");
    }

    return data.results;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get positions: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/orders/get-open-orders
export async function getOpenOrders(config: SystemConfig, account: Account): Promise<Order[]> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/orders`, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get open orders");

    const data = await response.json();

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid response format: missing or invalid results array");
    }

    return data.results;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get open orders: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/orders/new
export async function openOrder(
  config: SystemConfig,
  account: Account,
  orderDetails: OrderRequest
): Promise<unknown> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  // Validate order parameters
  validateOrderParameters(orderDetails);

  const timestamp = Date.now();
  const signature = signOrder(config, account, orderDetails as Record<string, string>, timestamp);

  const inputBody = JSON.stringify({
    ...orderDetails,
    signature: signature,
    signature_timestamp: timestamp,
  });

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/orders`, {
      method: "POST",
      headers,
      body: inputBody,
    });

    validateApiResponse(response, "Create order");

    const data = await response.json();

    if (!data.id && !data.orderId) {
      throw new Error("Order creation response missing order ID");
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to create order: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/orders/cancel
export async function cancelOrder(
  config: SystemConfig,
  account: Account,
  orderId: string
): Promise<boolean> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  if (!orderId || typeof orderId !== "string") {
    throw new Error("Valid order ID is required");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE",
      headers,
    });

    validateApiResponse(response, "Cancel order");

    return true;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to cancel order: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/orders/modify
export async function modifyOrder(
  config: SystemConfig,
  account: Account,
  orderId: string,
  updates: OrderModification
): Promise<unknown> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  if (!orderId || typeof orderId !== "string") {
    throw new Error("Valid order ID is required");
  }

  // Validate update parameters
  if (updates.price) {
    validateNumericInput(updates.price, "Price");
  }
  if (updates.size) {
    validateNumericInput(updates.size, "Size");
  }
  if (updates.trigger_price) {
    validateNumericInput(updates.trigger_price, "Trigger price");
  }

  const timestamp = Date.now();

  // Sign the modification request
  const modifyData = {
    ...updates,
    timestamp: timestamp,
  };

  const inputBody = JSON.stringify({
    ...modifyData,
    signature_timestamp: timestamp,
  });

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/orders/${encodeURIComponent(orderId)}`, {
      method: "PUT",
      headers,
      body: inputBody,
    });

    validateApiResponse(response, "Modify order");

    const data = await response.json();
    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to modify order: ${error}`);
  }
}

// https://docs.paradex.trade/api/prod/markets/get-orderbook
export async function getOrderBook(
  config: SystemConfig,
  market: string,
  depth?: number
): Promise<OrderBook> {
  const headers = {
    Accept: "application/json",
  };

  try {
    let url = `${config.apiBaseUrl}/orderbook/${encodeURIComponent(market)}`;
    if (depth) {
      url += `?depth=${depth}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get order book");

    const data = await response.json();
    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get order book: ${error}`);
  }
}

// https://docs.paradex.trade/api-reference/prod/account/list-fills
export async function getFills(
  config: SystemConfig,
  account: Account,
  market?: string,
  limit?: number
): Promise<Fill[]> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    let url = `${config.apiBaseUrl}/fills`;
    const params = new URLSearchParams();

    if (market) {
      params.append("market", market);
    }
    if (limit) {
      params.append("page_size", limit.toString());
    }

    if (params.toString()) {
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get fills");

    const data = await response.json();

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid response format: missing or invalid results array");
    }

    return data.results;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get fills: ${error}`);
  }
}

// https://docs.paradex.trade/api/prod/markets/get-markets-summary
export async function getMarketStats(config: SystemConfig, market?: string): Promise<MarketStats> {
  const headers = {
    Accept: "application/json",
  };

  try {
    const marketParam = market || "ALL";
    const url = `${config.apiBaseUrl}/markets/summary?market=${encodeURIComponent(marketParam)}`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get market stats");

    const data = await response.json();
    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get market stats: ${error}`);
  }
}

// https://docs.paradex.trade/api/prod/account/get-funding
export async function getFundingPayments(
  config: SystemConfig,
  account: Account,
  market: string,
  limit?: number
): Promise<FundingPayment> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  if (!market) {
    throw new Error("Market parameter is required for funding payments");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    let url = `${config.apiBaseUrl}/funding/payments?market=${encodeURIComponent(market)}`;
    if (limit) {
      url += `&page_size=${limit}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    validateApiResponse(response, "Get funding payments");

    const data = await response.json();
    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to get funding payments: ${error}`);
  }
}

//
// private
//

// Utility function to generate current and expiration timestamps
function generateTimestamps(): {
  timestamp: UnixTime;
  expiration: UnixTime;
} {
  const dateNow = new Date();
  const dateExpiration = new Date(dateNow.getTime() + SEVEN_DAYS_MS);

  return {
    timestamp: getUnixTime(dateNow),
    expiration: getUnixTime(dateExpiration),
  };
}

function signAuthRequest(
  config: SystemConfig,
  account: Account
): {
  signature: string;
  timestamp: UnixTime;
  expiration: UnixTime;
} {
  const { timestamp, expiration } = generateTimestamps();

  const request: AuthRequest = {
    method: "POST",
    path: "/v1/auth",
    body: "",
    timestamp,
    expiration,
  };

  const typedData = buildAuthTypedData(request, config.starknet.chainId);
  const signature = signatureFromTypedData(account, typedData);

  return { signature, timestamp, expiration };
}

function signOrder(
  config: SystemConfig,
  account: Account,
  orderDetails: Record<string, string>,
  timestamp: UnixTime
): string {
  const sideForSigning = orderDetails.side === "BUY" ? "1" : "2";

  const priceForSigning = toQuantums(orderDetails.price ?? "0", 8);
  const sizeForSigning = toQuantums(orderDetails.size, 8);
  const orderTypeForSigning = shortString.encodeShortString(orderDetails.type);
  const marketForSigning = shortString.encodeShortString(orderDetails.market);

  const message = {
    timestamp: timestamp,
    market: marketForSigning,
    side: sideForSigning,
    orderType: orderTypeForSigning,
    size: sizeForSigning,
    price: priceForSigning,
  };

  const typedData = buildOrderTypedData(message, config.starknet.chainId);
  const signature = signatureFromTypedData(account, typedData);

  return signature;
}

function buildAuthTypedData(message: Record<string, unknown>, starknetChainId: string) {
  const paradexDomain = buildParadexDomain(starknetChainId);
  return {
    domain: paradexDomain,
    primaryType: "Request",
    types: {
      ...DOMAIN_TYPES,
      Request: [
        { name: "method", type: "felt" },
        { name: "path", type: "felt" },
        { name: "body", type: "felt" },
        { name: "timestamp", type: "felt" },
        { name: "expiration", type: "felt" },
      ],
    },
    message,
  };
}

function buildOrderTypedData(message: Record<string, unknown>, starknetChainId: string) {
  const paradexDomain = buildParadexDomain(starknetChainId);
  return {
    domain: paradexDomain,
    primaryType: "Order",
    types: {
      ...DOMAIN_TYPES,
      Order: [
        { name: "timestamp", type: "felt" },
        { name: "market", type: "felt" },
        { name: "side", type: "felt" },
        { name: "orderType", type: "felt" },
        { name: "size", type: "felt" },
        { name: "price", type: "felt" },
      ],
    },
    message,
  };
}

function buildParadexDomain(starknetChainId: string) {
  return {
    name: "Paradex",
    chainId: starknetChainId,
    version: "1",
  };
}

function signatureFromTypedData(account: Account, typedData: TypedData) {
  const msgHash = starkTypedData.getMessageHash(typedData, account.address);
  const { r, s } = ec.starkCurve.sign(msgHash, account.privateKey);
  return JSON.stringify([r.toString(), s.toString()]);
}

/**
 * Convert to quantums rounding final number down.
 *
 * @param amount Amount in human numbers
 * @param precision How many decimals the target contract works with
 * @returns Quantum value
 */
export function toQuantums(amount: BigNumber | string, precision: number): string {
  const bnAmount = typeof amount === "string" ? BigNumber(amount) : amount;
  const bnQuantums = bnAmount.dividedBy(`1e-${precision}`);
  return bnQuantums.integerValue(BigNumber.ROUND_FLOOR).toString();
}
