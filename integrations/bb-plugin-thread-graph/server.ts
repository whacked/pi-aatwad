// The thread graph is UI only; bb requires a backend entry.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
	bb.onDispose(() => bb.log.info("disposed"));
}
