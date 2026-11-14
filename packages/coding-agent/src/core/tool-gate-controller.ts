/**
 * Agent tool-call gate: model-router escalation, autonomy gating, extension tool hooks, and the
 * untrusted-content output boundary.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Provides the two agent-core
 * hooks (`beforeToolCall`/`afterToolCall`) as bound arrow-field members the session installs onto its
 * agent. `beforeToolCall` runs the router escalation, then the autonomy tool gate (recording the
 * outcome when a capability envelope is active), then extension `tool_call` handlers. `afterToolCall`
 * runs extension `tool_result` handlers and structurally fences output from untrusted-content sources.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { harnessLog } from "../kernel/harness-log.ts";
import type { Agent, AgentContext, AgentRequestId, AgentToolCall, BeforeToolCallResult } from "../kernel/index.ts";
import type { CapabilityEnvelope, GateOutcome } from "./autonomy/contracts.ts";
import { classifyAllEdgeOperations, type EdgeClass } from "./autonomy/edge-policy.ts";
import { evaluateToolGateAsync } from "./autonomy/gates.ts";
import { safeRealpathSync } from "./autonomy/path-scope.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { isMutatingToolCall } from "./model-router/tool-escalation.ts";
import { refuseLocalPush } from "./objective-execution/local-commit-delivery.ts";
import { type HostRepositoryEffect, repositoryEffectForCall } from "./objective-execution/repository-effect.ts";
import type {
	RepositoryMutationObserver,
	RepositoryObservationToken,
} from "./objective-execution/repository-mutation-observer.ts";
import { ROUTINE_TOOL_NAME } from "./routines/routine-tool-names.ts";
import { detailsWithRuleIds, type RuleHookDelivery } from "./rule-hooks/rule-hook-delivery.ts";
import { classifyToolTrust, wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { serialCallHint } from "./serial-call-hint.ts";
import type { SoulController } from "./soul/soul-controller.ts";
import type { SystemOneController } from "./system-one/index.ts";
import type { ToolCallFacts } from "./tool-capability-policy.ts";
import type { ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";
import { retireToolCall } from "./tools/file-mutation-queue.ts";
import { LOOKUP_TOOL_NAME } from "./tools/lookup-tool-name.ts";
import type { NestedCall, NestedCallAdmitter, NestedCallPurpose } from "./tools/nested-tool-call.ts";

export const CONTROL_PLANE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"task_steps",
	"goal",
	"create_goal",
	"get_goal",
	"update_goal",
	"task_directory",
	"skill",
	"skill_audit",
	"delegate",
	"tool_task",
	"ask_question",
]);

/**
 * Tools that run sub-calls of other tools (a `lookup`'s requests, a `python` script's `pi_tools` calls); the gate keeps
 * the admitted call's context for them (see `admitNested`).
 */
const NESTED_ADMISSION_TOOL_NAMES: ReadonlySet<string> = new Set([LOOKUP_TOOL_NAME, "python"]);
/**
 * Calls whose context the gate keeps for sub-calls: the carrying tools above, and a routine save, whose watched command or
 * page is admitted as the call its check would make before the watch is armed (`RoutineSessionController`).
 */
const NESTED_PARENT_TOOL_NAMES: ReadonlySet<string> = new Set([...NESTED_ADMISSION_TOOL_NAMES, ROUTINE_TOOL_NAME]);

/** What an admitted parent call's sub-calls are admitted under: the real context of that parent. */
interface NestedParentContext {
	readonly assistantMessage: AssistantMessage;
	readonly requestId: AgentRequestId | undefined;
	readonly context: AgentContext;
}

type BeforeToolCall = NonNullable<Agent["beforeToolCall"]>;
type AfterToolCall = NonNullable<Agent["afterToolCall"]>;

/** Logs a call that a named gate refused, then passes the refusal on unchanged. */
function blockedCall(
	toolName: string,
	gate: string,
	result: BeforeToolCallResult,
	reasonCode?: string,
): BeforeToolCallResult {
	harnessLog.warn("tools", "a gate blocked a tool call", () => ({
		tool: toolName,
		gate,
		...(reasonCode === undefined ? {} : { reasonCode }),
	}));
	return result;
}

function existingObservationCwd(targetDirectory: string): string {
	let candidate = safeRealpathSync(targetDirectory);
	while (true) {
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return safeRealpathSync(candidate);
		} catch {
			// Continue to the nearest existing parent; the file operation's own path gate remains authoritative.
		}
		const parent = dirname(candidate);
		if (parent === candidate) return candidate;
		candidate = parent;
	}
}

