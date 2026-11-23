import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

// BIP-0039 English vocabulary, MIT licensed; see id-words.LICENSE.
// These are identifiers, NOT wallet mnemonics, credentials, or checksummed BIP-39 phrases.
export const ID_WORDS: readonly string[] = Object.freeze(readFileSync(new URL("./id-words.txt", import.meta.url), "utf8").trim().split("\n"));
if (ID_WORDS.length !== 2048 || new Set(ID_WORDS).size !== 2048 || ID_WORDS.some((word) => !/^[a-z]+$/.test(word))) {
	throw new Error("Invalid readable ID vocabulary: expected 2048 unique lowercase English words");
}

/** Random source for ID words; tests may replace `int` to force collisions. */
export const idRandom: { int: (max: number) => number } = { int: (max) => randomInt(max) };

const words = (n: number): string[] => Array.from({ length: n }, () => ID_WORDS[idRandom.int(ID_WORDS.length)]);

/** Lowercase ASCII tokens of the CWD basename, skipping generic tokens when others remain. */
function projectTokens(cwd: string): string[] {
	const tokens = basename(cwd).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const meaningful = tokens.filter((word) => !["a", "an", "the", "project", "repo", "repository"].includes(word));
	return meaningful.length ? meaningful : tokens;
}

/** First-pass CWD heuristic, not semantic project-name inference. Keep at most two tokens. */
export function projectKeyword(cwd: string): string {
	return projectTokens(cwd).slice(0, 2).join("-").slice(0, 19).replace(/-+$/, "") || "project";
}

/** First character of each CWD basename token, at most six: `standard-cell-generator` → `scg`; empty → `p`. */
export function projectAbbr(cwd: string): string {
	return projectTokens(cwd).map((token) => token[0]).join("").slice(0, 6) || "p";
}

/** The project a directory belongs to: its git top-level, else the directory itself (as the /team list scopes it). */
export function projectRoot(cwd: string): string {
	try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim() || cwd; }
	catch { return cwd; }
}

/** Format of the day part of a team stamp. Supported tokens: yyyy, MM, dd (local time). */
export const ID_DATE_FORMAT = "yyyyMMdd";

export function idDate(d = new Date(), format = ID_DATE_FORMAT): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return format.replace("yyyy", String(d.getFullYear())).replace("MM", pad(d.getMonth() + 1)).replace("dd", pad(d.getDate()));
}

/** A team's stamp: `<date>.<n>`, the nth team created for its project on that local day. */
export function teamStamp(date: string, n: number): string {
	return `${date}.${n}`;
}

/**
 * `<keyword>-<4 words>-<stamp>`; the stamp is the team's `<yyyyMMdd>.<n>`. Only the four words are random:
 * 4 × 11 = 44 bits among agents sharing a stamp (one team), and the controller retries on collision.
 * Without a stamp (teams created before v0.1.42) the legacy 7-digit random suffix is kept so a team stays uniform.
 * Length: 19 keyword + 4 × 8 word + 5 separators + stamp (10 characters while n < 10) ≤ 66.
 */
export function projectAgentId(cwd: string, stamp?: string): string {
	return `${projectKeyword(cwd)}-${words(4).join("-")}-${stamp ?? String(1_000_000 + idRandom.int(9_000_000))}`;
}

/**
 * `<prefix>-<project abbr>-<4 words>`, e.g. `run-scg-borrow-vault-visit-carpet`. 4 × 11 = 44 random bits; the abbr
 * contributes none. Run IDs are created a handful at a time on one local controller (10,000 runs: collision
 * chance ≈ 3 × 10⁻⁶), and the controller retries on collision anyway.
 */
export function readableId(prefix: string, cwd: string): string {
	return [prefix, projectAbbr(cwd), ...words(4)].join("-");
}
