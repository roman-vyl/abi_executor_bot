// GET-only deadline: cancellation asks the transport to stop; settlement and
// expiry checks prevent an uncooperative transport from retaining the caller
// or publishing evidence after its attempt expired. Never wrap a trading POST.
export function runBybitGetAttempt(
  request: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  decode: (response: Response, bodyText: string) => unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const timeout = new DOMException("Bybit GET request timed out", "TimeoutError");
    let active = true;
    let response: Response | undefined;
    let cancellationRequested = false;

    const cancelBody = () => {
      if (!response || cancellationRequested) return;
      cancellationRequested = true;
      try {
        // A locked reader is cancelled by the transport signal. Cancellation
        // of a late response is best effort and must never become an await.
        void response?.body?.cancel().catch(() => undefined);
      } catch { /* Cleanup cannot extend the GET deadline. */ }
    };
    const expire = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      reject(timeout);
      controller.abort(timeout);
      cancelBody();
    };
    const checkActive = () => {
      if (active && performance.now() >= deadline) expire();
      if (!active) throw timeout;
    };
    const timer = setTimeout(expire, timeoutMs);

    // Observe every late rejection. No application callback or durable write
    // is captured here: the only continuation is response cleanup/decoding.
    void (async () => {
      try {
        checkActive();
        response = await request(controller.signal);
        checkActive();
        const bodyText = await response.text();
        checkActive();
        const result = decode(response, bodyText);
        checkActive();
        active = false;
        clearTimeout(timer);
        resolve(result);
      } catch (error) {
        if (active) {
          active = false;
          clearTimeout(timer);
          reject(error);
        }
        cancelBody();
      }
    })();
  });
}
