import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMessage, ProtocolError } from "../src/protocol.js";

test("valid messages parse", () => {
  assert.deepEqual(parseClientMessage('{"type":"auth","token":"t"}'), { type: "auth", token: "t" });
  assert.deepEqual(parseClientMessage('{"type":"join","doc":"plan-2026.v1"}'), { type: "join", doc: "plan-2026.v1" });
  assert.deepEqual(parseClientMessage('{"type":"ops","doc":"d","seq":3,"ops":[],"t":1.5}'), {
    type: "ops",
    doc: "d",
    seq: 3,
    ops: [],
    t: 1.5,
  });
});

test("malformed messages are rejected with a reason", () => {
  const cases: [string, RegExp][] = [
    ["not json", /JSON/],
    ["[1,2]", /object/],
    ["null", /object/],
    ['{"type":"shout"}', /unknown message type/],
    ['{"type":"auth"}', /token/],
    ['{"type":"join","doc":"../etc/passwd"}', /document id/],
    ['{"type":"join","doc":""}', /document id/],
    [`{"type":"join","doc":"${"a".repeat(65)}"}`, /document id/],
    ['{"type":"ops","doc":"d","seq":1.5,"ops":[]}', /seq/],
    ['{"type":"ops","doc":"d","seq":1,"ops":{}}', /array/],
  ];
  for (const [raw, reason] of cases) assert.throws(() => parseClientMessage(raw), (e: unknown) => e instanceof ProtocolError && reason.test(e.message), raw);
});
