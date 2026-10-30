// Resolve user-facing names against Pi's authenticated registry, without exposing auth.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function availableModels(ctx: Pick<ExtensionContext, "modelRegistry">) {
	return ctx.modelRegistry.getAvailable().map((m) => ({
		id: `${m.provider}/${m.id}`, provider: m.provider, model: m.id, name: m.name,
		capability_tags: ["general", "coding", "tools", ...(m.reasoning ? ["reasoning"] : [])],
		tool_support: true,
		cost_per_m_input_usd: m.cost?.input ?? null,
		cost_per_m_output_usd: m.cost?.output ?? null,
	}));
}

export function resolveAvailableModel(ctx: Pick<ExtensionContext, "modelRegistry">, query: string) {
	const all = availableModels(ctx);
	const q = query.trim().toLowerCase();
	// A qualified ID wins over an unqualified ID or friendly name.
	const qualified = all.filter((m) => m.id.toLowerCase() === q);
	const matches = qualified.length ? qualified : all.filter((m) => m.model.toLowerCase() === q || m.name.toLowerCase() === q);
	if (matches.length === 1) {
		const { name: _name, ...entry } = matches[0];
		return entry;
	}
	if (matches.length > 1) throw new Error(`Ambiguous model '${query}'; ask the user to choose: ${matches.map((m) => m.id).join(", ")}`);
	const suggestions = all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 12);
	throw new Error(`Model '${query}' is not an exact authenticated Pi model. ${suggestions.length ? `Possible matches: ${suggestions.map((m) => m.id).join(", ")}. Ask the user to choose.` : "Use team_get_models with source=available, or configure/authenticate the model in Pi first."}`);
}
