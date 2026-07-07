import type { ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";

export function writeJson(response: ServerResponse, statusCode: number, payload: object): void {
  const body = JSON.stringify(payload, null, 2);

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function getPathname(requestUrl: string, config: AbiConfig): string {
  return new URL(requestUrl, `http://${config.host}:${config.port}`).pathname;
}

export function readJsonBody(request: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (body.trim() === "") {
        reject(new Error("request body is required"));
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}
