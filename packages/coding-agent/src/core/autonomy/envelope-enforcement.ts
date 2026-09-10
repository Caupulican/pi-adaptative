import type { ExecutionPathAuthority } from "@caupulican/pi-agent-core";
import { type ExecutionPathFlavor, executionPathApi, resolveExecutionPath } from "@caupulican/pi-agent-core/paths";
import { awaitPreflight, requireSynchronousPreflight } from "../preflight.ts";
import { resolveToolCallPathAccess } from "../tool-capability-policy.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { isPathWithinScopeWithDialect, safeRealpathSync } from "./path-scope.ts";

/**
 * Tool-level envelope enforcement (G2 prerequisite for code-writing workers): the capability
 * envelope's `allowedPaths`/`deniedPaths` were previously VALIDATION-ONLY — recorded on the
 * envelope but never checked when a tool actually ran. This module wraps tools so path-bearing
 * arguments are checked AT EXECUTION TIME, structurally refusing out-of-scope paths the same way
 * a failed script can never look like success: the refusal is an isError result with a stable
 * outcome code, never a silent no-op.
 */

const PATH_ARGUMENT_KEYS = ["path", "file_path", "filePath", "cwd", "directory", "dir", "target"] as const;
const PATH_LIST_ARGUMENT_KEYS = ["paths", "files", "referenced_image_paths"] as const;

export function extractPathArguments(params: unknown): string[] {
	if (!params || typeof params !== "object") return [];
	const record = params as Record<string, unknown>;
	const found: string[] = [];
	for (const key of PATH_ARGUMENT_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) found.push(value);
	}
	for (const key of PATH_LIST_ARGUMENT_KEYS) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string" && entry.length > 0) found.push(entry);
			}
		}
	}
	return found;
}

/** Tool-aware path projection shared by every envelope/gateway enforcement boundary. */
export function extractToolPathArguments(toolName: string, params: unknown): string[] {
	const normalizedToolName = toolName.toLowerCase();
	const paths = extractPathArguments(params);
	if (normalizedToolName === "secret_store" && params && typeof params === "object") {
		const record = params as Record<string, unknown>;
		if (record.action === "migrate" && Array.isArray(record.sources)) {
			for (const source of record.sources) {
				if (!source || typeof source !== "object" || !("path" in source)) continue;
				const sourcePath = source.path;
				if (typeof sourcePath === "string" && sourcePath.length > 0) paths.push(sourcePath);
			}
		}
		if (record.action === "discover" && paths.length === 0) paths.push(".");
	}
	if (
		paths.length === 0 &&
		(normalizedToolName === "find" ||
			normalizedToolName === "grep" ||
			normalizedToolName === "ls" ||
			normalizedToolName === "repo_read" ||
			normalizedToolName === "pipeline")
	) {
		paths.push(".");
	}
	return paths;
}

export interface PathEnvelopeAssessment {
	allowed: boolean;
	reasonCode?: "path_denied" | "path_outside_allowed_roots";
	target?: string;
}

export interface AssessPathEnvelopeOptions {
	cwd: string;
	scopeCwd?: string;
	pathAuthority?: ExecutionPathAuthority;
	signal?: AbortSignal;
}

function inferFlavor(cwd: string, authority?: ExecutionPathAuthority): ExecutionPathFlavor {
	if (authority?.flavor) return authority.flavor;
	if (cwd.startsWith("/") && !cwd.startsWith("//")) return "posix";
	if (cwd.includes("\\") || /^[A-Za-z]:/u.test(cwd) || cwd.startsWith("//")) return "win32";
	return process.platform === "win32" ? "win32" : "posix";
}

function inferCaseSensitive(flavor: ExecutionPathFlavor, authority?: ExecutionPathAuthority): boolean {
	if (authority?.caseSensitive !== undefined) return authority.caseSensitive;
	return flavor !== "win32";
}

function collectParentHops(path: string, flavor: ExecutionPathFlavor): { parent: string; parts: string[] }[] {
	const pathApi = executionPathApi(flavor);
	let current = path;
	const parts: string[] = [];
	const hops: { parent: string; parts: string[] }[] = [];
	for (let i = 0; i < 32; i++) {
		const parent = pathApi.dirname(current);
		if (parent === current) break;
		parts.unshift(pathApi.basename(current));
		current = parent;
		hops.push({ parent, parts: [...parts] });
	}
	return hops;
}

