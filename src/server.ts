import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { Close, parseClientMessage, ProtocolError, type ClientMessage, type ServerMessage } from "./protocol.js";
import { TokenBucket } from "./rate.js";
import { RejectedOp, Room } from "./room.js";
import { TokenError, verifyToken, type Claims } from "./token.js";

export interface ServerOptions {
  /** HMAC secret shared with whoever issues tokens. */
  readonly secret: string | Buffer;
  readonly port?: number;
  readonly host?: string;
  /** Browser origins allowed to connect; connections without an Origin header (non-browser clients) are allowed. */
  readonly allowedOrigins?: readonly string[];
  readonly authTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly maxOpsPerMessage?: number;
  readonly opsPerSecond?: number;
  readonly burst?: number;
  readonly heartbeatMs?: number;
  readonly maxOpsPerDoc?: number;
  readonly maxDocsPerConnection?: number;
  /** Documents held in memory across all connections; opening one more is refused. */
  readonly maxRooms?: number;
}

/** Live counters for tests, logs and the load script. */
export interface ServerStats {
  connections: number;
  rooms: number;
  opsApplied: number;
  opsBroadcast: number;
  rejected: number;
}

interface Connection {
  readonly socket: WebSocket;
  readonly id: number;
  claims: Claims | null;
  readonly rooms: Map<string, string>; // doc -> replica name
  readonly bucket: TokenBucket;
  alive: boolean;
  expiry?: NodeJS.Timeout;
}

/** A running collaboration server. */
export interface CollabServer {
  readonly port: number;
  readonly url: string;
  readonly stats: ServerStats;
  /** Current text of a document, or undefined if nobody has opened it. */
  text(doc: string): string | undefined;
  /** Members of a document's room. */
  members(doc: string): number;
  close(): Promise<void>;
}

/**
 * Start the server: clients authenticate with a token as their first message, join document
 * rooms, and send CRDT operations that the server validates, applies to its own replica and
 * broadcasts to everyone else in the room.
 */
