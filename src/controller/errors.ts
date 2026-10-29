import type { ErrorCode, ApiError } from "../shared/protocol.ts";

const STATUS: Record<ErrorCode, number> = {
	PROTOCOL_MISMATCH: 426,
	UNAUTHENTICATED: 401,
	STALE_SESSION: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	INVALID: 400,
	CONFLICT: 409,
	IDEMPOTENCY_MISMATCH: 409,
	BUDGET_EXCEEDED: 409,
	HARD_CAP: 409,
	INTERNAL: 500,
};

export class ApiErr extends Error {
	code: ErrorCode;
	status: number;
	details?: unknown;
	constructor(code: ErrorCode, message: string, details?: unknown) {
		super(message);
		this.code = code;
		this.status = STATUS[code];
		this.details = details;
	}
	toBody(): ApiError {
		return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
	}
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
	throw new ApiErr(code, message, details);
}

export function statusFor(code: ErrorCode): number {
	return STATUS[code];
}

/**
 * Returned (not thrown) by a handler when it wants its state changes COMMITTED (e.g. an audit event,
 * a proposal auto-rejected by a hard cap) and yet the HTTP response to be an error.
 */
export class CommittedError {
	err: ApiErr;
	constructor(err: ApiErr) {
		this.err = err;
	}
}
