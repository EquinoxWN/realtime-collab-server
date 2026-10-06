import { createHmac, timingSafeEqual } from "node:crypto";

/** What a token grants: a user and the documents that user may join ("*" for any). */
export interface Claims {
  readonly sub: string;
  readonly docs: readonly string[];
  readonly exp: number;
}

/** User ids become part of replica names, so they are kept short and plain. */
export const USER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TOKEN_LENGTH = 4096;

const b64 = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

function sign(secret: string | Buffer, input: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

/** Issue an HS256 JWT valid for ttlSeconds (used by tests, the load script and a real auth service). */
export function signToken(secret: string | Buffer, claims: Omit<Claims, "exp">, ttlSeconds: number, now = Date.now()): string {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${header}.${payload}.${b64(sign(secret, `${header}.${payload}`))}`;
}

/** Thrown when a token is missing, malformed, forged or expired; the message is safe to send. */
export class TokenError extends Error {
  override name = "TokenError";
}

/** Verify signature, algorithm and expiry, then return the claims; throws TokenError otherwise. */
export function verifyToken(secret: string | Buffer, token: unknown, now = Date.now()): Claims {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new TokenError("missing or oversized token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [header, payload, signature] = parts as [string, string, string];
  let head: unknown;
  let body: unknown;
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed token");
  }
  // Checking alg first blocks the classic "alg": "none" downgrade.
  if (typeof head !== "object" || head === null || (head as { alg?: unknown }).alg !== "HS256") {
    throw new TokenError("unsupported token algorithm");
  }
  const expected = sign(secret, `${header}.${payload}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TokenError("bad signature");
  const c = body as Partial<Claims> | null;
  if (
    typeof c !== "object" ||
    c === null ||
    typeof c.sub !== "string" ||
    !USER_ID.test(c.sub) ||
    !Array.isArray(c.docs) ||
    !c.docs.every((d) => typeof d === "string") ||
    typeof c.exp !== "number"
  ) {
    throw new TokenError("invalid claims");
  }
  if (c.exp * 1000 <= now) throw new TokenError("token expired");
  return { sub: c.sub, docs: c.docs, exp: c.exp };
}
