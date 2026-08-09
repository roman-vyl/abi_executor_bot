import type { IncomingMessage, ServerResponse } from "node:http";

import { writeJson } from "../app/http.js";
import type { EntryPackageValidationDetail } from "../domain/entryPackageApi.js";
import { decodeOpaquePathValue, internalErrorResult, validationFailedResult } from "../domain/openPositionApi.js";
import type { OpenPositionHttpResult } from "../domain/openPositionApi.js";
import { classifyOpenPositionResult, withOperationEvents } from "../observability/events.js";

// Narrow structural port, not the concrete class: openPositionRoutes.ts must
// not touch correlation state or Bybit directly — it only knows how to hand
// a decoded (strategy_instance_id, trade_cycle_id) pair to something that
// can resolve() it (mirrors entryPackageRoutes.ts's application-service
// port split).
export type OpenPositionResolutionServicePort = {
  resolve(query: { strategyInstanceId: string; tradeCycleId: string }): Promise<OpenPositionHttpResult>;
};

export type OpenPositionRouteMatch =
  | {
      matched: false;
    }
  | {
      matched: true;
      strategyInstanceId?: string;
      tradeCycleId?: string;
      details?: EntryPackageValidationDetail[];
    };

export async function handleOpenPositionRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  resolutionService: OpenPositionResolutionServicePort;
  isReady: () => boolean;
}): Promise<boolean> {
  const { request, response, resolutionService, isReady } = input;
  try {
    return await handleOpenPositionRoutesSafely(request, response, resolutionService, isReady);
  } catch {
    writeResult(response, internalErrorResult());
    return true;
  }
}

async function handleOpenPositionRoutesSafely(
  request: IncomingMessage,
  response: ServerResponse,
  resolutionService: OpenPositionResolutionServicePort,
  isReady: () => boolean,
): Promise<boolean> {
  const match = matchOpenPositionRoute(request.method, request.url);

  if (!match.matched) {
    return false;
  }

  if (match.details !== undefined) {
    writeResult(response, validationFailedResult(match.details));
    return true;
  }

  if (!isReady()) {
    // Correlation-store replay hasn't completed (or failed) yet — fail
    // closed with the same safe internal_error response the entry-package
    // PUT route already uses for the same condition, rather than resolving
    // against not-yet-recovered state.
    writeResult(response, internalErrorResult());
    return true;
  }

  const strategyInstanceId = match.strategyInstanceId as string;
  const tradeCycleId = match.tradeCycleId as string;
  const result = await withOperationEvents(
    { operation: "open_position", strategyInstanceId, tradeCycleId },
    () => resolutionService.resolve({ strategyInstanceId, tradeCycleId }),
    (httpResult) => classifyOpenPositionResult(httpResult.body),
  );
  writeResult(response, result);
  return true;
}

export function matchOpenPositionRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): OpenPositionRouteMatch {
  if (method !== "GET" || requestUrl === undefined) {
    return { matched: false };
  }

  const queryStart = requestUrl.indexOf("?");
  const pathname = queryStart === -1 ? requestUrl : requestUrl.slice(0, queryStart);
  const segments = pathname.split("/");
  if (
    segments.length !== 7 ||
    segments[0] !== "" ||
    segments[1] !== "v1" ||
    segments[2] !== "strategy-instances" ||
    segments[4] !== "trade-cycles" ||
    segments[6] !== "open-position"
  ) {
    return { matched: false };
  }

  const details: EntryPackageValidationDetail[] = [];
  const strategyInstanceId = decodeOpaquePathValue(segments[3], "/path/strategy_instance_id", details);
  const tradeCycleId = decodeOpaquePathValue(segments[5], "/path/trade_cycle_id", details);

  if (details.length > 0) {
    return {
      matched: true,
      details,
    };
  }

  return {
    matched: true,
    strategyInstanceId,
    tradeCycleId,
  };
}

function writeResult(response: ServerResponse, result: OpenPositionHttpResult): void {
  writeJson(response, result.statusCode, result.body);
}
