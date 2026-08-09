// Minimal in-process, per-key serialization: chains promises per key in a
// Map. No timeout, no external dependency, no distributed-lock semantics —
// this mutex only coordinates one ABI process. The chained "tail" always
// settles regardless of whether the previous task resolved or rejected, so a
// failing request never wedges the key for the next request — this is a
// correctness requirement, not an optimization.
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();

    const resultPromise = previousTail.then(fn, fn);
    const settledTail = resultPromise.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, settledTail);
    void settledTail.then(() => {
      if (this.tails.get(key) === settledTail) {
        this.tails.delete(key);
      }
    });

    return resultPromise;
  }
}
