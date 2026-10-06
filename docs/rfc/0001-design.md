# RFC 0001: realtime-collab-server design

- **Status:** Accepted (M1 implemented)
- **Author:** EquinoxWN
- **Created:** 2026

## Problem

[crdt-collab-engine](https://github.com/EquinoxWN/crdt-collab-engine) can merge concurrent edits
from any number of replicas, but only if something carries the edits between them. A real
product needs a server that people connect to from browsers: it must know who each person is,
which documents they may open, deliver every edit to everyone else in the document quickly, and
hand a newcomer the current document. It must also survive hostile clients, because a WebSocket
endpoint is reachable by anyone: forged edits, malformed messages, floods and connections that
silently die must not corrupt documents or take the server down.

## Goals

- Clients connect over WebSocket, authenticate with a signed token, and join document rooms the
  token allows.
- Edits travel as small CRDT operations; the server validates each one against its own replica of
  the document, applies it, acknowledges it, and broadcasts it to the other members of the room.
- A late joiner receives the document's history and reaches exactly the same text.
- The server is authoritative about identity: a client can only create characters under the
  replica name the server assigned to it, and can only refer to characters the server has seen.
- Every resource a single connection can consume is bounded: message size, operations per
  message, operations per second, documents per connection, operations per document.
- Later: presence (M2), Valkey pub/sub fan-out across server nodes (M2), snapshots and version
  history in Postgres and S3 (M3), backpressure for slow clients and resync with state vectors (M3).

## Non-goals

- Rich text and formatting: the engine handles plain text in M1.
- Persistence: documents live in memory until M3 (history is replayed from an in-memory log).
- A browser editor UI: the repo provides the server and a Node.js client used by tests and the
  load script.

## Proposed design

![architecture](../architecture.png)

```
client                              server (one Node.js process)
  │ WebSocket connect ──────────────► origin check (browsers only)
  │ {auth, token}  ─────────────────► HS256 verify (alg pinned, constant-time compare, exp)   ◄ 5 s deadline
  │ ◄──────────────── {ready, user}
  │ {join, doc}   ──────────────────► token allows doc? ─► room: Replica("server") + op log
  │ ◄──── {joined, replica: "ada~7", ops: history}
  │ {ops, seq, [insert/delete...]} ─► size / count / rate limits ─► Room.apply:
  │                                       own replica name? dependencies known? new?
  │ ◄──────────────── {ack, seq}            └─► apply to replica, append to log
  │                                   broadcast {ops, from} to every other member
```

| Part | M1 implementation |
|---|---|
| Transport | Node.js `http` server plus `ws` 8.22; JSON text frames; 64 KiB `maxPayload` |
| Authentication | HS256 JWT sent as the first message (not in the URL, where it would end up in logs); `alg` pinned before the signature is checked; `timingSafeEqual`; expiry; claims `sub` and `docs` |
| Authorisation | `docs` lists the document ids a token may join, or `*`; joining anything else closes with 4003 |
| Rooms | One `Room` per document: the vendored CRDT `Replica` plus an append-only log of every operation that changed it; duplicates are dropped by key |
| Validation | `assertOp` shape check; inserts must use the connection's assigned replica name (`user~connection`); every origin or delete target must already exist on the server, so nothing waits in a pending buffer |
| Limits | 1,000 operations per message, token bucket per connection (2,000 ops/s, burst 5,000), 8 documents per connection, 500,000 operations per document; all configurable |
| Liveness | Ping every 30 s; a connection that missed the previous pong is terminated |
| Errors | Close codes 4001 unauthorised, 4003 forbidden, 4400 protocol violation, 4429 rate limited; rejected edits get an `error` with the batch `seq` and the connection stays open |
| Client | `CollabClient` / `DocHandle` for Node.js: local replica, promises that resolve on `ack` |

## Alternatives considered

| Option | Why not (yet) |
|---|---|
| uWebSockets.js (named in the original plan) | Faster, but distributed as a binary from GitHub rather than npm and harder to audit; `ws` is the standard, pure-JavaScript, well-audited choice. The transport is isolated in `server.ts` so it can be swapped when M3 load tests show it matters. |
| Yjs with y-websocket | Production-proven, but the point of this portfolio is to build on its own engine and show every step; Yjs also replaces the engine instead of extending it. |
| Token in the WebSocket URL query string | The usual shortcut because browsers cannot set headers on WebSocket, but URLs are written to proxy and server logs. The first-message token with a deadline avoids that. See ADR 0003. |
| Trust clients and relay operations without a server replica | Simpler and cheaper, but a client could forge other users' edits, reference characters that do not exist, or park unbounded pending operations. The server replica makes validation exact. |
| Snapshots instead of replaying the log to late joiners | Smaller joins for long documents; it needs a snapshot format and compaction, which M3 adds with version history. |
| Server-assigned sequence numbers (operational transformation) | OT needs a central transform step and is hard to get right; the CRDT already makes every delivery order safe. |

## Measurement plan

- M1: 29 tests, most of them real WebSocket clients against a server on a random local port:
  authentication, authorisation, origin check, convergence (including ten seeded random sessions
  with five users), late joiners, isolation, forged edits, protocol violations, oversized frames,
  flooding, limits and dead-connection detection. A local load script measures delivery latency
  with 10, 50 and 200 clients in one process.
- M2: presence and multi-node fan-out through Valkey, measured with clients split across nodes.
- M3: k6 with 10,000 concurrent sockets and edit latency p99; Playwright multi-browser tests.

## Milestones

- **M1 (done):** authenticated WebSocket rooms, server-validated CRDT edits with ack and broadcast,
  history for late joiners, abuse limits, Node.js client, 29 tests, local load numbers.
- **M2:** presence (cursors and selections, not stored), Valkey pub/sub across nodes.
- **M3:** snapshots and version history, backpressure for slow clients, resync with state vectors,
  k6 proof.

## Risks and open questions

- Everything is in memory: a restart loses documents until M3 persistence. The op log also grows
  with every edit (bounded per document) until compaction.
- Broadcast is O(members) per edit and the CRDT's position lookup is O(document length); the load
  run shows latency growing quickly past 50 clients in one process, which is what M2 (fan-out across
  nodes) and M3 (measurement) address.
- Tokens cannot be revoked before they expire; short lifetimes are the usual answer and belong to
  the auth service that issues them. The server closes a connection (4001) the moment its token
  expires, so a session never outlives its credentials, and caps the documents held in memory
  (`maxRooms`, default 10,000).