export interface ToolGateControllerDeps {
	/**
	 * Execution permission mode. YOLO skips the permission checks (envelope, acquisition, extension
	 * vetoes, script authorization, edge prompts, System One review) and keeps self-regulation: context
	 * compaction, router escalation, the local-commit branch rule and project-rule acceptance.
	 */
	getExecutionMode?(): "guarded" | "yolo";
	gateSelfCompaction?(toolName: string, assistantMessage: AssistantMessage): BeforeToolCallResult | undefined;
	/** Router escalation: block a tool the active cheap route is not allowed to run. */
	maybeEscalateToolCall(toolName: string, args: unknown): { block: true; reason: string } | undefined;
	getCwd(): string;
	/** Active foreground capability envelope, if any — presence enables gate-outcome recording. */
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	/** Record an autonomy gate outcome (only when a capability envelope is active). */
	recordGateOutcome(outcome: GateOutcome): void;
	getExtensionRunner(): ExtensionRunner;
	/** Host-owned relevance gate for optional extension and credential tools. */
	checkToolApplicability?(toolName: string, args: unknown): BeforeToolCallResult | undefined;
	/**
	 * Rule hooks: the standing rules a successful trigger call delivers once per context, appended to that
	 * call's result (see rule-hooks/rule-hook-delivery.ts).
	 */
	ruleHooks?: RuleHookDelivery;
	/** Observe an execution only after all pre-execution gates and extension hooks allow it. */
	getToolSelectionController?(): ToolSelectionController | undefined;
	/**
	 * The edge: an operation class the operator has not granted asks once (or is blocked when no
	 * one can answer); a granted class and ordinary work return undefined.
	 */
	checkEdge?(
		toolName: string,
		args: unknown,
		executionCwd: string | undefined,
		signal: AbortSignal | undefined,
		/** What a sub-call is made for, named to the operator and kept with a draft if the call is held. */
		purpose?: NestedCallPurpose,
	): Promise<BeforeToolCallResult | undefined>;
	/**
	 * Soul gate of a root session: `checkWrite` screens and has System One review the root agent's write or edit of
	 * `<agentDir>/soul.md`, and `settleWrite` reconciles the file once the call has finished (see
	 * soul/soul-controller.ts). Not a permission check, so YOLO does not skip it. Absent in a worker session.
	 */
	soulGate?: Pick<SoulController, "checkWrite" | "settleWrite">;
	/**
	 * System One's operation gate: an operation the deterministic gates cannot decide is judged, then
	 * runs, asks the operator, or is refused (see system-one/operation-gate.ts).
	 */
	checkOperation?(
		toolName: string,
		args: unknown,
		executionCwd: string | undefined,
		signal: AbortSignal | undefined,
		/** What a sub-call is made for, named to the operator if the call is held. */
		purpose?: NestedCallPurpose,
	): Promise<BeforeToolCallResult | undefined>;
	/**
	 * Whether the run in progress is not the owner's own terminal run (it carries a third party's words, or it was opened
	 * from an owner channel): YOLO does not skip `checkOperation` for it.
	 */
	runsOutsideOwnerTerminal?(): boolean;
	/**
	 * Whether the run in progress was opened from an owner channel: YOLO stands for the owner at the terminal, so on such a
	 * run it skips no gate (envelope, acquisition screening, extension blocks, direct-script gate, System One hooks).
	 */
	runsGuardedRemoteOwner?(): boolean;
	/**
	 * Settles the owner's approval a remote-owner call claimed at the edge or the operation gate: `started` when the call's
	 * body starts (its draft is released durably; a release that cannot be written throws an `AgentToolPolicyDeniedError`
	 * and the body does not start), false when a later gate refused it, a check threw or the loop dropped the admitted call
	 * before its body started (only the claim is freed: the approval stays for a call that runs). A call that claimed none,
	 * or one already settled, is a no-op. Without the loop's start and cleanup hooks the call is settled at admission.
	 */
	settleApprovedCall?(args: unknown, started: boolean): void;
	/**
	 * The delegation gate: the root orchestrates, so a call that is task work is refused with the way to delegate it
	 * (see system-one/delegation-gate.ts). It steers, it does not authorize, so YOLO does not skip it.
	 */
	checkDelegation?(
		toolName: string,
		args: unknown,
		executionCwd: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<BeforeToolCallResult | undefined>;
	/**
	 * The owner's words decide what a call may do (grants, a delivery limit, a forbidden tool). They are
	 * classified lazily, so this settles them before the first gate reads any of that state.
	 */
	settleOwnerPolicy?(signal: AbortSignal | undefined): Promise<void>;
	/** An admitted tool call that may change the world (see `isMutatingToolCall`): the work boundary. */
	noteMutatingCall?(toolName: string, assistantMessage: AssistantMessage): void;
	/** The tool's own `readOnly` declaration, when it made one. */
	isToolReadOnly?(toolName: string): boolean | undefined;
	/** Branch this task must commit onto. Set only after System One classifies the request as local commits. */
	localCommitBranch?(): string | undefined;
	/**
	 * The edge classes an admitted call carries (empty for ordinary work), for the delivery projection. What it returns
	 * ends the note when the call is released: a sub-call has no execution end event of its own.
	 */
	noteEdgeOperations?(toolCallId: string, classes: readonly EdgeClass[]): (() => void) | undefined;
	/**
	 * Session identity of the group lock this call's announcement belongs to
	 * (see file-mutation-queue.ts). Omitted retires in the process-wide default scope.
	 */
	getMutationScope?(): string;
	/** Owner of provider-local call ids within the shared mutation scope. */
	getMutationAnnouncer?(): string;
	/** Direct script execution gate: intercepts shell/process execution of registered automation scripts. */
	checkDirectScriptExecution?(toolName: string, args: unknown, cwd?: string): BeforeToolCallResult | undefined;
	/**
	 * External-acquisition gate, at the real execution boundary: a command that fetches, installs or
	 * executes external code is screened before it runs.
	 */
	checkExternalAcquisition?(
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined>;
	/** System One semantic control plane controller, if active for this session/run. */
	getSystemOneController?(): SystemOneController | undefined;
	/**
	 * Semantic duplicate review of the code a successful edit/write added. Returns a note appended to the
	 * tool result (the edit stands; the model is steered to reuse the existing logic), or undefined.
	 */
	reviewNewCode?(input: { toolName: string; args: unknown; cwd: string }): Promise<string | undefined>;
	/**
	 * System One's review of a plan the model just published or changed (task_steps set/intake/add).
	 * Returns a steer appended to the tool result, or undefined when the plan passes.
	 */
	reviewPlan?(input: { toolName: string; args: unknown }): Promise<string | undefined>;
	/**
	 * Mutation-acceptance rule hook. A blocking violation converts the mutation's own result into an
	 * error carrying the violation, so the transition does not proceed on an accepted mutation; a rule
	 * left unsettled keeps the result and appends the note naming what to check.
	 */
	validateMutationAcceptance?(input: {
		toolName: string;
		changedFiles: readonly string[];
		/** The edit's own unified patch, when the tool produced one. */
		patch?: string;
	}): Promise<{ blocked: boolean; explanation?: string; repairId?: string; note?: string } | undefined>;
	/** Successful typed edit/write paths, hashed by the session ledger. */
	noteOwnedWrites?(paths: readonly string[], cwd: string): void;
	/** Bash or run_process changed the checkout, or that fingerprint could not be read. */
	noteShellMutation?(): void;
	/** Session mutation boundary. Absent sessions keep the ledger callbacks above. */
	repositoryObserver?: RepositoryMutationObserver;
	getObjectiveId?(): string;
	deliveryActive?(): boolean;
	hostRepositoryEffect?(toolName: string): HostRepositoryEffect | undefined;
	/** What the tool's owner reads about the target these args name (`ToolCallFacts`); undefined for most tools. */
	toolCallFacts?(toolName: string, args: unknown): ToolCallFacts | undefined;
}

/** File paths a mutation tool call names in its own arguments. */
export function collectMutatedPaths(toolName: string, args: unknown): string[] {
	if (!toolName.includes("edit") && !toolName.includes("write")) return [];
	const record = args as Record<string, unknown> | undefined;
	const paths: string[] = [];
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const value = record?.[key];
		if (typeof value === "string" && value.trim()) paths.push(value);
	}
	const edits = record?.edits;
	if (Array.isArray(edits)) {
		for (const edit of edits) {
			const editPath = (edit as Record<string, unknown> | undefined)?.path;
			if (typeof editPath === "string" && editPath.trim()) paths.push(editPath);
		}
	}
	return [...new Set(paths)];
}

interface AdmittedRepositoryObservation {
	readonly tokens: readonly RepositoryObservationToken[];
	readonly declaredOwnedPaths: readonly string[];
}

interface AdmittedToolInvocation {
	readonly id: string;
	readonly systemOne?: SystemOneController;
	selection?: ToolSelectionController;
	repositoryObservation?: AdmittedRepositoryObservation;
}

/** What a nested sub-call shares with the call that carries it: its own arguments, and that call's message, request and context. */
function nestedCallScope(parent: NestedParentContext, child: NestedCall) {
	return {
		args: child.args,
		assistantMessage: parent.assistantMessage,
		context: parent.context,
		...(parent.requestId !== undefined ? { requestId: parent.requestId } : {}),
		...(child.executionContext ? { executionContext: child.executionContext } : {}),
	};
}

export class ToolGateController {
	private readonly deps: ToolGateControllerDeps;
	// Agent core retains this exact call object from admission through detached finalization.
	// Provider IDs can repeat on later requests while an earlier background call remains live.
	private readonly admittedInvocations = new WeakMap<AgentToolCall, AdmittedToolInvocation>();
	/** Admitted parent calls that run sub-calls, by call id, until the parent call is finalized or dropped. */
	private readonly nestedParents = new Map<string, NestedParentContext>();
	/** What each admitted sub-call is made for, by its call object, while the gate holds it. */
	private readonly nestedPurposes = new WeakMap<AgentToolCall, NestedCallPurpose>();

