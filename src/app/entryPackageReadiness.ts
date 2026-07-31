// Composition-root-owned readiness for entry-package execution only —
// distinct from overall server health. Starts not-ready; becomes ready only
// once correlation-store replay succeeds, and stays fail-closed on any
// non-final corruption (design.md §13).
export class EntryPackageReadiness {
  private ready = false;
  private reason: string | undefined;

  get isReady(): boolean {
    return this.ready;
  }

  get currentReason(): string | undefined {
    return this.reason;
  }

  markReady(): void {
    this.ready = true;
    this.reason = undefined;
  }

  markNotReady(reason: string): void {
    this.ready = false;
    this.reason = reason;
  }
}
