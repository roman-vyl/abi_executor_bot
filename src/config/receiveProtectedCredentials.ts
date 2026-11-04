import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertContainerSwapDisabled, credentialFiles, credentialLimit, isCredential, protectedCredentialsRoot,
} from "./protectedCredentials.js";

async function receive(): Promise<void> {
  const root = protectedCredentialsRoot(process.env);
  if (root === undefined) throw new Error();
  assertContainerSwapDisabled();

  // This directory is also the exclusive claim for the single handoff.
  const staging = join(root, "incoming");
  mkdirSync(staging, { mode: 0o700 });
  let committed = false;
  try {
    let payload = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      payload += chunk;
      if (payload.length > 2 * credentialLimit + 16) throw new Error();
    }
    // A terminator distinguishes a complete frame from a stream cut before EOF.
    if (!payload.endsWith("\n")) throw new Error();
    const pair: unknown = JSON.parse(payload);
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isCredential)) throw new Error();
    // Keep the claim for the lifetime of the mount after publishing the pair.
    const ready = join(staging, "pair");
    mkdirSync(ready, { mode: 0o700 });
    for (const [index, name] of credentialFiles.entries()) {
      writeFileSync(join(ready, name), pair[index], { flag: "wx", mode: 0o400 });
    }
    renameSync(ready, join(root, "ready"));
    committed = true;
  } finally {
    if (!committed) rmSync(staging, { recursive: true, force: true });
  }
}

try {
  await receive();
} catch {
  console.error("Protected credential handoff failed");
  process.exitCode = 1;
}
