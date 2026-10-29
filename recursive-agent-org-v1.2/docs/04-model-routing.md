# 04 — Model catalog and selection

## Registry
Catalog record: `id`, `provider`, `model`, `adapter`, `context_window`, `tool_support`, `cost_per_m_input/output`, `latency_class`, `capability_tags`, `allowed_workloads`, `availability`, `privacy_class`, `config_ref`. Secret API keys remain in local environment or secret store; never in SQLite messages or prompts.

## Recruitment contract
Requester specifies capability requirements, preferred provider/model (optional), hard constraints, task description, justification, estimated token budget, maximum cost, maximum runtime, and fallback model preferences. Parent can approve capability-tier request without binding a specific model; controller resolves model at spawn according to policy and availability. Record both requested and actual selection with reason.

## Hard vs soft constraints
Hard: authorized provider, required tool use/context, security classification, local/global budget, availability, workspace permission. Soft: estimated quality, latency, cost and prior evaluation results. Controller rejects unsupported configuration rather than silently selecting an ineligible model.

## MVP selection
Deterministic score/filter is sufficient. Filter hard requirements, then rank eligible models by user-set weights on cost, latency and capability; expose candidate list to recruiting agent for a justified recommendation. Avoid pretending to know model quality automatically. Seed model capability data explicitly in config. No learned router in v1.

## Transitions
Switching model creates new session under same logical agent. Ensure checkpoint artifact/summary, task linkage, model switch audit and reset of tool state. Never replay secrets or blindly inject full private previous-session transcripts into a less-trusted provider.
