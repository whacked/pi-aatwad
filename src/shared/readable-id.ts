import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";

// BIP-0039 English vocabulary, MIT licensed; see id-words.LICENSE.
// These are identifiers, NOT wallet mnemonics, credentials, or checksummed BIP-39 phrases.
export const ID_WORDS: readonly string[] = Object.freeze(readFileSync(new URL("./id-words.txt", import.meta.url), "utf8").trim().split("\n"));
if (ID_WORDS.length !== 2048 || new Set(ID_WORDS).size !== 2048 || ID_WORDS.some((word) => !/^[a-z]+$/.test(word))) {
	throw new Error("Invalid readable ID vocabulary: expected 2048 unique lowercase English words");
}

/** Six independently, uniformly selected words: 6 × 11 = 66 bits (old hex IDs: 64). */
export function readableId(prefix: string): string {
	return `${prefix}-${Array.from({ length: 6 }, () => ID_WORDS[randomInt(ID_WORDS.length)]).join("-")}`;
}
