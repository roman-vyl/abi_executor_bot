import { createAuthorizationSocket } from "../authorization/authorizationSocket.js";
import { assureConfiguredActiveBindings } from "./positionModeAssuranceSeams.js";
import { disabledStreamStatus } from "../exchangeStream/exchangeStreamRecorder.js";
import { disabledRestStatus, emptyCompletenessStatus } from "../exchangeFacts/exchangeRestReconciler.js";
import type { ExchangeStreamHandle } from "../exchangeStream/exchangeStreamStartup.js";
import type { ExchangeRestReconcilerHandle } from "../exchangeFacts/exchangeRestReconciler.js";
import { createServer } from "node:http";

import { KeyedMutex } from "../concurrency/keyedMutex.js";
import type { AbiConfig } from "../config/config.js";
import { EntryPackageCorrelationRepository } from "../correlation/entryPackageCorrelationRepository.js";
import { RestBybitAdapter } from "../exchange/bybitAdapter.js";
import { BybitConnectionHeartbeat } from "../exchange/bybitConnectionHeartbeat.js";
import { createExchangeOrderLinker } from "../exchangeFacts/exchangeOrderLinker.js";
import { createExchangeRestReconciler } from "../exchangeFacts/exchangeRestReconciler.js";
import { createExchangeStreamRecorder } from "../exchangeStream/exchangeStreamStartup.js";
import { BybitExchangeInstrumentResolver } from "../exchange/exchangeInstrumentResolver.js";
import { BybitInstrumentTradingRulesProvider } from "../exchange/instrumentTradingRulesProvider.js";
import { emitEvent } from "../observability/events.js";
import {
  FixedMinimumPositionSizeCalculator,
  RiskPercentPositionSizeCalculator,
} from "../risk/positionSizeCalculator.js";
import { CloseApplicationService } from "../services/close/closeApplicationService.js";
import { EntryRemainderCancelService } from "../services/entryRemainder/entryRemainderCancelService.js";
import { EntryCycleRecoveryResolutionService } from "../services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { EntryPackageApplicationService } from "../services/entryPackage/entryPackageApplicationService.js";
import { OpenPositionResolutionService } from "../services/openPosition/openPositionResolutionService.js";
import { ProtectionApplicationService } from "../services/protection/protectionApplicationService.js";
import { EntryPackageReadiness } from "./entryPackageReadiness.js";
import type { ExchangeFactsStoreState } from "./exchangeFactsStartup.js";
import { writeJson } from "./http.js";
import { replayCorrelationStore } from "./lifecycleEvents.js";
import { installShutdownHandlers } from "./shutdown.js";
import { handleAccountRoutes } from "../routes/accountRoutes.js";
import { handleEntryCycleRecoveryRoutes } from "../routes/entryCycleRecoveryRoutes.js";
import { handleEntryPackageRoutes } from "../routes/entryPackageRoutes.js";
import { handleExchangeJournalRoutes } from "../routes/exchangeJournalRoutes.js";
import { handleOpenPositionRoutes } from "../routes/openPositionRoutes.js";
import { handlePositionManagementRoutes } from "../routes/positionManagementRoutes.js";
import { handleSystemRoutes } from "../routes/systemRoutes.js";