	constructor(deps: ToolGateControllerDeps) {
		this.deps = deps;
	}

	private async beginObservation(
		toolCallId: string,
		toolName: string,
		args: unknown,
		invocationCwd: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<AdmittedRepositoryObservation | undefined> {
		const observer = this.deps.repositoryObserver;
		if (!observer) return undefined;
		const effect = repositoryEffectForCall({
			toolName,
			args,
			facts: this.deps.toolCallFacts?.(toolName, args),
			deliveryActive: this.deps.deliveryActive?.() ?? false,
			hostEffect: this.deps.hostRepositoryEffect?.(toolName),
		});
		if (effect === "none") return undefined;
		// Direct typed mutations name their exact targets. Observe each target's parent repository,
		// including absolute paths admitted by PathAuthority outside the session launch folder.
		// Shell commands stay rooted at their admitted invocation cwd; parsing commands for `cd`
		// would confuse intent with the process's actual repository scope.
		const baseCwd = invocationCwd ?? this.deps.getCwd();
		const declaredOwnedPaths =
			effect === "typed_owned_write"
				? collectMutatedPaths(toolName, args).map((filePath) => safeRealpathSync(resolve(baseCwd, filePath)))
				: [];
		const candidates = declaredOwnedPaths.map((filePath) => existingObservationCwd(dirname(filePath)));
		const cwds = [...new Set(candidates.length ? candidates : [existingObservationCwd(baseCwd)])];
		const tokens: RepositoryObservationToken[] = [];
		const observedRoots = new Set<string>();
		try {
			for (let index = 0; index < cwds.length; index++) {
				const token = await observer.begin(
					{
						callId: cwds.length === 1 ? toolCallId : `${toolCallId}:repo:${index}`,
						objectiveId: this.deps.getObjectiveId?.() ?? "",
						cwd: cwds[index]!,
						effect,
					},
					signal,
				);
				const rootIdentity = token.repositoryRoot ?? token.cwd;
				if (observedRoots.has(rootIdentity)) {
					await observer.abort(token);
					continue;
				}
				observedRoots.add(rootIdentity);
				tokens.push(token);
			}
			return { tokens, declaredOwnedPaths };
		} catch (error) {
			for (const token of tokens) await observer.abort(token);
			throw error;
		}
	}

	private async finishObservation(
		observation: AdmittedRepositoryObservation | undefined,
		operationSucceeded: boolean,
	): Promise<void> {
		if (!observation) return;
		const results = await Promise.allSettled(
			observation.tokens.map((token) =>
				this.deps.repositoryObserver?.finish({
					token,
					declaredOwnedPaths: observation.declaredOwnedPaths,
					operationSucceeded,
				}),
			),
		);
		const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Repository observation finalization failed", { cause: failures[0] });
	}

	readonly beforeToolCall: BeforeToolCall = async (
		{
			toolCall,
			args,
			executionContext,
			pathAuthority,
			requestId,
			assistantMessage,
			context,
			registerCleanup,
			registerStart,
		},
		signal,
	) => {
		signal?.throwIfAborted();
		await this.deps.settleOwnerPolicy?.(signal);
		signal?.throwIfAborted();
		const yolo = this.deps.getExecutionMode?.() === "yolo" && this.deps.runsGuardedRemoteOwner?.() !== true;
		const selfCompactionBlock = this.deps.gateSelfCompaction?.(toolCall.name, assistantMessage);
		if (selfCompactionBlock) return blockedCall(toolCall.name, "self_compaction", selfCompactionBlock);
		const applicabilityBlock = this.deps.checkToolApplicability?.(toolCall.name, args);
		if (applicabilityBlock) return blockedCall(toolCall.name, "applicability", applicabilityBlock);
		// Session model selection may change during a provider response or any awaited hook.
		const modelRef = `${assistantMessage.provider}/${assistantMessage.model}`;
		const escalation = this.deps.maybeEscalateToolCall(toolCall.name, args);
		if (escalation) {
			return blockedCall(toolCall.name, "router", escalation);
		}
		const refusedPush = refuseLocalPush(
			this.deps.localCommitBranch ? { branch: () => this.deps.localCommitBranch?.() } : undefined,
			toolCall.name,
			args,
		);
		if (refusedPush) return blockedCall(toolCall.name, "local_push", refusedPush);

		// The capability envelope is evaluated twice per call - once on the raw arguments before any
		// extension hook can see them, once on the arguments the hooks actually hand to the tool (a
		// hook may rewrite a path in place) - but it is PUBLISHED once: the pre-hook denial when it
		// rejects, otherwise the final post-hook outcome. The `finally` below is the single owner of
		// that publication, so an early hook block, hook failure or later cancellation still leaves
		// exactly one record - the last envelope decision that actually completed. A call cancelled
		// before any evaluation completes leaves none (there is no decision to record).
		const envelope = yolo ? undefined : structuredClone(this.deps.getCapabilityEnvelope());
		const scopeCwd = this.deps.getCwd();
		const evaluateEnvelope = async (currentArgs: unknown): Promise<GateOutcome> => {
			signal?.throwIfAborted();
			return evaluateToolGateAsync({
				toolName: toolCall.name,
				args: currentArgs,
				// Read per pass: a hook that rewrites the args may name another target.
				facts: this.deps.toolCallFacts?.(toolCall.name, currentArgs),
				cwd: executionContext?.cwd ?? scopeCwd,
				scopeCwd,
				envelope,
				pathAuthority,
				signal,
			});
		};
		const blockedBy = (gateResult: GateOutcome): BeforeToolCallResult | undefined =>
			gateResult.outcome === "block"
				? blockedCall(
						toolCall.name,
						gateResult.gate,
						{
							block: true,
							reason: `Tool execution blocked by autonomy gate [${gateResult.gate}]: ${gateResult.message} (${gateResult.reasonCode})`,
						},
						gateResult.reasonCode,
					)
				: undefined;

		// 1. Pre-hook capability envelope & path bounds check on raw args
		let terminalOutcome = await evaluateEnvelope(args);
		let observation: AdmittedRepositoryObservation | undefined;
		let observationHandedOff = false;
		// Set only where the call is admitted: an owner approval it claimed is kept then, and freed on any other exit.
		let admitted = false;
		try {
			const denied = blockedBy(terminalOutcome);
			if (denied) return denied;

			// External acquisition is screened before any extension hook can rewrite the command, so the
			// bytes the gate judged are the bytes that would have run.
			if (!yolo && this.deps.checkExternalAcquisition) {
				const acquisitionBlock = await this.deps.checkExternalAcquisition(toolCall.name, args, signal);
				if (acquisitionBlock) return blockedCall(toolCall.name, "acquisition", acquisitionBlock);
			}

			// 2. Extension tool_call hooks
			const runner = this.deps.getExtensionRunner();
			let extensionResult: BeforeToolCallResult | undefined;
			if (runner.hasHandlers("tool_call")) {
				try {
					extensionResult = await runner.emitToolCall(
						{
							type: "tool_call",
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							input: args as Record<string, unknown>,
						},
						executionContext,
					);
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
				if (!yolo && extensionResult?.block) return blockedCall(toolCall.name, "extension", extensionResult);
			}

			// 3. Post-hook arguments: direct-script gate, then the envelope on what will really run
			// Hooks rewrite event.input in place. The executor retains this same args object;
			// extension return values carry control decisions, never replacement arguments.
			const effectiveCwd = executionContext?.cwd ?? scopeCwd;
			if (!yolo && this.deps.checkDirectScriptExecution) {
				const directCheck = this.deps.checkDirectScriptExecution(toolCall.name, args, effectiveCwd);
				if (directCheck) {
					return blockedCall(toolCall.name, "direct_script", directCheck);
				}
			}
			terminalOutcome = await evaluateEnvelope(args);
			const deniedAfterHook = blockedBy(terminalOutcome);
			if (deniedAfterHook) return deniedAfterHook;

			// 4. Single edge authorization on the actual final operation
			const purpose = this.nestedPurposes.get(toolCall);
			const edge = await this.deps.checkEdge?.(toolCall.name, args, executionContext?.cwd, signal, purpose);
			if (edge) return blockedCall(toolCall.name, "edge", edge);
			const delegation = await this.deps.checkDelegation?.(toolCall.name, args, executionContext?.cwd, signal);
			if (delegation) return blockedCall(toolCall.name, "delegation", delegation);
			// YOLO skips the operation gate on the owner's own terminal runs only: it is not a grant to a third party's words,
			// and it stands for the owner at the terminal, not on a phone.
			const operation =
				yolo && !this.deps.runsOutsideOwnerTerminal?.()
					? undefined
					: await this.deps.checkOperation?.(toolCall.name, args, executionContext?.cwd, signal, purpose);
			if (operation) return blockedCall(toolCall.name, "operation", operation);
			const soulWrite = await this.deps.soulGate?.checkWrite(toolCall, args, effectiveCwd, signal, registerCleanup);
			if (soulWrite) return blockedCall(toolCall.name, "soul", soulWrite);

			// 5. System One semantic tool gate
			const isControlPlaneTool = CONTROL_PLANE_TOOL_NAMES.has(toolCall.name);
			const edgeOperations = classifyAllEdgeOperations({
				toolName: toolCall.name,
				args,
				cwd: executionContext?.cwd ?? scopeCwd,
				scopeCwd,
			});
			const isOperatorAuthorizedEdge = edgeOperations.length > 0;
			const endEdgeNote = this.deps.noteEdgeOperations?.(
				toolCall.id,
				edgeOperations.map((operation) => operation.class),
			);
			if (endEdgeNote) registerCleanup?.(endEdgeNote);

			// Operator edge authorization outranks advisory semantic tool gates;
			// control-plane tools are internal harness operations, not untrusted repo inputs.
			const systemOne = this.deps.getSystemOneController?.();
			const impact =
				toolCall.name === "bash"
					? "local_reversible"
					: toolCall.name.includes("edit") || toolCall.name.includes("write")
						? "repo_mutation"
						: "read_only";
			if (systemOne && !yolo && !isControlPlaneTool && !isOperatorAuthorizedEdge) {
				if (systemOne.hookCoordinator?.hasExtensions()) {
					const beforeToolResult = await systemOne.hookCoordinator.runHook("before_tool", {
						schema_version: "1.0",
						run_id: systemOne.store.runId,
						session_id: systemOne.store.runId,
						hook: "before_tool",
						impact,
						tool: toolCall.name,
						metadata: { args },
					});
					if (beforeToolResult?.decision === "deny") {
						return blockedCall(
							toolCall.name,
							"system_one_before_tool",
							{
								block: true,
								reason:
									beforeToolResult.reasonCodes.join(", ") ||
									"Tool execution blocked by integrity before_tool hook",
							},
							beforeToolResult.reasonCodes.join(","),
						);
					}
					if (impact === "repo_mutation") {
						const beforeMutationResult = await systemOne.hookCoordinator.runHook("before_mutation", {
							schema_version: "1.0",
							run_id: systemOne.store.runId,
							session_id: systemOne.store.runId,
							hook: "before_mutation",
							impact,
							tool: toolCall.name,
							metadata: { args },
						});
						if (beforeMutationResult?.decision === "deny") {
							return blockedCall(
								toolCall.name,
								"system_one_before_mutation",
								{
									block: true,
									reason:
										beforeMutationResult.reasonCodes.join(", ") ||
										"Tool execution blocked by integrity before_mutation hook",
								},
								beforeMutationResult.reasonCodes.join(","),
							);
						}
					}
				}
			}
			const invocation: AdmittedToolInvocation = {
				id: randomUUID(),
				...(systemOne && !isControlPlaneTool ? { systemOne } : {}),
			};
			this.admittedInvocations.set(toolCall, invocation);
			registerCleanup?.(() => {
				if (this.admittedInvocations.get(toolCall) !== invocation) return;
				this.admittedInvocations.delete(toolCall);
				invocation.selection?.discard(invocation.id);
				invocation.systemOne?.recordToolTerminal({ call_id: invocation.id, succeeded: false, aborted: true });
				// Cancellation after awaited admission has no execution terminal hook. The observer
				// retains activity until its async journal close ends; no child has run at this point.
				void Promise.allSettled(
					(invocation.repositoryObservation?.tokens ?? []).map((token) =>
						this.deps.repositoryObserver?.abort(token),
					),
				);
			});
			// Recorded, not judged: the call's relevance and scope are judged once per step in postflight,
			// where the step and its evidence are known. Edge operations are recorded too.
			if (systemOne && !isControlPlaneTool) {
				systemOne.recordToolCall({ tool: toolCall.name, args, impact, call_id: invocation.id });
			}
			// Admitted: a call that may change the world opens the work boundary when no work is declared.
			if (!isControlPlaneTool && isMutatingToolCall(toolCall.name, args, this.deps.isToolReadOnly?.(toolCall.name)))
				this.deps.noteMutatingCall?.(toolCall.name, assistantMessage);

			try {
				const selection = this.deps.getToolSelectionController?.();
				if (selection) {
					invocation.selection = selection;
					selection.begin(invocation.id, toolCall.name, args, { modelRef, requestId });
				}
			} catch {
				// Advisory ranking/storage reads cannot deny an otherwise authorized operation.
			}
			observation = await this.beginObservation(invocation.id, toolCall.name, args, executionContext?.cwd, signal);
			if (observation) {
				observationHandedOff = true;
				invocation.repositoryObservation = observation;
			}
			harnessLog.trace("tools", "a tool call was admitted", () => ({
				tool: toolCall.name,
				edge: edgeOperations.map((operation) => operation.class),
				yolo,
			}));
			// A parent that runs sub-calls keeps the context it was admitted under until it is finalized or dropped;
			// without a cleanup owner nothing would release it, so it keeps none and its sub-calls are refused.
			if (NESTED_PARENT_TOOL_NAMES.has(toolCall.name) && registerCleanup) {
				const parent: NestedParentContext = { assistantMessage, requestId, context };
				this.nestedParents.set(toolCall.id, parent);
				registerCleanup(() => {
					if (this.nestedParents.get(toolCall.id) === parent) this.nestedParents.delete(toolCall.id);
				});
			}
			admitted = true;
			return yolo ? undefined : extensionResult;
		} finally {
			try {
				// An admitted call keeps the owner approval it claimed until its body starts (the draft is released then, and
				// a release that cannot be written stops the start) or the loop drops it unstarted (its preparation cleanup
				// frees the approval and writes nothing).
				if (admitted && registerStart && registerCleanup) {
					registerStart(() => this.deps.settleApprovedCall?.(args, true));
					registerCleanup(() => this.deps.settleApprovedCall?.(args, false));
				} else this.deps.settleApprovedCall?.(args, admitted);
			} finally {
				if (observation && !observationHandedOff) {
					for (const token of observation.tokens) {
						await this.deps.repositoryObserver?.finish({ token, operationSucceeded: false });
					}
				}
				// A later abort does not invalidate a decision the envelope already made; the pre-hook
				// evaluation above either completed (and is published) or threw before this block exists.
				if (envelope) this.deps.recordGateOutcome(terminalOutcome);
			}
		}
	};

	/**
	 * Admission of one sub-call of an admitted parent call (a lookup's requests, a script's tool calls). The sub-call is a call like any
	 * other: it goes through `beforeToolCall` with its own tool name, arguments and binding, under the parent's real
	 * request, so the envelope, path authority, router, extension hooks, edge, operation, delegation, soul and
	 * System One checks all apply to it as they would to a standalone call; an admitted one is closed through
	 * `afterToolCall` (result hooks, selection and terminal records). A parent this gate did not admit has no context
	 * to lend, so every sub-call of it is refused.
	 */
	readonly admitNested: NestedCallAdmitter = async (parentToolCallId, child, signal) => {
		const parent = this.nestedParents.get(parentToolCallId);
		if (!parent) return { kind: "refused", reason: "the call that asked for this was not admitted for sub-requests" };
		if (NESTED_ADMISSION_TOOL_NAMES.has(child.toolName)) {
			return { kind: "refused", reason: `${child.toolName} cannot run as a sub-call of another tool call` };
		}
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: child.id,
			name: child.toolName,
			arguments: child.args,
		};
		if (child.purpose) this.nestedPurposes.set(toolCall, child.purpose);
		const cleanups: (() => void)[] = [];
		const starts: (() => void)[] = [];
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			const errors: unknown[] = [];
			for (const cleanup of cleanups.splice(0)) {
				try {
					cleanup();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "Sub-call cleanup failed");
		};
		let decision: BeforeToolCallResult | undefined;
		try {
			decision = await this.beforeToolCall(
				{
					toolCall,
					...nestedCallScope(parent, child),
					...(child.pathAuthority ? { pathAuthority: child.pathAuthority } : {}),
					registerCleanup(cleanup) {
						if (released) cleanup();
						else cleanups.push(cleanup);
					},
					registerStart(onStart) {
						starts.push(onStart);
					},
				},
				signal,
			);
		} catch (error) {
			try {
				release();
			} catch {
				// The refusal or abort that stopped admission is the reported cause.
			}
			throw error;
		}
		if (decision?.block) {
			release();
			return {
				kind: "refused",
				reason: [decision.reason ?? "blocked by the session's tool policy", decision.correction]
					.filter((part): part is string => part !== undefined && part.length > 0)
					.join(" "),
			};
		}
		return {
			kind: "admitted",
			start: () => {
				for (const onStart of starts.splice(0)) onStart();
			},
			finish: async (result, isError, finishSignal) => {
				try {
					const finalized = await this.afterToolCall(
						{
							toolCall,
							result,
							isError,
							...nestedCallScope(parent, child),
						},
						finishSignal,
					);
					return { content: finalized?.content ?? result.content, isError: finalized?.isError ?? isError };
				} finally {
					release();
				}
			},
			abandon: release,
			consume: () => {
				try {
					for (const onStart of starts.splice(0)) onStart();
				} finally {
					release();
				}
			},
		};
	};

	readonly afterToolCall: AfterToolCall = async ({
		toolCall,
		args,
		result,
		isError,
		executionContext,
		assistantMessage,
		context,
	}) => {
		// Execution terminal for the emission-order announcement the reservation made: this call can no
		// longer start a file mutation, so a sibling exclusive run emitted after it must stop waiting.
		// Retired first and synchronously, before any hook here can throw -- a write rejected by its own
		// preflight would otherwise park a later bash in the same batch for the rest of the turn.
		retireToolCall(toolCall.id, this.deps.getMutationScope?.(), this.deps.getMutationAnnouncer?.());
		const invocation = this.admittedInvocations.get(toolCall);
		this.admittedInvocations.delete(toolCall);
		const selection = invocation?.selection;
		let finishSucceeded = !isError;
		try {
			const soulNotice = await this.deps.soulGate?.settleWrite(toolCall, !isError);
			const runner = this.deps.getExtensionRunner();
			let content = result.content;
			let details = result.details;
			let usage = result.usage;
			let terminate = result.terminate;
			let resolvedIsError = isError;

			if (runner.hasHandlers("tool_result")) {
				const hookResult = await runner.emitToolResult(
					{
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content,
						details,
						isError,
						usage,
					},
					executionContext,
				);
				if (hookResult) {
					content = hookResult.content ?? content;
					details = hookResult.details;
					resolvedIsError = hookResult.isError ?? isError;
					usage = hookResult.usage ?? usage;
					if (hookResult.terminate !== undefined) terminate = hookResult.terminate;
				}
			}

			// Untrusted-content boundary: structurally fence output from attacker-controllable sources
			// (web/search, subagents, recall, third-party tools) so injection payloads are framed as data.
			// First-party tools (read/grep/find/ls/edit/write/bash) are trusted and pass through unchanged.
			if (classifyToolTrust(toolCall.name) === "untrusted") {
				const source = `tool:${toolCall.name}`;
				const wrapped = content.map((block) =>
					block.type === "text" ? { ...block, text: wrapUntrustedText(block.text, source) } : block,
				);
				content = wrapped;
			}

			if (invocation) selection?.complete(invocation.id, !resolvedIsError, content);

			const systemOne = this.deps.getSystemOneController?.();
			invocation?.systemOne?.recordToolTerminal({
				call_id: invocation.id,
				succeeded: !resolvedIsError,
				output: content,
			});
			if (systemOne?.hookCoordinator?.hasExtensions()) {
				const isMutation = toolCall.name.includes("edit") || toolCall.name.includes("write");
				if (isMutation) {
					await systemOne.hookCoordinator.runHook("after_mutation", {
						schema_version: "1.0",
						run_id: systemOne.store.runId,
						session_id: systemOne.store.runId,
						hook: "after_mutation",
						impact: "repo_mutation",
						tool: toolCall.name,
					});
				}
				await systemOne.hookCoordinator.runHook("after_tool", {
					schema_version: "1.0",
					run_id: systemOne.store.runId,
					session_id: systemOne.store.runId,
					hook: "after_tool",
					impact: isMutation ? "repo_mutation" : toolCall.name === "bash" ? "local_reversible" : "read_only",
					tool: toolCall.name,
				});
			}
			// Mutation acceptance: project rules are evaluated on the files this call actually changed,
			// before the successful result is accepted into the transcript. A blocking violation makes
			// this result an error; the RepairWork it queued is durable on the session.
			if (!resolvedIsError) {
				const changedFiles = collectMutatedPaths(toolCall.name, args);
				if (changedFiles.length > 0 && this.deps.validateMutationAcceptance) {
					const patch = (details as { patch?: unknown } | undefined)?.patch;
					const verdict = await this.deps.validateMutationAcceptance({
						toolName: toolCall.name,
						changedFiles,
						...(typeof patch === "string" ? { patch } : {}),
					});
					if (verdict?.blocked) {
						const repair = verdict.repairId ? ` RepairWork ${verdict.repairId} is queued.` : "";
						harnessLog.warn("tools", "project rules rejected a mutation", () => ({
							tool: toolCall.name,
							repairQueued: repair !== "",
						}));
						return {
							content: [
								{
									type: "text",
									text: `Mutation rejected by project rules: ${verdict.explanation ?? "rule violation"}.${repair}`,
								},
							],
							details,
							isError: true,
							usage,
							terminate,
						};
					}
					if (verdict?.note) content = [...content, { type: "text", text: verdict.note }];
				}
				const planSteer = await this.deps.reviewPlan?.({ toolName: toolCall.name, args });
				if (planSteer) content = [...content, { type: "text", text: planSteer }];
				if (changedFiles.length > 0) {
					this.deps.noteOwnedWrites?.(changedFiles, executionContext?.cwd ?? this.deps.getCwd());
					const duplicateNote = await this.deps.reviewNewCode?.({
						toolName: toolCall.name,
						args,
						cwd: executionContext?.cwd ?? this.deps.getCwd(),
					});
					if (duplicateNote) content = [...content, { type: "text", text: duplicateNote }];
				}
				// Last, after every step that can still turn the result into an error: only a result that
				// stands carries a rule, and a rule is never fenced as untrusted output.
				const ruleBlocks =
					this.deps.ruleHooks?.collect({
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						args,
						cwd: executionContext?.cwd ?? this.deps.getCwd(),
						assistantMessage,
					}) ?? [];
				if (ruleBlocks.length > 0) {
					content = [...content, ...ruleBlocks.map(({ text }) => ({ type: "text" as const, text }))];
					// The delivered-once check reads the ids from details: they outlive the text, which context packing replaces.
					details = detailsWithRuleIds(
						details,
						ruleBlocks.map(({ id }) => id),
					);
				}
			}
			// A reverted soul.md change is told to the model in the result of the call that made it.
			if (soulNotice) content = [...content, { type: "text", text: soulNotice }];
			const serialNote = resolvedIsError
				? undefined
				: serialCallHint(context.messages, assistantMessage, context.tools);
			if (serialNote) content = [...content, { type: "text", text: serialNote }];
			finishSucceeded = !resolvedIsError;

			if (
				content === result.content &&
				details === result.details &&
				resolvedIsError === isError &&
				usage === result.usage &&
				terminate === result.terminate
			) {
				return undefined;
			}
			return { content, details, isError: resolvedIsError, usage, terminate };
		} finally {
			// Result hooks can fail before complete(). A terminal call must retain no pending
			// observation; a projection failure is not evidence that the tool itself failed.
			if (invocation) selection?.discard(invocation.id);
			await this.finishObservation(invocation?.repositoryObservation, finishSucceeded);
		}
	};
}
