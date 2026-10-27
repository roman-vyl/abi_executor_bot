import { loadConfig } from "../config/config.js";
import { configureDiagnostics } from "../observability/diagnostics.js";
import { emitEvent } from "../observability/events.js";
import { openExchangeFactsStore } from "./exchangeFactsStartup.js";
import { serviceStartingFields } from "./serviceStartingEvent.js";
import { startServer } from "./server.js";

const config = loadConfig();
configureDiagnostics(process.env.ABI_DIAGNOSTICS_PATH);

// Opened before service_starting so the event reports the real store state;
// a store that cannot open is reported and never stops startup.
const exchangeFacts = openExchangeFactsStore(config);

emitEvent("info", "service_starting", serviceStartingFields(config, exchangeFacts));

startServer(config, exchangeFacts);
