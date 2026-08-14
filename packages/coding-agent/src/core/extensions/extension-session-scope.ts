import type { TSchema } from "typebox";
import type { ToolDefinition } from "./types.ts";

const MAX_IDENTITY_CHARS = 256;
const IDENTITY_KEY = /^(?:card|project|board|.+Id)$/;

export class ExtensionSessionScope {
	private readonly valuesByOwner = new Map<string, Map<string, string>>();

	prepare(ownerKey: string, schema: TSchema, args: unknown): unknown {
		if (!isRecord(args)) return args;
		const stored = this.valuesByOwner.get(ownerKey);
		if (!stored || stored.size === 0) return args;
		const schemaKeys = schemaPropertyNames(schema);
		if (schemaKeys.length === 0) return args;
		let next: Record<string, unknown> | undefined;
		for (const key of schemaKeys) {
			if (!stored.has(key) || !isVacantIdentity(args[key])) continue;
			const value = stored.get(key);
			if (!value) continue;
			next ??= { ...args };
			next[key] = value;
		}
		return next ?? args;
	}

	observeSuccess(ownerKey: string, schema: TSchema, params: unknown, details: unknown): void {
		if (!shouldRetainIdentity(details)) return;
		const extracted = extractIdentity(schemaPropertyNames(schema), isRecord(params) ? params : {}, details);
		if (extracted.size === 0) return;
		const stored = this.valuesByOwner.get(ownerKey) ?? new Map<string, string>();
		for (const [key, value] of extracted) stored.set(key, value);
		this.valuesByOwner.set(ownerKey, stored);
	}

	get(ownerKey: string, key: string): string | undefined {
		return this.valuesByOwner.get(ownerKey)?.get(key);
	}

	clear(ownerKey?: string): void {
		if (ownerKey) this.valuesByOwner.delete(ownerKey);
		else this.valuesByOwner.clear();
	}
}

const scopes = new WeakMap<object, ExtensionSessionScope>();

export function extensionSessionScopeFor(owner: object): ExtensionSessionScope {
	const existing = scopes.get(owner);
	if (existing) return existing;
	const created = new ExtensionSessionScope();
	scopes.set(owner, created);
	return created;
}

export function applyExtensionSessionHeal<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
	ownerKey: string,
	scope: ExtensionSessionScope,
): ToolDefinition<TParams, TDetails> {
	const originalPrepare = definition.prepareArguments;
	const originalExecute = definition.execute;
	return {
		...definition,
		prepareArguments: (args) => {
			const prepared = originalPrepare ? originalPrepare(args) : args;
			return scope.prepare(ownerKey, definition.parameters, prepared) as ReturnType<
				NonNullable<ToolDefinition<TParams, TDetails>["prepareArguments"]>
			>;
		},
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
			scope.observeSuccess(ownerKey, definition.parameters, params, result.details);
			return result;
		},
	};
}

export function extensionScopeOwnerKey(source: { path: string; source: string; baseDir?: string }): string | undefined {
	if (source.source === "builtin") return undefined;
	return source.baseDir ?? source.path;
}

function schemaPropertyNames(schema: TSchema): string[] {
	const properties = (schema as { properties?: unknown }).properties;
	if (!isRecord(properties)) return [];
	return Object.keys(properties);
}

function extractIdentity(
	schemaKeys: readonly string[],
	params: Record<string, unknown>,
	details: unknown,
): Map<string, string> {
	const extracted = new Map<string, string>();
	for (const key of schemaKeys) {
		if (!IDENTITY_KEY.test(key)) continue;
		const fromParams = params[key];
		if (isIdentityValue(fromParams)) extracted.set(key, fromParams);
	}
	if (!isRecord(details)) return extracted;
	for (const key of schemaKeys) {
		if (!IDENTITY_KEY.test(key) || extracted.has(key)) continue;
		const fromDetails = details[key];
		if (isIdentityValue(fromDetails)) {
			extracted.set(key, fromDetails);
			continue;
		}
		if (!key.endsWith("Id")) continue;
		const nested = details[key.slice(0, -2)];
		if (isRecord(nested) && isIdentityValue(nested.id)) extracted.set(key, nested.id);
	}
	return extracted;
}

function shouldRetainIdentity(details: unknown): boolean {
	if (!isRecord(details)) return true;
	if (details.error || details.ok === false) return false;
	const status = details.status;
	if (typeof status !== "string") return true;
	return status === "resolved" || status === "ok" || status === "success";
}

function isVacantIdentity(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

function isIdentityValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_IDENTITY_CHARS &&
		!value.includes("\0") &&
		!value.includes("\n")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
