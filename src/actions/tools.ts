import { z, action } from "@daydreamsai/core";
import {
  cancelOrder,
  getAccountInfo,
  getOpenOrders,
  getPositions,
  listAvailableMarkets,
  openOrder,
  paradexLogin,
} from "../utils/paradex";

export const toolActions = [
  action({
    name: "getAccountInfo",
    description:
      "Retrieves comprehensive account information including balance, free collateral, and trading details.",
    instructions:
      "Use this action when you need to check account status, available balance, or trading capacity before making trading decisions.",
    schema: z.object({}),
    handler: async (_call, _ctx, _agent) => {
      try {
        const { config, account } = await paradexLogin();
        const accountInfo = await getAccountInfo(config, account);

        return {
          success: true,
          message: "Account information retrieved successfully",
          data: accountInfo,
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get account info:", error);
        return {
          success: false,
          message: `Failed to retrieve account information: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Action ${ctx.call.name} failed:`, error);
      ctx.emit("actionError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "openOrder",
    description: "Creates a new trading order on Paradex with specified parameters.",
    instructions:
      "Use this action when you want to place a buy or sell order. Ensure you have sufficient balance and the market is available before placing the order.",
    schema: z.object({
      instruction: z
        .literal("GTC")
        .describe(
          "Order instruction - Good Till Cancelled (GTC) keeps the order active until filled or manually cancelled"
        ),
      market: z
        .string()
        .describe("Market symbol for the trading pair (e.g., 'BTC-USD-PERP', 'ETH-USD-PERP')"),
      price: z
        .string()
        .describe("Order price as a string (required for LIMIT orders, ignored for MARKET orders)"),
      size: z.string().describe("Order size/quantity as a string representing the amount to trade"),
      side: z
        .enum(["BUY", "SELL"])
        .describe("Order side - BUY to purchase or SELL to sell the asset"),
      type: z
        .enum(["MARKET", "LIMIT"])
        .describe(
          "Order type - MARKET for immediate execution at current price, LIMIT for execution at specified price"
        ),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        // Input validation
        if (call.type === "LIMIT" && (!call.price || call.price === "0")) {
          return {
            success: false,
            message: "Cannot create LIMIT order: price must be specified and greater than 0",
            timestamp: Date.now(),
          };
        }

        if (!call.size || call.size === "0") {
          return {
            success: false,
            message: "Cannot create order: size must be specified and greater than 0",
            timestamp: Date.now(),
          };
        }

        const { config, account } = await paradexLogin();
        const response = await openOrder(config, account, call);

        return {
          success: true,
          message: `${call.type} ${call.side} order created successfully for ${call.size} ${call.market}`,
          data: {
            orderId: response.orderId || response.id,
            market: call.market,
            side: call.side,
            type: call.type,
            size: call.size,
            price: call.price,
            instruction: call.instruction,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to create order:", error);
        return {
          success: false,
          message: `Failed to create order: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Order creation ${ctx.call.name} failed:`, error);
      ctx.emit("orderError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "cancelOrder",
    description: "Cancels an existing order on Paradex using the order ID.",
    instructions:
      "Use this action when you want to cancel a pending or partially filled order. You need the specific order ID to cancel it.",
    schema: z.object({
      orderId: z.string().describe("Unique identifier of the order to cancel"),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        if (!call.orderId) {
          return {
            success: false,
            message: "Cannot cancel order: orderId is required",
            timestamp: Date.now(),
          };
        }

        const { config, account } = await paradexLogin();
        const _response = await cancelOrder(config, account, call.orderId);

        return {
          success: true,
          message: `Order ${call.orderId} cancelled successfully`,
          data: {
            orderId: call.orderId,
            status: "cancelled",
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to cancel order:", error);
        return {
          success: false,
          message: `Failed to cancel order ${call.orderId}: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Order cancellation ${ctx.call.name} failed:`, error);
      ctx.emit("cancelOrderError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "listOpenOrders",
    description: "Retrieves all currently open (unfilled) orders for the account.",
    instructions:
      "Use this action when you need to see all pending orders, check order status, or manage existing orders.",
    schema: z.object({}),
    handler: async (_call, _ctx, _agent) => {
      try {
        const { config, account } = await paradexLogin();
        const response = await getOpenOrders(config, account);

        return {
          success: true,
          message: `Retrieved ${Array.isArray(response) ? response.length : 0} open orders`,
          data: response,
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get open orders:", error);
        return {
          success: false,
          message: `Failed to retrieve open orders: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`List open orders ${ctx.call.name} failed:`, error);
      ctx.emit("listOrdersError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "listAvailableMarkets",
    description: "Fetches all available trading markets and their symbols on Paradex.",
    instructions:
      "Use this action when you need to see what markets are available for trading or to validate market symbols before placing orders.",
    schema: z.object({}),
    handler: async (_call, _ctx, _agent) => {
      try {
        const { config } = await paradexLogin();
        const response = await listAvailableMarkets(config);

        const markets: string[] = [];
        for (const market of response) {
          markets.push(market.symbol);
        }

        return {
          success: true,
          message: `Retrieved ${markets.length} available markets`,
          data: {
            markets: markets,
            count: markets.length,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get available markets:", error);
        return {
          success: false,
          message: `Failed to retrieve available markets: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`List available markets ${ctx.call.name} failed:`, error);
      ctx.emit("listMarketsError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "getPositions",
    description: "Retrieves all current open positions for the trading account.",
    instructions:
      "Use this action when you need to check your current market exposure, position sizes, or unrealized P&L across all markets.",
    schema: z.object({}),
    handler: async (_call, _ctx, _agent) => {
      try {
        const { config, account } = await paradexLogin();
        const response = await getPositions(config, account);

        return {
          success: true,
          message: `Retrieved ${Array.isArray(response) ? response.length : 0} positions`,
          data: response,
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get positions:", error);
        return {
          success: false,
          message: `Failed to retrieve positions: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Get positions ${ctx.call.name} failed:`, error);
      ctx.emit("getPositionsError", { action: ctx.call.name, error: error.message });
    },
  }),
];
