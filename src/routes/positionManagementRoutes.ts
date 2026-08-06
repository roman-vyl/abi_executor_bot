import type { IncomingMessage, ServerResponse } from "node:http";

import { readJsonBody, writeJson } from "../app/http.js";
import type { EntryPackageValidationDetail } from "../domain/entryPackageApi.js";
import { isSupportedJsonContentType } from "../domain/entryPackageApi.js";
import { decodeOpaquePathValue } from "../domain/openPositionApi.js";
import {
  internalErrorResult,
  malformedJsonResult,
  unsupportedMediaTypeResult,
  validateProtectionCommand,
  validationFailedResult,
} from "../domain/positionManagementApi.js";
import type { PositionManagementHttpResult } from "../domain/positionManagementApi.js";

export type PositionManagementRouteMatch =
  | {
      matched: false;
    }
  | {
      matched: true;
      strategyInstanceId?: string;
      tradeCycleId?: string;
      details?: EntryPackageValidationDetail[];
    };

export async function handlePositionManagementRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<boolean> {
  const { request, response } = input;
  try {
    return await handlePositionManagementRoutesSafely(request, response);
  } catch {
    writeResult(response, internalErrorResult());
    return true;
  }
}

async function handlePositionManagementRoutesSafely(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const protectionMatch = matchProtectionRoute(request.method, request.url);
  if (protectionMatch.matched) {
    await handleProtection(request, response, protectionMatch);
    return true;
  }

  const closeMatch = matchCloseRoute(request.method, request.url);
  if (closeMatch.matched) {
    await handleClose(request, response, closeMatch);
    return true;
  }

  return false;
}

async function handleProtection(
  request: IncomingMessage,
  response: ServerResponse,
  match: Extract<PositionManagementRouteMatch, { matched: true }>,
): Promise<void> {
  if (!isSupportedJsonContentType(request.headers["content-type"])) {
    writeResult(response, unsupportedMediaTypeResult());
    return;
  }

  if (match.details !== undefined) {
    writeResult(response, validationFailedResult(match.details));
    return;
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch {
    writeResult(response, malformedJsonResult());
    return;
  }

  const validation = validateProtectionCommand(
    {
      strategyInstanceId: match.strategyInstanceId,
      tradeCycleId: match.tradeCycleId,
    },
    payload,
  );

  if (!validation.ok) {
    writeResult(response, validationFailedResult(validation.details));
    return;
  }

  // Scope resolution, exchange confirmation, and position_not_open are
  // deferred to a later execution change (proposal.md non-goal): a
  // transport-valid command fails safe rather than fabricating success.
  void validation.command;
  writeResult(response, internalErrorResult());
}

async function handleClose(
  request: IncomingMessage,
  response: ServerResponse,
  match: Extract<PositionManagementRouteMatch, { matched: true }>,
): Promise<void> {
  if (match.details !== undefined) {
    writeResult(response, validationFailedResult(match.details));
    return;
  }

  const rawBody = await readRawBody(request);
  if (rawBody.length > 0) {
    writeResult(
      response,
      validationFailedResult([{ path: "/", message: "request body must be empty" }]),
    );
    return;
  }

  // Scope resolution, order cleanup, and postcondition verification are
  // deferred to a later execution change (proposal.md non-goal).
  writeResult(response, internalErrorResult());
}

export function matchProtectionRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): PositionManagementRouteMatch {
  if (method !== "PUT" || requestUrl === undefined) {
    return { matched: false };
  }

  const segments = pathSegments(requestUrl);
  if (
    segments.length !== 7 ||
    segments[0] !== "" ||
    segments[1] !== "v1" ||
    segments[2] !== "strategy-instances" ||
    segments[4] !== "trade-cycles" ||
    segments[6] !== "protection"
  ) {
    return { matched: false };
  }

  const details: EntryPackageValidationDetail[] = [];
  const strategyInstanceId = decodePathValue(segments[3], "/path/strategy_instance_id", details);
  const tradeCycleId = decodePathValue(segments[5], "/path/trade_cycle_id", details);

  if (details.length > 0) {
    return { matched: true, details };
  }

  return { matched: true, strategyInstanceId, tradeCycleId };
}

export function matchCloseRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): PositionManagementRouteMatch {
  if (method !== "DELETE" || requestUrl === undefined) {
    return { matched: false };
  }

  const segments = pathSegments(requestUrl);
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
  // Reused from openPositionApi.ts: same opaque-path decode-and-empty-check
  // this resource's existing GET already uses (design.md Decision 1).
  const strategyInstanceId = decodeOpaquePathValue(segments[3], "/path/strategy_instance_id", details);
  const tradeCycleId = decodeOpaquePathValue(segments[5], "/path/trade_cycle_id", details);

  if (details.length > 0) {
    return { matched: true, details };
  }

  return { matched: true, strategyInstanceId, tradeCycleId };
}

function pathSegments(requestUrl: string): string[] {
  const queryStart = requestUrl.indexOf("?");
  const pathname = queryStart === -1 ? requestUrl : requestUrl.slice(0, queryStart);
  return pathname.split("/");
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

// DELETE's body is required to be empty (spec: "ABI exposes a close endpoint
// accepting only an empty body") — unlike readJsonBody, this never parses
// JSON and never rejects an empty body; it only reports raw byte length.
function readRawBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeResult(response: ServerResponse, result: PositionManagementHttpResult): void {
  writeJson(response, result.statusCode, result.body);
}
