import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { basename } from "node:path";

// BIP-0039 English vocabulary, MIT licensed; see id-words.LICENSE.
// These are identifiers, NOT wallet mnemonics, credentials, or checksummed BIP-39 phrases.
export const ID_WORDS: readonly string[] = Object.freeze(readFileSync(new URL("./id-words.txt", import.meta.url), "utf8").trim().split("\n"));
if (ID_WORDS.length !== 2048 || new Set(ID_WORDS).size !== 2048 || ID_WORDS.some((word) => !/^[a-z]+$/.test(word))) {
	throw new Error("Invalid readable ID vocabulary: expected 2048 unique lowercase English words");
}

/** First-pass CWD heuristic, not semantic project-name inference. Keep at most two tokens. */
export function projectKeyword(cwd: string): string {
	const tokens = basename(cwd).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const meaningful = tokens.filter((word) => !["a", "an", "the", "project", "repo", "repository"].includes(word));
	return (meaningful.length ? meaningful : tokens).slice(0, 2).join("-").slice(0, 19).replace(/-+$/, "") || "project";
}

/** 4 × 11 + log2(9,000,000) ≈ 67.1 random bits; keyword contributes no entropy.
 * At most 63 characters: 19 keyword + 4 × 8 word + 7 digit + 5 separators.
 */
export function projectAgentId(cwd: string): string {
	const words = Array.from({ length: 4 }, () => ID_WORDS[randomInt(ID_WORDS.length)]);
	return `${projectKeyword(cwd)}-${words.join("-")}-${randomInt(1_000_000, 10_000_000)}`;
}

/** Run IDs retain six independently, uniformly selected words: 6 × 11 = 66 bits. */
export function readableId(prefix: string): string {
	return `${prefix}-${Array.from({ length: 6 }, () => ID_WORDS[randomInt(ID_WORDS.length)]).join("-")}`;
}
