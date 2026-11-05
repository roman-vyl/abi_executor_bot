export type Credentials = Readonly<{
  apiKey: string;
  apiSecret: string;
}>;

// The verifier owns knowledge of the exchange, expected UID and required rights.
export type VerificationResult = "accepted" | "rejected" | "temporary_failure";
export type CredentialsVerifier = (candidate: Credentials) => Promise<VerificationResult>;

export type AuthorizationState = "LOCKED" | "VERIFYING" | "RETRY_PENDING" | "AUTHORIZED";
export type AuthorizationResult =
  | VerificationResult
  | "busy"
  | "retry_required"
  | "already_authorized"
  | "no_candidate";

export class AuthorizationService {
  private state: AuthorizationState = "LOCKED";
  private pair: Credentials | undefined;

  constructor(private readonly verify: CredentialsVerifier) {}

  status(): AuthorizationState {
    return this.state;
  }

  credentials(): Credentials | undefined {
    return this.state === "AUTHORIZED" ? this.pair : undefined;
  }

  async authorize(candidate: Credentials): Promise<AuthorizationResult> {
    if (this.state === "AUTHORIZED") return "already_authorized";
    if (this.state === "VERIFYING") return "busy";
    if (this.state === "RETRY_PENDING") return "retry_required";

    // Copy only primitive fields. Neither the caller nor the verifier may
    // mutate the service's candidate or the subsequently authorized pair.
    const pair = Object.freeze({ apiKey: candidate.apiKey, apiSecret: candidate.apiSecret });
    if (
      typeof pair.apiKey !== "string" || pair.apiKey.length === 0 ||
      typeof pair.apiSecret !== "string" || pair.apiSecret.length === 0
    ) {
      throw new TypeError("Credentials must contain a non-empty key and secret");
    }
    this.pair = pair;
    return this.verifyPair(pair);
  }

  async retry(): Promise<AuthorizationResult> {
    if (this.state === "AUTHORIZED") return "already_authorized";
    if (this.state === "VERIFYING") return "busy";
    if (this.pair === undefined) return "no_candidate";
    return this.verifyPair(this.pair);
  }

  private async verifyPair(pair: Credentials): Promise<AuthorizationResult> {
    // Set before calling external code, including a synchronously reentrant
    // verifier. There is exactly one in-flight check.
    this.state = "VERIFYING";
    let result: VerificationResult;
    try {
      result = await this.verify(pair);
    } catch {
      // An exception is not proof of rejection. Keep the candidate for retry,
      // and expose neither the exception nor possible credential-bearing text.
      result = "temporary_failure";
    }

    if (result === "accepted") {
      this.state = "AUTHORIZED";
      return "accepted";
    }
    if (result === "rejected") {
      this.pair = undefined;
      this.state = "LOCKED";
      return "rejected";
    }

    // Unexpected runtime results also fail closed.
    this.state = "RETRY_PENDING";
    return "temporary_failure";
  }
}
