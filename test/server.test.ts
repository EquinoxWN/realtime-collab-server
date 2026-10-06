import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { CollabClient, EditRejected } from "../src/client.js";
import { Close } from "../src/protocol.js";
import type { CollabServer } from "../src/server.js";
import { signToken } from "../src/token.js";
import { connect, eventually, server, SECRET, sleep, token } from "./helpers.js";

/** Connect expecting the server to close; returns the close code and reason. */
async function rejected(s: CollabServer, tok: string): Promise<{ code: number; reason: string }> {
  try {
    await CollabClient.connect(s.url, tok);
  } catch (e) {
    const { code, reason } = e as { code: number; reason: string };
    return { code, reason };
  }
  throw new Error("connection was accepted");
}

describe("authentication and access", () => {
  let s: CollabServer;
  before(async () => {
    s = await server({ authTimeoutMs: 150, allowedOrigins: ["https://editor.example"] });
  });
  after(() => s.close());

  test("a valid token is accepted", async () => {
    const c = await connect(s, "ada");
    assert.equal(c.user, "ada");
    await c.close();
  });

  test("a forged or expired token closes the connection with 4001", async () => {
    assert.deepEqual(await rejected(s, signToken("wrong-secret-wrong-secret-wrong!!", { sub: "ada", docs: ["*"] }, 60)), {
      code: Close.UNAUTHORIZED,
      reason: "bad signature",
    });
    const expired = signToken(SECRET, { sub: "ada", docs: ["*"] }, 1, Date.now() - 10_000);
    assert.equal((await rejected(s, expired)).reason, "token expired");
  });

  test("no authentication in time, or another message first, closes with 4001", async () => {
    const silent = new WebSocket(s.url);
    const [code, reason] = (await new Promise((r) => silent.once("close", (...a) => r(a)))) as [number, Buffer];
    assert.equal(code, Close.UNAUTHORIZED);
    assert.equal(reason.toString(), "no authentication in time");
    const eager = new WebSocket(s.url);
    eager.once("open", () => eager.send(JSON.stringify({ type: "join", doc: "plan" })));
    const code2 = await new Promise<number>((r) => eager.once("close", (code) => r(code)));
    assert.equal(code2, Close.UNAUTHORIZED);
  });

  test("joining a document the token does not allow closes with 4003", async () => {
    const c = await connect(s, "ada", ["plan"]);
    await c.join("plan");
    await assert.rejects(c.join("payroll"), (e: { code?: number }) => e.code === Close.FORBIDDEN);
  });

  test("browsers from other origins are refused at the handshake", async () => {
    await assert.rejects(CollabClient.connect(s.url, token("ada"), { origin: "https://evil.example" }), /401/);
    const ok = await CollabClient.connect(s.url, token("ada"), { origin: "https://editor.example" });
    await ok.close();
  });
});

describe("collaborative editing", () => {
  let s: CollabServer;
  before(async () => {
    s = await server();
  });
  after(() => s.close());

  test("edits are acknowledged, broadcast to others and not echoed to the sender", async () => {
    const a = await connect(s, "alice");
    const b = await connect(s, "bob");
    const da = await a.join("echo");
    const db = await b.join("echo");
    let echoes = 0;
    da.onChange(() => echoes++);
    await da.insert(0, "hello");
    await db.waitFor((t) => t === "hello");
    await sleep(50);
    assert.equal(echoes, 0, "the sender never receives its own edit back");
    assert.equal(s.text("echo"), "hello");
    await Promise.all([a.close(), b.close()]);
  });

  test("concurrent edits converge on every client and the server", async () => {
    const [a, b] = await Promise.all([connect(s, "alice"), connect(s, "bob")]);
    const [da, db] = await Promise.all([a.join("race"), b.join("race")]);
    await Promise.all([da.insert(0, "AAA"), db.insert(0, "BBB")]);
    const expected = s.text("race") as string;
    await Promise.all([da.waitFor((t) => t === expected), db.waitFor((t) => t === expected)]);
    assert.equal(expected.length, 6);
    assert.match(expected, /^(AAABBB|BBBAAA)$/, "each user's typing stays together");
    await Promise.all([a.close(), b.close()]);
  });

  test("a late joiner receives the history and sees the same text", async () => {
    const a = await connect(s, "alice");
    const da = await a.join("history");
    await da.insert(0, "draft one");
    await da.delete(0, 6);
    await da.insert(3, " two");
    const late = await connect(s, "carol");
    const dl = await late.join("history");
    assert.equal(dl.text, s.text("history"));
    assert.equal(dl.text, "one two");
    await Promise.all([a.close(), late.close()]);
  });

  test("rooms are isolated from each other", async () => {
    const a = await connect(s, "alice");
    const b = await connect(s, "bob");
    const da = await a.join("room-a");
    const db = await b.join("room-b");
    await da.insert(0, "secret");
    await sleep(50);
    assert.equal(db.text, "");
    assert.equal(s.text("room-b"), "");
    await Promise.all([a.close(), b.close()]);
  });

  test("random concurrent editing by five users always converges", async () => {
    for (let seed = 1; seed <= 10; seed++) {
      let state = seed;
      const random = (): number => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
      const doc = `random-${seed}`;
      const clients = await Promise.all(Array.from({ length: 5 }, (_, i) => connect(s, `u${i}`)));
      const docs = await Promise.all(clients.map((c) => c.join(doc)));
      await Promise.all(
        docs.map(async (d) => {
          for (let step = 0; step < 20; step++) {
            if (d.text.length > 0 && random() < 0.3) {
              const i = Math.floor(random() * d.text.length);
              await d.delete(i, 1);
            } else {
              await d.insert(Math.floor(random() * (d.text.length + 1)), String.fromCharCode(97 + Math.floor(random() * 26)));
            }
            if (random() < 0.3) await sleep(1);
          }
        }),
      );
      const expected = s.text(doc) as string;
      await Promise.all(docs.map((d) => d.waitFor((t) => t === expected)));
      await Promise.all(clients.map((c) => c.close()));
    }
  });

  test("leaving a room or disconnecting stops delivery and frees the seat", async () => {
    const a = await connect(s, "alice");
    const b = await connect(s, "bob");
    const da = await a.join("seats");
    await b.join("seats");
    assert.equal(s.members("seats"), 2);
    b.leave("seats");
    await eventually(() => s.members("seats") === 1);
    await da.insert(0, "x");
    await b.close();
    await a.close();
    await eventually(() => s.members("seats") === 0 && s.stats.connections === 0);
  });
});

