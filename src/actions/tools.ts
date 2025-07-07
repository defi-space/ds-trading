import { z, action } from "@daydreamsai/core";
import type { OrderModification } from "../schema/paradex-types";
import {
  cancelOrder,
  getAccountInfo,
  getOpenOrders,
  getPositions,
  listAvailableMarkets,
  openOrder,
  paradexLogin,
  modifyOrder,
  getOrderBook,
  getFills,
  getMarketStats,
  getFundingPayments,
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
    description:
      "Creates a new trading order on Paradex with specified parameters including advanced order types.",
    instructions:
      "Use this action when you want to place a buy or sell order. Supports MARKET, LIMIT, STOP, and STOP_LIMIT orders with various flags and instructions. Ensure you have sufficient balance and the market is available before placing the order.",
    schema: z.object({
      instruction: z
        .enum(["GTC", "POST_ONLY", "IOC", "RPI"])
        .default("GTC")
        .describe(
          "Order instruction - GTC (Good Till Cancelled), POST_ONLY (only add liquidity), IOC (Immediate or Cancel), RPI (Reduce Position If)"
        ),
      market: z
        .string()
        .describe("Market symbol for the trading pair (e.g., 'BTC-USD-PERP', 'ETH-USD-PERP')"),
      price: z
        .string()
        .optional()
        .describe(
          "Order price as a string (required for LIMIT and STOP_LIMIT orders, ignored for MARKET and STOP orders)"
        ),
      size: z.string().describe("Order size/quantity as a string representing the amount to trade"),
      side: z
        .enum(["BUY", "SELL"])
        .describe("Order side - BUY to purchase or SELL to sell the asset"),
      type: z
        .enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"])
        .describe(
          "Order type - MARKET (immediate execution), LIMIT (execution at specified price), STOP (stop order), STOP_LIMIT (stop limit order)"
        ),
      trigger_price: z.string().optional().describe("Trigger price for STOP and STOP_LIMIT orders"),
      flags: z
        .array(
          z.enum([
            "REDUCE_ONLY",
            "STOP_CONDITION_BELOW_TRIGGER",
            "STOP_CONDITION_ABOVE_TRIGGER",
            "INTERACTIVE",
          ])
        )
        .optional()
        .describe(
          "Order flags - REDUCE_ONLY to only reduce position size, stop condition flags for trigger direction"
        ),
      stp: z
        .enum(["EXPIRE_MAKER", "EXPIRE_TAKER", "EXPIRE_BOTH"])
        .optional()
        .describe("Self Trade Prevention mode"),
      client_id: z.string().optional().describe("Client-provided order ID for tracking"),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        // Input validation
        if (
          (call.type === "LIMIT" || call.type === "STOP_LIMIT") &&
          (!call.price || call.price === "0")
        ) {
          return {
            success: false,
            message:
              "Cannot create LIMIT/STOP_LIMIT order: price must be specified and greater than 0",
            timestamp: Date.now(),
          };
        }

        if (
          (call.type === "STOP" || call.type === "STOP_LIMIT") &&
          (!call.trigger_price || call.trigger_price === "0")
        ) {
          return {
            success: false,
            message:
              "Cannot create STOP/STOP_LIMIT order: trigger_price must be specified and greater than 0",
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
        const responseData = response as { orderId?: string; id?: string; [key: string]: unknown };

        return {
          success: true,
          message: `${call.type} ${call.side} order created successfully for ${call.size} ${call.market}`,
          data: {
            orderId: responseData.orderId || responseData.id,
            market: call.market,
            side: call.side,
            type: call.type,
            size: call.size,
            price: call.price,
            trigger_price: call.trigger_price,
            instruction: call.instruction,
            flags: call.flags,
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
    name: "modifyOrder",
    description:
      "Modifies an existing order on Paradex by updating price, size, or other parameters.",
    instructions:
      "Use this action when you want to update an existing order instead of canceling and placing a new one. You can modify price, size, trigger_price, and other order parameters.",
    schema: z.object({
      orderId: z.string().describe("Unique identifier of the order to modify"),
      price: z.string().optional().describe("New price for the order"),
      size: z.string().optional().describe("New size for the order"),
      trigger_price: z.string().optional().describe("New trigger price for stop orders"),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        if (!call.orderId) {
          return {
            success: false,
            message: "Cannot modify order: orderId is required",
            timestamp: Date.now(),
          };
        }

        if (!call.price && !call.size && !call.trigger_price) {
          return {
            success: false,
            message:
              "Cannot modify order: at least one parameter (price, size, or trigger_price) must be provided",
            timestamp: Date.now(),
          };
        }

        const { config, account } = await paradexLogin();
        const updates: OrderModification = {};

        if (call.price) updates.price = call.price;
        if (call.size) updates.size = call.size;
        if (call.trigger_price) updates.trigger_price = call.trigger_price;

        const response = await modifyOrder(config, account, call.orderId, updates);

        return {
          success: true,
          message: `Order ${call.orderId} modified successfully`,
          data: {
            orderId: call.orderId,
            updates: updates,
            response: response as unknown,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to modify order:", error);
        return {
          success: false,
          message: `Failed to modify order ${call.orderId}: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Order modification ${ctx.call.name} failed:`, error);
      ctx.emit("modifyOrderError", { action: ctx.call.name, error: error.message });
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
    name: "getOrderBook",
    description: "Retrieves the order book (market depth) for a specific trading market.",
    instructions:
      "Use this action when you need to analyze market depth, liquidity, or best bid/ask prices before placing orders. Essential for understanding market conditions.",
    schema: z.object({
      market: z
        .string()
        .describe("Market symbol to get order book for (e.g., 'BTC-USD-PERP', 'ETH-USD-PERP')"),
      depth: z
        .number()
        .optional()
        .describe(
          "Number of price levels to retrieve (optional, defaults to all available levels)"
        ),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        if (!call.market) {
          return {
            success: false,
            message: "Cannot get order book: market symbol is required",
            timestamp: Date.now(),
          };
        }

        const { config } = await paradexLogin();
        const response = await getOrderBook(config, call.market, call.depth);

        return {
          success: true,
          message: `Order book retrieved successfully for ${call.market}`,
          data: {
            market: call.market,
            depth: call.depth,
            orderBook: response,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get order book:", error);
        return {
          success: false,
          message: `Failed to retrieve order book for ${call.market}: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Get order book ${ctx.call.name} failed:`, error);
      ctx.emit("getOrderBookError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "getFills",
    description:
      "Retrieves your account's fill history (matched orders) with optional filtering by market.",
    instructions:
      "Use this action when you need to analyze your trading performance, review past fills, or track profit/loss. This returns matched orders that have been sent to chain for settlement.",
    schema: z.object({
      market: z
        .string()
        .optional()
        .describe(
          "Market symbol to filter fills for (optional - if not provided, returns fills for all markets)"
        ),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of fills to retrieve (optional, uses page_size parameter)"),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        const { config, account } = await paradexLogin();
        const response = await getFills(config, account, call.market, call.limit);

        return {
          success: true,
          message: `Retrieved ${Array.isArray(response) ? response.length : 0} fills`,
          data: {
            market: call.market,
            limit: call.limit,
            fills: response,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get fills:", error);
        return {
          success: false,
          message: `Failed to retrieve fills: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Get fills ${ctx.call.name} failed:`, error);
      ctx.emit("getFillsError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "getMarketStats",
    description:
      "Retrieves market statistics including 24h volume, price changes, and other market metrics.",
    instructions:
      "Use this action when you need to analyze market performance, compare different markets, or understand overall market conditions for trading decisions.",
    schema: z.object({
      market: z
        .string()
        .optional()
        .describe(
          "Market symbol to get stats for (optional - if not provided, returns stats for all markets)"
        ),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        const { config } = await paradexLogin();
        const response = await getMarketStats(config, call.market);

        return {
          success: true,
          message: call.market
            ? `Market statistics retrieved successfully for ${call.market}`
            : "Market statistics retrieved successfully for all markets",
          data: {
            market: call.market,
            stats: response,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get market stats:", error);
        return {
          success: false,
          message: `Failed to retrieve market statistics: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Get market stats ${ctx.call.name} failed:`, error);
      ctx.emit("getMarketStatsError", { action: ctx.call.name, error: error.message });
    },
  }),

  action({
    name: "getFundingPayments",
    description: "Retrieves funding payment history for a specific perpetual contract market.",
    instructions:
      "Use this action when trading perpetual contracts to understand funding payment history. Market parameter is required. Returns funding payments made by/to your account.",
    schema: z.object({
      market: z
        .string()
        .describe("Market symbol to get funding payments for (required for this endpoint)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of funding payments to retrieve (optional)"),
    }),
    handler: async (call, _ctx, _agent) => {
      try {
        if (!call.market) {
          return {
            success: false,
            message: "Cannot get funding payments: market parameter is required",
            timestamp: Date.now(),
          };
        }

        const { config, account } = await paradexLogin();
        const response = await getFundingPayments(config, account, call.market, call.limit);

        return {
          success: true,
          message: `Funding payment history retrieved successfully for ${call.market}`,
          data: {
            market: call.market,
            limit: call.limit,
            fundingPayments: response,
          },
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Failed to get funding payments:", error);
        return {
          success: false,
          message: `Failed to retrieve funding payments: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
      }
    },
    retry: 3,
    onError: async (error, ctx, _agent) => {
      console.error(`Get funding payments ${ctx.call.name} failed:`, error);
      ctx.emit("getFundingPaymentsError", { action: ctx.call.name, error: error.message });
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
