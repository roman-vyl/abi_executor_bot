import assert from "node:assert/strict";
import test from "node:test";

import type { CorrelationReplayResult } from "../../src/correlation/entryPackageCorrelationRepository.js";
import { replayCorrelationStore } from "../../src/app/lifecycleEvents.js";
import type { CorrelationReplayer } from "../../src/app/lifecycleEvents.js";

function captureWrites(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string): boolean => {
    lines.push(chunk);
    return true;
  }) as typeof stream.write;

  return {
    lines,
    restore: () => {
      stream.write = original;
    },
  };
}

function fakeReadiness(): {
  readiness: { markReady(): void; markNotReady(reason: string): void };
  ready: boolean;
  reason: string | undefined;
} {
  const state = { ready: false, reason: undefined as string | undefined };
  return {
    readiness: {
      markReady(): void {
        state.ready = true;
        state.reason = undefined;
      },
      markNotReady(reason: string): void {
        state.ready = false;
        state.reason = reason;
      },
    },
    get ready(): boolean {
      return state.ready;
    },
    get reason(): string | undefined {
      return state.reason;
    },
  };
}

test("successful replay emits correlation_replay_started -> correlation_replay_succeeded -> readiness_ready and marks ready", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const repository: CorrelationReplayer = {
    async replay(): Promise<CorrelationReplayResult> {
      return { ok: true };
    },
  };

  try {
    await replayCorrelationStore(repository, state.readiness);
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stderr.lines.length, 0);
  assert.equal(stdout.lines.length, 3);
  const events = stdout.lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event);
  assert.deepEqual(events, ["correlation_replay_started", "correlation_replay_succeeded", "readiness_ready"]);
  assert.equal(state.ready, true);
});

test("failed replay (typed result) emits correlation_replay_started -> correlation_replay_failed -> readiness_failed and marks not ready", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const repository: CorrelationReplayer = {
    async replay(): Promise<CorrelationReplayResult> {
      return { ok: false, reason: "corrupt line 3" };
    },
  };

  try {
    await replayCorrelationStore(repository, state.readiness);
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stdout.lines.length, 1);
  assert.equal((JSON.parse(stdout.lines[0]) as Record<string, unknown>).event, "correlation_replay_started");
  assert.equal(stderr.lines.length, 2);
  const errorEvents = stderr.lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event);
  assert.deepEqual(errorEvents, ["correlation_replay_failed", "readiness_failed"]);
  assert.equal(state.ready, false);
  assert.equal(state.reason, "corrupt line 3");
});

test("replay() rejecting is also treated as a replay failure", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const repository: CorrelationReplayer = {
    async replay(): Promise<CorrelationReplayResult> {
      throw new Error("disk exploded");
    },
  };

  try {
    await replayCorrelationStore(repository, state.readiness);
  } finally {
    stdout.restore();
    stderr.restore();
  }

  const errorEvents = stderr.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    errorEvents.map((event) => event.event),
    ["correlation_replay_failed", "readiness_failed"],
  );
  assert.equal(errorEvents[0].reason, "disk exploded");
  assert.equal(state.ready, false);
  assert.equal(state.reason, "disk exploded");
});
