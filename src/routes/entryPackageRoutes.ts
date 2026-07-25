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
import type { EntryPackageValidationDetail } from "../domain/entryPackageApi.js";

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
}): Promise<boolean> {
  const { request, response } = input;
  try {
    return await handleEntryPackageRoutesSafely(request, response);
  } catch {
    writeResult(response, internalErrorResult());
    return true;
  }
}

async function handleEntryPackageRoutesSafely(
  request: IncomingMessage,
  response: ServerResponse,
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

  // Execution wiring is deliberately outside abi-entry-package-api-v1.
  // Until a later change supplies it, a valid command must fail safely rather
  // than receive a fabricated success acknowledgement.
  void validation.command;
  writeResult(response, internalErrorResult());
  return true;
}

export function matchEntryPackageRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): EntryPackageRouteMatch {
  if (method !== "PUT" || requestUrl === undefined) {
    return { matched: false };
  }

  const pathname = new URL(requestUrl, "http://abi.local").pathname;
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
