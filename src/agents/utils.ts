import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Represents the configuration for a Starknet connection
 */
export interface StarknetConfig {
  rpcUrl: string;
  address: string;
  privateKey: string;
}

/**
 * A singleton store for Starknet configuration by agent ID
 */
export class StarknetConfigStore {
  private static instance: StarknetConfigStore;
  private configs: Map<string, StarknetConfig> = new Map();

  private constructor() {}

  public static getInstance(): StarknetConfigStore {
    if (!StarknetConfigStore.instance) {
      StarknetConfigStore.instance = new StarknetConfigStore();
    }
    return StarknetConfigStore.instance;
  }

  public setConfig(agentId: string, config: StarknetConfig): void {
    this.configs.set(agentId, config);
  }

  public getConfig(agentId: string): StarknetConfig | undefined {
    return this.configs.get(agentId);
  }
}

/**
 * Validates if an agent number is within the acceptable range
 * @param agentNumber The agent number to validate
 * @throws Error if agent number is invalid
 */
export function validateAgentNumber(agentNumber: number): void {
  if (Number.isNaN(agentNumber) || agentNumber < 1 || agentNumber > 4) {
    throw new Error(`Invalid agent number: ${agentNumber}. Must be between 1 and 4.`);
  }
}

/**
 * Gets the agent ID from environment variable or agent number
 * @param agentNumber The agent number
 * @returns The agent ID string
 */
export function getAgentId(agentNumber: number): string {
  if (process.env.CURRENT_AGENT_ID) {
    return process.env.CURRENT_AGENT_ID;
  }

  validateAgentNumber(agentNumber);
  return `agent-${agentNumber}`;
}

/**
 * Gets the command line arguments
 * @returns Array of command line arguments
 */
export function getCommandLineArgs(): string[] {
  return process.argv.slice(2);
}

/**
 * Checks if the agent is running in manual mode
 * @returns Boolean indicating if manual mode is enabled
 */
export function isManualMode(): boolean {
  return getCommandLineArgs().includes("--manual");
}

/**
 * Gets the Google API key for a specific agent
 * @param agentId The agent ID
 * @param agentNumber The agent number
 * @returns The Google API key
 * @throws Error if no API key is found
 */
