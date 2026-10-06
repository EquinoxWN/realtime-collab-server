# Vendored CRDT engine

`id.ts`, `ops.ts` and `replica.ts` are copied from
[crdt-collab-engine](https://github.com/EquinoxWN/crdt-collab-engine) at commit `274744f`
(same author, MIT License). The only change is a new `Replica.has(id)` method, which the server
uses to refuse operations whose dependencies it has not seen (marked `Added for the server`).

Why a copy instead of a package dependency: see
[ADR 0002](../../docs/adr/0002-vendor-the-crdt-engine.md).
