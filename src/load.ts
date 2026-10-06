// Local load run: N clients edit one document at once; prints convergence and delivery latency.
import { CollabClient } from "./client.js";
import { startServer } from "./server.js";
import { signToken } from "./token.js";

const clients = Number(process.argv[2] ?? 200);
const editsPerClient = Number(process.argv[3] ?? 20);
const secret = "load-test-secret-that-is-long-enough";

/** Percentile of a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

const server = await startServer({ secret, opsPerSecond: 100_000, burst: 100_000 });
const started = performance.now();
const connected = await Promise.all(
  Array.from({ length: clients }, (_, i) =>
    CollabClient.connect(server.url, signToken(secret, { sub: `user${i}`, docs: ["load"] }, 300)),
  ),
);
const handles = await Promise.all(connected.map((c) => c.join("load")));
const connectMs = performance.now() - started;

const editStart = performance.now();
await Promise.all(
  handles.map(async (h, i) => {
    for (let e = 0; e < editsPerClient; e++) {
      const index = Math.floor(Math.random() * (h.text.length + 1));
      await h.insert(index, String.fromCharCode(97 + ((i + e) % 26)));
      await new Promise((r) => setTimeout(r, Math.random() * 10));
    }
  }),
);
const finalText = server.text("load") ?? "";
await Promise.all(handles.map((h) => h.waitFor((t) => t === finalText, 30_000)));
const editMs = performance.now() - editStart;
const latencies = handles.flatMap((h) => h.latencies).sort((a, b) => a - b);

console.log(`| Local load run (one Node.js process, ${clients} clients x ${editsPerClient} edits) | Result |`);
console.log("|---|---|");
console.log(`| Connect, authenticate and join | ${connectMs.toFixed(0)} ms |`);
console.log(`| Edits applied by the server | ${server.stats.opsApplied} |`);
console.log(`| Edit deliveries to other clients | ${latencies.length} |`);
console.log(`| All ${clients} replicas equal to the server's text (${finalText.length} chars) | ${handles.every((h) => h.text === finalText) ? "yes" : "NO"} |`);
console.log(`| Delivery latency p50 / p95 / p99 | ${percentile(latencies, 50).toFixed(1)} / ${percentile(latencies, 95).toFixed(1)} / ${percentile(latencies, 99).toFixed(1)} ms |`);
console.log(`| Wall time for all edits to converge | ${editMs.toFixed(0)} ms |`);
await Promise.all(connected.map((c) => c.close()));
await server.close();