export function getGoogleApiKey(agentId: string, agentNumber: number): string {
  // Validate agent number
  validateAgentNumber(agentNumber);

  const apiKeyEnvVar = `AGENT${agentNumber}_API_KEY`;

  // Get API key and remove quotes if present
  let apiKey = process.env[apiKeyEnvVar];
  if (apiKey) {
    apiKey = apiKey.replace(/^["'](.*)["']$/, "$1").trim();
  } else {
    // Fall back to default key
    apiKey = process.env.GOOGLE_API_KEY;
    if (apiKey) {
      apiKey = apiKey.replace(/^["'](.*)["']$/, "$1").trim();
    }
  }

  if (!apiKey) {
    throw new Error(
      `No Google API key found for agent ${agentId}. Please set AGENT${agentNumber}_API_KEY or GOOGLE_API_KEY in environment variables.`
    );
  }

  return apiKey;
}

/**
 * Gets the ChromaDB URL from environment variables or falls back to the default container
 * @returns The ChromaDB URL
 */
export function getChromaDbUrl(): string {
  // Check if we're running locally (not in Docker)
  const isLocalDev = !process.env.HOSTNAME?.includes("container");

  let chromaHost: string;

  if (isLocalDev) {
    // When running locally outside Docker, we need to use localhost or the specified host
    chromaHost = process.env.CHROMA_HOST || "localhost";
  } else {
    // For Docker environment
    const defaultPrefix = process.env.COMPOSE_PROJECT_NAME || "daydreams";
    chromaHost = process.env.CHROMA_HOST || `${defaultPrefix}_chroma`;
  }

  const chromaPort = process.env.CHROMA_PORT || "8000";

  return `http://${chromaHost}:${chromaPort}`;
}

/**
 * Gets the Starknet configuration for a specific agent
 * @param agentNumber The agent number
 * @returns Starknet configuration object
 * @throws Error if configuration is missing
 */
export function getStarknetConfig(agentNumber: number): StarknetConfig {
  // Validate agent number
  validateAgentNumber(agentNumber);

  const rpcUrl = process.env.STARKNET_RPC_URL;
  const address = process.env[`AGENT${agentNumber}_ADDRESS`];
  const privateKey = process.env[`AGENT${agentNumber}_PRIVATE_KEY`];

  if (!rpcUrl) {
    throw new Error("STARKNET_RPC_URL is not defined in environment variables");
  }

  if (!address) {
    throw new Error(`AGENT${agentNumber}_ADDRESS is not defined in environment variables`);
  }

  if (!privateKey) {
    throw new Error(`AGENT${agentNumber}_PRIVATE_KEY is not defined in environment variables`);
  }

  return { rpcUrl, address, privateKey };
}

/**
 * Generates a collection name in the format:
 * f_{last 5 char of game factory address}_s_{gameSessionId}_a_{agentId}
 *
 * @param agentId The ID of the agent
 * @returns The formatted collection name string
 * @throws Error if unable to fetch game session info
 */
export async function getCollectionName(agentId: string): Promise<string> {
  try {
    // Extract just the number from agentId (e.g., "agent-2" → "2")
    const agentNumber = agentId.charAt(agentId.length - 1);

    // Format the collection name
    return `trading_mvp_a_${agentNumber}`;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get collection name: ${errorMessage}`);
  }
}

/**
 * Gets the Supabase configuration from environment variables
 * @returns Supabase configuration object
 * @throws Error if required config is missing
 */
export function getFirebaseConfig() {
  const projectId = process.env.FB_PROJECT_ID;
  const clientEmail = process.env.FB_CLIENT_EMAIL;
  const privateKey = process.env.FB_PRIVATE_KEY || "";

  if (!projectId) {
    throw new Error("FB_PROJECT_ID must be provided in environment variables");
  }

  if (!clientEmail) {
    throw new Error("FB_CLIENT_EMAIL must be provided in environment variables");
  }

  if (!privateKey) {
    throw new Error("FB_PRIVATE_KEY must be provided in environment variables");
  }

  // Decode the Base64 encoded key and properly format it
  let decodedKey: string;
  try {
    // Use Buffer to decode base64 (more reliable than atob)
    decodedKey = Buffer.from(privateKey, "base64").toString();

    // Handle newline characters correctly
    decodedKey = decodedKey.replace(/\\n/g, "\n");
  } catch (error) {
    console.error("Error decoding private key:", error);
    throw new Error("Failed to decode FB_PRIVATE_KEY. Make sure it is properly base64 encoded.");
  }

  return {
    projectId,
    clientEmail,
    privateKey: decodedKey,
  };
}

/**
 * Validates all required environment variables for the agents
 * @param agentNumber The agent number to validate for (optional, validates common vars if not provided)
 * @throws Error if any required environment variable is missing
 */
export function validateEnvironmentVariables(agentNumber?: number): void {
  const missing: string[] = [];

  // Common required variables
  if (!process.env.STARKNET_RPC_URL) {
    missing.push("STARKNET_RPC_URL");
  }

  if (!process.env.LUNARCRUSH_API_KEY) {
    missing.push("LUNARCRUSH_API_KEY");
  }

  if (!process.env.FB_PROJECT_ID) {
    missing.push("FB_PROJECT_ID");
  }

  if (!process.env.FB_CLIENT_EMAIL) {
    missing.push("FB_CLIENT_EMAIL");
  }

  if (!process.env.FB_PRIVATE_KEY) {
    missing.push("FB_PRIVATE_KEY");
  }

  // Agent-specific validation
  if (agentNumber) {
    validateAgentNumber(agentNumber);

    // Required for all agents
    if (!process.env[`AGENT${agentNumber}_ADDRESS`]) {
      missing.push(`AGENT${agentNumber}_ADDRESS`);
    }

    if (!process.env[`AGENT${agentNumber}_PRIVATE_KEY`]) {
      missing.push(`AGENT${agentNumber}_PRIVATE_KEY`);
    }

    if (!process.env[`AGENT${agentNumber}_API_KEY`] && !process.env.GOOGLE_API_KEY) {
      missing.push(`AGENT${agentNumber}_API_KEY or GOOGLE_API_KEY`);
    }

    // OpenRouter key required for agents 2-4
    if (agentNumber > 1) {
      if (
        !process.env[`AGENT${agentNumber}_OPENROUTER_API_KEY`] &&
        !process.env.OPENROUTER_API_KEY
      ) {
        missing.push(`AGENT${agentNumber}_OPENROUTER_API_KEY or OPENROUTER_API_KEY`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Please check your .env file and ensure all required variables are set. You can use .env.example as a template.`
    );
  }
}
