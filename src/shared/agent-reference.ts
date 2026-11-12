// Human references match complete ID words, not arbitrary character substrings.
// A single word may occur anywhere; multiple words must be adjacent and ordered.
export function matchesAgentWords(agentId: string, reference: string): boolean {
	if (!/^agent-[a-z]+(?:-[a-z]+)+$/i.test(agentId)) return false;
	const query = reference.trim().toLowerCase().replace(/^agent[\s-]+/, "");
	const words = query.split(/[\s-]+/);
	if (!words.length || words.some((word) => !/^[a-z]+$/.test(word))) return false;
	const idWords = agentId.toLowerCase().slice("agent-".length).split("-");
	return idWords.some((_word, start) => words.every((word, offset) => idWords[start + offset] === word));
}
