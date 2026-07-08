#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.env.FAKE_ABI_PORT ?? "18787");
const eventsFile = process.env.FAKE_ABI_EVENTS_FILE ?? "";

/** @type {Map<string, { payload: object; orderLinkId: string }>} */
const intents = new Map();

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function protectionShape(payload) {
  const hasStop = payload?.stop_loss != null;
  const hasTake = payload?.take_profit != null;
  if (hasTake && !hasStop) {
    return "invalid";
  }
  if (hasStop && hasTake) {
    return "stop_take";
  }
  if (hasStop) {
    return "stop_only";
  }
  return "entry_only";
}

function recordEvent(event, details = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details,
  });
  if (eventsFile !== "") {
    appendFileSync(eventsFile, `${line}\n`, "utf8");
  }
  console.log(`event ${event}${details.signal_id ? ` signal_id=${details.signal_id}` : ""}`);
}

function orderLinkIdFor(instanceId) {
  return `abi-entry-fake-${String(instanceId).replace(/[^a-zA-Z0-9:_-]/g, "-")}`;
}

function validateSignalBody(body) {
  if (body == null || typeof body !== "object") {
    return { ok: false, error: "invalid request body" };
  }
  for (const field of ["signal_id", "instance_id", "symbol", "side", "entry"]) {
    if (body[field] == null || body[field] === "") {
      return { ok: false, error: `missing ${field}` };
    }
  }
  if (protectionShape(body) === "invalid") {
    return { ok: false, error: "take_profit_requires_stop_loss" };
  }
  return { ok: true };
}

function emptyActiveOrdersResponse() {
  return {
    status: "ok",
    bybitResponse: {
      result: {
        list: [],
      },
    },
  };
}

function entryOrderResponse(intent) {
  return {
    status: "ok",
    signalId: intent.payload.signal_id,
    entryOrder: {
      orderLinkId: intent.orderLinkId,
    },
    bybitResponse: {
      result: {
        list: [
          {
            orderLinkId: intent.orderLinkId,
            orderStatus: "New",
            symbol: intent.payload.symbol,
            side: intent.payload.side,
          },
        ],
      },
    },
  };
}

function handleCreate(body) {
  const validation = validateSignalBody(body);
  if (!validation.ok) {
    if (validation.error === "take_profit_requires_stop_loss") {
      recordEvent("invalid_take_without_stop_rejected", {
        signal_id: body?.signal_id ?? "unknown",
      });
    }
    return { statusCode: 400, body: { error: validation.error } };
  }

  const shape = protectionShape(body);
  const signalId = body.signal_id;
  const orderLinkId = orderLinkIdFor(body.instance_id);

  intents.set(signalId, { payload: body, orderLinkId });
  recordEvent(`create_${shape}`, {
    signal_id: signalId,
    protection: shape,
  });

  return {
    statusCode: 200,
    body: {
      status: "accepted_live_entry_order_created",
      signalId,
      orderLinkId,
    },
  };
}

function handleAmend(signalId, body) {
  const existing = intents.get(signalId);
  if (existing == null) {
    return {
      statusCode: 404,
      body: { error: "intent_not_found", signalId },
    };
  }

  const validation = validateSignalBody(body);
  if (!validation.ok) {
    if (validation.error === "take_profit_requires_stop_loss") {
      recordEvent("invalid_take_without_stop_rejected", {
        signal_id: signalId,
      });
    }
    return { statusCode: 400, body: { error: validation.error } };
  }

  const fromShape = protectionShape(existing.payload);
  const toShape = protectionShape(body);
  recordEvent(`amend_${fromShape}_to_${toShape}`, {
    signal_id: signalId,
    from: fromShape,
    to: toShape,
  });

  const orderLinkId = orderLinkIdFor(body.instance_id);
  intents.set(signalId, { payload: body, orderLinkId });

  return {
    statusCode: 200,
    body: {
      status: "updated_live_entry_order_amended",
      signalId,
      orderLinkId,
    },
  };
}

function handleCancel(signalId) {
  if (!intents.has(signalId)) {
    return {
      statusCode: 404,
      body: { error: "intent_not_found", signalId },
    };
  }

  intents.delete(signalId);
  recordEvent("cancelled", { signal_id: signalId });

  return {
    statusCode: 200,
    body: {
      status: "cancelled",
      signalId,
    },
  };
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = url.pathname;

  console.log(`${method} ${pathname}`);

  try {
    if (method === "GET" && pathname === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/execution/mode") {
      writeJson(res, 200, {
        dryRun: false,
        liveTradingEnabled: true,
        bybitEnvironment: "demo",
        bybitApiKeyConfigured: true,
        canExecuteLive: true,
      });
      return;
    }

    if (method === "GET" && pathname === "/account/orders/active") {
      writeJson(res, 200, emptyActiveOrdersResponse());
      return;
    }

    if (method === "POST" && pathname === "/signals") {
      const body = await readBody(req);
      const result = handleCreate(body);
      writeJson(res, result.statusCode, result.body);
      return;
    }

    const entryMatch = pathname.match(/^\/intents\/([^/]+)\/orders\/entry$/);
    if (method === "GET" && entryMatch != null) {
      const signalId = decodeURIComponent(entryMatch[1]);
      const intent = intents.get(signalId);
      if (intent == null) {
        writeJson(res, 404, { error: "execution_plan_not_found", signalId });
        return;
      }
      writeJson(res, 200, entryOrderResponse(intent));
      return;
    }

    const intentMatch = pathname.match(/^\/intents\/([^/]+)$/);
    if (method === "PUT" && intentMatch != null) {
      const signalId = decodeURIComponent(intentMatch[1]);
      const body = await readBody(req);
      const result = handleAmend(signalId, body);
      writeJson(res, result.statusCode, result.body);
      return;
    }

    const cancelMatch = pathname.match(/^\/intents\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch != null) {
      const signalId = decodeURIComponent(cancelMatch[1]);
      const result = handleCancel(signalId);
      writeJson(res, result.statusCode, result.body);
      return;
    }

    writeJson(res, 404, { error: "not_found", path: pathname });
  } catch (error) {
    writeJson(res, 400, {
      error: error instanceof Error ? error.message : "invalid request",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake abi smoke server listening on 127.0.0.1:${port}`);
  if (eventsFile !== "") {
    console.log(`events file: ${eventsFile}`);
  }
});
