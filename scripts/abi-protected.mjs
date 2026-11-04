import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";

const composeFile = fileURLToPath(new URL("../docker-compose.protected.yml", import.meta.url));
const compose = ["compose", "--project-name", "abi-protected", "--file", composeFile];
const containerName = "abi-protected-unlocked";
const header = Buffer.from("ABI-CREDS-V1\n");

async function prompt(label) {
  if (!process.stdin.isTTY) throw new Error("An interactive terminal is required");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  const controller = new AbortController();
  terminal.once("SIGINT", () => controller.abort());
  process.stderr.write(label);
  try {
    return await terminal.question("", { signal: controller.signal });
  } catch {
    throw new Error("Input cancelled");
  } finally {
    terminal.close();
    process.stderr.write("\n");
  }
}

function validatePair(pair) {
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(value =>
    typeof value === "string" && value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value))) {
    throw new Error("Invalid credential pair");
  }
}

function deriveKey(password, salt) {
  return scryptSync(password, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 ** 2 });
}

async function encrypt(path) {
  const pair = [await prompt("Bybit Demo API key: "), await prompt("Bybit Demo API secret: ")];
  validatePair(pair);
  const password = await prompt("New passphrase: ");
  if (password.length < 16) throw new Error("Use a passphrase of at least 16 characters");
  if (password !== await prompt("Repeat passphrase: ")) throw new Error("Passphrases differ");

  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(pair)), cipher.final()]);
    writeFileSync(path, Buffer.concat([header, salt, nonce, cipher.getAuthTag(), ciphertext]), {
      flag: "wx", mode: 0o600,
    });
  } finally {
    key.fill(0);
  }
}

async function decrypt(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) {
    throw new Error("Use a regular encrypted credential file with private permissions");
  }
  const file = readFileSync(path);
  const offset = header.length;
  if (file.length <= offset + 44 || !file.subarray(0, offset).equals(header)) {
    throw new Error("Invalid encrypted credential file");
  }
  const password = await prompt("Passphrase: ");
  const key = deriveKey(password, file.subarray(offset, offset + 16));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, file.subarray(offset + 16, offset + 28));
    decipher.setAAD(header);
    decipher.setAuthTag(file.subarray(offset + 28, offset + 44));
    return Buffer.concat([decipher.update(file.subarray(offset + 44)), decipher.final()]);
  } catch {
    throw new Error("Could not unlock credentials");
  } finally {
    key.fill(0);
  }
}

function docker(args, error, options = {}) {
  const result = spawnSync("docker", ["--context", "desktop-linux", ...args], { encoding: "utf8", timeout: 10_000, ...options });
  if (result.status !== 0) throw new Error(error);
  return result.stdout.trim();
}

async function start(path) {
  const plaintext = await decrypt(path);
  let id;
  try {
    let pair;
    try {
      pair = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("Invalid credential pair");
    }
    validatePair(pair);

    // Docker reserves the name atomically. A competing attempt has no ID to clean up.
    id = docker([...compose, "run", "--detach", "--rm", "--no-deps", "--service-ports", "--pull", "never",
      "--name", containerName, "abi"], "Could not start protected ABI. Build the image first and check for an existing session.");
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Could not identify the protected container");

    const swap = docker(["exec", id, "cat", "/sys/fs/cgroup/memory.swap.max"], "Could not verify container swap");
    if (swap !== "0") throw new Error("Container swap must be disabled");
    const frame = Buffer.concat([plaintext, Buffer.from("\n")]);
    try {
      docker(["exec", "-i", id, "node", "dist/config/receiveProtectedCredentials.js"],
        "Protected credential handoff failed", { input: frame });
    } finally {
      frame.fill(0);
    }
    plaintext.fill(0);

    for (let attempt = 0; attempt < 45; attempt++) {
      const state = docker(["inspect", "--format", "{{.State.Health.Status}}", id], "Protected ABI stopped during startup");
      if (state === "healthy") {
        console.log("Protected Demo ABI is ready at http://127.0.0.1:8788");
        return;
      }
      if (state === "unhealthy") break;
      await delay(1000);
    }
    throw new Error("Protected ABI did not become healthy");
  } catch (error) {
    if (id && /^[a-f0-9]{64}$/.test(id)) {
      const removed = spawnSync("docker", ["--context", "desktop-linux", "rm", "-f", id], { stdio: "ignore", timeout: 10_000 });
      if (removed.status !== 0) {
        const inspect = spawnSync("docker", ["--context", "desktop-linux", "inspect", id], { stdio: "ignore", timeout: 10_000 });
        if (inspect.status === 0) console.error("Could not remove failed protected container. Stop it manually.");
      }
    }
    throw error;
  } finally {
    plaintext.fill(0);
  }
}

try {
  const [command, path, extra] = process.argv.slice(2);
  if ((command !== "encrypt" && command !== "start") || !path?.endsWith(".abi-credentials.enc") || extra !== undefined) {
    throw new Error("Usage: node scripts/abi-protected.mjs encrypt|start <path.abi-credentials.enc>");
  }
  if (command === "encrypt") await encrypt(path);
  else await start(path);
} catch (error) {
  // Node filesystem errors can contain paths. Only show operator-facing messages.
  console.error(error.code ? "Could not access the encrypted credential file or terminal" : error.message);
  process.exitCode = 1;
}
