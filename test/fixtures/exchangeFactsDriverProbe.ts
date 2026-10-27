// Child-process probe: loads the ABI server module graph and the startup
// helper with the store disabled, then reports whether the SQLite native
// driver was loaded (abi-exchange-facts-trading-isolation-v1 D2).
import { createRequire } from "node:module";

import { openExchangeFactsStore } from "../../src/app/exchangeFactsStartup.js";
import "../../src/app/server.js";
import { makeTestConfig } from "./config.js";

const state = openExchangeFactsStore(makeTestConfig());
const loaded = Object.keys(createRequire(import.meta.url).cache).some((key) => key.includes("better-sqlite3"));
process.stdout.write(JSON.stringify({ status: state.status, driverLoaded: loaded }) + "\n");
