import type { IncomingMessage, ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import { getPathname, readJsonBody, writeJson } from "../app/http.js";
import type { Journal } from "../journal/journal.js";
import { cancelIntent, getEntryOrder, getIntentStatus, updateIntent } from "../services/intentService.js";

export async function handleIntentRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  bybit: BybitAdapter;
  journal: Journal;
}): Promise<boolean> {
  const { request, response, config, bybit, journal } = input;

  if (request.url === undefined) {
    return false;
  }

  const pathname = getPathname(request.url, config);

  if (request.method === "POST" && pathname.startsWith("/intents/") && pathname.endsWith("/cancel")) {
    const signalId = decodeURIComponent(pathname.slice("/intents/".length, -"/cancel".length));
    const result = await cancelIntent({ signalId, config, bybit, journal });
    writeJson(response, result.statusCode, result.body);
    return true;
  }

  if (request.method === "PUT" && pathname.startsWith("/intents/")) {
    const signalId = decodeURIComponent(pathname.slice("/intents/".length));
    let payload: unknown;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid request body",
      });
      return true;
    }

    const result = await updateIntent({ signalId, payload, config, bybit, journal });
    writeJson(response, result.statusCode, result.body);
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/intents/") && pathname.endsWith("/orders/entry")) {
    const signalId = decodeURIComponent(pathname.slice("/intents/".length, -"/orders/entry".length));
    const result = await getEntryOrder({ signalId, config, bybit, journal });
    writeJson(response, result.statusCode, result.body);
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/intents/")) {
    const signalId = decodeURIComponent(pathname.slice("/intents/".length));
    const result = await getIntentStatus({ signalId, journal });
    writeJson(response, result.statusCode, result.body);
    return true;
  }

  return false;
}
