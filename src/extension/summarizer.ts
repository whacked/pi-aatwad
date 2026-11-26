// Team summaries are opt-in per project. This module picks a suitable model from the ones Pi can
// use, walks the human through enabling or declining, and says on every session start which model
// summarizes (or that summaries were declined), so the setting is never invisible.
import type { ProjectSettings, SummarizerSetting } from "../shared/protocol.ts";
import type { TeamRuntime } from "./runtime.ts";
import { availableModels } from "./models.ts";

type Model = ReturnType<typeof availableModels>[number];

/** Names that usually mean a small, fast model: enough for summaries, cheap to run. */
const SMALL = /(mini|haiku|flash|lite|small|nano|tiny|instant|(^|[^0-9.])([1-9]|1[0-4])b\b)/i;
const price = (m: Model) => (m.cost_per_m_input_usd ?? Number.POSITIVE_INFINITY) + 4 * (m.cost_per_m_output_usd ?? Number.POSITIVE_INFINITY);

/**
 * A model of suitable size for summaries: a small model if one is available, cheapest first;
 * otherwise the cheapest model with a known price. Summaries need no tools or deep reasoning.
 */
export function suggestSummarizer(models: Model[]): { model: Model; reason: string } | undefined {
	if (!models.length) return undefined;
	const byPrice = [...models].sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id));
	const small = byPrice.filter((m) => SMALL.test(m.model) || SMALL.test(m.name));
	if (small.length) return { model: small[0], reason: `a small model${priceText(small[0])}` };
	const known = byPrice.filter((m) => Number.isFinite(price(m)));
	if (known.length) return { model: known[0], reason: `the cheapest available model${priceText(known[0])}` };
	return { model: byPrice[0], reason: "the only kind available (no prices known)" };
}

function priceText(m: Model): string {
	if (m.cost_per_m_input_usd === null || m.cost_per_m_output_usd === null) return "";
	if (m.cost_per_m_input_usd === 0 && m.cost_per_m_output_usd === 0) return ", free to run";
	return `, $${m.cost_per_m_input_usd}/$${m.cost_per_m_output_usd} per million input/output tokens`;
}

/** The one line every session start shows for a project, or undefined when nothing was chosen yet. */
export function summarizerLine(s: SummarizerSetting | undefined, project: string): string | undefined {
	if (!s) return undefined;
	return s.state === "enabled"
		? `Team summaries are on in ${project}, written by ${s.model} and charged to each team's budget. /team summarizer changes or turns them off.`
		: `Team summaries were declined in ${project}. /team summarizer setup turns them on.`;
}
export const SUMMARIZER_OFFER = "Team summaries (recommended) are off in this project: a small model condenses what your team did into readable, searchable summaries. /team summarizer setup turns them on.";

export async function readSummarizer(rt: TeamRuntime, project: string): Promise<{ project: string; setting?: SummarizerSetting }> {
	const r = await rt.client.get<{ project: string; settings: ProjectSettings }>(`/projects/settings?project=${encodeURIComponent(project)}`, { token: await rt.commandToken() });
	return { project: r.project, setting: r.settings.summarizer };
}

export async function writeSummarizer(rt: TeamRuntime, project: string, summarizer: SummarizerSetting): Promise<void> {
	await rt.client.post("/projects/settings", { project, summarizer }, { token: await rt.commandToken() });
}

interface SetupUI {
	hasUI: boolean;
	ui: { select(title: string, options: string[]): Promise<string | undefined>; confirm(title: string, detail: string): Promise<boolean> };
	modelRegistry: Parameters<typeof availableModels>[0]["modelRegistry"];
}

/**
 * Offer: detect a suitable model (suggest one; the human accepts or picks another), pick one, or
 * decline. Returns what to tell the human. Without a UI, it explains the commands instead.
 */
export async function setupSummarizer(rt: TeamRuntime, ctx: SetupUI, project: string): Promise<string> {
	const models = availableModels(ctx);
	const suggestion = suggestSummarizer(models);
	if (!ctx.hasUI) {
		return [
			`Team summaries for ${project}: choose a model, or decline.`,
			suggestion ? `Suggested: ${suggestion.model.id} (${suggestion.reason}). To use it, run: /team summarizer use ${suggestion.model.id}` : "No models are available to this Pi; set one up in Pi first.",
			"To use another model, run: /team summarizer use <provider/model>",
			"To decline summaries in this project, run: /team summarizer off",
		].join("\n");
	}
	const DETECT = "Detect a suitable model (recommended)", PICK = "Choose a model myself", NO = "Don't summarize this project's teams";
	const choice = await ctx.ui.select(`Team summaries for ${project}`, suggestion ? [DETECT, PICK, NO] : [PICK, NO]);
	if (!choice) return "Team summaries: nothing changed.";
	if (choice === NO) {
		await writeSummarizer(rt, project, { state: "declined" });
		return `Team summaries declined for ${project}. /team summarizer setup turns them on later.`;
	}
	let model = choice === DETECT && suggestion
		&& (await ctx.ui.confirm(`Summarize with ${suggestion.model.id}?`, `${suggestion.model.name}: ${suggestion.reason}. Summaries are made when someone reads the team brief and enough has happened, and are charged to the team's budget.`))
		? suggestion.model.id : undefined;
	if (!model) {
		const sorted = [...models].sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id));
		const labels = sorted.map((m) => `${m.id}${priceText(m) ? ` (${priceText(m).slice(2)})` : ""}`);
		const picked = await ctx.ui.select("Model for team summaries", labels);
		if (!picked) return "Team summaries: nothing changed.";
		model = sorted[labels.indexOf(picked)].id;
	}
	await writeSummarizer(rt, project, { state: "enabled", model });
	return `Team summaries are on for ${project}, written by ${model}. /team brief shows the latest overview; /team history summaries lists and searches them.`;
}
