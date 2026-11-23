import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

// BIP-0039 English vocabulary, MIT licensed; see id-words.LICENSE.
// These are identifiers, NOT wallet mnemonics, credentials, or checksummed BIP-39 phrases.
export const ID_WORDS: readonly string[] = Object.freeze(readFileSync(new URL("./id-words.txt", import.meta.url), "utf8").trim().split("\n"));
if (ID_WORDS.length !== 2048 || new Set(ID_WORDS).size !== 2048 || ID_WORDS.some((word) => !/^[a-z]+$/.test(word))) {
	throw new Error("Invalid readable ID vocabulary: expected 2048 unique lowercase English words");
}

/** Random source for ID words; tests may replace `int` to force collisions. */
export const idRandom: { int: (max: number) => number } = { int: (max) => randomInt(max) };

const words = (n: number): string[] => Array.from({ length: n }, () => ID_WORDS[idRandom.int(ID_WORDS.length)]);

/** Filler words dropped inside a folder name when other words remain. */
const FILLER = new Set(["a", "an", "the", "project", "repo", "repository"]);
/** Folder names that say little about the project; kept in a name but carry no information. */
export const GENERIC_FOLDERS: ReadonlySet<string> = new Set([
	...FILLER, "projects", "repos", "src", "source", "sources", "lib", "libs", "app", "apps", "pkg", "pkgs", "packages",
	"code", "dev", "devel", "test", "tests", "build", "dist", "out", "bin", "main", "master", "trunk", "work", "workspace",
	"workspaces", "git", "github", "tmp", "temp", "home", "users", "user", "private", "var", "opt", "usr", "local",
	"documents", "desktop", "downloads", "mnt", "volumes", "data", "server", "client", "web", "frontend", "backend",
]);
/** Informative characters (outside generic folders) a project name needs before the path walk stops. */
export const MIN_NAME_INFO = 6;
/** At most this many folders make up a name. */
export const MAX_NAME_FOLDERS = 3;

function folderTokens(name: string): string[] {
	const tokens = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const meaningful = tokens.filter((word) => !FILLER.has(word));
	return meaningful.length ? meaningful : tokens;
}

/**
 * The folders that name a project, outermost first, each as its tokens. Starts at the working directory and walks
 * up while the name is below MIN_NAME_INFO informative characters (generic folders such as src count zero), never
 * past the home directory or the root: /path/to/something/cool/src → something, cool, src; /x/pi-aatwad →
 * pi-aatwad; /tmp → tmp (nothing better exists).
 */
export function projectNameFolders(cwd: string, home = homedir()): string[][] {
	const folders: string[][] = [];
	let info = 0;
	for (let dir = resolve(cwd); dir !== resolve(home) && dir !== dirname(dir); dir = dirname(dir)) {
		const tokens = folderTokens(basename(dir));
		if (!tokens.length) continue;
		folders.unshift(tokens);
		info += tokens.filter((t) => !GENERIC_FOLDERS.has(t)).join("").length;
		if (info >= MIN_NAME_INFO || folders.length >= MAX_NAME_FOLDERS) break;
	}
	if (!folders.length) { const own = folderTokens(basename(resolve(cwd))); if (own.length) folders.push(own); }
	return folders;
}

/** Drop vowels after the first letter: something → smthng, cool → cl. */
const squeeze = (token: string) => token[0] + token.slice(1).replace(/[aeiou]/g, "");

/**
 * A project name of at most `max` characters from projectNameFolders. Too long: squeeze outer folders (outermost
 * first), keep two words of the innermost folder, squeeze it, drop outer folders, then cut.
 */
export function projectName(cwd: string, max = Infinity, home = homedir()): string {
	let folders = projectNameFolders(cwd, home);
	if (!folders.length) return "project";
	const text = () => folders.map((f) => f.join("-")).join("-");
	for (let i = 0; i < folders.length - 1 && text().length > max; i++) folders[i] = folders[i].map(squeeze);
	const last = folders.length - 1;
	if (text().length > max) folders[last] = folders[last].slice(0, 2);
	if (text().length > max) folders[last] = folders[last].map(squeeze);
	while (folders.length > 1 && text().length > max) folders = folders.slice(1);
	return text().slice(0, max).replace(/-+$/, "") || "project";
}

/** Keyword at the start of agent IDs: the project name, at most 19 characters. */
export function projectKeyword(cwd: string, home = homedir()): string {
	return projectName(cwd, 19, home);
}

/** First character of each word of the project name, at most six: `standard-cell-generator` → `scg`; empty → `p`. */
export function projectAbbr(cwd: string, home = homedir()): string {
	return projectNameFolders(cwd, home).flat().map((token) => token[0]).join("").slice(0, 6) || "p";
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
