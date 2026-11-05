import { createServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthorizationService } from "./authorizationService.js";
import { createBybitCredentialsVerifier, type VerificationPolicy } from "./bybitCredentialsVerifier.js";
import { decodeControlFrame, FRAME_LIMIT } from "./credentialProtocol.js";

// Independent component only. Production composition root does not start it yet.
export async function createAuthorizationSocket(input: {
  path: string;
  policy: VerificationPolicy;
}, testOptions: { fetch?: typeof fetch; verificationTimeoutMs?: number; frameTimeoutMs?: number } = {}) {
  const verifier = createBybitCredentialsVerifier(input.policy, { fetch: testOptions.fetch, timeoutMs: testOptions.verificationTimeoutMs });
  const authorization = new AuthorizationService(verifier.verify);
  const directory = dirname(input.path);
  const frameTimeoutMs = testOptions.frameTimeoutMs ?? 5000;
  if (!(frameTimeoutMs > 0 && frameTimeoutMs <= 5000)) { verifier.close(); throw new Error("Invalid frame deadline"); }
  let active: Socket | undefined;
  let verifying = false;
  let stopping = false;
  const sockets = new Set<Socket>();
  const answer = (socket: Socket, data: Record<string, unknown>) => {
    if (!socket.destroyed) socket.end(JSON.stringify({ v: 1, state: authorization.status(), ...data }) + "\n");
  };
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => { sockets.delete(socket); if (active === socket) active = undefined; });
    if (stopping || active || verifying) {
      answer(socket, { result: stopping ? "shutting_down" : "busy" });
      socket.once("finish", () => socket.destroy());
      socket.resume();
      return;
    }
    active = socket;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let invalid = false;
    const wipe = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const timer = setTimeout(() => { invalid = true; wipe(); socket.destroy(); }, frameTimeoutMs);
    socket.once("close", () => { clearTimeout(timer); wipe(); });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > FRAME_LIMIT || invalid) {
        invalid = true; chunk.fill(0); wipe(); clearTimeout(timer); socket.destroy(); return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      if (invalid || stopping) { wipe(); socket.destroy(); return; }
      const frame = Buffer.concat(chunks);
      wipe();
      void (async () => {
        try {
          const request = decodeControlFrame(frame);
          if (request.op === "status") { answer(socket, {}); return; }
          verifying = true;
          const result = await (request.op === "retry" ? authorization.retry() : authorization.authorize({
            apiKey: request.credentials[0], apiSecret: request.credentials[1],
          }));
          if (!stopping) answer(socket, { result, ...(result === "temporary_failure" ? { reason: verifier.reason() } : {}) });
        } catch {
          if (!stopping) answer(socket, { result: "protocol_error" });
        } finally {
          frame.fill(0);
          verifying = false;
        }
      })();
    });
  });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") { verifier.close(); throw error; }
  }
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Unsafe authorization directory");
    // Refuse an existing socket/path; never delete another process's listener.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.path, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(input.path, 0o600);
  } catch (error) {
    verifier.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  return {
    // Exposes the same sole owner for later root wiring; no credential setters.
    authorization,
    async close(): Promise<void> {
      if (stopping) return;
      stopping = true;
      verifier.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await unlink(input.path).catch(error => { if (error.code !== "ENOENT") throw error; });
    },
  };
}
