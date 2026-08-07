import type { IncomingMessage, ServerResponse } from "node:http";

import { readJsonBody, writeJson } from "../app/http.js";
import type { EntryPackageValidationDetail } from "../domain/entryPackageApi.js";
import { isSupportedJsonContentType } from "../domain/entryPackageApi.js";
import { decodeOpaquePathValue } from "../domain/openPositionApi.js";
import {
  internalErrorResult,
  malformedJsonResult,
  unsupportedMediaTypeResult,
  validateCloseCommand,
  validateProtectionCommand,
  validationFailedResult,
} from "../domain/positionManagementApi.js";
import type { CloseCommand, PositionManagementHttpResult, ProtectionCommand } from "../domain/positionManagementApi.js";

// Narrow structural port, not the concrete class: this route must not touch
// correlation state, Bybit, or the mutex directly — it only knows how to
// hand a validated command to something that can apply() it (mirrors
// entryPackageRoutes.ts's EntryPackageApplicationServicePort split).
export type ProtectionApplicationServicePort = {
  apply(command: ProtectionCommand): Promise<PositionManagementHttpResult>;
};

// Same narrow-port split as ProtectionApplicationServicePort above, for the
// close pipeline (close-execution).
export type CloseApplicationServicePort = {
  apply(command: CloseCommand): Promise<PositionManagementHttpResult>;
};

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
  protectionApplicationService: ProtectionApplicationServicePort;
  closeApplicationService: CloseApplicationServicePort;
  isReady: () => boolean;
}): Promise<boolean> {
  const { request, response, protectionApplicationService, closeApplicationService, isReady } = input;
  try {
    return await handlePositionManagementRoutesSafely(
      request,
      response,
      protectionApplicationService,
      closeApplicationService,
      isReady,
    );
  } catch {
    writeResult(response, internalErrorResult());
    return true;
  }
}

async function handlePositionManagementRoutesSafely(
  request: IncomingMessage,
  response: ServerResponse,
  protectionApplicationService: ProtectionApplicationServicePort,
  closeApplicationService: CloseApplicationServicePort,
  isReady: () => boolean,
): Promise<boolean> {
  const protectionMatch = matchProtectionRoute(request.method, request.url);
  if (protectionMatch.matched) {
    await handleProtection(request, response, protectionMatch, protectionApplicationService, isReady);
    return true;
  }

  const closeMatch = matchCloseRoute(request.method, request.url);
  if (closeMatch.matched) {
    await handleClose(request, response, closeMatch, closeApplicationService, isReady);
    return true;
  }

  return false;
}

async function handleProtection(
  request: IncomingMessage,
  response: ServerResponse,
  match: Extract<PositionManagementRouteMatch, { matched: true }>,
  protectionApplicationService: ProtectionApplicationServicePort,
  isReady: () => boolean,
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

  if (!isReady()) {
    // Correlation-store replay hasn't completed (or failed) yet — fail
    // closed rather than risk acting before durable state is recovered
    // (mirrors entryPackageRoutes.ts's readiness gate).
    writeResult(response, internalErrorResult());
    return;
  }

  const result = await protectionApplicationService.apply(validation.command);
  writeResult(response, result);
}

async function handleClose(
  request: IncomingMessage,
  response: ServerResponse,
  match: Extract<PositionManagementRouteMatch, { matched: true }>,
  closeApplicationService: CloseApplicationServicePort,
  isReady: () => boolean,
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

  const validation = validateCloseCommand({
    strategyInstanceId: match.strategyInstanceId,
    tradeCycleId: match.tradeCycleId,
  });

  if (!validation.ok) {
    writeResult(response, validationFailedResult(validation.details));
    return;
  }

  if (!isReady()) {
    // Correlation-store replay hasn't completed (or failed) yet — fail
    // closed rather than risk acting before durable state is recovered
    // (mirrors handleProtection's identical readiness gate).
    writeResult(response, internalErrorResult());
    return;
  }

  const result = await closeApplicationService.apply(validation.command);
  writeResult(response, result);
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
  // Reused from openPositionApi.ts: same opaque-path decode-and-empty-check
  // matchCloseRoute below already uses (design.md Decision 1) — both
  // endpoints on this pair decode path identifiers identically.
  const strategyInstanceId = decodeOpaquePathValue(segments[3], "/path/strategy_instance_id", details);
  const tradeCycleId = decodeOpaquePathValue(segments[5], "/path/trade_cycle_id", details);

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
