import { createServer } from "node:http";

import { KeyedMutex } from "../concurrency/keyedMutex.js";
import type { AbiConfig } from "../config/config.js";
import { EntryPackageCorrelationRepository } from "../correlation/entryPackageCorrelationRepository.js";
import { RestBybitAdapter } from "../exchange/bybitAdapter.js";
import { BybitExchangeInstrumentResolver } from "../exchange/exchangeInstrumentResolver.js";
import { BybitInstrumentTradingRulesProvider } from "../exchange/instrumentTradingRulesProvider.js";
import { FixedMinimumPositionSizeCalculator } from "../risk/positionSizeCalculator.js";
import { CloseApplicationService } from "../services/close/closeApplicationService.js";
import { EntryPackageApplicationService } from "../services/entryPackage/entryPackageApplicationService.js";
import { OpenPositionResolutionService } from "../services/openPosition/openPositionResolutionService.js";
import { ProtectionApplicationService } from "../services/protection/protectionApplicationService.js";
import { EntryPackageReadiness } from "./entryPackageReadiness.js";
import { writeJson } from "./http.js";
import { installShutdownHandlers } from "./shutdown.js";
import { handleAccountRoutes } from "../routes/accountRoutes.js";
import { handleEntryPackageRoutes } from "../routes/entryPackageRoutes.js";
import { handleOpenPositionRoutes } from "../routes/openPositionRoutes.js";
import { handlePositionManagementRoutes } from "../routes/positionManagementRoutes.js";
import { handleSystemRoutes } from "../routes/systemRoutes.js";

export function startServer(config: AbiConfig): void {
  const bybit = new RestBybitAdapter(config);

  const correlationRepository = new EntryPackageCorrelationRepository(config.entryPackageCorrelationPath);
  const rulesProvider = new BybitInstrumentTradingRulesProvider(bybit, config);
  const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);
  const mutex = new KeyedMutex();
  // Serializes physical-position-scope acquisition across different pairs
  // with a distinct instance from `mutex` above. It is always acquired
  // second/inner, never while `mutex` is not already held for the same
  // request.
  const scopeMutex = new KeyedMutex();
  const readiness = new EntryPackageReadiness();
  const exchangeInstrumentResolver = new BybitExchangeInstrumentResolver();

  const applicationService = new EntryPackageApplicationService({
    config,
    bybit,
    correlationRepository,
    positionSizeCalculator,
    mutex,
    scopeMutex,
    exchangeInstrumentResolver,
  });

  const openPositionResolutionService = new OpenPositionResolutionService({
    correlationRepository,
    bybit,
  });

  // Reuses the same pair-level `mutex` (not `scopeMutex`) and the same
  // live-position determination as openPositionResolutionService; protection
  // never claims or releases physical scopes.
  const protectionApplicationService = new ProtectionApplicationService({
    config,
    bybit,
    correlationRepository,
    mutex,
    openPositionResolutionService,
  });

  // Reuses the same pair-level `mutex`, never `scopeMutex` — release of a
  // pair's own scope happens as a side effect of its durable terminal write,
  // not through the scope-acquisition lock.
  const closeApplicationService = new CloseApplicationService({
    config,
    bybit,
    correlationRepository,
    mutex,
  });

  // Correlation-store replay runs asynchronously so account/system routes can
  // come up before entry-package state is ready; entry-package and position
  // management routes fail closed until readiness flips true.
  void correlationRepository
    .replay()
    .then((result) => {
      if (result.ok) {
        readiness.markReady();
      } else {
        readiness.markNotReady(result.reason);
      }
    })
    .catch((error: unknown) => {
      readiness.markNotReady(error instanceof Error ? error.message : "correlation replay failed");
    });

  const server = createServer(async (request, response) => {
    if (await handleSystemRoutes({ request, response, config, entryPackageReady: readiness.isReady })) {
      return;
    }

    if (await handleAccountRoutes({ request, response, config, bybit })) {
      return;
    }

    if (
      await handleEntryPackageRoutes({
        request,
        response,
        applicationService,
        isReady: () => readiness.isReady,
      })
    ) {
      return;
    }

    if (
      await handleOpenPositionRoutes({
        request,
        response,
        resolutionService: openPositionResolutionService,
        isReady: () => readiness.isReady,
      })
    ) {
      return;
    }

    if (
      await handlePositionManagementRoutes({
        request,
        response,
        protectionApplicationService,
        closeApplicationService,
        isReady: () => readiness.isReady,
      })
    ) {
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Abi service listening on ${config.host}:${config.port}`);
  });

  installShutdownHandlers({ server });
}
