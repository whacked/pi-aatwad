import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadGraphNavigation } from "./ThreadGraph.js";

// A "list" navigation draws in the area above bb's thread list. It renders bb's own Top list
// rows first, so New thread and plugin pages stay where they were, then the graph.
// Choose it in Settings → Appearance → Navigation; bb's thread list below is untouched.
export default definePluginApp((app) => {
	app.slots.experimental_sidebarNavigation({
		id: "thread-graph",
		title: "Top list + thread graph",
		description: "bb's Top list with a left-to-right graph of threads above the thread list",
		placement: "list",
		component: ThreadGraphNavigation,
	});
});
