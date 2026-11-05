import { connect } from "node:net";
import { readFile, statfs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeControlFrame, FRAME_LIMIT } from "./credentialProtocol.js";

export const AUTHORIZATION_SOCKET = "/run/abi-authorization/control.sock";
export async function relayCredentials(input: AsyncIterable<Buffer>, path = AUTHORIZATION_SOCKET): Promise<string> {
  const chunks: Buffer[] = [];
  let frame: Buffer | undefined;
  try {
    let size = 0;
    for await (const chunk of input) {
      size += chunk.length;
      if (size > FRAME_LIMIT) { chunk.fill(0); throw new Error("Invalid control frame"); }
      chunks.push(chunk);
    }
    frame = Buffer.concat(chunks);
    decodeControlFrame(frame);
    return await new Promise<string>((resolve, reject) => {
      const socket = connect(path);
      const responses: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Authorization response unavailable; check status")); }, 15_000);
      socket.on("error", () => { clearTimeout(timer); reject(new Error("Authorization channel unavailable")); });
      socket.once("connect", () => socket.end(frame!));
      socket.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 1024) { socket.destroy(); clearTimeout(timer); reject(new Error("Invalid authorization response")); }
        else responses.push(chunk);
      });
      socket.once("end", () => {
        clearTimeout(timer);
        try {
          const text = Buffer.concat(responses).toString("utf8");
          const result = JSON.parse(text);
          const states = ["LOCKED", "VERIFYING", "RETRY_PENDING", "AUTHORIZED"];
          const results = ["accepted", "rejected", "temporary_failure", "busy", "retry_required", "already_authorized", "no_candidate", "protocol_error", "shutting_down"];
          const reasons = ["confirmed", "credentials_rejected", "uid_mismatch", "rights_missing", "invalid_response", "verification_unavailable", "verification_timeout", "shutting_down"];
          if (result.v !== 1 || !states.includes(result.state) ||
              (result.result !== undefined && !results.includes(result.result)) ||
              (result.reason !== undefined && !reasons.includes(result.reason))) throw new Error();
          // Reconstruct rather than echo server-controlled properties.
          resolve(JSON.stringify({ v: 1, state: result.state, ...(result.result === undefined ? {} : { result: result.result }),
            ...(result.reason === undefined ? {} : { reason: result.reason }) }));
        } catch { reject(new Error("Invalid authorization response")); }
      });
    });
  } finally { frame?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const fs = await statfs("/run/abi-authorization");
    if (fs.type !== 0x01021994 || (await readFile("/sys/fs/cgroup/memory.swap.max", "utf8")).trim() !== "0") {
      throw new Error();
    }
    process.stdout.write(await relayCredentials(process.stdin) + "\n");
  } catch { process.stderr.write("Authorization delivery failed; check status before retrying\n"); process.exitCode = 1; }
}
