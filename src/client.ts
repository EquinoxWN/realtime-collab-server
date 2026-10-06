import WebSocket from "ws";
import type { Op } from "./crdt/ops.js";
import { Replica } from "./crdt/replica.js";
import type { ServerMessage } from "./protocol.js";

/** How the server closed the connection. */
export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

/** Rejected by the server for one batch of edits. */
export class EditRejected extends Error {
  override name = "EditRejected";
}

/** Milliseconds since the Unix epoch with sub-millisecond precision, comparable across processes. */
export const nowMs = (): number => performance.timeOrigin + performance.now();

/** One joined document: a local replica kept in sync with the server. */
export class DocHandle {
  readonly doc: string;
  readonly replica: Replica;
  readonly #client: CollabClient;
  #seq = 0;
  readonly #acks = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  readonly #listeners = new Set<() => void>();
  /** Delivery delays (ms) of remote edits, measured from the sender's clock. */
  readonly latencies: number[] = [];

  constructor(client: CollabClient, doc: string, replica: string, snapshot: readonly Op[]) {
    this.#client = client;
    this.doc = doc;
    this.replica = new Replica(replica);
    for (const op of snapshot) this.replica.apply(op);
  }

  /** Current local text. */
  get text(): string {
    return this.replica.toString();
  }

  /** Insert locally and send; resolves when the server has accepted the edit. */
  insert(index: number, text: string): Promise<void> {
    return this.#send(this.replica.insert(index, text));
  }

  /** Delete locally and send; resolves when the server has accepted the edit. */
  delete(index: number, count: number): Promise<void> {
    return this.#send(this.replica.delete(index, count));
  }

  /** Send raw operations (tests use this to try forged or malformed edits). */
  sendRaw(ops: readonly unknown[]): Promise<void> {
    return this.#send(ops as readonly Op[]);
  }

  #send(ops: readonly Op[]): Promise<void> {
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#acks.set(seq, { resolve, reject });
      this.#client.sendJson({ type: "ops", doc: this.doc, seq, ops, t: nowMs() });
    });
  }

  /** Call listener after every remote change. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolve once predicate holds for the text, or reject after timeoutMs. */
  waitFor(predicate: (text: string) => boolean, timeoutMs = 5_000): Promise<void> {
    if (predicate(this.text)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting; text is ${JSON.stringify(this.text)}`));
      }, timeoutMs);
      const off = this.onChange(() => {
        if (predicate(this.text)) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  /** Internal: a message for this document arrived. */
  receive(msg: ServerMessage): void {
    if (msg.type === "ops") {
      for (const op of msg.ops) this.replica.apply(op);
      if (msg.t !== undefined) this.latencies.push(nowMs() - msg.t);
      for (const l of this.#listeners) l();
    } else if (msg.type === "ack") {
      this.#acks.get(msg.seq)?.resolve();
      this.#acks.delete(msg.seq);
    } else if (msg.type === "error" && msg.seq !== undefined) {
      this.#acks.get(msg.seq)?.reject(new EditRejected(msg.message));
      this.#acks.delete(msg.seq);
    }
  }

  /** Internal: the connection closed; fail every pending edit. */
  fail(reason: string): void {
    for (const { reject } of this.#acks.values()) reject(new Error(reason));
    this.#acks.clear();
  }
}

/** A connection to the collaboration server (used by tests, the load script and Node clients). */
export class CollabClient {
  readonly user: string;
  readonly closed: Promise<CloseInfo>;
  /** Non-fatal errors the server reported (codes such as "not_joined"). */
  readonly errors: { code: string; message: string }[] = [];
  readonly #socket: WebSocket;
  readonly #docs = new Map<string, DocHandle>();
  readonly #joining = new Map<string, (handle: DocHandle) => void>();

  private constructor(socket: WebSocket, user: string, closed: Promise<CloseInfo>) {
    this.#socket = socket;
    this.user = user;
    this.closed = closed;
    socket.on("message", (data) => this.#onMessage(JSON.parse(data.toString()) as ServerMessage));
    void closed.then(({ reason }) => {
      for (const d of this.#docs.values()) d.fail(reason || "connection closed");
    });
  }

  /** Connect and authenticate; rejects with the close code and reason if the server refuses. */
  static connect(url: string, token: string, options: { origin?: string; autoPong?: boolean } = {}): Promise<CollabClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        autoPong: options.autoPong ?? true,
      });
      const closed = new Promise<CloseInfo>((res) => socket.once("close", (code, reason) => res({ code, reason: reason.toString() })));
      socket.once("error", reject);
      socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token })));
      socket.once("message", (data) => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (msg.type === "ready") resolve(new CollabClient(socket, msg.user, closed));
        else reject(new Error(`unexpected first message ${msg.type}`));
      });
      void closed.then((info) => reject(Object.assign(new Error(`closed ${info.code}: ${info.reason}`), info)));
    });
  }

  /** Join a document and replay its history into a local replica. */
  join(doc: string): Promise<DocHandle> {
    return new Promise((resolve, reject) => {
      this.#joining.set(doc, resolve);
      void this.closed.then((info) => reject(Object.assign(new Error(`closed ${info.code}: ${info.reason}`), info)));
      this.sendJson({ type: "join", doc });
    });
  }

  /** Stop receiving edits for a document. */
  leave(doc: string): void {
    this.#docs.delete(doc);
    this.sendJson({ type: "leave", doc });
  }

  /** Internal: send one message. */
  sendJson(msg: unknown): void {
    this.#socket.send(JSON.stringify(msg));
  }

  /** Send arbitrary text or bytes (tests use this for malformed messages). */
  sendRaw(data: string | Buffer): void {
    this.#socket.send(data);
  }

  /** Close the connection and wait until it is closed. */
  async close(): Promise<CloseInfo> {
    this.#socket.close();
    return this.closed;
  }

  #onMessage(msg: ServerMessage): void {
    if (msg.type === "joined") {
      const handle = new DocHandle(this, msg.doc, msg.replica, msg.ops);
      this.#docs.set(msg.doc, handle);
      this.#joining.get(msg.doc)?.(handle);
      this.#joining.delete(msg.doc);
      return;
    }
    if (msg.type === "error") this.errors.push({ code: msg.code, message: msg.message });
    if ("doc" in msg && msg.doc !== undefined) this.#docs.get(msg.doc)?.receive(msg);
  }
}
