import path from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolkitScript } from "../toolkit/script-registry.ts";
import { executeToolkitScript, type ScriptExecution, type ScriptExecutor } from "../toolkit/script-runner.ts";
import type {
	ToolkitScriptAuthorizationDecision,
	ToolkitScriptAuthorizationRequest,
	ToolkitScriptAuthorizer,
} from "../tools/run-toolkit-script.ts";
import { parseShellCommandSequence, stripShellInvocationPrefixes } from "../tools/shell-command-parser.ts";
import { createTaskAutomationToolDefinition, type TaskAutomationInput } from "../tools/task-automation.ts";
import type { TaskStepLike } from "./contracts.ts";
import { TASK_AUTOMATION_STATE_CUSTOM_TYPE } from "./session-task-automation.ts";
import { TaskAutomationController } from "./task-automation-controller.ts";

export const TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE = "task_automation_context";
export const TASK_AUTOMATION_CONTEXT_CLEARED =
	"<task_automation_context>\nNo task automations currently registered for the active task scope.\n</task_automation_context>";

const MAX_TASK_AUTOMATION_CONTEXT_BYTES = 4 * 1024;
const CONTEXT_WRAPPER_OPEN = "<task_automation_context>\n";
const CONTEXT_WRAPPER_CLOSE = "\n</task_automation_context>";
const CONTEXT_WRAPPER_BYTES =
	Buffer.byteLength(CONTEXT_WRAPPER_OPEN, "utf8") + Buffer.byteLength(CONTEXT_WRAPPER_CLOSE, "utf8");
const CONTEXT_RESERVE_BYTES = 64;
const INNER_CONTEXT_MAX_BYTES = MAX_TASK_AUTOMATION_CONTEXT_BYTES - CONTEXT_WRAPPER_BYTES - CONTEXT_RESERVE_BYTES;

export const TASK_AUTOMATION_PROVENANCE = Symbol.for("pi.task_automation_provenance");

export interface TaskAutomationProvenance {
	readonly sessionId: string;
	readonly cwd: string;
	readonly automationName: string;
	readonly scriptPath: string;
	readonly runner: string;
	readonly scriptHash: string;
	readonly generation: number;
	readonly verifiedAt?: string;
}

export interface TaskAutomationContextPlan {
	content: string | undefined;
	isCurrent(): boolean;
}

export interface TaskAutomationRuntimeAdapterDeps {
	getCwd: () => string;
	getSessionManager: () => SessionManager;
	authorize?: ToolkitScriptAuthorizer;
	executor?: ScriptExecutor;
}

const PLAIN_WRAPPERS = new Set(["nohup", "exec", "time", "builtin", "unbuffer", "caffeinate", "sudo"]);

function stripWrappers(argv: readonly string[]): string[] {
	let args = [...argv];
	while (args.length > 0 && PLAIN_WRAPPERS.has(args[0].toLowerCase())) {
		args = args.slice(1);
	}
	return args;
}

const SHELL_INTERPRETER_BASENAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const PYTHON_INTERPRETER_BASENAMES = new Set(["python", "python3", "py"]);
const POWERSHELL_INTERPRETER_BASENAMES = new Set(["powershell", "pwsh"]);

/**
 * Extract potential script candidate path strings from an invocation argv array.
 * Recognizes standard POSIX shells, Python, PowerShell (flags, -File), uv run, and direct path executions.
 * Handles nested commands inside `-c` recursively via the AST shell parser.
 */
