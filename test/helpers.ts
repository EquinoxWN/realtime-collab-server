import { CollabClient } from "../src/client.js";
import { startServer, type CollabServer, type ServerOptions } from "../src/server.js";
import { signToken } from "../src/token.js";

export const SECRET = "test-secret-with-enough-length-1234";

/** Start a server on a free port with test defaults. */
export function server(options: Partial<ServerOptions> = {}): Promise<CollabServer> {
  return startServer({ secret: SECRET, ...options });
}

/** A valid token for a user and documents. */
export function token(sub: string, docs: string[] = ["*"], ttl = 60): string {
  return signToken(SECRET, { sub, docs }, ttl);
}

/** Connect and authenticate. */
export function connect(s: CollabServer, sub: string, docs: string[] = ["*"]): Promise<CollabClient> {
  return CollabClient.connect(s.url, token(sub, docs));
}

/** Resolve after ms milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until predicate is true or fail after timeoutMs. */
export async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(5);
  }
}
