import { createHmac } from "node:crypto";
import type { Credentials, CredentialsVerifier, VerificationResult } from "./authorizationService.js";

export type VerificationPolicy = Readonly<{
  environment: "demo" | "testnet";
  expectedUid: string;
  category: "linear" | "spot";
  recvWindow: string;
}>;
export type VerificationReason = "confirmed" | "credentials_rejected" | "uid_mismatch" | "rights_missing" |
  "invalid_response" | "verification_unavailable" | "verification_timeout" | "shutting_down";
const rejectedCodes = new Set([10003, 10005, 10007, -2015, 33004]);
const MAX_RESPONSE = 65_536;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Only this fixed read-only operation can use an unconfirmed candidate.
export function createBybitCredentialsVerifier(policy: VerificationPolicy, options: {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number; // Tests may shorten, never extend the production deadline.
} = {}): { verify: CredentialsVerifier; close(): void; reason(): VerificationReason } {
  if (!/^[1-9][0-9]*$/.test(policy.expectedUid) || !["demo", "testnet"].includes(policy.environment) ||
      !["linear", "spot"].includes(policy.category) || !/^[1-9][0-9]*$/.test(policy.recvWindow)) {
    throw new Error("Invalid verification policy");
  }
  const config = Object.freeze({ ...policy });
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("Invalid verification deadline");
  const transport = options.fetch ?? globalThis.fetch;
  const shutdown = new AbortController();
  let reason: VerificationReason = "verification_unavailable";
  const close = () => shutdown.abort();
  if (options.signal?.aborted) close();
  else options.signal?.addEventListener("abort", close, { once: true });
  const detach = () => options.signal?.removeEventListener("abort", close);
  shutdown.signal.addEventListener("abort", detach, { once: true });

  const inspect = (body: unknown, status: number, candidate: Credentials): VerificationResult => {
    if ((status >= 300 && status < 400) || status === 403 || status === 429 || status >= 500) return "temporary_failure";
    if (!object(body) || !Number.isInteger(body.retCode)) { reason = "invalid_response"; return "temporary_failure"; }
    if (rejectedCodes.has(body.retCode as number)) { reason = "credentials_rejected"; return "rejected"; }
    if (status !== 200 || body.retCode !== 0) return "temporary_failure";
    const result = body.result;
    if (!object(result) || result.apiKey !== candidate.apiKey || !Number.isSafeInteger(result.userID) ||
        (result.userID as number) <= 0 || ![0, 1].includes(result.readOnly as number) ||
        !object(result.permissions)) { reason = "invalid_response"; return "temporary_failure"; }
    const rights = result.permissions[config.category === "linear" ? "ContractTrade" : "Spot"];
    if (!Array.isArray(rights) || !rights.every(value => typeof value === "string")) {
      reason = "invalid_response"; return "temporary_failure";
    }
    if (String(result.userID) !== config.expectedUid) { reason = "uid_mismatch"; return "rejected"; }
    const required = config.category === "linear" ? ["Order", "Position"] : ["SpotTrade"];
    if (result.readOnly !== 0 || !required.every(right => rights.includes(right))) {
      reason = "rights_missing"; return "rejected";
    }
    reason = "confirmed";
    return "accepted";
  };

  const verify: CredentialsVerifier = candidate => {
    if (shutdown.signal.aborted) { reason = "shutting_down"; return Promise.resolve("temporary_failure"); }
    reason = "verification_unavailable";
    return new Promise<VerificationResult>(resolve => {
      const request = new AbortController();
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const finish = (result: VerificationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        shutdown.signal.removeEventListener("abort", stop);
        resolve(result);
      };
      const cancel = (why: VerificationReason) => {
        if (settled) return;
        reason = why;
        finish("temporary_failure");
        request.abort();
      };
      const stop = () => cancel("shutting_down");
      const timer = setTimeout(() => cancel("verification_timeout"), timeoutMs);
      shutdown.signal.addEventListener("abort", stop, { once: true });
      // Both success and failure are consumed even if a transport ignores abort.
      void (async () => {
        const timestamp = String(Date.now());
        const signature = createHmac("sha256", candidate.apiSecret)
          .update(`${timestamp}${candidate.apiKey}${config.recvWindow}`).digest("hex");
        const host = config.environment === "demo" ? "api-demo.bybit.com" : "api-testnet.bybit.com";
        const response = await transport(`https://${host}/v5/user/query-api`, {
          method: "GET", redirect: "error", signal: request.signal,
          headers: { "X-BAPI-API-KEY": candidate.apiKey, "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": config.recvWindow, "X-BAPI-SIGN": signature },
        });
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const cancelReader = () => { void reader.cancel().catch(() => undefined); };
        request.signal.addEventListener("abort", cancelReader, { once: true });
        if (request.signal.aborted) cancelReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE) { value.fill(0); throw new Error(); }
            chunks.push(value);
          }
          if (settled) return;
          if (shutdown.signal.aborted || Date.now() >= deadline) {
            cancel(shutdown.signal.aborted ? "shutting_down" : "verification_timeout"); return;
          }
          const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          finish(inspect(body, response.status, candidate));
        } finally {
          // Do not await a broken transport's cancellation.
          request.signal.removeEventListener("abort", cancelReader);
          void reader.cancel().catch(() => undefined);
          for (const chunk of chunks) chunk.fill(0);
        }
      })().catch(() => { if (!settled) { reason = "verification_unavailable"; finish("temporary_failure"); request.abort(); } });
    });
  };
  return { verify, close, reason: () => reason };
}
