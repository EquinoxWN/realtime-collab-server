# ADR 0003: Authenticate with the first message, and make the server authoritative for identity

- **Status:** Accepted

## Context

Browsers cannot set an `Authorization` header on a WebSocket handshake. The common workarounds
put the token in the URL (which then appears in proxy and access logs) or in a cookie (which
brings cross-site WebSocket hijacking concerns). Separately, CRDT operations carry their own
author: an insert's id contains a replica name. A server that simply relays operations lets any
client create characters under another user's name.

## Decision

- The client's first message must be `{"type": "auth", "token": ...}`; until it arrives, every
  other message closes the connection with 4001, and so does silence after 5 seconds. The token
  is an HS256 JWT whose algorithm is pinned before the signature is checked, compared in constant
  time, with an expiry. Browser connections must also come from an allowed origin.
- On join, the server assigns the replica name `user~connection`. Inserts with any other replica
  name are rejected, and every operation must refer only to characters the server already has.

## Consequences

- Tokens never appear in URLs; a connection holds no resources beyond the socket until it has
  authenticated, and the deadline closes idle sockets.
- Edits in a document can be attributed to the authenticated user from the replica name alone,
  which version history (M3) will use.
- The server must keep a replica of every open document (memory proportional to the documents),
  and every operation costs a validation step; the load numbers in `docs/results/m1.md` include it.
