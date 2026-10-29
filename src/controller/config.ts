// Run configuration defaults, envelopes, and deterministic model resolution.
import { isAbsolute } from "node:path";
import { DEFAULT_PROVIDER, LEADER_MODEL_ID, type Envelope_Limits, type ExpansionRole, type GlobalLimits, type ModelCatalogEntry, type RunConfig } from "../shared/protocol.ts";
import { fail } from "./errors.ts";

/** From recursive-agent-org-v1.2/examples/config.example.yaml */
export const DEFAULT_LIMITS: GlobalLimits = {
	max_live_agents: 12,
	max_pending_spawns: 8,
	emergency_max_depth: 12,
	max_run_usd: 25,
	max_run_seconds: 14400,
	max_agent_seconds: 3600,
	allow_providers: ["anthropic", "openrouter", "local"],
};

export { DEFAULT_PROVIDER, LEADER_MODEL_ID };

export function defaultRootEnvelope(l: GlobalLimits): Envelope_Limits {
	// Generous but strictly inside global caps (root itself occupies one live slot).
	const slots = Math.max(0, l.max_live_agents - 1);
	const usd = Math.round(l.max_run_usd * 0.8 * 100) / 100;
	return {
		max_subtree_slots: slots,
		max_subtree_usd: usd,
		max_session_seconds: l.max_agent_seconds,
		max_grant_slots: slots,
		max_grant_usd: usd,
		allowed_providers: [],
		allowed_capabilities: [],
	};
}

export interface RootSpec {
	role: string;
	cwd: string;
	provider?: string;
	model?: string;
}

export function buildRunConfig(partial: Partial<RunConfig> | undefined, root: RootSpec): RunConfig {
	const p = partial ?? {};
	const limits: GlobalLimits = { ...DEFAULT_LIMITS, ...(p.limits ?? {}) };
	const models: ModelCatalogEntry[] = (p.models ?? []).map(normalizeModel);
	const provider = root.provider ?? DEFAULT_PROVIDER;
	if (!models.some((m) => m.id === LEADER_MODEL_ID)) {
		models.push({
			id: LEADER_MODEL_ID,
			provider,
			model: root.model ?? DEFAULT_PROVIDER,
			capability_tags: ["reasoning", "coding", "tools", "general"],
			tool_support: true,
			cost_per_m_input_usd: null,
			cost_per_m_output_usd: null,
			availability: "available",
		});
	}
	// "same model as leader" must always be permitted.
	if (!limits.allow_providers.includes(provider)) limits.allow_providers = [...limits.allow_providers, provider];
	const root_envelope: Envelope_Limits = { ...defaultRootEnvelope(limits), ...(p.root_envelope ?? {}) };
	if (root_envelope.max_subtree_slots > limits.max_live_agents - 1) root_envelope.max_subtree_slots = limits.max_live_agents - 1;
	if (root_envelope.max_subtree_usd > limits.max_run_usd) root_envelope.max_subtree_usd = limits.max_run_usd;
	const workspace_root = p.workspace_root ?? root.cwd;
	if (!isAbsolute(workspace_root)) fail("INVALID", "workspace_root must be absolute");
	const deadline_policy = p.deadline_policy ?? "BLOCKED";
	if (deadline_policy !== "BLOCKED" && deadline_policy !== "FAILED") fail("INVALID", "deadline_policy must be BLOCKED or FAILED");
	const root_failure_policy = p.root_failure_policy ?? "continue";
	if (root_failure_policy !== "continue" && root_failure_policy !== "pause_subtree") fail("INVALID", "invalid root_failure_policy");
	for (const k of ["max_live_agents", "max_pending_spawns", "emergency_max_depth", "max_run_usd"] as const) {
		if (typeof limits[k] !== "number" || limits[k] < 0) fail("INVALID", `limits.${k} must be a non-negative number`);
	}
	return { limits, models, root_envelope, root_failure_policy, workspace_root, deadline_policy };
}

