// A one/two-token project keyword, four vocabulary words, and either the team stamp `<date digits>.<n>`
// (v0.1.42+) or the legacy seven random decimal digits.
const PROJECT_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)?(?:-[a-z]+){4}-(?:[1-9][0-9]{6}|[0-9]{4,}\.[1-9][0-9]*)$/i;

export function isFullAgentId(reference: string): boolean {
	return /^agent-(?:[0-9a-f]{16}|[a-z]+(?:-[a-z]+){5})$/i.test(reference) || PROJECT_AGENT_ID.test(reference);
}

// Human references match complete ID tokens, not arbitrary character substrings.
// A single token may occur anywhere; multiple tokens must be adjacent and ordered.
// In project IDs the stamp's date and counter are separate tokens (`20261123.2` → `20261123`, `2`).
export function matchesAgentWords(agentId: string, reference: string): boolean {
	const projectId = PROJECT_AGENT_ID.test(agentId);
	if (!projectId && !/^agent-[a-z]+(?:-[a-z]+)+$/i.test(agentId)) return false;
	const query = reference.trim().toLowerCase().replace(/^agent[\s-]+/, "");
	const words = query.split(projectId ? /[\s.-]+/ : /[\s-]+/);
	if (!words.length || words.some((word) => !(projectId ? /^[a-z0-9]+$/ : /^[a-z]+$/).test(word))) return false;
	const idWords = (projectId ? agentId : agentId.slice("agent-".length)).toLowerCase().split(projectId ? /[-.]/ : "-");
	return idWords.some((_word, start) => words.every((word, offset) => idWords[start + offset] === word));
}
