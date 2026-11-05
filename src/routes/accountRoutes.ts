import { admitExecution } from "../execution/executionAdmission.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  buildAccountQuery,
  buildCancelAllOrdersPayload,
  buildMarketCloseOrdersFromPositions,
} from "../account/accountActions.js";
import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import { getPathname, writeJson } from "../app/http.js";
import { getLiveExecutionMode } from "../execution/liveGuard.js";

export async function handleAccountRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  bybit: BybitAdapter;
  isReady?: () => boolean;
}): Promise<boolean> {
  const { request, response, config, bybit } = input;

  if (request.url === undefined) {
    return false;
  }

  const pathname = getPathname(request.url, config);

  const known = (request.method === "GET" && ["/account/balance", "/account/orders/active", "/account/positions/open"].includes(pathname)) ||
    (request.method === "POST" && ["/account/orders/cancel-all", "/account/positions/close-all"].includes(pathname));
  if (known && !admitExecution(response, input.isReady ?? (() => bybit.isAuthorized()))) return true;

  if (request.method === "GET" && pathname === "/account/balance") {
    await handleBalance({ request, response, config, bybit });
    return true;
  }

  if (request.method === "GET" && pathname === "/account/orders/active") {
    await handleActiveOrders({ request, response, config, bybit });
    return true;
  }

  if (request.method === "GET" && pathname === "/account/positions/open") {
    await handleOpenPositions({ request, response, config, bybit });
    return true;
  }

  if (request.method === "POST" && pathname === "/account/orders/cancel-all") {
    await handleCancelAllOrders({ request, response, config, bybit });
    return true;
  }

  if (request.method === "POST" && pathname === "/account/positions/close-all") {
    await handleCloseAllPositions({ request, response, config, bybit });
    return true;
  }

  return false;
}

async function handleBalance(input: AccountRouteInput): Promise<void> {
  const { request, response, config, bybit } = input;
  const url = new URL(request.url ?? "", `http://${config.host}:${config.port}`);
  const coin = url.searchParams.get("coin") ?? undefined;

  try {
    const balance = await bybit.getWalletBalance({ coin });
    writeJson(response, 200, {
      status: "ok",
      balance,
    });
  } catch (error) {
    writeJson(response, 502, {
      error: error instanceof Error ? error.message : "failed to fetch Bybit balance",
    });
  }
}

async function handleActiveOrders(input: AccountRouteInput): Promise<void> {
  const { request, response, config, bybit } = input;
  const url = new URL(request.url ?? "", `http://${config.host}:${config.port}`);
  const symbol = url.searchParams.get("symbol") ?? undefined;
  const query = buildAccountQuery(config, symbol);


  try {
    const bybitResponse = await bybit.getActiveOrders({ symbol });
    writeJson(response, 200, {
      status: "ok",
      queryBybit: {
        endpoint: "/v5/order/realtime",
        params: {
          ...query,
          openOnly: "0",
          limit: "50",
        },
      },
      bybitResponse,
    });
  } catch (error) {
    writeJson(response, 502, {
      status: "bybit_active_orders_query_failed",
      error: error instanceof Error ? error.message : "failed to query Bybit active orders",
    });
  }
}

async function handleOpenPositions(input: AccountRouteInput): Promise<void> {
  const { request, response, config, bybit } = input;
  const url = new URL(request.url ?? "", `http://${config.host}:${config.port}`);
  const symbol = url.searchParams.get("symbol") ?? undefined;
  const query = buildAccountQuery(config, symbol);


  try {
    const bybitResponse = await bybit.getOpenPositions({ symbol });
    writeJson(response, 200, {
      status: "ok",
      queryBybit: {
        endpoint: "/v5/position/list",
        params: query,
      },
      bybitResponse,
    });
  } catch (error) {
    writeJson(response, 502, {
      status: "bybit_open_positions_query_failed",
      error: error instanceof Error ? error.message : "failed to query Bybit open positions",
    });
  }
}

async function handleCancelAllOrders(input: AccountRouteInput): Promise<void> {
  const { request, response, config, bybit } = input;
  const url = new URL(request.url ?? "", `http://${config.host}:${config.port}`);
  const symbol = url.searchParams.get("symbol") ?? undefined;
  const payload = buildCancelAllOrdersPayload(config, symbol);
  const mode = getLiveExecutionMode(config, bybit.isAuthorized());

  if (!mode.canExecuteLive) {
    writeJson(response, 200, {
      status: "skipped_live_execution",
      wouldSendToBybit: {
        cancelAllOrders: payload,
      },
      mode,
    });
    return;
  }

  try {
    const bybitResponse = await bybit.cancelAllOrders(payload);
    writeJson(response, 200, {
      status: "cancel_all_orders_accepted",
      sentToBybit: {
        cancelAllOrders: payload,
      },
      bybitResponse,
    });
  } catch (error) {
    writeJson(response, 502, {
      status: "cancel_all_orders_failed",
      sentToBybit: {
        cancelAllOrders: payload,
      },
      error: error instanceof Error ? error.message : "failed to cancel all Bybit orders",
    });
  }
}

async function handleCloseAllPositions(input: AccountRouteInput): Promise<void> {
  const { request, response, config, bybit } = input;
  const url = new URL(request.url ?? "", `http://${config.host}:${config.port}`);
  const symbol = url.searchParams.get("symbol") ?? undefined;
  const query = buildAccountQuery(config, symbol);
  const mode = getLiveExecutionMode(config, bybit.isAuthorized());


  try {
    const positionsResponse = await bybit.getOpenPositions({ symbol });
    const closeOrders = buildMarketCloseOrdersFromPositions(config, positionsResponse);

    if (!mode.canExecuteLive) {
      writeJson(response, 200, {
        status: "skipped_live_execution",
        queryBybit: {
          endpoint: "/v5/position/list",
          params: query,
        },
        positionsResponse,
        wouldSendToBybit: {
          closePositionOrders: closeOrders,
        },
        mode,
      });
      return;
    }

    const bybitResponses = [];
    for (const closeOrder of closeOrders) {
      bybitResponses.push(await bybit.createOrder(closeOrder));
    }

    writeJson(response, 200, {
      status: "close_all_positions_orders_accepted",
      queryBybit: {
        endpoint: "/v5/position/list",
        params: query,
      },
      sentToBybit: {
        closePositionOrders: closeOrders,
      },
      bybitResponses,
    });
  } catch (error) {
    writeJson(response, 502, {
      status: "close_all_positions_failed",
      error: error instanceof Error ? error.message : "failed to close all Bybit positions",
    });
  }
}

type AccountRouteInput = {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  bybit: BybitAdapter;
};
