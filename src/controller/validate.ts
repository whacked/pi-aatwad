// Minimal JSON-schema validator for the subset used by contracts/*.schema.json, plus body helpers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../shared/paths.ts";
import { fail } from "./errors.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

function typeOk(t: string, v: unknown): boolean {
	switch (t) {
		case "object":
			return typeof v === "object" && v !== null && !Array.isArray(v);
		case "array":
			return Array.isArray(v);
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number" && Number.isFinite(v);
		case "integer":
			return typeof v === "number" && Number.isInteger(v);
		case "boolean":
			return typeof v === "boolean";
		default:
			return true;
	}
}

export function validateSchema(schema: Schema, v: unknown, path = "$", errors: string[] = []): string[] {
	if (schema.type && !typeOk(schema.type, v)) {
		errors.push(`${path}: expected ${schema.type}`);
		return errors;
	}
	if ("const" in schema && v !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.includes(v)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}`);
	if (typeof v === "string") {
		if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
		if (schema.format === "date-time" && Number.isNaN(Date.parse(v))) errors.push(`${path}: not a date-time`);
	}
	if (typeof v === "number") {
		if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
		if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
	}
	if (Array.isArray(v)) {
		if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
		if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
		if (schema.items) v.forEach((x, i) => validateSchema(schema.items, x, `${path}[${i}]`, errors));
	}
	if (typeOk("object", v) && (schema.properties || schema.required)) {
		const o = v as Record<string, unknown>;
		for (const r of schema.required ?? []) if (o[r] === undefined) errors.push(`${path}.${r}: required`);
		for (const [k, x] of Object.entries(o)) {
			const ps = schema.properties?.[k];
			if (ps) {
				if (x !== undefined) validateSchema(ps, x, `${path}.${k}`, errors);
			} else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown property`);
		}
	}
	return errors;
}

const cache = new Map<string, Schema>();
export function contractSchema(name: "envelope" | "expansion"): Schema {
	let s = cache.get(name);
	if (!s) {
		s = JSON.parse(readFileSync(join(packageRoot(), "contracts", `${name}.schema.json`), "utf8")) as Schema;
		cache.set(name, s);
	}
	return s;
}

export function assertSchema(name: "envelope" | "expansion", v: unknown): void {
	const errs = validateSchema(contractSchema(name), v);
	if (errs.length) fail("INVALID", `${name} validation failed: ${errs.slice(0, 5).join("; ")}`, { errors: errs });
}

// ---- small body helpers ----------------------------------------------------

export function obj(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) fail("INVALID", "body must be a JSON object");
	return body as Record<string, unknown>;
}
export function str(o: Record<string, unknown>, k: string, opts: { optional?: boolean; min?: number } = {}): string {
	const v = o[k];
	if (v === undefined || v === null) {
		if (opts.optional) return undefined as unknown as string;
		fail("INVALID", `${k} is required`);
	}
	if (typeof v !== "string" || v.length < (opts.min ?? 1)) fail("INVALID", `${k} must be a non-empty string`);
	return v;
}
export function int(o: Record<string, unknown>, k: string, opts: { optional?: boolean } = {}): number {
	const v = o[k];
	if (v === undefined || v === null) {
		if (opts.optional) return undefined as unknown as number;
		fail("INVALID", `${k} is required`);
	}
	if (typeof v !== "number" || !Number.isInteger(v)) fail("INVALID", `${k} must be an integer`);
	return v;
}
export function oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[], opts: { optional?: boolean } = {}): T {
	const v = o[k];
	if (v === undefined && opts.optional) return undefined as unknown as T;
	if (!values.includes(v as T)) fail("INVALID", `${k} must be one of ${values.join(", ")}`);
	return v as T;
}
export function onlyKeys(o: Record<string, unknown>, allowed: string[]): void {
	const extra = Object.keys(o).filter((k) => !allowed.includes(k));
	if (extra.length) fail("INVALID", `unknown field(s): ${extra.join(", ")}`);
}
