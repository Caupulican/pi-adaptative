import type { BeforeToolCallResult } from "../../kernel/index.ts";
import { toolPathSpellings } from "../../kernel/utils/paths.ts";
import { type ReadOnlyShellLaneScope, readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import { type CapabilityGateway, CapabilityGatewayDeniedError } from "../orchestration/capability-gateway.ts";
import type { HarnessCapability, ToolCapabilityManifest } from "../orchestration/contracts.ts";
import {
	READ_ONLY_SHELL_TOOL_NAMES,
	requiredEnvelopeCapabilities,
	resolveToolCallPathAccess,
	type ToolCallFacts,
} from "../tool-capability-policy.ts";
import type { NestedCallPurpose } from "../tools/nested-tool-call.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { classifyYoloBoundary } from "./edge-policy.ts";
import { extractToolPathArguments } from "./envelope-enforcement.ts";
import { evaluateToolGate } from "./gates.ts";
import { findRepositoryGitPaths } from "./path-scope.ts";
import { readScopeRefusal, type SessionReadScope } from "./session-read-scope.ts";

/** The same scope guidance accompanies every lane write refusal. */
export const WORKER_WRITE_SCOPE_GUIDANCE =
	"A worker writes only inside its working directory plus the roots its dispatcher granted with writePaths. Do not route around this: finish what is in scope and report to the parent the absolute path you need to write and why, so it can start a new worker with writePaths for it (a worker's own write scope cannot be widened).";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * The first path a read tool opens outside the lane's read scope, with why; undefined when every path it opens lies inside.
 * The paths are the tool's own path arguments (a search with none opens `.`), so a read the tool would make is judged.
 */
function readScopeViolation(
	toolName: string,
	args: unknown,
	facts: ToolCallFacts | undefined,
	capabilities: readonly HarnessCapability[],
	scope: SessionReadScope,
): string | undefined {
	if (resolveToolCallPathAccess(capabilities, toolName, args, facts) !== "read") return undefined;
	for (const target of extractToolPathArguments(toolName, args)) {
		const refusal = readScopeRefusal(scope, target);
		if (refusal)
			return `${target} is ${refusal === "denied" ? "a private path" : "outside this worker's read scope"}`;
		// git reads the whole repository it runs in, including a linked worktree's shared common directory.
		if (toolName !== "repo_read") continue;
		for (const spelled of toolPathSpellings(target, scope.cwd) ?? []) {
			for (const gitDir of findRepositoryGitPaths(spelled)?.gitDirs ?? []) {
				const gitRefusal = readScopeRefusal(scope, gitDir);
				if (gitRefusal) return `the repository's git directory ${gitDir} is outside this worker's read scope`;
			}
		}
	}
	return undefined;
}

export interface LaneToolAdmissionEvent {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

interface LaneToolAdmissionOptions {
	readonly cwd: string;
	readonly allowedTools: ReadonlySet<string>;
	readonly manifests: ReadonlyMap<string, ToolCapabilityManifest>;
	readonly gateway?: CapabilityGateway;
	/**
	 * What a lane tool's owner reads about the target a call names (`ToolCallFacts`), given to every check below so they
	 * decide as the root's gate does. Only root-only lane tools resolve facts and no lane holds one, so no surface passes
	 * this today; without it every check keeps the strictest requirement.
	 */
	readonly callFacts?: (toolName: string, args: unknown) => ToolCallFacts | undefined;
	readonly yolo?: boolean;
	/**
	 * Present for a `readOnly` grant's shell: its commands are judged by the read/write line plus this lane's
	 * network grant, scratch directory and private paths (`readOnlyShellViolation`).
	 */
	readonly readOnlyShell?: ReadOnlyShellLaneScope;
	/**
	 * Present for a confined lane (its read scope comes from the admitted plan): every path a read tool opens must lie inside
	 * it, in every mode. The gateway checks the same paths only outside YOLO, so this is the check YOLO keeps.
	 */
	readonly readScope?: SessionReadScope;
	readonly denyCommands?: readonly string[];
	readonly readEnvelope: CapabilityEnvelope;
	readonly writeEnvelope: CapabilityEnvelope;
	readonly writeProtectionEnvelope?: CapabilityEnvelope;
	readonly yoloWriteScopeEnvelope?: CapabilityEnvelope;
	assertOpen(): void;
	/** `purpose` names what a host call is made for (a watch's check), for the operation gate's notice. */
	checkEdge?(
		toolName: string,
		args: unknown,
		cwd: string,
		purpose?: NestedCallPurpose,
	): Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
}

/** One execution admission path; preparation may inspect structure but cannot spend or admit work. */
export class LaneToolAdmission {
	private readonly options: LaneToolAdmissionOptions;
	private failure: { readonly error: unknown } | undefined;
	private observer: ((event: LaneToolAdmissionEvent) => void) | undefined;
	private hadObserver = false;

	constructor(options: LaneToolAdmissionOptions) {
		this.options = options;
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure.error;
	}

	/** The executor owns admission-dependent attribution; a callback failure prevents dispatch. */
	subscribe(observer: (event: LaneToolAdmissionEvent) => void): () => void {
		this.options.assertOpen();
		if (this.observer) throw new Error("Lane tool admission already has an attribution owner.");
		this.observer = observer;
		this.hadObserver = true;
		return () => {
			if (this.observer === observer) this.observer = undefined;
		};
	}

	/** Pure policy diagnostics, shared by preparation and the mandatory execution boundary. */
	check(
		toolName: string,
		args: unknown,
		facts = this.options.callFacts?.(toolName, args),
	): BeforeToolCallResult | undefined {
		this.assertHealthy();
		const options = this.options;
		options.assertOpen();
		if (!options.allowedTools.has(toolName))
			return { block: true, reason: `Lane tool '${toolName}' is outside the materialized UAC surface.` };
		if (options.readOnlyShell && READ_ONLY_SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
			const command = (args as { command?: unknown } | undefined)?.command;
			const violation =
				typeof command === "string"
					? readOnlyShellViolation(command, options.cwd, {
							lane: options.readOnlyShell,
							dialect: toolName.toLowerCase() === "powershell" ? "powershell" : "posix",
						})
					: undefined;
			if (violation)
				return {
					block: true,
					reason: `Read-only worker: ${violation}. Read, search and inspect freely; write scratch output only under $TMPDIR (this worker's own scratch directory, removed when it ends); report any change, network access or private file that is needed to the parent instead of reaching it.`,
				};
		}
		if (options.readScope) {
			const violation = readScopeViolation(
				toolName,
				args,
				facts,
				// A tool without a compiled manifest (a YOLO lane keeps every read tool on its surface) is judged by its own policy.
				options.manifests.get(toolName)?.capabilities ?? requiredEnvelopeCapabilities(toolName, args, facts),
				options.readScope,
			);
			if (violation)
				return {
					block: true,
					reason: `Read scope: ${violation}. This worker reads only the directories it was given; report the path to the parent instead of reading it.`,
				};
		}
		if (options.writeProtectionEnvelope && WRITE_TOOLS.has(toolName)) {
			const protection = evaluateToolGate({
				toolName,
				args,
				facts,
				cwd: options.cwd,
				envelope: options.writeProtectionEnvelope,
			});
			if (protection.outcome !== "allow")
				return {
					block: true,
					reason: `Harness resource is write-protected (${protection.reasonCode}): ${protection.message ?? "write refused"}`,
				};
		}
		if (options.yolo) {
			const boundary = classifyYoloBoundary({
				toolName,
				args,
				cwd: options.cwd,
				scopeCwd: options.cwd,
				denyCommands: options.denyCommands,
			});
			if (boundary)
				return {
					block: true,
					reason:
						boundary.kind === "confirm"
							? `Owner approval required: ${boundary.reason}`
							: `YOLO hardline: ${boundary.reason}`,
				};
			if (options.yoloWriteScopeEnvelope && WRITE_TOOLS.has(toolName)) {
				const scope = evaluateToolGate({
					toolName,
					args,
					facts,
					cwd: options.cwd,
					envelope: options.yoloWriteScopeEnvelope,
				});
				if (scope.outcome !== "allow")
					return {
						block: true,
						reason: `Lane tool blocked (${scope.reasonCode}): ${scope.message ?? "write is outside this worker's scope"} ${WORKER_WRITE_SCOPE_GUIDANCE}`,
					};
			}
		} else if (!options.gateway) {
			const outcome = evaluateToolGate({
				toolName,
				args,
				facts,
				cwd: options.cwd,
				envelope: WRITE_TOOLS.has(toolName) ? options.writeEnvelope : options.readEnvelope,
			});
			if (outcome.outcome !== "allow")
				return {
					block: true,
					reason: `Lane tool blocked (${outcome.reasonCode}): ${outcome.message ?? "capability gate denied it"}${WRITE_TOOLS.has(toolName) && outcome.reasonCode.includes("path") ? ` ${WORKER_WRITE_SCOPE_GUIDANCE}` : ""}`,
				};
		}
		return undefined;
	}

	/**
	 * The checks every call faces before it runs, attributing nothing: the structural policy, the grant's eligibility and
	 * budget, the edge check, and the grant's path authorization. Undefined admits the call.
	 */
	private async authorize(
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
		purpose?: NestedCallPurpose,
	): Promise<BeforeToolCallResult | undefined> {
		signal?.throwIfAborted();
		const facts = this.options.callFacts?.(toolName, args);
		const structural = this.check(toolName, args, facts);
		if (structural?.block) return structural;
		const { gateway, manifests, yolo, checkEdge, cwd } = this.options;
		const manifest = gateway && !yolo ? manifests.get(toolName) : undefined;
		if (gateway && !yolo) {
			if (!manifest) return { block: true, reason: `Lane tool '${toolName}' has no compiled capability manifest.` };
			gateway.checkToolCallEligibility(manifest, toolName, args, facts);
			gateway.assertBudgetAvailable(toolName);
		}
		const edge = await checkEdge?.(toolName, args, cwd, purpose);
		signal?.throwIfAborted();
		this.assertHealthy();
		this.options.assertOpen();
		if (edge?.block) return edge;
		if (gateway && manifest) gateway.authorizeToolCall(manifest, toolName, args, facts);
		return undefined;
	}

	/** A standalone call: the checks of `authorize`, then its attribution to the executor. */
	async admit(event: LaneToolAdmissionEvent, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
		try {
			const observer = this.observer;
			if (this.hadObserver && !observer) throw new Error("Lane tool execution attribution is closed.");
			const refused = await this.authorize(event.toolName, event.args, signal);
			if (refused) return refused;
			if (this.observer !== observer) throw new Error("Lane tool execution attribution changed before dispatch.");
			observer?.(event);
			return undefined;
		} catch (error) {
			return this.projectFailure(error, signal);
		}
	}

	/**
	 * A sub-call the lane admitted makes (a `lookup` request, a python tool call): the checks of a standalone call, with no
	 * attribution of its own. Nested calls run every grant and edge check their tool would face on its own.
	 */
	async admitNested(
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
		purpose?: NestedCallPurpose,
	): Promise<BeforeToolCallResult | undefined> {
		try {
			return await this.authorize(toolName, args, signal, purpose);
		} catch (error) {
			return this.projectFailure(error, signal);
		}
	}

	private projectFailure(error: unknown, signal?: AbortSignal): BeforeToolCallResult {
		if (error instanceof CapabilityGatewayDeniedError && error.status !== "budget_exhausted")
			return {
				block: true,
				reason: `Lane tool blocked (${error.reasonCode}): ${error.message}${error.reasonCode === "scope_denied" ? ` ${WORKER_WRITE_SCOPE_GUIDANCE}` : ""}`,
			};
		// The kernel projects thrown tool errors. Retain fatal admission failures independently
		// so a later report cannot turn exhausted authority or failed accounting into success.
		if (!signal?.aborted) this.failure ??= { error };
		throw error;
	}
}
