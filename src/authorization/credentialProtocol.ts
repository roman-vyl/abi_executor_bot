export const FRAME_LIMIT = 4096;
export type ControlRequest = { v: 1; op: "authorize"; credentials: [string, string] } |
  { v: 1; op: "retry" } | { v: 1; op: "status" };
export function credentialPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every(item =>
    typeof item === "string" && item.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(item));
}
export function decodeControlFrame(frame: Buffer): ControlRequest {
  if (frame.length > FRAME_LIMIT || frame.at(-1) !== 10 || frame.subarray(0, -1).includes(10)) throw new Error("Invalid control frame");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, -1)));
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.v !== 1) throw new Error("Invalid control frame");
  const keys = Object.keys(value).sort().join(",");
  if (value.op === "authorize" && keys === "credentials,op,v" && credentialPair(value.credentials)) return value;
  if (["retry", "status"].includes(value.op) && keys === "op,v") return value;
  throw new Error("Invalid control frame");
}
