/** Presentation-only failure: the executor must ensure Pi has not started before fallback. */
export class TerminalAllocationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TerminalAllocationError";
	}
}
