// Fencing: a controller may write only while controller_lease names it at its own epoch.
import { get } from "./db.ts";
import { ApiErr } from "./errors.ts";
import type { Ctx } from "./context.ts";

export class FencedError extends ApiErr {
	constructor(holder: string | null) {
		super("INTERNAL", "controller has been fenced by a newer instance; retry against the current controller", { holder });
	}
}

/** Call at the start of every write transaction. Throws FencedError (→ rollback) when we lost the lease. */
export function assertLeaseHeld(ctx: Ctx): void {
	const lease = get(ctx.db, "SELECT controller_id, fencing_epoch FROM controller_lease WHERE singleton_key = 'local'");
	if (!lease || lease.controller_id !== ctx.controllerId || Number(lease.fencing_epoch) !== ctx.epoch()) {
		throw new FencedError(lease?.controller_id ?? null);
	}
}