function extractInvocationScriptCandidates(argv: readonly string[]): string[] {
	const cleaned = stripWrappers(stripShellInvocationPrefixes([...argv]));
	if (cleaned.length === 0) return [];

	const rawProg = cleaned[0];
	const baseProg = path
		.basename(rawProg)
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/, "");
	const rest = cleaned.slice(1);
	const candidates: string[] = [];

	if (SHELL_INTERPRETER_BASENAMES.has(baseProg)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "-c" && i + 1 < rest.length) {
				const nestedCommand = rest[i + 1];
				const parsed = parseShellCommandSequence(nestedCommand, { redirects: "drop" });
				if (parsed) {
					for (const inv of parsed.invocations) {
						candidates.push(...extractInvocationScriptCandidates(inv));
					}
				}
				i++;
			} else if (!arg.startsWith("-")) {
				// First non-flag argument to shell is the script path
				candidates.push(arg);
				break;
			}
		}
	} else if (PYTHON_INTERPRETER_BASENAMES.has(baseProg)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "-c" || arg === "-m") {
				break;
			}
			if (!arg.startsWith("-")) {
				candidates.push(arg);
				break;
			}
		}
	} else if (POWERSHELL_INTERPRETER_BASENAMES.has(baseProg)) {
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			const lower = arg.toLowerCase();
			if (lower === "-file" && i + 1 < rest.length) {
				candidates.push(rest[i + 1]);
				break;
			}
			if (lower === "-command" || lower === "-c") {
				break;
			}
			if (!arg.startsWith("-")) {
				candidates.push(arg);
				break;
			}
		}
	} else if (baseProg === "uv" && rest.length > 0 && rest[0].toLowerCase() === "run") {
		const uvRest = rest.slice(1);
		for (let i = 0; i < uvRest.length; i++) {
			const arg = uvRest[i];
			if (!arg.startsWith("-")) {
				candidates.push(arg);
				break;
			}
		}
	} else if (
		rawProg.includes("/") ||
		rawProg.includes("\\") ||
		rawProg.startsWith(".") ||
		rawProg.endsWith(".sh") ||
		rawProg.endsWith(".ps1") ||
		rawProg.endsWith(".py")
	) {
		candidates.push(rawProg);
	}

	return candidates;
}

/**
 * Cohesive runtime adapter for task-local deterministic automation.
 * Bridges TaskAutomationController to AgentSession, RuntimeBuilder,
 * ToolGateController, task_steps invariants, and provider request context.
 */
export class TaskAutomationRuntimeAdapter {
	private readonly deps: TaskAutomationRuntimeAdapterDeps;
	private _controller: TaskAutomationController | undefined;

	constructor(deps: TaskAutomationRuntimeAdapterDeps) {
		this.deps = deps;
	}

	getController(): TaskAutomationController {
		if (!this._controller) {
			this._controller = new TaskAutomationController({
				getCwd: this.deps.getCwd,
				getSessionManager: this.deps.getSessionManager,
				executor: this.deps.executor,
				authorize: this.deps.authorize,
			});
		}
		return this._controller;
	}

	/**
	 * Materialize tool definition for task_automation.
	 * Exposes native background lifecycle policy via backgroundRequested hook for run and validate.
	 * Worker exclusion is governed canonically through WORKER_FORBIDDEN_TOOLS.
	 */
	createToolDefinition(): ToolDefinition {
		const controller = this.getController();
		const baseDefinition = createTaskAutomationToolDefinition(controller);

		return {
			...baseDefinition,
			backgroundRequested: (input: TaskAutomationInput) =>
				(input.action === "run" || input.action === "validate") && input.background === true,
			execute: async (toolCallId, input: TaskAutomationInput, signal, onUpdate, context) => {
				return baseDefinition.execute(toolCallId, input, signal, onUpdate, context);
			},
		};
	}

	/**
	 * Combined script registry: merges task-local admitted dynamic scripts with static settings scripts.
	 * Rejects name/alias collisions rather than silently overriding.
	 * Stamps immutable dynamic provenance symbol to prevent scope-switch bypass.
	 * Returns mutable ToolkitScript[] to satisfy getScripts contracts.
	 */
	getCombinedScripts(staticScripts: readonly ToolkitScript[]): ToolkitScript[] {
		const controller = this.getController();
		const dynamic = controller.getAdmittedScripts();
		const cwd = this.deps.getCwd();
		const sessionManager = this.deps.getSessionManager();
		const sessionId = sessionManager.getSessionId();
		const automations = controller.getAutomations();

		const stampedDynamic: ToolkitScript[] = dynamic.map((d) => {
			const matchingAuto = automations.find((a) => a.name.toLowerCase() === d.name.toLowerCase());
			const provenance: TaskAutomationProvenance = Object.freeze({
				sessionId,
				cwd,
				automationName: d.name,
				scriptPath: d.path,
				runner: d.runner,
				scriptHash: matchingAuto?.evidence?.scriptHash ?? "",
				generation: matchingAuto?.generation ?? 1,
				verifiedAt: matchingAuto?.evidence?.verifiedAt,
			});
			return {
				...d,
				[TASK_AUTOMATION_PROVENANCE]: provenance,
			};
		});

		if (stampedDynamic.length === 0) return [...staticScripts];

		const staticNames = new Set<string>();
		for (const s of staticScripts) {
			staticNames.add(s.name.toLowerCase());
			for (const alias of s.aliases ?? []) {
				staticNames.add(alias.toLowerCase());
			}
		}

		for (const d of stampedDynamic) {
			if (staticNames.has(d.name.toLowerCase())) {
				throw new Error(
					`Task automation "${d.name}" collides with an existing static toolkit script or alias. Collisions must be resolved explicitly.`,
				);
			}
		}

		return [...staticScripts, ...stampedDynamic];
	}

