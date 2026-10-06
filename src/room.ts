import { idKey } from "./crdt/id.js";
import { assertOp, type Op } from "./crdt/ops.js";
import { Replica } from "./crdt/replica.js";

/** Why an operation was refused; the text is safe to send to the client. */
export class RejectedOp extends Error {
  override name = "RejectedOp";
}

/**
 * The server's copy of one document: a CRDT replica plus the log of every operation that changed
 * it. A late joiner receives the log and replays it (compaction into snapshots is M2).
 */
export class Room {
  readonly doc: string;
  readonly replica: Replica;
  readonly log: Op[] = [];
  readonly #seen = new Set<string>();
  readonly #maxOps: number;

  constructor(doc: string, maxOps: number) {
    this.doc = doc;
    this.replica = new Replica("server");
    this.#maxOps = maxOps;
  }

  /**
   * Validate and apply a batch from one connection; returns only the operations that were new.
   * Inserts must carry the sender's own replica name, and every dependency must already exist
   * here, so a client cannot forge another user's edits or park operations on the server.
   */
  apply(ops: readonly unknown[], replicaName: string): Op[] {
    const fresh: Op[] = [];
    for (const op of ops) {
      try {
        assertOp(op);
      } catch (e) {
        throw new RejectedOp((e as Error).message);
      }
      if (op.type === "insert") {
        if (op.id.replica !== replicaName) throw new RejectedOp("insert ids must use your own replica name");
        if (op.origin !== null && !this.replica.has(op.origin)) throw new RejectedOp("insert refers to an unknown character");
      } else if (!this.replica.has(op.target)) {
        throw new RejectedOp("delete refers to an unknown character");
      }
      const key = op.type === "insert" ? `i:${idKey(op.id)}` : `d:${idKey(op.target)}`;
      if (this.#seen.has(key)) continue;
      if (this.log.length >= this.#maxOps) throw new RejectedOp("document has reached its operation limit");
      this.replica.apply(op);
      this.#seen.add(key);
      this.log.push(op);
      fresh.push(op);
    }
    return fresh;
  }

  /** The current text. */
  get text(): string {
    return this.replica.toString();
  }
}
