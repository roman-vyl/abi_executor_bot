import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type AbiEvent = {
  id: string;
  ts: string;
  eventType: string;
  signalId?: string;
  payload: unknown;
};

export class Journal {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async appendEvent(input: {
    eventType: string;
    signalId?: string;
    payload: unknown;
  }): Promise<AbiEvent> {
    const event: AbiEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      eventType: input.eventType,
      signalId: input.signalId,
      payload: input.payload,
    };

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");

    return event;
  }

  async hasSignal(signalId: string): Promise<boolean> {
    return (await this.findLastEvent({ signalId })) !== null;
  }

  async findLastEvent(input: { signalId: string; eventType?: string }): Promise<AbiEvent | null> {
    let latest: AbiEvent | null = null;

    for (const event of await this.readEvents()) {
      if (event.signalId !== input.signalId) {
        continue;
      }

      if (input.eventType !== undefined && event.eventType !== input.eventType) {
        continue;
      }

      latest = event;
    }

    return latest;
  }

  async findActiveIntentByInstanceId(instanceId: string): Promise<{ signalId: string; instanceId: string } | null> {
    const bySignalId = new Map<string, { instanceId?: string; status?: string }>();

    for (const event of await this.readEvents()) {
      if (event.signalId === undefined) {
        continue;
      }

      const current = bySignalId.get(event.signalId) ?? {};

      if (event.eventType === "signal_received" || event.eventType === "signal_updated") {
        const eventInstanceId = readPayloadString(event.payload, "instanceId");
        if (eventInstanceId !== "") {
          current.instanceId = eventInstanceId;
        }
      }

      if (event.eventType === "intent_status_changed") {
        const status = readPayloadString(event.payload, "status");
        if (status !== "") {
          current.status = status;
        }
      }

      bySignalId.set(event.signalId, current);
    }

    for (const [signalId, state] of bySignalId.entries()) {
      if (state.instanceId === instanceId && state.status === "planned") {
        return {
          signalId,
          instanceId,
        };
      }
    }

    return null;
  }

  private async readEvents(): Promise<AbiEvent[]> {
    let content: string;

    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const events: AbiEvent[] = [];

    for (const line of content.split("\n")) {
      if (line.trim() === "") {
        continue;
      }

      try {
        events.push(JSON.parse(line) as AbiEvent);
      } catch {
        continue;
      }
    }

    return events;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readPayloadString(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null || !(key in payload)) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const value = record[key];
  return typeof value === "string" ? value : "";
}
