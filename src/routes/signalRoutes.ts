import type { IncomingMessage, ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import { readJsonBody, writeJson } from "../app/http.js";
import type { Journal } from "../journal/journal.js";
import { createSignalIntent } from "../services/signals/createSignalIntent.js";

export async function handleSignalRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  bybit: BybitAdapter;
  journal: Journal;
}): Promise<boolean> {
  const { request, response, config, bybit, journal } = input;

  if (request.method !== "POST" || request.url !== "/signals") {
    return false;
  }

  try {
    const payload = await readJsonBody(request);
    const result = await createSignalIntent(
      { payload },
      {
        config,
        bybit,
        journal,
      },
    );
    writeJson(response, result.statusCode, result.body);
  } catch (error) {
    void journal.appendEvent({
      eventType: "signal_rejected",
      payload: {
        error: error instanceof Error ? error.message : "invalid request body",
      },
    });
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid request body",
    });
  }

  return true;
}
