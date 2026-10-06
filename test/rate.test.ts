import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenBucket } from "../src/rate.js";

test("the bucket allows a burst, then refills at the configured rate", () => {
  const bucket = new TokenBucket(10, 20, 0);
  assert.equal(bucket.take(20, 0), true);
  assert.equal(bucket.take(1, 0), false);
  assert.equal(bucket.take(5, 500), true, "half a second refills 5 tokens");
  assert.equal(bucket.take(1, 500), false);
  assert.equal(bucket.take(20, 10_000), true, "never more than the burst");
  assert.equal(bucket.take(1, 10_000), false);
});
