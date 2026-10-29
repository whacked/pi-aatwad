# 03 — Protocol, APIs and lifecycle

## Pi extension integration
The agent and UI access this API only through the packaged Pi extension. Its `/team` commands and registered agent tools are a thin client; no direct database writes. The extension auto-connects/bootstraps the background controller and handles enrollment and reconnect.

## API surface (v1)
All mutations require `Idempotency-Key`, actor principal, and organization/run ID. Validate actor authorization separately from `from` in payload.

| Operation | Request -> result | Permission |
|---|---|---|
| `POST /runs` | explicit `/team init` + Pi session identity -> run/root IDs | authenticated local user |
| `GET /runs/:id/tree` | current roles, ancestry, sessions, tasks | operator/member scoped |
| `POST /messages` | typed message envelope -> message ID | member |
| `GET /inbox?agent_id=` | pending messages -> cursor | self/adapter |
| `POST /messages/:id/ack` | processed message -> acknowledged | recipient |
| `POST /tasks` | assign/delegate child task -> task ID | owner/manager |
| `POST /expansions` | proposal -> proposal ID | member |
| `POST /expansions/:id/decision` | approve/reject/amend/escalate -> decision/event | current manager |
| `POST /agents/:id/reparent` | new parent -> changed edge | authorized manager/operator |
| `POST /agents/:id/lifecycle` | pause/resume/retire/cancel -> status | manager/operator |
| `GET /events` | ordered cursor of durable audit events | scoped read |
| `GET /models` | eligible models/capability/cost catalog | member |
| `GET /budgets/:agent_id` | allocation + reservations + usage | self/ancestors |

## Agent tool facade
Expose to every Pi agent: `send_message`, `delegate_task`, `request_expansion`, `review_expansion` (only if authorized), `get_team`, `get_inbox`, `report_progress`, `complete_task`, `get_models`, `get_budget`. Tool descriptions must explicitly warn that proposals do not guarantee approval.

## Message types
`task.assigned`, `task.progress`, `task.completed`, `question`, `answer`, `team.expand.request`, `team.expand.decision`, `agent.lifecycle`, `system.notice`. Envelope IDs, correlation ID and causation ID are opaque strings. The recipient may be a direct parent, subordinate or controller; cross-team routing requires controller policy.

## State machines
- **Proposal:** DRAFT (optional client) -> PENDING -> UNDER_REVIEW -> APPROVED | REJECTED | ESCALATED. An escalated proposal routes to higher manager, can later be approved/rejected. `AMENDED` records a revision and returns to PENDING; never silently mutate historical request payload.
- **Agent:** PROVISIONING -> RUNNING <-> PAUSED -> COMPLETED | FAILED | CANCELLED | RETIRED. Restart creates new `session`, not new `agent`.
- **Session:** REQUESTED -> STARTING -> LIVE -> STOPPED | FAILED | LOST. `LOST` processes reconcile on controller startup.
- **Task:** OPEN -> ASSIGNED -> IN_PROGRESS -> DONE | BLOCKED | FAILED | CANCELLED.
- **Delivery:** PENDING -> CLAIMED -> ACKED; expired claims reset to PENDING, duplicates deduplicated by ID.

## Durable spawn (critical)
1. In one SQL transaction: validate decision and current reservations; create child agent with PROVISIONING; record `spawn_intent` with stable unique proposal/role/ordinal key; reserve slots/budget; insert outbox event; commit.
2. Outside transaction: adapter starts worker using intent ID as external correlation; persist session PID/session marker.
3. Mark live after handshake. If worker start fails, mark failed and release or retry per policy. Controller startup scans orphan intents and OS processes; never blindly starts another process when its prior launch status is uncertain.
4. Worker heartbeat with short lease; after repeated missed heartbeats mark LOST, attempt a controlled recovery; check PID and process identity before retry.

## Delivery and crash handling
- Never spawn on receiving the same approval twice: unique constraint on `(proposal_id, role_index, ordinal)` and idempotency table.
- Retries may duplicate messages; receiver records processed IDs before effects.
- Controller crash between spawn and session record requires external process identity lookup + reconciliation. Do not assume PID alone is globally unique; include boot/process start time or stable adapter marker.
- Persist model provider/model ID and resume context artifact. Cross-model resume loads summarized task state + relevant artifacts, not a provider-specific opaque conversation format.

## Authorization
Agent tool caller authenticates as agent ID via controller-issued short-lived local credential bound to run and permissions. Manager can review requests only within authorized subtree. Only operator can alter top-level global hard caps. Do not permit an agent's own prompt text to grant capabilities.
