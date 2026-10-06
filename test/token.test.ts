import assert from "node:assert/strict";
import { test } from "node:test";
import { signToken, TokenError, verifyToken } from "../src/token.js";

const secret = "s".repeat(32);
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

test("a signed token verifies and returns its claims", () => {
  const claims = verifyToken(secret, signToken(secret, { sub: "ada", docs: ["plan"] }, 60));
  assert.equal(claims.sub, "ada");
  assert.deepEqual(claims.docs, ["plan"]);
});

test("expired, tampered and foreign tokens are rejected", () => {
  const now = Date.now();
  const expired = signToken(secret, { sub: "ada", docs: ["*"] }, 10, now - 20_000);
  assert.throws(() => verifyToken(secret, expired, now), /expired/);
  const [h, , s] = signToken(secret, { sub: "ada", docs: ["plan"] }, 60).split(".");
  const tampered = `${h}.${b64({ sub: "ada", docs: ["*"], exp: 9_999_999_999 })}.${s}`;
  assert.throws(() => verifyToken(secret, tampered), /bad signature/);
  assert.throws(() => verifyToken("x".repeat(32), signToken(secret, { sub: "ada", docs: [] }, 60)), /bad signature/);
});

test('the "alg": "none" downgrade is refused', () => {
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "ada", docs: ["*"], exp: 9_999_999_999 })}.`;
  assert.throws(() => verifyToken(secret, unsigned), /algorithm/);
});

test("malformed input and bad claims are rejected with a TokenError", () => {
  for (const bad of [undefined, 42, "", "a.b", "a.b.c.d", "x".repeat(5000), "!!!.???.###"]) {
    assert.throws(() => verifyToken(secret, bad), TokenError, String(bad).slice(0, 20));
  }
  const badUser = signToken(secret, { sub: "ada lovelace", docs: ["*"] }, 60);
  assert.throws(() => verifyToken(secret, badUser), /invalid claims/);
});
