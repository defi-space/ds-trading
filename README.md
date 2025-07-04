# ds-trading-agents: Autonomous Trading Agents for Paradex

ds-trading-agents is a multi-agent system designed for automated trading on the Paradex platform. It allows you to run up to four autonomous agents, each powered by a different large language model (LLM), to execute trading strategies, manage goals, and interact with the Paradex API.

## Features

- **Multi-Agent System:** Run up to four agents concurrently, each in its own process.
- **Diverse AI Models:** Each agent is powered by a different LLM for a variety of responses and strategies:
    - **Agent 1:** Google Gemini 2.0 Flash
    - **Agent 2:** xAI Grok Beta (via OpenRouter)
    - **Agent 3:** OpenAI GPT-4.1 Mini (via OpenRouter)
    - **Agent 4:** Anthropic Claude 3.5 Haiku (via OpenRouter)
- **Paradex Integration:** A comprehensive set of tools for interacting with the Paradex API, including:
    - Account information retrieval
    - Order management (open, cancel, list open orders)
    - Market data (list available markets)
    - Position tracking
- **Goal Management:** A flexible goal management system that allows agents to create, update, and delete long-term, medium-term, and short-term goals.
- **Extensible Architecture:** Built on `@daydreamsai/core`, the system is highly extensible. It includes a command-line interface (CLI) for manual control and an autonomous mode for hands-off operation.
- **Real-time Data:** Includes a "Model Context Protocol" (MCP) extension for connecting to real-time data feeds like LunarCrush for asset context, price history, and market sentiment analysis.
- **Configurable:** Uses environment variables for easy configuration of API keys, Starknet wallets, and other settings.

## Available Tools

The agents have access to a variety of tools for trading and goal management:

### Trading Tools

-   **`getAccountInfo`**: Retrieves comprehensive account information, including balance, free collateral, and trading details.
-   **`openOrder`**: Creates a new trading order on Paradex. Supports both `MARKET` and `LIMIT` orders.
-   **`cancelOrder`**: Cancels an existing order using its order ID.
-   **`listOpenOrders`**: Retrieves all currently open (unfilled) orders for the account.
-   **`listAvailableMarkets`**: Fetches all available trading markets and their symbols on Paradex.
-   **`getPositions`**: Retrieves all current open positions for the trading account.

### Goal Management Tools

-   **`addTask`**: Creates and adds a new task to the agent's goal list with a specified priority and timeframe (long-term, medium-term, or short-term).
-   **`setGoalPlan`**: Sets the complete goal planning structure for the agent.
-   **`updateGoal`**: Updates the properties of a specific goal by its ID.
-   **`deleteGoal`**: Removes a goal from the agent's goal list.

### Market Intelligence Tools (LunarCrush Integration)

The agents leverage LunarCrush API through Model Context Protocol (MCP) to gain comprehensive market intelligence:

-   **Asset Context**: Detailed information about cryptocurrencies and tokens, including fundamental data and market metrics.
-   **Price History**: Historical price data and trends to inform trading decisions and technical analysis.
-   **Market Sentiment**: Real-time social sentiment analysis from various platforms to gauge market mood and potential price movements.
-   **Token Analytics**: Overall market feeling and community sentiment about specific tokens to enhance trading strategies.
-   **Social Data**: Aggregated social media mentions, engagement metrics, and influence scores for better market understanding.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) installed on your system.
- A Paradex account and a Starknet wallet.
- API keys for Google, OpenRouter, and LunarCrush.

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/ds-agents.git
    cd ds-agents
    ```

2.  **Install dependencies:**
    ```bash
    bun install
    ```

### Configuration

1.  **Create a `.env` file:**
    Copy the `.env.example` file to a new file named `.env`:
    ```bash
    cp .env.example .env
    ```

2.  **Edit the `.env` file:**
    Fill in the required environment variables in the `.env` file. This includes your API keys, Starknet wallet details, and other configuration options.

         **Required:**
     - `LUNARCRUSH_API_KEY` - For market sentiment, price history, and asset context data
     - `FIREBASE_PROJECT_ID` - Firebase project ID for persistent memory storage
     - `FIREBASE_CLIENT_EMAIL` - Firebase service account email
     - `FIREBASE_PRIVATE_KEY` - Firebase private key (base64 encoded)
     - `AGENT1_STARKNET_ADDRESS` - Starknet wallet address for Agent 1
     - `AGENT1_STARKNET_PRIVATE_KEY` - Starknet private key for Agent 1
     - `AGENT1_GOOGLE_API_KEY` - Google AI Studio API key for Gemini 2.0 Flash

    **Optional (depending on which agents you run):**
    - `OPENROUTER_API_KEY` (for agents 2, 3, and 4)
    - `AGENT2_STARKNET_ADDRESS`, `AGENT2_STARKNET_PRIVATE_KEY`
    - `AGENT3_STARKNET_ADDRESS`, `AGENT3_STARKNET_PRIVATE_KEY`
    - `AGENT4_STARKNET_ADDRESS`, `AGENT4_STARKNET_PRIVATE_KEY`


## Usage

You can run one or more agents using the following `bun` scripts:

-   **Run all four agents:**
    ```bash
    bun run start-all
    ```

-   **Run a specific number of agents (1-4):**
    ```bash
    bun run src/run-agents.ts <number_of_agents>
    ```
    For example, to run two agents:
    ```bash
    bun run src/run-agents.ts 2
    ```

-   **Run a single agent by its number (1-4):**
    ```bash
    bun run start-1
    bun run start-2
    bun run start-3
    bun run start-4
    ```

Each agent will start in its own process and log its output to the console with a unique color for easy identification.

## Project Structure

```
/
├───.env.example        # Example environment variables
├───package.json        # Project dependencies and scripts
├───README.md           # This file
├───src/
│   ├───run-agents.ts   # Main script for running the agents
│   ├───actions/        # Agent actions (goals, tools)
│   ├───agents/         # Agent creation and configuration
│   ├───extensions/     # CLI and autonomous mode extensions
│   ├───prompts/        # System prompts for the agents
│   ├───schema/         # Zod schemas for data validation
│   └───utils/          # Utility functions (Paradex, Starknet)
└───vendored/           # Local, vendored dependencies
```

## Contributing

Contributions are welcome! Please feel free to open an issue or submit a pull request.

1.  Fork the repository.
2.  Create a new branch (`git checkout -b feature/your-feature`).
3.  Make your changes.
4.  Commit your changes (`git commit -m 'Add some feature'`).
5.  Push to the branch (`git push origin feature/your-feature`).
6.  Open a pull request.

---

*This project is for educational and research purposes only. Trading cryptocurrencies involves significant risk. Use this software at your own risk.*