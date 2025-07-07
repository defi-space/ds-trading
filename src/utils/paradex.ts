// most stuff here is taken from
// https://github.com/tradeparadex/code-samples/tree/main/typescript

import BigNumber from "bignumber.js";
import type { Account, SystemConfig, UnixTime } from "../schema/paradex-types";
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
 * Validates order parameters
 */
function validateOrderParameters(orderDetails: Record<string, string>): void {
  if (!orderDetails.market) {
    throw new Error("Market symbol is required");
  }

  if (!orderDetails.side || !["BUY", "SELL"].includes(orderDetails.side)) {
    throw new Error("Side must be either 'BUY' or 'SELL'");
  }

  if (!orderDetails.type || !["MARKET", "LIMIT"].includes(orderDetails.type)) {
    throw new Error("Type must be either 'MARKET' or 'LIMIT'");
  }

  validateNumericInput(orderDetails.size, "Size");

  if (orderDetails.type === "LIMIT") {
    validateNumericInput(orderDetails.price, "Price");
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

export async function authenticate(
  config: SystemConfig,
  account: Account
): Promise<string> {
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

// https://docs.paradex.trade/api-reference/prod/account/get
export async function getAccountInfo(config: SystemConfig, account: Account): Promise<any> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${account.jwtToken}`,
  };

  try {
    const response = await fetch(`${config.apiBaseUrl}/account`, {
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

// https://docs.paradex.trade/api-reference/prod/markets/get-markets
export async function listAvailableMarkets(config: SystemConfig, market?: string): Promise<any[]> {
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
      throw new Error("Invalid response format: missing or invalid results array");
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
export async function getPositions(config: SystemConfig, account: Account): Promise<any[]> {
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
export async function getOpenOrders(
  config: SystemConfig,
  account: Account
): Promise<any[]> {
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
  orderDetails: Record<string, string>
): Promise<any> {
  if (!account.jwtToken) {
    throw new Error("Account not authenticated. Call paradexLogin() first.");
  }

  // Validate order parameters
  validateOrderParameters(orderDetails);

  const timestamp = Date.now();
  const signature = signOrder(config, account, orderDetails, timestamp);

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
    body: "", // Assuming no body is required for this request
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
        { name: "method", type: "felt" }, // string
        { name: "path", type: "felt" }, // string
        { name: "body", type: "felt" }, // string
        { name: "timestamp", type: "felt" }, // number
        { name: "expiration", type: "felt" }, // number
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
        { name: "timestamp", type: "felt" }, // UnixTimeMs; Acts as a nonce
        { name: "market", type: "felt" }, // 'BTC-USD-PERP'
        { name: "side", type: "felt" }, // '1': 'BUY'; '2': 'SELL'
        { name: "orderType", type: "felt" }, // 'LIMIT';  'MARKET'
        { name: "size", type: "felt" }, // Quantum value
        { name: "price", type: "felt" }, // Quantum value; '0' for Market order
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
