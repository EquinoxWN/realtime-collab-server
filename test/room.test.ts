import assert from "node:assert/strict";
import { test } from "node:test";
import { Replica } from "../src/crdt/replica.js";
import { RejectedOp, Room } from "../src/room.js";

test("a client's edits apply and are logged once", () => {
  const room = new Room("d", 100);
  const alice = new Replica("alice~1");
  const ops = alice.insert(0, "hi");
  assert.equal(room.apply(ops, "alice~1").length, 2);
  assert.equal(room.apply(ops, "alice~1").length, 0, "duplicates are ignored");
  assert.equal(room.text, "hi");
  assert.equal(room.log.length, 2);
});

test("inserts under someone else's replica name are refused", () => {
  const room = new Room("d", 100);
  const forged = new Replica("bob~2").insert(0, "x");
  assert.throws(() => room.apply(forged, "alice~1"), (e: unknown) => e instanceof RejectedOp && /own replica/.test(e.message));
  assert.equal(room.text, "");
});

test("operations on characters the server has not seen are refused", () => {
  const room = new Room("d", 100);
  const other = new Replica("alice~1");
  const [first] = other.insert(0, "a");
  const [second] = other.insert(1, "b");
  assert.throws(() => room.apply([second], "alice~1"), /unknown character/);
  room.apply([first], "alice~1");
  assert.throws(() => room.apply([{ type: "delete", target: { replica: "x~9", counter: 1 } }], "alice~1"), /unknown character/);
  assert.equal(room.replica.pendingCount, 0, "nothing is parked waiting on the server");
});

test("malformed operations and the per-document limit are enforced", () => {
  const room = new Room("d", 3);
  assert.throws(() => room.apply([{ type: "insert", id: { replica: "a~1", counter: 0 }, origin: null, value: "x" }], "a~1"), RejectedOp);
  assert.throws(() => room.apply([{ type: "insert", id: { replica: "a~1", counter: 1 }, origin: null, value: "xy" }], "a~1"), RejectedOp);
  const a = new Replica("a~1");
  room.apply(a.insert(0, "abc"), "a~1");
  assert.throws(() => room.apply(a.insert(3, "d"), "a~1"), /operation limit/);
});