export async function startServer(options: ServerOptions): Promise<CollabServer> {
  const o = {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: [] as readonly string[],
    authTimeoutMs: 5_000,
    maxPayloadBytes: 64 * 1024,
    maxOpsPerMessage: 1_000,
    opsPerSecond: 2_000,
    burst: 5_000,
    heartbeatMs: 30_000,
    maxOpsPerDoc: 500_000,
    maxDocsPerConnection: 8,
    maxRooms: 10_000,
    ...options,
  };
  const stats: ServerStats = { connections: 0, rooms: 0, opsApplied: 0, opsBroadcast: 0, rejected: 0 };
  const rooms = new Map<string, { room: Room; members: Set<Connection> }>();
  const connections = new Map<WebSocket, Connection>();
  const http: Server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("WebSocket only\n");
  });
  const wss = new WebSocketServer({
    server: http,
    maxPayload: o.maxPayloadBytes,
    verifyClient: (info: { origin: string; req: IncomingMessage }) =>
      !info.req.headers.origin || o.allowedOrigins.includes(info.origin),
  });
  let nextId = 0;

  const send = (c: Connection, msg: ServerMessage): void => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  };

  const leave = (c: Connection, doc: string): void => {
    const entry = rooms.get(doc);
    c.rooms.delete(doc);
    if (!entry) return;
    entry.members.delete(c);
  };

  const join = (c: Connection, doc: string): void => {
    if (!c.claims) return;
    if (!c.claims.docs.includes("*") && !c.claims.docs.includes(doc)) {
      c.socket.close(Close.FORBIDDEN, "token does not allow this document");
      return;
    }
    if (!c.rooms.has(doc) && c.rooms.size >= o.maxDocsPerConnection) {
      send(c, { type: "error", code: "too_many_docs", message: `at most ${o.maxDocsPerConnection} documents per connection` });
      return;
    }
    let entry = rooms.get(doc);
    if (!entry && rooms.size >= o.maxRooms) {
      send(c, { type: "error", code: "too_many_rooms", message: "the server is holding its maximum number of documents" });
      return;
    }
    if (!entry) {
      entry = { room: new Room(doc, o.maxOpsPerDoc), members: new Set() };
      rooms.set(doc, entry);
      stats.rooms = rooms.size;
    }
    const replica = `${c.claims.sub}~${c.id}`;
    c.rooms.set(doc, replica);
    entry.members.add(c);
    send(c, { type: "joined", doc, replica, ops: entry.room.log });
  };

  const edit = (c: Connection, msg: Extract<ClientMessage, { type: "ops" }>): void => {
    const replica = c.rooms.get(msg.doc);
    const entry = rooms.get(msg.doc);
    if (!replica || !entry) {
      send(c, { type: "error", code: "not_joined", message: "join the document before editing" });
      return;
    }
    if (msg.ops.length > o.maxOpsPerMessage) {
      c.socket.close(Close.PROTOCOL, `at most ${o.maxOpsPerMessage} operations per message`);
      return;
    }
    if (!c.bucket.take(Math.max(1, msg.ops.length))) {
      c.socket.close(Close.RATE_LIMITED, "too many operations per second");
      return;
    }
    let fresh;
    try {
      fresh = entry.room.apply(msg.ops, replica);
    } catch (e) {
      if (!(e instanceof RejectedOp)) throw e;
      stats.rejected++;
      send(c, { type: "error", code: "rejected", message: e.message, doc: msg.doc, seq: msg.seq });
      return;
    }
    stats.opsApplied += fresh.length;
    send(c, { type: "ack", doc: msg.doc, seq: msg.seq });
    if (fresh.length === 0) return;
    const out = JSON.stringify(msg.t === undefined ? { type: "ops", doc: msg.doc, from: replica, ops: fresh }
      : { type: "ops", doc: msg.doc, from: replica, ops: fresh, t: msg.t });
    for (const member of entry.members) {
      if (member !== c && member.socket.readyState === member.socket.OPEN) {
        member.socket.send(out);
        stats.opsBroadcast += fresh.length;
      }
    }
  };

  const onMessage = (c: Connection, data: RawData, isBinary: boolean): void => {
    let msg: ClientMessage;
    try {
      if (isBinary) throw new ProtocolError("binary messages are not supported");
      msg = parseClientMessage(data.toString());
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      c.socket.close(Close.PROTOCOL, e.message);
      return;
    }
    if (!c.claims) {
      if (msg.type !== "auth") {
        c.socket.close(Close.UNAUTHORIZED, "authenticate first");
        return;
      }
      try {
        c.claims = verifyToken(o.secret, msg.token);
      } catch (e) {
        if (!(e instanceof TokenError)) throw e;
        c.socket.close(Close.UNAUTHORIZED, e.message);
        return;
      }
      // The session ends when the token does: a connection cannot outlive its credentials.
      const left = c.claims.exp * 1000 - Date.now();
      if (left < 2 ** 31) c.expiry = setTimeout(() => c.socket.close(Close.UNAUTHORIZED, "token expired"), left);
      send(c, { type: "ready", user: c.claims.sub });
      return;
    }
    if (c.claims.exp * 1000 <= Date.now()) {
      c.socket.close(Close.UNAUTHORIZED, "token expired");
      return;
    }
    switch (msg.type) {
      case "auth":
        send(c, { type: "error", code: "already_authenticated", message: "already authenticated" });
        break;
      case "join":
        join(c, msg.doc);
        break;
      case "leave":
        leave(c, msg.doc);
        break;
      case "ops":
        edit(c, msg);
        break;
    }
  };

  wss.on("connection", (socket) => {
    const c: Connection = {
      socket,
      id: ++nextId,
      claims: null,
      rooms: new Map(),
      bucket: new TokenBucket(o.opsPerSecond, o.burst),
      alive: true,
    };
    connections.set(socket, c);
    stats.connections++;
    const authTimer = setTimeout(() => {
      if (!c.claims) socket.close(Close.UNAUTHORIZED, "no authentication in time");
    }, o.authTimeoutMs);
    socket.on("pong", () => {
      c.alive = true;
    });
    socket.on("message", (data, isBinary) => onMessage(c, data, isBinary));
    socket.on("close", () => {
      clearTimeout(authTimer);
      clearTimeout(c.expiry);
      for (const doc of [...c.rooms.keys()]) leave(c, doc);
      connections.delete(socket);
      stats.connections--;
    });
    socket.on("error", () => socket.terminate());
  });

  // Drop connections that stopped answering pings (half-open TCP, sleeping laptops).
  const heartbeat = setInterval(() => {
    for (const c of connections.values()) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, o.heartbeatMs);
  heartbeat.unref();

  await new Promise<void>((resolve) => http.listen(o.port, o.host, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    url: `ws://${o.host}:${port}`,
    stats,
    text: (doc) => rooms.get(doc)?.room.text,
    members: (doc) => rooms.get(doc)?.members.size ?? 0,
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
