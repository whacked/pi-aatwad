# Pi extension specific acceptance tests

- [ ] Developer-created package installs through `pi install ./path/to/package`, loads in ordinary Pi and adds `/team` commands and tools.
- [ ] User does not need to install/start a separate daemon manually; extension bootstraps single controller safely.
- [ ] Controller is not started multiple times by simultaneous Pi sessions or `/reload`.
- [ ] Plain Pi remains unenrolled until `/team init`; no accidental organization creation.
- [ ] Child Pi loads same extension, auto-enrolls using bounded one-time credentials, and can itself request recruits.
- [ ] Child cannot self-upgrade authority or impersonate another agent by modifying `agent_id` arguments.
- [ ] Parent Pi TUI exits while child continues; reopening Pi can inspect and resume existing run.
- [ ] Controller crash and restart preserves org and reconciles workers without duplicate spawn.
- [ ] Expired, reused, or mismatched enrollment credential is rejected.
- [ ] Extension reconnects after controller restart, handles incompatible protocol versions gracefully.
- [ ] Running without tmux retains full task/delegation functionality.
- [ ] `pi remove`/uninstall does not silently delete user data; docs describe stop, cleanup and purge.
- [ ] On-shell agent bypass of resource governance is documented as a limitation, not claimed prevented.
