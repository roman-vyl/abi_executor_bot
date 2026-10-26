import { loadConfig } from "../config/config.js";
import { configureDiagnostics } from "../observability/diagnostics.js";
import { emitEvent } from "../observability/events.js";
import { serviceStartingFields } from "./serviceStartingEvent.js";
import { startServer } from "./server.js";

const config = loadConfig();
configureDiagnostics(process.env.ABI_DIAGNOSTICS_PATH);

emitEvent("info", "service_starting", serviceStartingFields(config));

startServer(config);
