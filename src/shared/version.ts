import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.ts";

// Capture at module load, not on each command: disk updates do not reload running code.
export const LOADED_SOURCE = packageRoot();
export const LOADED_VERSION: string = (() => {
	try {
		const value = JSON.parse(readFileSync(join(LOADED_SOURCE, "package.json"), "utf8")).version;
		return typeof value === "string" ? value : "unknown";
	} catch { return "unknown"; } // Source-only copies must still load safely.
})();
