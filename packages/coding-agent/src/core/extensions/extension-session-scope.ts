import type { TSchema } from "typebox";
import { isVacantArgument } from "../../kernel/index.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { isRecordObject as isRecord } from "../util/value-guards.ts";
import type { ToolDefinition } from "./types.ts";

const MAX_IDENTITY_CHARS = 256;

/**
 * Session identity of one extension: the values its tools declared through `ToolDefinition.sessionIdentity`
 * and its successful results established. Only declared parameters are ever read or filled; an omitted
 * parameter a tool did not declare keeps its own meaning.
 */
export class ExtensionSessionScope {
	private readonly valuesByOwner = new Map<string, Map<string, string>>();

	prepare(ownerKey: string, identityKeys: readonly string[], args: unknown): unknown {
		if (!isRecord(args)) return args;
		const stored = this.valuesByOwner.get(ownerKey);
		if (!stored || stored.size === 0) return args;
		let next: Record<string, unknown> | undefined;
		for (const key of identityKeys) {
			if (!isVacantArgument(args[key])) continue;
			const value = stored.get(key);
			if (!value) continue;
			next ??= { ...args };
			next[key] = value;
		}
		return next ?? args;
	}

	observeSuccess(ownerKey: string, identityKeys: readonly string[], params: unknown, details: unknown): void {
		if (!shouldRetainIdentity(details)) return;
		const extracted = extractIdentity(identityKeys, isRecord(params) ? params : {}, details);
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

/**
 * Registration check for `ToolDefinition.sessionIdentity`: every name must be one of the tool's own
 * parameters. A name that is not one could never be filled, so it is refused where the extension registers
 * instead of silently doing nothing.
 */
export function assertSessionIdentityDeclaration(definition: ToolDefinition): void {
	const declared: unknown = definition.sessionIdentity;
	if (declared === undefined) return;
	const properties = (definition.parameters as { properties?: unknown }).properties;
	const parameterNames = isRecord(properties) ? properties : {};
	if (!Array.isArray(declared))
		throw new Error(`Tool "${definition.name}" must declare sessionIdentity as a list of parameter names.`);
	for (const key of declared) {
		if (typeof key !== "string" || !Object.hasOwn(parameterNames, key))
			throw new Error(
				`Tool "${definition.name}" declares sessionIdentity ${JSON.stringify(key)}, which is not one of its parameters.`,
			);
	}
}

/**
 * Carry the declared identity of an extension across its tool calls. A definition that declares no
 * `sessionIdentity` is returned unchanged: nothing is retained from its results and none of its omitted
 * arguments is filled.
 */
export function applyExtensionSessionHeal<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
	ownerKey: string,
	scope: ExtensionSessionScope,
): ToolDefinition<TParams, TDetails> {
	const identityKeys = definition.sessionIdentity;
	if (!identityKeys || identityKeys.length === 0) return definition;
	const originalPrepare = definition.prepareArguments;
	return wrapToolExecution(definition, (executor) => ({
		...executor,
		prepareArguments: (args) => {
			const prepared = originalPrepare ? originalPrepare(args) : args;
			return scope.prepare(ownerKey, identityKeys, prepared) as ReturnType<
				NonNullable<ToolDefinition<TParams, TDetails>["prepareArguments"]>
			>;
		},
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const result = await executor.execute(toolCallId, params, signal, onUpdate, ctx);
			scope.observeSuccess(ownerKey, identityKeys, params, result.details);
			return result;
		},
	}));
}

function extractIdentity(
	identityKeys: readonly string[],
	params: Record<string, unknown>,
	details: unknown,
): Map<string, string> {
	const extracted = new Map<string, string>();
	for (const key of identityKeys) {
		const fromParams = params[key];
		if (isIdentityValue(fromParams)) extracted.set(key, fromParams);
	}
	if (!isRecord(details)) return extracted;
	for (const key of identityKeys) {
		if (extracted.has(key)) continue;
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

function isIdentityValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_IDENTITY_CHARS &&
		!value.includes("\0") &&
		!value.includes("\n")
	);
}
