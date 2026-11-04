import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const credentialFiles = ["key", "secret"] as const;
export const credentialLimit = 1024;

export function protectedCredentialsRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.ABI_PROTECTED_CREDENTIALS_DIR;
  if (root === undefined) return undefined;
  if (root === "" || env.BYBIT_API_KEY !== undefined || env.BYBIT_API_SECRET !== undefined) {
    throw new Error("Invalid protected credential configuration");
  }
  return root;
}

export function assertContainerSwapDisabled(): void {
  if (readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8").trim() !== "0") {
    throw new Error("Protected credentials require container swap to be disabled");
  }
}

export async function waitForCredentials(root: string): Promise<void> {
  assertContainerSwapDisabled();
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (lstatSync(join(root, "ready"), { throwIfNoEntry: false }) !== undefined) return;
    await delay(50);
  }
  throw new Error("Protected credentials were not delivered");
}

export function isCredential(value: unknown): value is string {
  return typeof value === "string" && value.length <= credentialLimit && /^[A-Za-z0-9_-]+$/.test(value);
}

export function readProtectedCredentials(root: string): [string, string] {
  const ready = join(root, "ready");
  try {
    if (!lstatSync(ready).isDirectory()) throw new Error();
    const read = (name: string): string => {
      const path = join(ready, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > credentialLimit) throw new Error();
      const value = readFileSync(path, "utf8");
      if (!isCredential(value)) throw new Error();
      return value;
    };
    return [read("key"), read("secret")];
  } catch {
    throw new Error("Invalid or unreadable protected credential pair");
  } finally {
    try {
      rmSync(ready, { recursive: true, force: true });
    } catch {
      throw new Error("Could not remove protected credential files");
    }
  }
}
