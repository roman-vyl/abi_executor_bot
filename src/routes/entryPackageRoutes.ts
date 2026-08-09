import type { IncomingMessage, ServerResponse } from "node:http";

import { readJsonBody, writeJson } from "../app/http.js";
import {
  internalErrorResult,
  isSupportedJsonContentType,
  malformedJsonResult,
  unsupportedMediaTypeResult,
  validateEntryPackageCommand,
  validationFailedResult,
} from "../domain/entryPackageApi.js";
import type { EntryPackageCommand, EntryPackageHttpResult, EntryPackageValidationDetail } from "../domain/entryPackageApi.js";
import { classifyStatusResult, withOperationEvents } from "../observability/events.js";

// Narrow structural port, not the concrete class: entryPackageRoutes.ts must
// not touch correlation state, Bybit, or the mutex directly — it only knows
// how to hand a validated command to something that can apply() it.
export type EntryPackageApplicationServicePort = {
  apply(command: EntryPackageCommand): Promise<EntryPackageHttpResult>;
};

export type EntryPackageRouteMatch =
  | {
      matched: false;
    }
  | {
      matched: true;
      strategyInstanceId?: string;
      tradeCycleId?: string;
      details?: EntryPackageValidationDetail[];
    };

export async function handleEntryPackageRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  applicationService: EntryPackageApplicationServicePort;
  isReady: () => boolean;
}): Promise<boolean> {
  const { request, response, applicationService, isReady } = input;
  try {
    return await handleEntryPackageRoutesSafely(request, response, applicationService, isReady);
  } catch {
    writeResult(response, internalErrorResult());
    return true;
  }
}

async function handleEntryPackageRoutesSafely(
  request: IncomingMessage,
  response: ServerResponse,
  applicationService: EntryPackageApplicationServicePort,
  isReady: () => boolean,
): Promise<boolean> {
  const match = matchEntryPackageRoute(request.method, request.url);

  if (!match.matched) {
    return false;
  }

  if (!isSupportedJsonContentType(request.headers["content-type"])) {
    writeResult(response, unsupportedMediaTypeResult());
    return true;
  }

  if (match.details !== undefined) {
    writeResult(response, validationFailedResult(match.details));
    return true;
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch {
    writeResult(response, malformedJsonResult());
    return true;
  }

  const validation = validateEntryPackageCommand(
    {
      strategyInstanceId: match.strategyInstanceId,
      tradeCycleId: match.tradeCycleId,
    },
    payload,
  );

  if (!validation.ok) {
    writeResult(response, validationFailedResult(validation.details));
    return true;
  }

  if (!isReady()) {
    // Correlation-store replay hasn't completed (or failed) yet — fail
    // closed with the existing safe internal_error response rather than
    // risk acting before durable state is recovered.
    writeResult(response, internalErrorResult());
    return true;
  }

  const result = await withOperationEvents(
    {
      operation: "entry_package",
      strategyInstanceId: validation.command.strategyInstanceId,
      tradeCycleId: validation.command.tradeCycleId,
    },
    () => applicationService.apply(validation.command),
    (httpResult) => classifyStatusResult(httpResult.body),
  );
  writeResult(response, result);
  return true;
}

export function matchEntryPackageRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): EntryPackageRouteMatch {
  if (method !== "PUT" || requestUrl === undefined) {
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
    segments[6] !== "entry-package"
  ) {
    return { matched: false };
  }

  const details: EntryPackageValidationDetail[] = [];
  const strategyInstanceId = decodePathValue(
    segments[3],
    "/path/strategy_instance_id",
    details,
  );
  const tradeCycleId = decodePathValue(segments[5], "/path/trade_cycle_id", details);

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

function decodePathValue(
  value: string,
  path: string,
  details: EntryPackageValidationDetail[],
): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    details.push({
      path,
      message: "path value must use valid percent encoding",
    });
    return undefined;
  }
}

function writeResult(
  response: ServerResponse,
  result: {
    statusCode: number;
    body: object;
  },
): void {
  writeJson(response, result.statusCode, result.body);
}
