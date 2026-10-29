# 02 — Component architecture

```text
Pi extension (root or worker): /team commands, tools, UI
        | auto-discovery/auto-start (local socket)
Controller service (typed API + auth + validation)
  |     |                |
  |     |                +-- model catalog / policy governor
  |     +-- lifecycle scheduler / reconciler
  +-- SQLite (transactions, projections, inbox/outbox, event log)
        |
   Pi executor adapter (one logical session -> one live process or SDK session)
        |
   provider model / tools / working directory
```

Extension is the product entry point; the background controller and Pi worker launcher ship in the same installable package. Parent Pi termination does not terminate managed descendants by default. See `docs/00-product-and-install.md` and `docs/07-pi-extension-contract.md`.

## Organization model
`agent` is a stable principal; `session` is an ephemeral executable instance with harness/model; `role` is a changeable role assignment; `task` is deliverable work; `reporting_edges` is a temporal manager/subordinate relation. Agents may do work and supervise simultaneously. A reporting graph is a tree **per organization/run at any instant**, but historical relations are preserved. Tasks form a separate DAG (v1 restricts task ownership to one agent and parent task to one edge).

## Authoritative boundaries
Controller is the sole writer to organizational tables. Adapters exchange requests/events; never write SQLite directly. The database stores full message payloads and small artifacts metadata; filesystem/Git stores code and large artifacts with checksums and paths. Relative file paths always scoped to registered workspaces. Pi session transcripts may live in the Pi standard location but must have indexed references and durable checkpoints/summary context in controller metadata.

## Transport
v1 local HTTP over a per-user Unix domain socket (or Windows-equivalent scoped local IPC); no direct in-process API as the sole controller, because workers must survive TUI exit plus SQLite-backed outbox polling; JSON payloads conform to versioned schemas. Agent-facing tools call the controller through a narrow capability-based client; worker sessions never receive direct database credentials. Do not promise exactly-once network delivery: **at-least-once delivery plus idempotent processing**.

## Expansion review
1. Requester submits proposal tied to task and requested role(s), estimated costs, max slots, reason, alternatives.
2. Controller checks schema, permissions and parent edge; records PENDING proposal.
3. Parent inspects scope and makes APPROVE / REJECT / AMEND / ESCALATE decision.
4. If proposal exceeds parent delegated authority, parent can endorse and escalate to their parent; final authority cannot exceed root's envelope.
5. Controller performs atomic constraint checks and reservation, transitions proposal to APPROVED, queues spawn intent.
6. Reconciler spawns child, commits session state, marks active. Failure moves intent to retry or terminal error, never creates an untracked child.

## Authority scope
Every agent has a delegated envelope: allowed models/providers/tools; maximum aggregate active descendants (or subtree slots), token/currency reservation limits, max single-session time, and maximum allowed grant to descendants. Envelopes are ceilings; reservations at every ancestor prevent two sibling proposals racing for the same pooled capacity. Track active reservations and cumulative consumption separately. Expansion beyond authority is escalated; policy hard caps cannot be overridden by any LLM.

## Organizational changes
Reparent operations must be controller transactions: validate no cycles, close old edge, open new edge, transfer reservations if both scopes authorize, or reject. Use role changes rather than killing a manager to make it an individual contributor. Retiring a manager requires explicitly reassigning or terminating descendants. Subtree termination walks descendants then releases reservations safely.

## Concurrency
SQLite WAL, busy_timeout, single controller writer queue initially. The controller serializes relevant organizational mutations in `BEGIN IMMEDIATE` transactions. Lock order is global by sorted agent IDs if introducing finer-grained locks. Do not hold SQL transactions open while waiting for model or process calls.

**Normative supplement:** `08-recovery-topology-and-context.md` defines crash/recovery, reassignment, fenced sessions, and topology versions. Implement its stronger invariants wherever this document is abbreviated.
