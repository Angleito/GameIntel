import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { SAFE_IDENTIFIER_PATTERN, type AbuseProtection, type OperatorIdentity, type OperatorIdentityProvider } from "@gameintel/contracts";

// Local/free capability implementations for operator identity and community
// intake abuse protection. They satisfy the @gameintel/contracts capabilities
// so future deployments can replace them without changing GameIntel Core.

export class SubmissionIdentityError extends Error {}

const TOKEN_PLACEHOLDER = /^(?:change[-_ ]?me|replace|placeholder|example|test)$/i;
const SUBMISSION_SESSION_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export type StaticOperatorIdentityOptions = {
  token: string;
  operatorId?: string;
};

// Static-token operator identity for the local reference deployment. The
// token is compared in constant time and validated for strength at startup.
export class StaticOperatorIdentityProvider implements OperatorIdentityProvider {
  private readonly expected: Uint8Array;
  private readonly actorId: string;

  constructor(options: StaticOperatorIdentityOptions) {
    if (!options.token || options.token.length < 32 || TOKEN_PLACEHOLDER.test(options.token)) {
      throw new Error("LOCAL_OPERATOR_TOKEN must be a unique token of at least 32 characters");
    }
    const operatorId = options.operatorId ?? "local-operator";
    if (!SAFE_IDENTIFIER_PATTERN.test(operatorId)) throw new Error("OPERATOR_ID must be a valid operator identifier");
    this.expected = new TextEncoder().encode(options.token);
    this.actorId = operatorId;
  }

  async authenticate(token: string): Promise<OperatorIdentity | null> {
    const received = new TextEncoder().encode(token);
    if (received.length !== this.expected.length) return null;
    return timingSafeEqual(received, this.expected) ? { actorId: this.actorId } : null;
  }

  operatorActorId(): string {
    return this.actorId;
  }
}

export type LocalAbuseProtectionOptions = {
  secret: string;
  trustProxy: boolean;
  trustedIpHeader?: string;
  trustedProxyToken?: string;
};

// Local community-intake protection: HMAC identity hashing of the session and
// trusted-proxy IP. Quarantine, rate limiting, duplicate detection and
// retention remain in persistence; this only produces the identity digests.
export class LocalAbuseProtection implements AbuseProtection {
  private readonly secret: string;
  private readonly trustProxy: boolean;
  private readonly trustedIpHeader: string;
  private readonly trustedProxyToken: string;

  constructor(options: LocalAbuseProtectionOptions) {
    this.secret = options.secret;
    this.trustProxy = options.trustProxy;
    this.trustedIpHeader = options.trustedIpHeader ?? "cf-connecting-ip";
    this.trustedProxyToken = options.trustedProxyToken ?? "";
  }

  async hashSubmissionIdentity(input: { session: string; ip: string; accountId?: string | null }): Promise<{ sessionHash: string; ipHash: string }> {
    if (!this.secret || this.secret.length < 32) {
      throw new SubmissionIdentityError("Submission identity hashing is not configured");
    }
    if (!this.trustProxy) throw new SubmissionIdentityError("A trusted submission proxy is required");
    const session = input.session ?? "";
    if (!SUBMISSION_SESSION_PATTERN.test(session)) {
      throw new SubmissionIdentityError("A valid submission session is required");
    }
    if (!isIP(input.ip)) throw new SubmissionIdentityError("A trusted client IP is required");
    const hash = (kind: string, value: string) => createHmac("sha256", this.secret).update(`${kind}:${value}`).digest("hex");
    return { sessionHash: hash("session", session), ipHash: hash("ip", input.ip) };
  }

  // A client must not be able to opt into a trusted IP header. The ingress
  // authenticates itself with this secret and is responsible for stripping any
  // client-supplied copies of the configured IP header before forwarding.
  isTrustedSubmissionProxy(token: string | null): boolean {
    if (!this.trustProxy || this.trustedProxyToken.length < 32 || token === null) return false;
    const expected = new TextEncoder().encode(this.trustedProxyToken);
    const received = new TextEncoder().encode(token);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  trustedClientIpHeader(): string {
    return this.trustedIpHeader;
  }
}
