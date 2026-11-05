import type { ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import { writeJson } from "./http.js";

// Called once, synchronously, after request validation and before invoking a
// use case. Once admitted, a request follows the existing execution contract.
export function admitExecution(response: ServerResponse, isReady: () => boolean): boolean {
  if (isReady()) return true;
  writeJson(response, 503, {
    error: { code: "execution_not_ready", message: "ABI execution is not ready" },
  });
  return false;
}

export function executionIsReady(config: AbiConfig, recovered: boolean): boolean {
  return config.authorizationMode === "env" && recovered;
}
