import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { AbuseProtection, OperatorIdentity, OperatorIdentityProvider } from "@gameintel/contracts";

// Local/free capability implementations for operator identity and community
// intake abuse protection. They satisfy the @gameintel/contracts capabilities
// so future deployments can replace them without changing GameIntel Core.

export class SubmissionIdentityError extends Error {}

const TOKEN_PLACEHOLDER = /^(?:change[-_ ]?me|replace|placeholder|example|test)$/i;
const OPERATOR_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
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
    if (!OPERATOR_ID_PATTERN.test(operatorId)) throw new Error("OPERATOR_ID must be a valid operator identifier");
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
};

// Local community-intake protection: HMAC identity hashing of the session and
// trusted-proxy IP. Quarantine, rate limiting, duplicate detection and
// retention remain in persistence; this only produces the identity digests.
export class LocalAbuseProtection implements AbuseProtection {
  private readonly secret: string;
  private readonly trustProxy: boolean;
  private readonly trustedIpHeader: string;

  constructor(options: LocalAbuseProtectionOptions) {
    this.secret = options.secret;
    this.trustProxy = options.trustProxy;
    this.trustedIpHeader = options.trustedIpHeader ?? "cf-connecting-ip";
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

  trustedClientIpHeader(): string {
    return this.trustedIpHeader;
  }
}