import type { Op } from "./crdt/ops.js";

/** Document ids are used as map keys and in logs, so they are kept short and plain. */
export const DOC_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Messages a client may send. */
export type ClientMessage =
  | { readonly type: "auth"; readonly token: string }
  | { readonly type: "join"; readonly doc: string }
  | { readonly type: "leave"; readonly doc: string }
  | { readonly type: "ops"; readonly doc: string; readonly seq: number; readonly ops: readonly Op[]; readonly t?: number };

/** Messages the server sends. */
export type ServerMessage =
  | { readonly type: "ready"; readonly user: string }
  | { readonly type: "joined"; readonly doc: string; readonly replica: string; readonly ops: readonly Op[] }
  | { readonly type: "ops"; readonly doc: string; readonly from: string; readonly ops: readonly Op[]; readonly t?: number }
  | { readonly type: "ack"; readonly doc: string; readonly seq: number }
  | { readonly type: "error"; readonly code: string; readonly message: string; readonly doc?: string; readonly seq?: number };

/** WebSocket close codes the server uses (4000-4999 are free for applications). */
export const Close = {
  /** Missing, invalid or expired token, or no auth in time. */
  UNAUTHORIZED: 4001,
  /** The token does not allow this document. */
  FORBIDDEN: 4003,
  /** Not JSON, unknown message type or malformed fields. */
  PROTOCOL: 4400,
  /** Too many operations per second. */
  RATE_LIMITED: 4429,
} as const;

/** Thrown for a malformed client message; the message text is safe to send back. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/** Parse and shape-check one client message (operations are checked later, against the document). */
export function parseClientMessage(raw: string): ClientMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new ProtocolError("message is not valid JSON");
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) throw new ProtocolError("message must be an object");
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "auth":
      if (typeof m.token !== "string") throw new ProtocolError("auth needs a token");
      return { type: "auth", token: m.token };
    case "join":
    case "leave":
      if (typeof m.doc !== "string" || !DOC_ID.test(m.doc)) throw new ProtocolError("invalid document id");
      return { type: m.type, doc: m.doc };
    case "ops": {
      if (typeof m.doc !== "string" || !DOC_ID.test(m.doc)) throw new ProtocolError("invalid document id");
      if (!Number.isSafeInteger(m.seq)) throw new ProtocolError("ops needs an integer seq");
      if (!Array.isArray(m.ops)) throw new ProtocolError("ops must be an array");
      const base = { type: "ops" as const, doc: m.doc, seq: m.seq as number, ops: m.ops as Op[] };
      return typeof m.t === "number" ? { ...base, t: m.t } : base;
    }
    default:
      throw new ProtocolError("unknown message type");
  }
}
