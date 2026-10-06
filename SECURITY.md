# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security > Report a vulnerability** on this repository
(`https://github.com/EquinoxWN/realtime-collab-server/security/advisories/new`). Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You will get an answer
within 7 days. Fixes are released as soon as they are ready, and you are credited unless you ask
not to be.

## Supported versions

This project is pre-1.0. Only the latest commit on `main` receives fixes.

## Scope

- **In scope:** Authentication bypass, joining documents a token does not allow, forging another user's edits, crashing the server or growing its memory without limit from one connection, and token handling.
- **Out of scope:** Load from many legitimate connections (capacity planning is M3), and the CRDT algorithm itself (report those to crdt-collab-engine).

## How this repository protects itself

- Every GitHub Action is pinned to a full commit SHA, and workflows run with read-only
  permissions and without persisted credentials.
- Dependabot proposes dependency and action updates weekly as reviewable pull requests.
- CI runs lint, tests and a known-vulnerability check (npm audit) on every push and pull request.
