import type { ServerResponse } from "node:http";
import { writeJson } from "../app/http.js";

export function admitExecution(response: ServerResponse, isReady: () => boolean): boolean {
  if (isReady()) return true;
  writeJson(response, 503, { error: { code: "execution_not_ready", message: "execution is not ready" } });
  return false;
}