function resolveAuthorityPathSync(
	path: string,
	authority: ExecutionPathAuthority | undefined,
	flavor: ExecutionPathFlavor,
): string | undefined {
	const nativeFlavor: ExecutionPathFlavor = process.platform === "win32" ? "win32" : "posix";
	if (!authority) return flavor === nativeFlavor ? safeRealpathSync(path) : path;
	if (authority.safeRealpath) {
		const res = requireSynchronousPreflight(authority.safeRealpath(path));
		if (typeof res === "string") return res;
	}
	const direct = requireSynchronousPreflight(authority.canonicalPath(path));
	if (typeof direct === "string") return direct;
	const pathApi = executionPathApi(flavor);
	for (const hop of collectParentHops(path, flavor)) {
		const canon = requireSynchronousPreflight(authority.canonicalPath(hop.parent));
		if (typeof canon === "string") return pathApi.join(canon, ...hop.parts);
	}
	return path;
}

async function resolveAuthorityPathAsync(
	path: string,
	authority: ExecutionPathAuthority | undefined,
	flavor: ExecutionPathFlavor,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return awaitPreflight(async () => {
		signal?.throwIfAborted();
		const nativeFlavor: ExecutionPathFlavor = process.platform === "win32" ? "win32" : "posix";
		if (!authority) return flavor === nativeFlavor ? safeRealpathSync(path) : path;
		if (authority.safeRealpath) return await authority.safeRealpath(path, signal);
		const direct = await authority.canonicalPath(path, signal);
		signal?.throwIfAborted();
		if (typeof direct === "string") return direct;
		const pathApi = executionPathApi(flavor);
		for (const hop of collectParentHops(path, flavor)) {
			signal?.throwIfAborted();
			const canon = await authority.canonicalPath(hop.parent, signal);
			if (typeof canon === "string") return pathApi.join(canon, ...hop.parts);
		}
		return path;
	}, signal);
}

function matchesEnvelopeCandidate(
	target: string,
	candidate: string,
	scopeCwd: string,
	flavor: ExecutionPathFlavor,
	caseSensitive: boolean,
	resolvedCandidate?: string,
): boolean {
	const lexical = resolveExecutionPath(candidate, scopeCwd, flavor);
	if (isPathWithinScopeWithDialect(target, lexical, flavor, caseSensitive)) return true;
	return Boolean(resolvedCandidate && isPathWithinScopeWithDialect(target, resolvedCandidate, flavor, caseSensitive));
}

function initEnvelopeContext(envelope: CapabilityEnvelope, rawPath: string, options: AssessPathEnvelopeOptions) {
	options.signal?.throwIfAborted();
	const flavor = inferFlavor(options.cwd, options.pathAuthority);
	return {
		flavor,
		caseSensitive: inferCaseSensitive(flavor, options.pathAuthority),
		scopeCwd: options.scopeCwd ?? options.cwd,
		lexicalTarget: resolveExecutionPath(rawPath, options.cwd, flavor),
		allowed: envelope.allowedPaths ?? [],
		denied: envelope.deniedPaths ?? [],
	};
}

interface PathResolutionFact {
	resolved?: string;
	unavailable?: boolean;
}

function* matchesAllowedScope(
	target: string,
	context: ReturnType<typeof initEnvelopeContext>,
): Generator<string, boolean, PathResolutionFact> {
	for (const root of context.allowed) {
		const { resolved } = yield resolveExecutionPath(root, context.scopeCwd, context.flavor);
		if (matchesEnvelopeCandidate(target, root, context.scopeCwd, context.flavor, context.caseSensitive, resolved)) {
			return true;
		}
	}
	return false;
}

/** One authorization policy; adapters supply facts without owning allow/deny decisions. */
function* assessEnvelopeScope(
	ctx: ReturnType<typeof initEnvelopeContext>,
): Generator<string, PathEnvelopeAssessment, PathResolutionFact> {
	if (ctx.allowed.length > 0 && !(yield* matchesAllowedScope(ctx.lexicalTarget, ctx))) {
		return { allowed: false, reasonCode: "path_outside_allowed_roots" };
	}

	const { resolved: target } = yield ctx.lexicalTarget;
	if (!target) return { allowed: false, reasonCode: "path_outside_allowed_roots" };

	for (const denied of ctx.denied) {
		const { resolved, unavailable } = yield resolveExecutionPath(denied, ctx.scopeCwd, ctx.flavor);
		if (
			unavailable ||
			matchesEnvelopeCandidate(target, denied, ctx.scopeCwd, ctx.flavor, ctx.caseSensitive, resolved)
		) {
			return { allowed: false, reasonCode: "path_denied", target };
		}
	}

	if (ctx.allowed.length === 0 || (yield* matchesAllowedScope(target, ctx))) {
		return { allowed: true, target };
	}

	return { allowed: false, reasonCode: "path_outside_allowed_roots", target };
}

