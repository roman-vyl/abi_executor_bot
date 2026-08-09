export function captureWrites(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
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

// Only chunks that are themselves one parseable JSON object with our
// envelope's service field are treated as emitted events — the test
// runner's own reporter can interleave unrelated writes onto the same
// stdout/stderr stream while a test's promises are pending, and those
// must not be mistaken for operational events.
export function parseEvents(lines: string[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).service === "abi_executor_bot"
    ) {
      events.push(parsed as Record<string, unknown>);
    }
  }

  return events;
}