	/**
	 * Route script execution: dynamic task automation scripts MUST execute through
	 * controller.run (enforcing hash checks, output contracts, and execution fencing).
	 * Enforces provenance checking: if stamped with TASK_AUTOMATION_PROVENANCE, rejects stale
	 * session, cwd, generation, hash, re-validation, or missing automation, and NEVER falls back to raw executeToolkitScript.
	 */
	async executeScript(
		script: ToolkitScript,
		scriptArgs: readonly string[],
		signal?: AbortSignal,
	): Promise<ScriptExecution> {
		const controller = this.getController();
		const automations = controller.getAutomations();
		const currentCwd = this.deps.getCwd();
		const currentSessionId = this.deps.getSessionManager().getSessionId();
		const scriptCanonical = path.resolve(currentCwd, script.path);

		const provenance = (script as { [TASK_AUTOMATION_PROVENANCE]?: TaskAutomationProvenance })[
			TASK_AUTOMATION_PROVENANCE
		];

		if (provenance) {
			if (provenance.sessionId !== currentSessionId) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${provenance.automationName}" execution rejected: dynamic script provenance belongs to session "${provenance.sessionId}", not current session "${currentSessionId}". Scope switch invalidates pending execution.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			if (provenance.cwd !== currentCwd) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${provenance.automationName}" execution rejected: dynamic script provenance belongs to workspace "${provenance.cwd}", not current workspace "${currentCwd}". Scope switch invalidates pending execution.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			const matched = automations.find((a) => a.name.toLowerCase() === provenance.automationName.toLowerCase());
			if (!matched) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${provenance.automationName}" is no longer active in the current task scope. Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			if (
				script.name.toLowerCase() !== provenance.automationName.toLowerCase() ||
				matched.name.toLowerCase() !== script.name.toLowerCase()
			) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${provenance.automationName}" name drift detected (requested: ${script.name}, registered: ${matched.name}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			const expectedCanonical = path.resolve(currentCwd, matched.path);
			const provenanceCanonical = path.resolve(currentCwd, provenance.scriptPath);
			const pathMatches =
				process.platform === "win32"
					? expectedCanonical.toLowerCase() === scriptCanonical.toLowerCase() &&
						provenanceCanonical.toLowerCase() === scriptCanonical.toLowerCase()
					: expectedCanonical === scriptCanonical && provenanceCanonical === scriptCanonical;

			if (!pathMatches) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matched.name}" path drift detected (registered: ${matched.path}, requested: ${script.path}, provenance: ${provenance.scriptPath}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			if (matched.runner !== script.runner || matched.runner !== provenance.runner) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matched.name}" runner drift detected (registered: ${matched.runner}, requested: ${script.runner}, provenance: ${provenance.runner}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			const currentGeneration = matched.generation ?? 1;
			if (currentGeneration !== provenance.generation) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matched.name}" generation mismatch (provenance generation: ${provenance.generation}, current: ${currentGeneration}). Automation was re-authored or modified since selection. Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			const currentHash = matched.evidence?.scriptHash ?? "";
			if (!provenance.scriptHash || provenance.scriptHash !== currentHash) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matched.name}" hash mismatch (provenance hash: ${provenance.scriptHash || "none"}, current evidence hash: ${currentHash || "none"}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			if (provenance.verifiedAt !== matched.evidence?.verifiedAt) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matched.name}" was re-validated since selection (provenance verifiedAt: ${provenance.verifiedAt}, current: ${matched.evidence?.verifiedAt}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			if (matched.state !== "ready") {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matched.name}" is not in ready state (current: ${matched.state}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			return controller.executeAdmittedScript(matched.name, scriptArgs, signal);
		}

		// Also verify un-stamped scripts against active automations
		const matchedAutomation = automations.find((a) => {
			if (a.name.toLowerCase() === script.name.toLowerCase()) return true;
			const aCanonical = path.resolve(currentCwd, a.path);
			return process.platform === "win32"
				? aCanonical.toLowerCase() === scriptCanonical.toLowerCase()
				: aCanonical === scriptCanonical;
		});

		if (matchedAutomation) {
			const expectedCanonical = path.resolve(currentCwd, matchedAutomation.path);
			const pathMatches =
				process.platform === "win32"
					? expectedCanonical.toLowerCase() === scriptCanonical.toLowerCase()
					: expectedCanonical === scriptCanonical;

			if (!pathMatches || matchedAutomation.runner !== script.runner) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `Task automation "${matchedAutomation.name}" metadata drift detected (runner: expected ${matchedAutomation.runner}, got ${script.runner}; path: expected ${matchedAutomation.path}, got ${script.path}). Execution rejected.`,
					durationMs: 0,
					timedOut: false,
				};
			}

			return controller.executeAdmittedScript(matchedAutomation.name, scriptArgs, signal);
		}

		return executeToolkitScript({
			script,
			scriptArgs,
			cwd: currentCwd,
			signal,
			executor: this.deps.executor,
		});
	}

	/**
	 * Determines whether a script is a dynamic registered task automation stamped with
	 * TASK_AUTOMATION_PROVENANCE. Only stamped scripts are treated as dynamic scripts.
	 */
	isDynamicScript(script: ToolkitScript): boolean {
		return Boolean(
			(script as { [TASK_AUTOMATION_PROVENANCE]?: TaskAutomationProvenance })[TASK_AUTOMATION_PROVENANCE],
		);
	}

	/**
	 * Route outer toolkit script authorization: defers dynamic registered automation authorization
	 * exclusively to controller.run (ensuring one mandatory host-authorization check on production run)
	 * ONLY for scripts stamped with immutable TASK_AUTOMATION_PROVENANCE.
	 *
	 * Unstamped scripts that match active task automations are rejected explicitly (directing the caller
	 * to discover a fresh script from the registry) rather than deferred on a transient lookup,
	 * preventing race-condition fallback to raw execution without host authorization.
	 *
	 * Static scripts are delegated to the static host authorizer.
	 */
	async authorizeToolkitScript(
		request: ToolkitScriptAuthorizationRequest,
		staticAuthorizer: ToolkitScriptAuthorizer,
		signal?: AbortSignal,
	): Promise<ToolkitScriptAuthorizationDecision> {
		if (this.isDynamicScript(request.script)) {
			// Defer ONLY immutable provenance-stamped scripts; controller.run is the single authorizer owner
			return { authorized: true };
		}

		// Reject un-stamped script that matches any active registered automation
		const automations = this.getController().getAutomations();
		const cwd = this.deps.getCwd();
		const scriptCanonical = path.resolve(cwd, request.script.path);
		const matchingAutomation = automations.find((a) => {
			if (a.name.toLowerCase() === request.script.name.toLowerCase()) return true;
			const aCanonical = path.resolve(cwd, a.path);
			return process.platform === "win32"
				? aCanonical.toLowerCase() === scriptCanonical.toLowerCase()
				: aCanonical === scriptCanonical;
		});

		if (matchingAutomation) {
			return {
				authorized: false,
				reason: `Script "${request.script.name}" matches task automation "${matchingAutomation.name}" but lacks dynamic provenance. Discover a fresh script from the registry before authorizing.`,
			};
		}

		return staticAuthorizer(request, signal);
	}

	/**
	 * Delegates completion and step transition verification to controller.assertTaskStepsTransition.
	 */
	assertTaskStepsTransition(previous: readonly TaskStepLike[] | undefined, next: readonly TaskStepLike[]): void {
		this.getController().assertTaskStepsTransition(previous, next);
	}

	private matchesRegisteredScript(
		candidatePath: string,
		executionCwd?: string,
	): { name: string; path: string } | undefined {
		const execCwd = executionCwd ?? this.deps.getCwd();
		const resolvedCandidate = path.resolve(execCwd, candidatePath);
		const automations = this.getController().getAutomations();
		const defaultCwd = this.deps.getCwd();

		for (const automation of automations) {
			const authoringCwd = automation.workspaceCwd ?? defaultCwd;
			const resolvedScript = path.resolve(authoringCwd, automation.path);
			const isMatch =
				process.platform === "win32"
					? resolvedCandidate.toLowerCase() === resolvedScript.toLowerCase()
					: resolvedCandidate === resolvedScript;
			if (isMatch) {
				return { name: automation.name, path: automation.path };
			}
		}
		return undefined;
	}

	/**
	 * Actionable gate check for direct shell command executions (bash/powershell/shell).
	 * Uses AST parser without loose whitespace fallback. Resolves candidate relative to executionCwd
	 * and registered script relative to authoringCwd.
	 */
	checkDirectScriptExecution(command: string, cwd?: string): { block: true; reason: string } | undefined {
		const trimmed = command.trim();
		if (!trimmed) return undefined;

		const automations = this.getController().getAutomations();
		if (automations.length === 0) return undefined;

		const parsed = parseShellCommandSequence(command, { redirects: "drop" });
		if (!parsed) return undefined;

		for (const argv of parsed.invocations) {
			const candidates = extractInvocationScriptCandidates(argv);
			for (const candidate of candidates) {
				const matched = this.matchesRegisteredScript(candidate, cwd);
				if (matched) {
					return {
						block: true,
						reason: `Direct shell execution of registered automation script "${matched.name}" (${matched.path}) is gated. Use 'task_automation' (run) or 'run_toolkit_script' to execute with verification evidence and audit tracking.`,
					};
				}
			}
		}

		return undefined;
	}

	/**
	 * Actionable gate check for direct run_process tool executions.
	 */
	checkDirectProcessExecution(
		executable: string,
		args: readonly string[] = [],
		cwd?: string,
	): { block: true; reason: string } | undefined {
		const automations = this.getController().getAutomations();
		if (automations.length === 0) return undefined;

		const candidates = extractInvocationScriptCandidates([executable, ...args]);
		for (const candidate of candidates) {
			const matched = this.matchesRegisteredScript(candidate, cwd);
			if (matched) {
				return {
					block: true,
					reason: `Direct process execution of registered automation script "${matched.name}" (${matched.path}) is gated. Use 'task_automation' (run) or 'run_toolkit_script' to execute with verification evidence and audit tracking.`,
				};
			}
		}

		return undefined;
	}

	/**
	 * Delegates context projection to controller.formatContext using bounded projection.
	 * isCurrent() verifies that current SessionManager, cwd, and latest custom entry id match.
	 */
	previewContext(): TaskAutomationContextPlan {
		const session = this.deps.getSessionManager();
		const sessionId = session.getSessionId();
		const latestEntry = session.getLatestCustomEntryOnBranch(TASK_AUTOMATION_STATE_CUSTOM_TYPE);
		const entryId = latestEntry?.id;
		const cwd = this.deps.getCwd();

		const controller = this.getController();
		const formatted = controller.formatContext(INNER_CONTEXT_MAX_BYTES);
		const content = formatted ? `${CONTEXT_WRAPPER_OPEN}${formatted}${CONTEXT_WRAPPER_CLOSE}` : undefined;

		return {
			content,
			isCurrent: () => {
				const currentSession = this.deps.getSessionManager();
				const currentCwd = this.deps.getCwd();
				return (
					currentCwd === cwd &&
					currentSession === session &&
					currentSession.getSessionId() === sessionId &&
					currentSession.getLatestCustomEntryOnBranch(TASK_AUTOMATION_STATE_CUSTOM_TYPE)?.id === entryId
				);
			},
		};
	}
}