export function assessPathWithinEnvelopeSync(
	envelope: CapabilityEnvelope,
	rawPath: string,
	options: AssessPathEnvelopeOptions,
): PathEnvelopeAssessment {
	const context = initEnvelopeContext(envelope, rawPath, options);
	const assessment = assessEnvelopeScope(context);
	let step = assessment.next();
	while (!step.done) {
		let fact: PathResolutionFact;
		try {
			fact = { resolved: resolveAuthorityPathSync(step.value, options.pathAuthority, context.flavor) };
		} catch {
			fact = { unavailable: true };
		}
		step = assessment.next(fact);
	}
	return step.value;
}

export async function assessPathWithinEnvelopeAsync(
	envelope: CapabilityEnvelope,
	rawPath: string,
	options: AssessPathEnvelopeOptions,
): Promise<PathEnvelopeAssessment> {
	const context = initEnvelopeContext(envelope, rawPath, options);
	const policy = assessEnvelopeScope(context);
	let request = policy.next();
	while (!request.done) {
		let resolved: string | undefined;
		let unavailable = false;
		try {
			resolved = await resolveAuthorityPathAsync(
				request.value,
				options.pathAuthority,
				context.flavor,
				options.signal,
			);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			unavailable = true;
		}
		options.signal?.throwIfAborted();
		request = policy.next({ resolved, unavailable });
	}
	return request.value;
}

/**
 * Deny wins over allow; an empty/absent allow list means "no positive scope restriction"
 * (only denies apply) — mirroring the resource-profile filter semantics.
 *
 * Both the target and every scope root are resolved through the real filesystem
 * (symlinks expanded in the existing prefix) before comparison: a pre-existing symlink
 * under an allowed root cannot smuggle a write outside the scope, and a shortcut into a
 * denied subtree is still denied. An unresolvable target fails closed.
 */
export function isPathWithinEnvelope(
	envelope: CapabilityEnvelope,
	rawPath: string,
	cwd: string,
	scopeCwd = cwd,
	pathAuthority?: ExecutionPathAuthority,
): boolean {
	return assessPathWithinEnvelopeSync(envelope, rawPath, { cwd, scopeCwd, pathAuthority }).allowed;
}

export interface EnvelopeScopedTool {
	name: string;
	/**
	 * The `never` parameter keeps this structural boundary compatible with both the synchronous
	 * fixtures used by the path-policy tests and the strongly typed async `AgentTool.execute`
	 * implementations. The wrapper itself preserves the concrete execute signature below.
	 */
	execute: (...args: never[]) => unknown;
}

/**
 * Wrap a tool so path-bearing arguments are scope-checked when it RUNS, consulting canonical
 * tool capability policy so only tools whose policy declares path-scope access
 * (resolveToolCallPathAccess !== "none") are checked against envelope boundaries. The wrapped tool is
 * shape-identical; params are conventionally the second execute argument (toolCallId, params, …).
 */
export function wrapToolWithEnvelopeScope<T extends EnvelopeScopedTool>(
	tool: T,
	envelope: CapabilityEnvelope,
	cwd: string,
): T {
	return wrapToolExecution(tool, (executor, executionContext, pathAuthority) => {
		type Execute = T["execute"];
		const denialBlock = (rawPath: string) => ({
			content: [
				{
					type: "text",
					text: `envelope_path_denied: "${rawPath}" is outside envelope ${envelope.id}'s path scope. The tool was NOT run.`,
				},
			],
			details: {
				outcome: "envelope_path_denied",
				tool: tool.name,
				path: rawPath,
				envelopeId: envelope.id,
			},
			isError: true,
		});

		const execute = (...args: Parameters<Execute>): ReturnType<Execute> => {
			const params = args[1];
			const signal = args[2] as AbortSignal | undefined;
			signal?.throwIfAborted();
			const pathAccess = resolveToolCallPathAccess(envelope.capabilities, tool.name, params);
			if (pathAccess !== "none") {
				const paths = extractToolPathArguments(tool.name, params);
				if (pathAuthority) {
					return (async () => {
						signal?.throwIfAborted();
						for (const rawPath of paths) {
							const assessment = await assessPathWithinEnvelopeAsync(envelope, rawPath, {
								cwd: executionContext?.cwd ?? cwd,
								scopeCwd: cwd,
								pathAuthority,
								signal,
							});
							if (!assessment.allowed) {
								return denialBlock(rawPath);
							}
						}
						signal?.throwIfAborted();
						return await executor.execute(...args);
					})() as ReturnType<Execute>;
				}

				for (const rawPath of paths) {
					const assessment = assessPathWithinEnvelopeSync(envelope, rawPath, {
						cwd: executionContext?.cwd ?? cwd,
						scopeCwd: cwd,
					});
					if (!assessment.allowed) {
						return denialBlock(rawPath) as ReturnType<Execute>;
					}
				}
			}
			signal?.throwIfAborted();
			return executor.execute(...args) as ReturnType<Execute>;
		};
		return {
			...executor,
			execute,
		} as T;
	});
}