function normalizeModel(m: Partial<ModelCatalogEntry>): ModelCatalogEntry {
	if (!m || typeof m.id !== "string" || typeof m.provider !== "string" || typeof m.model !== "string") fail("INVALID", "model entries need id, provider, model");
	return {
		id: m.id,
		provider: m.provider,
		model: m.model,
		capability_tags: Array.isArray(m.capability_tags) ? m.capability_tags : [],
		tool_support: m.tool_support ?? true,
		context_window: m.context_window,
		cost_per_m_input_usd: m.cost_per_m_input_usd ?? null,
		cost_per_m_output_usd: m.cost_per_m_output_usd ?? null,
		latency_class: m.latency_class,
		availability: m.availability ?? "available",
	};
}

/** Envelope for a newly approved child. It holds no subtree capacity until a later approval grants it. */
export function childEnvelope(role: ExpansionRole, parent: Envelope_Limits, limits: GlobalLimits): Envelope_Limits {
	return {
		max_subtree_slots: 0,
		max_subtree_usd: 0,
		max_session_seconds: Math.min(role.max_runtime_seconds ?? limits.max_agent_seconds, limits.max_agent_seconds),
		max_grant_slots: 2,
		max_grant_usd: role.max_cost_usd,
		allowed_providers: [...parent.allowed_providers],
		allowed_capabilities: [...parent.allowed_capabilities],
	};
}

export function modelIneligibility(m: ModelCatalogEntry, cfg: RunConfig, chainProviders: string[][]): string | null {
	if (m.availability !== "available") return "unavailable";
	if (!m.tool_support) return "no tool support";
	if (!cfg.limits.allow_providers.includes(m.provider)) return `provider ${m.provider} not allowed by global policy`;
	for (const ap of chainProviders) if (ap.length && !ap.includes(m.provider)) return `provider ${m.provider} not allowed by delegated envelope`;
	return null;
}

export interface ModelChoice {
	entry: ModelCatalogEntry;
	reason: string;
	cost_estimated: boolean;
	candidates: string[];
}

/** Hard-filter then deterministic rank (preferred id first, then cheapest, then id). */
export function resolveModel(cfg: RunConfig, chainProviders: string[][], role: ExpansionRole): ModelChoice {
	const caps = role.capabilities ?? [];
	const eligible = cfg.models.filter((m) => modelIneligibility(m, cfg, chainProviders) === null && caps.every((c) => m.capability_tags.includes(c)));
	if (role.preferred_model_id) {
		const pref = cfg.models.find((m) => m.id === role.preferred_model_id);
		if (!pref) fail("INVALID", `preferred_model_id ${role.preferred_model_id} is not in the catalog`);
		if (!eligible.includes(pref)) {
			const why = modelIneligibility(pref, cfg, chainProviders) ?? `missing capabilities ${caps.filter((c) => !pref.capability_tags.includes(c)).join(",")}`;
			fail("INVALID", `preferred_model_id ${pref.id} is ineligible: ${why}`);
		}
		return { entry: pref, reason: "preferred_model_id eligible", cost_estimated: pref.cost_per_m_input_usd == null || pref.cost_per_m_output_usd == null, candidates: eligible.map((m) => m.id) };
	}
	if (!eligible.length) fail("INVALID", `no eligible model for role "${role.title}" (capabilities: ${caps.join(",") || "none"})`);
	const cost = (m: ModelCatalogEntry) => (m.cost_per_m_input_usd ?? 0) + (m.cost_per_m_output_usd ?? 0);
	const ranked = [...eligible].sort((a, b) => cost(a) - cost(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const e = ranked[0];
	return { entry: e, reason: "cheapest eligible (null cost treated as 0)", cost_estimated: e.cost_per_m_input_usd == null || e.cost_per_m_output_usd == null, candidates: ranked.map((m) => m.id) };
}