describe("abuse and malformed input", () => {
  let s: CollabServer;
  before(async () => {
    s = await server({ maxOpsPerMessage: 50, opsPerSecond: 20, burst: 40, maxPayloadBytes: 8 * 1024, maxDocsPerConnection: 2, maxOpsPerDoc: 30 });
  });
  after(() => s.close());

  test("forged edits are rejected, the document is unchanged and the connection stays open", async () => {
    const a = await connect(s, "alice");
    const da = await a.join("forge");
    await da.insert(0, "ok");
    const forged = [{ type: "insert", id: { replica: "bob~999", counter: 50 }, origin: null, value: "!" }];
    await assert.rejects(da.sendRaw(forged), (e: unknown) => e instanceof EditRejected && /own replica/.test(e.message));
    assert.equal(s.text("forge"), "ok");
    await da.insert(2, "!");
    assert.equal(s.text("forge"), "ok!", "the connection still works");
    await a.close();
  });

  test("protocol violations close the connection with 4400", async () => {
    for (const bad of ["{oops", JSON.stringify({ type: "dance" }), Buffer.from([1, 2, 3])]) {
      const c = await connect(s, "mallory");
      c.sendRaw(bad);
      assert.equal((await c.closed).code, Close.PROTOCOL);
    }
    const c = await connect(s, "mallory");
    await c.join("big");
    c.sendJson({ type: "ops", doc: "big", seq: 1, ops: Array.from({ length: 51 }, () => ({})) });
    assert.deepEqual(await c.closed, { code: Close.PROTOCOL, reason: "at most 50 operations per message" });
  });

  test("oversized frames are cut off by the WebSocket layer (1009)", async () => {
    const c = await connect(s, "mallory");
    c.sendRaw("x".repeat(9 * 1024));
    assert.equal((await c.closed).code, 1009);
  });

  test("flooding edits closes the connection with 4429", async () => {
    const c = await connect(s, "mallory");
    const d = await c.join("flood");
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) sends.push(d.insert(0, "zz").catch(() => undefined));
    assert.equal((await c.closed).code, Close.RATE_LIMITED);
    await Promise.all(sends);
  });

  test("per-connection document limit and per-document operation limit", async () => {
    const c = await connect(s, "alice");
    await c.join("one");
    await c.join("two");
    c.sendJson({ type: "join", doc: "three" });
    await eventually(() => c.errors.some((e) => e.code === "too_many_docs"));
    const d = await connect(s, "bob").then((b) => b.join("full"));
    await d.insert(0, "a".repeat(30));
    await assert.rejects(d.insert(0, "b"), /operation limit/);
    await c.close();
  });

  test("editing a document that was not joined is reported", async () => {
    const c = await connect(s, "alice");
    c.sendJson({ type: "ops", doc: "nowhere", seq: 1, ops: [] });
    await eventually(() => c.errors.some((e) => e.code === "not_joined"));
    await c.close();
  });
});

test("a connection is closed with 4001 when its token expires", async () => {
  const s = await server();
  const c = await CollabClient.connect(s.url, signToken(SECRET, { sub: "ada", docs: ["*"] }, 1));
  const info = await c.closed;
  assert.deepEqual([info.code, info.reason], [Close.UNAUTHORIZED, "token expired"]);
  await s.close();
});

test("the server refuses to open more documents than maxRooms, but existing ones stay open", async () => {
  const s = await server({ maxRooms: 2 });
  const c = await connect(s, "ada");
  await c.join("one");
  await c.join("two");
  c.sendJson({ type: "join", doc: "three" });
  await eventually(() => c.errors.some((e) => e.code === "too_many_rooms"));
  const b = await connect(s, "bob");
  await b.join("one");
  assert.equal(s.members("one"), 2);
  await c.close();
  await b.close();
  await s.close();
});

test("connections that stop answering pings are dropped", async () => {
  const s = await server({ heartbeatMs: 50 });
  const quiet = await CollabClient.connect(s.url, token("sleepy"), { autoPong: false });
  const info = await quiet.closed;
  assert.equal(info.code, 1006, "terminated without a close frame");
  await eventually(() => s.stats.connections === 0);
  await s.close();
});
