# Handoff revision notes

## v1.1 — Pi extension-first product
- Prior proposal treated Pi as an execution adapter under an external CLI/controller.
- Now **the deliverable is one installable Pi package** whose extension gives normal Pi sessions recursive team commands/tools.
- Controller is bundled, automatically started and a local singleton; it survives UI exit and governs shared resources.
- Children use same extension and one-time enrollment; every agent may supervise with policy-enforced authority.
- Build order changed to verify package install/bootstrap before implementing team logic.
- Added `docs/00-product-and-install.md`, `docs/07-pi-extension-contract.md`, extension tests, manifest shape example.
- Existing SQL and message schemas intentionally retained: governance/state protocol unchanged.

## v1.2 — Recovery and dynamic topology
- Added normative `docs/08-recovery-topology-and-context.md`.
- Added SQLite migration `db/002_runtime_and_topology.sql` for desired/observed state, root identity, topology version, session checkpoints, process fencing and move audit.
- Made manager/root/controller crash recovery, subtree reparent, fork semantics and context reassembly mandatory acceptance gates.
