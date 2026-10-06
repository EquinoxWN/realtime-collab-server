# ADR 0002: Vendor the CRDT engine instead of depending on it as a package

- **Status:** Accepted

## Context

The server needs the exact `Replica`, operation types and validation from crdt-collab-engine, so
that the server and its clients merge edits identically. That repo is not published to npm. The
options were a git dependency (`github:EquinoxWN/crdt-collab-engine`), publishing a package, or
copying the three source files. A git dependency needs a `prepare` build step in the other repo
and makes every install depend on GitHub being reachable; publishing a package is extra release
work for a portfolio project; and the server needs one small addition (`has(id)`) that the engine
does not offer yet.

## Decision

Copy `id.ts`, `ops.ts` and `replica.ts` into `src/crdt/` with a header naming the source commit
(`274744f`) and license, plus a README that lists the single change: a new `Replica.has(id)`
method, marked "Added for the server". The engine's own repo stays the source of truth and keeps
its property tests.

## Consequences

- Installs and CI need nothing beyond npm, and the server's tests run against exactly the code it
  ships.
- The copy can drift from upstream. The header and README make the base commit explicit, and
  `has(id)` is a candidate to upstream into crdt-collab-engine so the copy can become a dependency
  once that engine is published.
- Two places now hold the algorithm; a bug fix in the engine must be copied here too (the README
  says so).
