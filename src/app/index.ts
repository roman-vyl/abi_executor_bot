import { loadConfig } from "../config/config.js";
import { emitEvent } from "../observability/events.js";
import { serviceStartingFields } from "./serviceStartingEvent.js";
import { startServer } from "./server.js";

const config = loadConfig();

emitEvent("info", "service_starting", serviceStartingFields(config));

startServer(config);