// The exchange facts store is opened by the caller before anything listens;
// nothing in order execution uses it.
export async function startServer(config: AbiConfig, exchangeFacts: ExchangeFactsStoreState,
  retryTimers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis) {
  let stopping = false;
  let activate: () => void = () => undefined;
  let authorizationChanged: () => void = () => undefined;
  const control = await createAuthorizationSocket({
    path: config.authorizationSocketPath,
    policy: { environment: config.bybitEnvironment, expectedUid: config.expectedBybitUid,
      category: config.bybitCategory as "linear" | "spot", recvWindow: config.bybitRecvWindow },
    onAuthorizationResult: result => {
      if (result !== "busy" && result !== "retry_required" && result !== "no_candidate") authorizationChanged();
    },
  });
  const authorization = control.authorization;
  const bybit = new RestBybitAdapter(config, { credentialsSource: authorization });
  let exchangeStream: ExchangeStreamHandle | undefined;
  let exchangeRest: ExchangeRestReconcilerHandle | undefined;
  let bindingsVerified = false;
  let activationReason: string | undefined;
  let activation: Promise<void> | undefined;
  const accountReady = () => !stopping && authorization.status() === "AUTHORIZED";
  const executionReady = () => accountReady() && readiness.isReady && bindingsVerified;
  // One completion-based timer for the two safe startup read phases. Never retries trading commands.
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryPhase: "authorization" | "bindings" | undefined;
  let retryStep = 0;
  let authorizationAttempt: Promise<void> | undefined;
  const cancelRetryTimer = () => {
    if (retryTimer !== undefined) retryTimers.clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const resetRetry = () => { cancelRetryTimer(); retryPhase = undefined; retryStep = 0; };
  const scheduleRetry = (phase: "authorization" | "bindings") => {
    if (stopping || retryTimer !== undefined) return;
    if (retryPhase !== phase) { retryPhase = phase; retryStep = 0; }
    const delayMs = [5_000, 15_000, 30_000][Math.min(retryStep++, 2)];
    retryTimer = retryTimers.setTimeout(() => {
      retryTimer = undefined;
      if (stopping) return;
      if (authorization.status() === "RETRY_PENDING" && !authorizationAttempt) {
        authorizationAttempt = (async () => {
          await authorization.retry();
          authorizationChanged();
        })().finally(() => { authorizationAttempt = undefined; });
      } else if (accountReady()) activate();
    }, delayMs);
    retryTimer.unref?.();
    emitEvent("info", "startup_retry_scheduled", { phase, delayMs });
  };
  authorizationChanged = () => {
    if (stopping) return;
    cancelRetryTimer();
    const state = authorization.status();
    if (state === "RETRY_PENDING") scheduleRetry("authorization");
    else if (state === "AUTHORIZED") activate();
    else if (state === "LOCKED") resetRetry();
  };
  // Keeps the pooled Bybit connection in use between bars; trading never
  // waits for it (abi-bybit-connection-keepalive-v1).
  const bybitHeartbeat = new BybitConnectionHeartbeat({ adapter: bybit, intervalMs: config.bybitHeartbeatIntervalMs });

  const correlationRepository = new EntryPackageCorrelationRepository(config.entryPackageCorrelationPath);
  const rulesProvider = new BybitInstrumentTradingRulesProvider(bybit, config);
  const positionSizeCalculator =
    config.positionSizingMode === "risk"
      ? new RiskPercentPositionSizeCalculator(rulesProvider, bybit)
      : new FixedMinimumPositionSizeCalculator(rulesProvider);
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
    tradingRules: rulesProvider,
  });

  const openPositionResolutionService = new OpenPositionResolutionService({
    correlationRepository,
    bybit,
    // Used only to durably capture first_fill_at_ms exactly once
    // (abi-pair-scoped-open-position-resolution-v1) — the same shared
    // instance every other durable write in this codebase already uses.
    mutex,
  });

  const entryCycleRecoveryResolutionService = new EntryCycleRecoveryResolutionService({
    correlationRepository,
    bybit,
    // Used only to durably capture first_fill_at_ms exactly once, when
    // resolving position_open (abi-entry-cycle-recovery-attribution-v1) —
    // the same shared instance every other durable write in this codebase
    // already uses.
    mutex,
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
    tradingRules: rulesProvider,
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

  // Ends the unfilled remainder of a filled entry order under the same
  // pair-level `mutex`; never writes the record (abi-entry-remainder-cancel-v1).
  const entryRemainderCancelService = new EntryRemainderCancelService({
    config,
    bybit,
    correlationRepository,
    mutex,
  });

  // Correlation-store replay runs asynchronously so account/system routes can
  // come up before entry-package state is ready; entry-package and position
  // management routes fail closed until readiness flips true.
  // Links stored orders to trade cycles from ABI's own labels; reads the
  // correlation records only, never called by trading
  // (abi-exchange-order-linker-v1).
  const exchangeLinker = createExchangeOrderLinker(exchangeFacts, {
    listRecords: () => correlationRepository.listAllRecords(),
    isCorrelationReady: () => readiness.isReady,
  });

  // Preserve the existing local recovery exactly once, independently of authorization.
  const localRecovery = replayCorrelationStore(correlationRepository, readiness);
  activate = () => {
    if (!accountReady() || activation || bindingsVerified) return;
    activation = (async () => {
      try {
        if (stopping) return;
        if (!exchangeStream) {
          exchangeStream = createExchangeStreamRecorder(config, exchangeFacts, authorization);
          exchangeStream.start();
        }
        if (!exchangeRest) {
          exchangeRest = createExchangeRestReconciler(config, exchangeFacts, {
            reader: bybit, listRecords: () => correlationRepository.listAllRecords(),
            isCorrelationReady: () => readiness.isReady,
          });
          exchangeRest.start();
        }
        await localRecovery;
        if (stopping || !readiness.isReady) return;
        const result = await assureConfiguredActiveBindings({ bybit,
          linearPolicy: config.bybitLinearPositionBindingMode,
          activeRecords: correlationRepository.findAllActiveRecords() });
        if (stopping) return;
        bindingsVerified = result.ok;
        activationReason = result.ok ? undefined : result.reason;
        if (result.ok) { resetRetry(); emitEvent("info", "execution_ready"); }
        else {
          emitEvent("warn", "execution_activation_failed", { reason: result.reason });
          if (result.retryable) scheduleRetry("bindings");
          else resetRetry();
        }
      } catch {
        activationReason = "activation_failed";
        emitEvent("warn", "execution_activation_failed", { reason: activationReason });
      }
    })().finally(() => { activation = undefined; });
  };

  // Cover an authorization that completed while the socket was being opened.
  authorizationChanged();

  const server = createServer(async (request, response) => {
    if (await handleSystemRoutes({
        request,
        response,
        config,
        entryPackageReady: executionReady(),
        authorizationState: authorization.status(),
        localRecoveryReady: readiness.isReady,
        bindingsVerified,
        activationReason,
        exchangeFacts,
        exchangeStream: exchangeStream?.status() ?? disabledStreamStatus("awaiting_authorization"),
        exchangeLinker: exchangeLinker.status(),
        exchangeRest: exchangeRest?.status() ?? disabledRestStatus("awaiting_authorization"),
        exchangeCompleteness: exchangeRest?.completenessStatus() ?? emptyCompletenessStatus(),
        bybitConnection: bybitHeartbeat.status(),
      })) {
      return;
    }

    if (await handleAccountRoutes({ request, response, config, bybit, isReady: accountReady })) {
      return;
    }

    // Read-only journal API; works without correlation readiness, because it
    // reads only the exchange facts store (abi-exchange-journal-read-api-v1).
    if (
      await handleExchangeJournalRoutes({
        request,
        response,
        exchangeFacts,
        health: () => ({
          stream: exchangeStream?.status() ?? disabledStreamStatus("awaiting_authorization"),
          linker: exchangeLinker.status(),
          rest: exchangeRest?.status() ?? disabledRestStatus("awaiting_authorization"),
          completeness: exchangeRest?.completenessStatus() ?? emptyCompletenessStatus(),
        }),
      })
    ) {
      return;
    }

    if (
      await handleEntryPackageRoutes({
        request,
        response,
        applicationService,
        isReady: executionReady,
      })
    ) {
      return;
    }

    if (
      await handleOpenPositionRoutes({
        request,
        response,
        resolutionService: openPositionResolutionService,
        isReady: executionReady,
      })
    ) {
      return;
    }

    if (
      await handleEntryCycleRecoveryRoutes({
        request,
        response,
        resolutionService: entryCycleRecoveryResolutionService,
        isReady: executionReady,
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
        entryRemainderCancelService,
        isReady: executionReady,
      })
    ) {
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
    });
  });

  let controlClosed: Promise<void> | undefined;
  const beginShutdown = () => {
    stopping = true;
    resetRetry();
    controlClosed ??= control.close();
    // Observe rejection immediately even while HTTP requests drain.
    void controlClosed.catch(() => undefined);
  };
  const release = async () => {
    beginShutdown();
    await controlClosed;
    await authorizationAttempt;
    await activation;
    bybitHeartbeat.stop();
    try {
      exchangeStream?.stop();
      exchangeLinker.stop();
      exchangeRest?.stop();
      if (exchangeFacts.status === "enabled") exchangeFacts.store.close();
    } finally { bybit.close(); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) { await release(); throw error; }
  emitEvent("info", "server_listening", { host: config.host, port: config.port });
  exchangeLinker.start();
  bybitHeartbeat.start();
  const close = async () => {
    beginShutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await release();
  };
  installShutdownHandlers({ server, onShutdownStarted: beginShutdown, onServerClosed: release });
  return { server, close, authorization };
}
