import { test } from "node:test";
import assert from "node:assert/strict";
import { TmuxWatch, type Pane } from "../../src/watch/tmux.ts";
import { planLayout } from "../../src/watch/layout.ts";
import { TerminalAllocationError } from "../../src/watch/terminal-error.ts";

for (const scenario of ["leader zoom", "unrelated zoom", "full", "split race", "missing target"] as const) {
	test(`typed terminal allocation failure: ${scenario}, with no unzoom or unrelated mutation`, async () => {
		const view = new TmuxWatch({ stateDir: "/tmp/allocation-unit", runId: "run", location: { leader: "%1", window: "@1" } });
		const panes: Pane[] = [{ id: "%1", window: "@1", agent: "leader", dead: false }];
		const layout = planLayout(scenario === "full" ? 4 : 160, scenario === "full" ? 3 : 40, "%1", scenario === "unrelated zoom" ? ["%9"] : [])!.layout;
		const zoom = scenario.includes("zoom") ? "1" : "0";
		const calls: string[][] = [];
		view.open = async () => { if (scenario === "missing target") throw new Error("tmux: can't find pane: %1"); };
		view.panes = async () => panes;
		view.tmux = async (...args) => {
			calls.push(args);
			if (args[0] === "display-message") {
				if (args.at(-1) === "#{window_layout}") return layout;
				if (args.at(-1) === "#{window_layout}\t#{window_zoomed_flag}") return `${layout}\t${zoom}`;
				if (args.at(-1) === "#{pane_width} #{pane_height} #{window_zoomed_flag}") return `160 40 ${zoom}`;
			}
			if (args[0] === "split-window" && scenario === "split race") throw new Error("tmux: no space for new pane");
			throw new Error(`unexpected mutation: ${args.join(" ")}`);
		};
		await assert.rejects(view.launchAgent("worker", "Worker", ["/bin/true"], "/tmp"), (e: unknown) => {
			assert.ok(e instanceof TerminalAllocationError);
			assert.match(e.message, scenario.includes("zoom") ? /Unzoom/ : scenario === "full" ? /too small/ : scenario === "split race" ? /no space/ : /can't find pane/);
			return true;
		});
		assert.ok(calls.every((c) => c[0] === "display-message" || (scenario === "split race" && c[0] === "split-window")));
		assert.equal(panes.length, 1);
	});
}
