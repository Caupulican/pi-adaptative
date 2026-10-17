import "../builtin-install.ts";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CheckOptions, LockOptions, UnlockOptions } from "proper-lockfile";
import { expect } from "vitest";
import { stateFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession, AgentSessionEvent } from "../../../../src/core/agent-session.ts";
import { getDirectoryResourceProfileInfo } from "../../../../src/core/settings/settings-rules.ts";
import type { Settings } from "../../../../src/core/settings/settings-schema.ts";
import type { ExecutionState } from "../../../../src/core/system-one/types.ts";
import { OPTIONAL_TOOL_INTENT_CUSTOM_TYPE } from "../../../../src/core/tool-applicability-gate.ts";
import { localFileMutationIntentOperations } from "../../../../src/core/tools/file-mutation-intent.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import type { ScriptedRequest, ScriptStep } from "../scripted-provider.ts";
import { HARNESS_PROVIDER } from "../scripted-provider.ts";
import {
	HARNESS_PROJECT_CWD,
	type HarnessWorld,
	type HarnessWorldOptions,
	projectPath,
	runHarnessWorld,
	type SystemOneDecodedRequest,
	withDeadline,
} from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */

export interface ProperLockfile {
	lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	lockSync(file: string, options?: LockOptions): () => void;
	unlock(file: string, options?: UnlockOptions): Promise<void>;
	unlockSync(file: string, options?: UnlockOptions): void;
	check(file: string, options?: CheckOptions): Promise<boolean>;
	checkSync(file: string, options?: CheckOptions): boolean;
}

export const lockfileFs: { current: object | undefined } = { current: undefined };
export const properLockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;
export const bindVirtualFs = <T extends object>(options: T | undefined): T => {
	if (lockfileFs.current === undefined) throw new Error("proper-lockfile used outside a harness world");
	return { ...options, fs: lockfileFs.current } as T;
};
for (const name of ["lock", "lockSync", "unlock", "unlockSync", "check", "checkSync"] as const) {
	const original = properLockfile[name] as (file: string, options?: object) => unknown;
	Object.assign(properLockfile, {
		[name]: (file: string, options?: object) => original(file, bindVirtualFs(options)),
	});
}

/** Each of the three journeys runs completely in both modes, with fresh storage and the same native owners. */
export async function runJourney(
	options: Omit<HarnessWorldOptions, "systemOneEnabled">,
	body: (world: HarnessWorld) => Promise<void>,
): Promise<void> {
	for (const systemOneEnabled of [true, false]) {
		try {
			await runHarnessWorld(
				{ ...options, name: `${options.name}-system-one-${systemOneEnabled ? "on" : "off"}`, systemOneEnabled },
				async (world) => {
					lockfileFs.current = world.io.nodeFsExports();
					await body(world);
				},
			);
		} catch (error) {
			throw new Error(`${options.name}, System One ${systemOneEnabled ? "on" : "off"}: ${failureText(error)}`, {
				cause: error,
			});
		} finally {
			// Clear only after every session and store has settled; their cleanup still needs the virtual locks.
			lockfileFs.current = undefined;
		}
	}
}

export const LIMITS_PATH = projectPath("src", "limits.ts");
export const E0_SRC_PATH = projectPath("src");
/** The two raw deltas a read path streams as: the first ends inside the directory name, the second starts at its separator. */
export const E0_FIRST_DELTA = JSON.stringify({ path: E0_SRC_PATH }).slice(0, -2);
export const E0_SECOND_DELTA = `${JSON.stringify(LIMITS_PATH.slice(E0_SRC_PATH.length)).slice(1, -1)}"}`;
export const TASK_REQUEST = `Read ${LIMITS_PATH}, change MAX_RETRIES from 3 to 5, and remember that I prefer tabs over spaces.`;
export const FOLLOW_UP_REQUEST = "Also keep the tab preference in mind.";

/** One production reference captured at module evaluation; every world must route it to its own tree. */
export const CAPTURED_ACCESS = localFileMutationIntentOperations.access;

/**
 * The summarizer's scripted checkpoint. Production verifies it against the session's facts (read/edited files,
 * the active request, mandatory rules, open problems, done actions) and accepts it only when it carries them.
 */
export const COMPACTION_SUMMARY = [
	"## Active Task",
	`User: Read ${LIMITS_PATH}, change MAX_RETRIES from 3 to 5, and remember that I prefer tabs over spaces.`,
	"",
	"### Mandatory Rules",
	"(none)",
	"",
	"## Working Set",
	`- ${LIMITS_PATH} — EDIT`,
	"",
	"## Files",
	`- ${LIMITS_PATH}`,
	"",
	"## Open Problems",
	"(none)",
	"",
	"## Done",
	`1. READ ${LIMITS_PATH}`,
	`2. EDIT ${LIMITS_PATH}`,
	"3. MEMORY saved the owner's tab preference to USER.md",
	"",
	"## Key Decisions",
	"- MAX_RETRIES is set to 5 as the owner asked.",
	"",
	"## Constraints & Preferences",
	"- The owner prefers tabs over spaces.",
	"",
	"## Critical Context",
	`- ${LIMITS_PATH} holds MAX_RETRIES = 5 after the edit.`,
].join("\n");

/**
 * The orchestration root's checkpoint while its verification obligation is open: the file it edited, the revision it
 * left failing, and the actions it took. Production verifies the recall of these facts before it accepts the checkpoint.
 */
export const CHECKPOINT_SUMMARY = [
	"## Active Task",
	"User: Retire the checks and check completion again.",
	"",
	"### Mandatory Rules",
	"(none)",
	"",
	"## Working Set",
	`- ${LIMITS_PATH} — EDIT`,
	"",
	"## Files",
	`- ${LIMITS_PATH}`,
	"",
	"## Open Problems",
	"- The vitest run at MAX_RETRIES = 4 failed; its verification obligation is still open.",
	"",
	"## Done",
	`1. EDIT ${LIMITS_PATH} to MAX_RETRIES = 4`,
	"2. BASH the vitest run failed at MAX_RETRIES = 4",
	"",
	"## Key Decisions",
	"- MAX_RETRIES is set to 4 for the revision check.",
	"",
	"## Constraints & Preferences",
	"(none)",
	"",
	"## Critical Context",
	`- ${LIMITS_PATH} holds MAX_RETRIES = 4 at the checkpoint.`,
].join("\n");

/**
 * The control-plane bundle's entries: the path module decides containment (relative, never a separator-suffixed prefix, so Windows
 * separators classify the same way), lease directories are excluded by path component, and SQLite files by name.
 */
export function bundleEntries(entries: ReadonlyMap<string, string>, bundleDir: string): Array<[string, string]> {
	const selected: Array<[string, string]> = [];
	for (const [path, content] of entries) {
		const within = relative(bundleDir, path);
		if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
		if (within.split(sep).includes(".leases")) continue;
		if (/\.(sqlite|db)(-wal|-shm|-journal)?$/.test(path)) continue;
		selected.push([path, content]);
	}
	return selected;
}

/** Every message of a failure, including the members of an aggregate, so a wrapped diagnostic is still matched. */
export function failureText(error: unknown): string {
	if (error instanceof AggregateError) return error.errors.map(failureText).join(" | ");
	return error instanceof Error ? error.message : String(error);
}

/** Counters of the E0 stages a bound request actually carried, read by the journey after its integrate turn. */
export interface E0Counters {
	preflight: number;
	postflight: number;
	toolGate: number;
	preflightEvidence: number;
	postflightEvidence: number;
	/** Completion preflight rows (evidence_view) that carry the admitted integration observation. */
	integrationPreflightRows: number;
	/** Completion postflight rows (new_evidence) that carry the admitted integration observation. */
	integrationPostflightRows: number;
	/** Completion outcome_evidence rows that select the admitted integration observation by id, text and trust. */
	completionOutcomeRows: number;
	/** Completion verification_matrix rows bound one-to-one to the store's verification runs. */
	verificationRows: number;
	/** Completion requests that carry an acceptance_matrix field: a branch count, so an empty matrix is still proven transported. */
	acceptanceMatrixRequests: number;
	/** Completion requests that carry a verification_matrix field: a branch count, so an empty matrix is still proven transported. */
	verificationMatrixRequests: number;
}

export function zeroE0Counters(): E0Counters {
	return {
		preflight: 0,
		postflight: 0,
		toolGate: 0,
		preflightEvidence: 0,
		postflightEvidence: 0,
		integrationPreflightRows: 0,
		integrationPostflightRows: 0,
		completionOutcomeRows: 0,
		verificationRows: 0,
		acceptanceMatrixRequests: 0,
		verificationMatrixRequests: 0,
	};
}

/**
 * Binds one admitted System One request of an explicit root turn to the native store and the session's message count, before its
 * answer. The stage is the state shape: the tool gate carries tool_request, postflight carries last_action, preflight carries
 * current_step.action_class. Ids and trust are compared with the store's own fresh observations; redacted text and locator are not
 * compared, since the test holds no independent redaction output. Requests of any other shape bind nothing and count nothing.
 */
export function bindE0Request(
	request: SystemOneDecodedRequest,
	snapshot: ExecutionState,
	messageCount: number,
	counters: E0Counters,
): void {
	if (!isRecordObject(request.state)) throw new Error("the E0 request carries no state record");
	const state = request.state;
	const fresh = new Map(snapshot.observations.filter((o) => o.freshness === "fresh").map((o) => [o.id, o] as const));
	const activeStep = snapshot.plan.steps.find((step) => step.status === "active");
	const stepGoal = activeStep?.goal ?? snapshot.objective.normalized_goal;
	const bindEvidence = (rows: unknown, label: string, requireTrust: boolean): number => {
		if (!Array.isArray(rows)) throw new Error(`the E0 ${label} is not a list`);
		for (const row of rows) {
			if (!isRecordObject(row) || typeof row.id !== "string") throw new Error(`the E0 ${label} row carries no id`);
			const observation = fresh.get(row.id);
			if (observation === undefined)
				throw new Error(`the E0 ${label} row ${row.id} is not a fresh store observation`);
			if (requireTrust && row.trust !== observation.source.trust) {
				throw new Error(`the E0 ${label} row ${row.id} trust differs from its store observation`);
			}
		}
		return rows.length;
	};
	if ("tool_request" in state) {
		// Goal-only current step: present exactly when the store holds an active step or a normalized goal to act on.
		const current = state.current_step;
		if ((current !== undefined) !== stepGoal.trim().length > 0) {
			throw new Error("the E0 tool gate's current step disagrees with the store's active goal intent");
		}
		if (current !== undefined && (!isRecordObject(current) || Object.keys(current).join(",") !== "goal")) {
			throw new Error("the E0 tool gate's current step is not goal-only");
		}
		counters.toolGate += 1;
		return;
	}
	if ("last_action" in state) {
		if (!isRecordObject(state.current_step) || state.current_step.id !== String(messageCount)) {
			throw new Error(`the E0 postflight step id is not the admitted boundary ${messageCount}`);
		}
		counters.postflight += 1;
		counters.postflightEvidence += bindEvidence(state.new_evidence, "new_evidence", false);
		return;
	}
	if (isRecordObject(state.current_step) && "action_class" in state.current_step) {
		if (state.current_step.id !== String(messageCount + 1)) {
			throw new Error(`the E0 preflight step id is not the admitted boundary ${messageCount + 1}`);
		}
		counters.preflight += 1;
		counters.preflightEvidence += bindEvidence(state.evidence_view, "evidence_view", true);
	}
}

/**
 * Completion relations of one admitted completion request, bound to the native store and the goal's requirements. Each request that
 * carries a matrix field counts once for that field, so an empty matrix is proven transported by its branch count. When the acceptance
 * matrix is transported, each row must name the native store criterion and the native goal requirement of the same id, with the store's
 * required, status and evidence ids, and the requirement's text. The selected outcome row for the integration observation must be the
 * criterion of the requirement that cites the admitted integration evidence, and carry that requirement's text and the admitted summary.
 * The verification matrix, when transported, must name exactly the store's runs by id, status and covered acceptance ids.
 */
export function bindE0Completion(
	request: SystemOneDecodedRequest,
	snapshot: ExecutionState,
	requirements: readonly { readonly id: string; readonly text: string; readonly evidenceIds: readonly string[] }[],
	integration: { readonly id: string; readonly uri?: string },
	counters: E0Counters,
): void {
	if (!isRecordObject(request.state)) return;
	const state = request.state;
	const observation = snapshot.observations.find(
		(o) =>
			o.freshness === "fresh" && o.source.content_hash === integration.id && o.source.locator === integration.uri,
	);
	if (observation === undefined) return;
	const summary = "vitest passed: MAX_RETRIES is 5 and the late module is landed";
	if (Array.isArray(state.acceptance_matrix)) {
		counters.acceptanceMatrixRequests += 1;
		for (const row of state.acceptance_matrix) {
			const native = isRecordObject(row)
				? snapshot.objective.acceptance_criteria.find((c) => c.id === row.id)
				: undefined;
			const requirement = isRecordObject(row) ? requirements.find((r) => r.id === row.id) : undefined;
			expect(
				isRecordObject(row) &&
					native !== undefined &&
					requirement !== undefined &&
					row.required === native.required &&
					row.status === native.status &&
					JSON.stringify(row.evidence_ids) === JSON.stringify(native.evidence_ids) &&
					row.text === requirement.text,
				"each transported acceptance row is the native criterion of its native requirement",
			).toBe(true);
		}
	}
	if (Array.isArray(state.outcome_evidence)) {
		for (const outcome of state.outcome_evidence) {
			if (!isRecordObject(outcome) || !Array.isArray(outcome.evidence)) continue;
			for (const item of outcome.evidence) {
				if (!isRecordObject(item) || item.id !== observation.id) continue;
				expect(item.text, "the selected integration row carries its admitted summary text").toBe(summary);
				expect(item.trust, "the selected integration row carries its store trust").toBe(observation.source.trust);
				expect(
					observation.source.locator,
					"the selected integration observation is the verify-integration-1 receipt",
				).toBe("verify-integration-1");
				const citing = requirements.find((r) => r.evidenceIds.includes(integration.id));
				expect(
					citing !== undefined && outcome.criterion_id === citing.id && outcome.text === citing.text,
					"the selected integration row is the criterion of the native requirement that cites the admitted evidence",
				).toBe(true);
				counters.completionOutcomeRows += 1;
			}
		}
	}
	if (Array.isArray(state.verification_matrix)) {
		counters.verificationMatrixRequests += 1;
		const runs = snapshot.verification;
		expect(
			state.verification_matrix.length,
			"the transported verification matrix names exactly the store's runs",
		).toBe(runs.length);
		for (const row of state.verification_matrix) {
			const run = isRecordObject(row) ? runs.find((candidate) => candidate.id === row.id) : undefined;
			expect(
				run !== undefined && isRecordObject(row) && row.status === run.status,
				"each transported verification row matches its store run by id and status",
			).toBe(true);
			expect(
				isRecordObject(row) &&
					JSON.stringify(row.covers_acceptance_ids) === JSON.stringify(run?.covers_acceptance_ids),
				"each transported verification row covers the store run's acceptance ids",
			).toBe(true);
			counters.verificationRows += 1;
		}
	}
}

/**
 * Decoded-request oracle for an owner-input phase. The owner words System One classifies must be the phase's own
 * inputs, the screened messages must be the owner's queued messages, and the previous intent must be the one the
 * session's latest persisted entry holds. Every expected value comes from scenario literals and native entries,
 * never from the projector under test. A request the oracle rejects fails the journey before any answer is sent.
 */
export function expectOwnerWords(input: {
	readonly sessionManager: () => SessionManager;
	readonly userRequests?: readonly string[];
	readonly ownerMessages?: readonly string[];
	readonly optionalToolNames: readonly string[];
}): (request: SystemOneDecodedRequest) => void {
	return (request) => {
		const state = request.state as Record<string, unknown>;
		if ("user_request" in state) {
			if (input.userRequests === undefined || !input.userRequests.includes(state.user_request as string)) {
				throw new Error(
					`user_request is not one of the phase's owner inputs: ${JSON.stringify(state.user_request)}`,
				);
			}
			// A judgment into the committed chain appends a paused entry before it classifies, and a queued input's staged
			// judgment appends nothing, so the expected previous intent is the newest entry that is classified: the native
			// ledger the intake continues from.
			let classifiedTask: string | null = null;
			for (const entry of input.sessionManager().getEntries()) {
				if (entry.type !== "custom" || entry.customType !== OPTIONAL_TOOL_INTENT_CUSTOM_TYPE) continue;
				const data = entry.data;
				if (typeof data === "object" && data !== null && "status" in data && data.status === "classified") {
					classifiedTask = "taskRequest" in data && typeof data.taskRequest === "string" ? data.taskRequest : null;
				}
			}
			const previous = state.previous_optional_tool_intent;
			const previousTask =
				typeof previous === "object" && previous !== null && "taskRequest" in previous
					? previous.taskRequest
					: null;
			if (previousTask !== classifiedTask) {
				throw new Error(
					`previous_optional_tool_intent is not the session's classified intent: ${JSON.stringify(previousTask)}`,
				);
			}
			const tools = Array.isArray(state.optional_tools) ? state.optional_tools : [];
			const names = tools.map((tool) =>
				typeof tool === "object" && tool !== null ? (tool as { toolName?: unknown }).toolName : undefined,
			);
			if (JSON.stringify(names) !== JSON.stringify(input.optionalToolNames)) {
				throw new Error(
					`optional_tools carries ${JSON.stringify(names)}, expected ${JSON.stringify(input.optionalToolNames)}`,
				);
			}
		}
		if ("owner_messages" in state) {
			if (JSON.stringify(state.owner_messages) !== JSON.stringify(input.ownerMessages)) {
				throw new Error(
					`owner_messages is ${JSON.stringify(state.owner_messages)}, expected ${JSON.stringify(input.ownerMessages)}`,
				);
			}
		}
	};
}

/** One line per tool result the production loop recorded, so an assertion failure names the failing call. */
/** The shape a persisted worker conversation line carries: a bare message or an entry that wraps one. */
export interface WireRecord {
	readonly role?: string;
	readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly id?: string }>;
}

/** The assistant text persisted in the admitted worker conversation for the message that carries one call id. */
export function persistedGenerationText(
	world: {
		readonly io: {
			fileEntries(): ReadonlyMap<string, string>;
			readFileSync(path: string, encoding: "utf8"): unknown;
		};
	},
	callId: string,
	file?: string,
): string {
	const sources: Array<readonly [string, string]> =
		file === undefined
			? [...world.io.fileEntries()].filter(
					([path]) => path.includes("worker-conversations") && path.endsWith(".jsonl"),
				)
			: [[file, String(world.io.readFileSync(file, "utf8"))]];
	for (const [, content] of sources) {
		for (const line of content.split("\n")) {
			if (!line.includes(callId)) continue;
			const entry = JSON.parse(line) as { readonly message?: WireRecord } & WireRecord;
			const record: WireRecord = entry.message ?? entry;
			if (
				record.role === "assistant" &&
				record.content?.some((block) => block.type === "toolCall" && block.id === callId)
			) {
				return (record.content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
			}
		}
	}
	throw new Error(`no persisted assistant message carries ${callId}`);
}

/** One persisted conversation record: a bare message, or the entry that wraps one. */
export interface ConversationRecord {
	readonly role?: string;
	readonly toolCallId?: string;
	readonly isError?: boolean;
}

export function toolOutcomes(session: AgentSession): string {
	return session.messages
		.flatMap((message) => {
			if (message.role !== "toolResult") return [];
			const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join(" ");
			return [`${message.toolName} isError=${message.isError}: ${text.slice(0, 900)}`];
		})
		.join("\n");
}

/** Text of every `delegate` tool result the session recorded, in order (structured, not line-prefix matched). */
export function delegateResultTexts(session: AgentSession): string[] {
	return session.messages.flatMap((message) => {
		if (message.role !== "toolResult" || message.toolName !== "delegate") return [];
		return [message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n")];
	});
}

/** The stable agent id production assigned to the worker that runs on `track` (its effective model). */
export function agentIdForTrack(request: ScriptedRequest, track: string): string {
	for (const message of request.context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const match = new RegExp(`stable agentId (\\S+?),[^\\n]*effective model harness-script/${track}\\b`).exec(
				block.text,
			);
			if (match?.[1]) return match[1];
		}
	}
	throw new Error(`No started agent is running on track ${track} in the projected request`);
}

/** The raw source mailbox's reply acknowledgements, narrowed from the unknown record (no cast, no any). */
export function rawReplyAcknowledgements(mailbox: unknown): unknown[] {
	if (typeof mailbox !== "object" || mailbox === null || !("replyAcknowledgements" in mailbox)) {
		throw new Error("the raw source mailbox carries no reply acknowledgements");
	}
	const list: unknown = mailbox.replyAcknowledgements;
	if (!Array.isArray(list)) throw new Error("the raw source reply acknowledgements are not a list");
	const values: unknown[] = list;
	return values;
}

/** The raw source mailbox's receipt for one request message, narrowed from the unknown record (no cast, no any). */
export function rawReplyReceiptOf(mailbox: unknown, requestMessageId: string): unknown {
	if (typeof mailbox !== "object" || mailbox === null || !("messages" in mailbox)) {
		throw new Error("the raw source mailbox carries no messages");
	}
	const list: unknown = mailbox.messages;
	if (!Array.isArray(list)) throw new Error("the raw source messages are not a list");
	const messages: unknown[] = list;
	for (const candidate of messages) {
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			"messageId" in candidate &&
			candidate.messageId === requestMessageId
		) {
			return "replyReceipt" in candidate ? candidate.replyReceipt : undefined;
		}
	}
	throw new Error(`the raw source mailbox holds no message ${requestMessageId}`);
}

/** The most recent stable agent id production assigned to a worker on `track` (the one a later start created). */
export function latestAgentIdForTrack(request: ScriptedRequest, track: string): string {
	let found: string | undefined;
	for (const message of request.context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const pattern = new RegExp(`stable agentId (\\S+?),[^\\n]*effective model harness-script/${track}\\b`, "g");
			for (const match of block.text.matchAll(pattern)) found = match[1];
		}
	}
	if (found === undefined) throw new Error(`No started agent is running on track ${track} in the projected request`);
	return found;
}

/**
 * Native settlement facts at one boundary, read through owner getters that neither admit nor recover work: the goal record, the task runtime projection,
 * foreground activity, streaming flags, the pending idle continuation timers, the resource snapshot, and the durable retire
 * receipts. It never calls `getLaneRecords`, `getSessionWorkState` or `getGoalRuntimeSnapshot`: those reach the worker recovery
 * coordinator (`WorkerDelegationController.getRecords` runs `recovery.recover()` while the delegate tool is active), so a read
 * through them is not passive. The task and resource getters may refresh or compact their storage, so the read is not zero IO.
 */
export function settlementFacts(
	session: AgentSession,
	sessionManager: SessionManager,
	autonomy: { readonly maxStallTurns: number; readonly goalAutoContinue: boolean },
) {
	const goal = session.getGoalStateSnapshot();
	const runtime = session.backgroundLanes.getTaskRuntimeSnapshot();
	return structuredClone({
		goal: goal && {
			goalId: goal.goalId,
			status: goal.status,
			revision: goal.revision,
			progressRevision: goal.progressRevision,
			stallTurns: goal.stallTurns,
			blockedReason: goal.blockedReason,
			continuationTurnsUsed: goal.continuationTurnsUsed,
			requirementCount: goal.requirements.length,
		},
		goalAutoContinueSetting: autonomy.goalAutoContinue,
		maxStallTurns: autonomy.maxStallTurns,
		pendingIdleContinuation: session.backgroundLanes.hasPendingIdleContinuation(),
		foregroundActivity: session.getForegroundActivity(),
		streaming: {
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			isRetrying: session.isRetrying,
		},
		attempts: Object.values(runtime?.attempts ?? {}).map((attempt) => ({
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			agentId: attempt.agentId,
			status: attempt.status,
			reasonCode: attempt.reasonCode,
			result:
				attempt.result === undefined
					? null
					: {
							status: attempt.result.status,
							reasonCode: attempt.result.reasonCode,
							nextAction: attempt.result.nextAction,
							artifacts: attempt.result.artifacts.map((artifact) => ({
								uri: artifact.uri,
								digest: artifact.digest,
								sizeBytes: artifact.sizeBytes,
							})),
						},
		})),
		agents: Object.values(runtime?.agents ?? {}).map((agent) => ({ agentId: agent.agentId, status: agent.status })),
		// The current branch, not the live context: a compaction removes superseded tool results from `session.messages`.
		retireReceipts: sessionManager.getBranch().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "delegate")
				return [];
			const details = entry.message.details as { action?: unknown } | undefined;
			if (details?.action !== "retire") return [];
			return [
				{
					toolCallId: entry.message.toolCallId,
					isError: entry.message.isError,
					text: entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
					details: entry.message.details,
				},
			];
		}),
		resources: session.getResourceSnapshot(),
	});
}

/** Tool results the production loop recorded after the latest assistant turn: the outcomes this step answers. */
/**
 * The lanes a `worktree_sync` status reports: lane key and checkout path, plus the bound agent when one is bound; the credential guard keeps the `laneKey` key readable and retains independent secret-value redaction.
 */
export function lanesOf(
	details: unknown,
): Array<{ readonly laneKey: string; readonly worktreePath: string; readonly boundLaneId?: string }> {
	if (typeof details !== "object" || details === null || !("lanes" in details) || !Array.isArray(details.lanes)) {
		throw new Error("the status details carry no lanes");
	}
	return details.lanes.map((lane: unknown) => {
		if (
			typeof lane !== "object" ||
			lane === null ||
			!("laneKey" in lane) ||
			typeof lane.laneKey !== "string" ||
			!("worktreePath" in lane) ||
			typeof lane.worktreePath !== "string"
		) {
			throw new Error("a status lane carries no laneKey or worktreePath");
		}
		const bound = "boundLaneId" in lane && typeof lane.boundLaneId === "string" ? lane.boundLaneId : undefined;
		return bound === undefined
			? { laneKey: lane.laneKey, worktreePath: lane.worktreePath }
			: { laneKey: lane.laneKey, worktreePath: lane.worktreePath, boundLaneId: bound };
	});
}

/** Evidence ids the host reported in goal results, in the order the transcript shows them. */
/** The requirement text the goal admits in the mixed case; the criterion statement a completion request carries names it. */
export const COMPLETION_REQUIREMENT_TEXT = "MAX_RETRIES equals 5 and the late module lands";
/** The statement prefix of the unsettled-item family for a statement that a change helps achieve a requirement. */
export const CRITERION_STATEMENT_PREFIX = "This change helps achieve: ";

/** The evidence ids the goal ledger admitted, read from the durable goal results of a session branch. */
export function durableGoalEvidenceIds(sessionManager: SessionManager): string[] {
	const ids: string[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "goal")
			continue;
		for (const match of JSON.stringify(entry.message.content).matchAll(/ev-[0-9a-f]+/g)) {
			if (!ids.includes(match[0])) ids.push(match[0]);
		}
	}
	return ids;
}

/**
 * The unsettled-item family of a completion request carries `sN` statements and `eN` evidence; each `shows_*` question names one
 * such pair. Before any answer: every named pair must be carried, a criterion statement must name the admitted requirement
 * text, and any evidence a statement cites must be an admitted evidence id. Returns how many statements cite admitted evidence.
 */
export function checkCompletionItems(
	request: SystemOneDecodedRequest,
	native: { readonly requirementText: string; readonly evidenceIds: readonly string[] },
): number {
	const state = request.state as Record<string, unknown>;
	for (const [id, question] of Object.entries(request.questions)) {
		const shown = /^shows_(?:true|false)_(\d+)$/.exec(id);
		if (shown === null) continue;
		const index = shown[1];
		const instructions = question.instructions ?? "";
		if (!instructions.includes(`\`s${index}\``) || !instructions.includes(`\`e${index}\``)) {
			throw new Error(`question ${id} does not name s${index} and e${index} in its instructions`);
		}
		if (typeof state[`s${index}`] !== "string" || typeof state[`e${index}`] !== "string") {
			throw new Error(`question ${id} names s${index} and e${index}, which the decoded state does not carry`);
		}
	}
	let checked = 0;
	for (const [key, statement] of Object.entries(state)) {
		if (!/^s\d+$/.test(key) || typeof statement !== "string") continue;
		const evidence = state[`e${key.slice(1)}`];
		if (
			statement.startsWith(CRITERION_STATEMENT_PREFIX) &&
			statement !== `${CRITERION_STATEMENT_PREFIX}${native.requirementText}.`
		)
			throw new Error(`statement ${key} does not name the native requirement: ${statement}`);
		if (typeof evidence !== "string") throw new Error(`statement ${key} has no evidence e${key.slice(1)}`);
		const cited = [...evidence.matchAll(/^(ev-[0-9a-f]+):/gm)].map((match) => match[1] ?? "");
		if (cited.some((id) => !native.evidenceIds.includes(id))) {
			throw new Error(`e${key.slice(1)} cites evidence the goal never admitted: ${cited.join(", ")}`);
		}
		// A statement that cites admitted evidence is linked; a change may cite none.
		if (cited.length > 0) checked += 1;
	}
	return checked;
}

/**
 * Each cited evidence line's marker must agree with the native ledger's verified flag: `[verified]` exactly when the ledger holds the
 * evidence verified, `[unverified summary]` otherwise. Returns how many markers it checked; a disagreement throws.
 */
export function checkEvidenceMarkers(request: SystemOneDecodedRequest, ledger: ReadonlyMap<string, boolean>): number {
	const state = request.state as Record<string, unknown>;
	let checked = 0;
	for (const [key, value] of Object.entries(state)) {
		if (!/^e\d+$/.test(key) || typeof value !== "string") continue;
		for (const match of value.matchAll(/^(ev-[0-9a-f]+):\s*(\[verified\]|\[unverified summary\])/gm)) {
			const id = match[1] ?? "";
			const verified = ledger.get(id);
			if (verified === undefined) throw new Error(`${key} cites ${id}, which the ledger does not hold`);
			if ((match[2] === "[verified]") !== verified) {
				throw new Error(`${key} marks ${id} as ${match[2]}, but the ledger verified flag is ${verified}`);
			}
			checked += 1;
		}
	}
	return checked;
}

export function evidenceIdsOf(request: ScriptedRequest): string[] {
	const ids: string[] = [];
	for (const message of request.context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "goal") continue;
		for (const match of JSON.stringify(message.content).matchAll(/ev-[0-9a-f]+/g)) {
			if (!ids.includes(match[0])) ids.push(match[0]);
		}
	}
	if (ids.length === 0) throw new Error("no evidence id in any goal result of the transcript");
	return ids;
}

/** The requirement id in the most recent goal result of the transcript, however many turns back it is. */
export function requirementIdOf(request: ScriptedRequest): string {
	const messages = request.context.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "goal") continue;
		const text = JSON.stringify(message.content);
		const match = /req-[0-9a-f]+/.exec(text);
		if (match) return match[0];
	}
	throw new Error("no requirement id in any goal result of the transcript");
}

/** The marker of the root reflection checkpoint: the reflection turn's own prompt, which the production loop sends after a unit of work. */
export const REFLECTION_CHECKPOINT_MARKER = "Reflection checkpoint: the unit of work above has ended.";

/**
 * Epoch-scoped identity of one owner input. The observer reads the native message_end of the owner's own user message and
 * the submission epoch it was emitted under. The provider check then requires the CURRENT epoch to equal that captured epoch,
 * and exactly one wire user message to carry the captured content and timestamp. Observer failures are kept in the order they
 * occur; the check rethrows a single one unchanged and aggregates several.
 */
export interface OwnerInputCapture {
	arm(): void;
	disarm(): void;
	check(request: ScriptedRequest): void;
}

export function ownerInputCapture(session: AgentSession, text: string): OwnerInputCapture {
	let unsubscribe: (() => void) | undefined;
	let captured: { readonly content: unknown; readonly timestamp: number; readonly epoch: number } | undefined;
	const failures: unknown[] = [];
	const observe = (event: AgentSessionEvent): void => {
		try {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const content = event.message.content;
			const joined =
				typeof content === "string"
					? content
					: content.map((block) => (block.type === "text" ? block.text : "")).join("");
			if (joined !== text) return;
			if (captured !== undefined) throw new Error(`the owner input "${text}" was emitted twice in one prompt`);
			const epoch = session.getResourceSnapshot().foregroundRecovery.submissionEpoch;
			if (epoch === undefined) throw new Error("the owner input was emitted with no submission lease held");
			captured = { content: structuredClone(content), timestamp: event.message.timestamp, epoch };
		} catch (error) {
			failures.push(error);
		}
	};
	return {
		arm: () => {
			unsubscribe = session.subscribe(observe);
		},
		disarm: () => {
			unsubscribe?.();
			unsubscribe = undefined;
		},
		check: (request) => {
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "the owner input capture failed more than once");
			const owner = captured;
			if (owner === undefined) throw new Error(`the owner input "${text}" was never captured`);
			const current = session.getResourceSnapshot().foregroundRecovery.submissionEpoch;
			if (current === undefined || current !== owner.epoch) {
				throw new Error(
					`the current submission epoch ${current} does not equal the captured owner epoch ${owner.epoch}`,
				);
			}
			const bound = request.context.messages.filter(
				(message) =>
					message.role === "user" &&
					message.timestamp === owner.timestamp &&
					isDeepStrictEqual(message.content, owner.content),
			);
			if (bound.length !== 1) {
				throw new Error(`expected exactly one wire user message bound to the owner input, found ${bound.length}`);
			}
		},
	};
}

/** True when a request-visible message carries the marker text. */
export function requestCarriesMarker(request: ScriptedRequest, marker: string): boolean {
	return request.context.messages.some((message) => JSON.stringify(message).includes(marker));
}

/**
 * A submit_report result whose host receipt matches its call: the same call id, and a completed, successful invocation. Tool
 * receipt, not host acceptance: it proves the host recorded the call, nothing about the claim's verdict.
 */
export function matchedSubmitReceipt(request: ScriptedRequest, callId: string): boolean {
	return matchedSubmitReceiptIn(request.context.messages, callId);
}

/** A completed submit whose successful invocation is recorded on the message with this call id. */
export function matchedSubmitReceiptIn(messages: ScriptedRequest["context"]["messages"], callId: string): boolean {
	return messages.some((message) => {
		if (message.role !== "toolResult" || message.toolName !== "submit_report" || message.toolCallId !== callId)
			return false;
		const details: unknown = message.details;
		if (typeof details !== "object" || details === null || !("piToolInvocation" in details)) return false;
		const invocation: unknown = details.piToolInvocation;
		return (
			typeof invocation === "object" &&
			invocation !== null &&
			"execution" in invocation &&
			invocation.execution === "completed" &&
			"operationStatus" in invocation &&
			invocation.operationStatus === "success"
		);
	});
}

/**
 * True when the current host request carries the text: the messages after the latest assistant turn, not the whole history. An older
 * request's text cannot satisfy a fresh request's check.
 */
export function currentRequestCarries(request: ScriptedRequest, text: string): boolean {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	return JSON.stringify(messages.slice(start)).includes(text);
}

/** The task id the latest bash start carried in its tool result details. */
export function backgroundTaskIdOf(request: ScriptedRequest): string {
	const messages = request.context.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "bash") continue;
		const details: unknown = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"taskId" in details &&
			typeof details.taskId === "string"
		) {
			return details.taskId;
		}
		throw new Error("the latest bash result carries no background task id");
	}
	throw new Error("no bash result is in the request");
}

/** True when one message of the request is the background handoff that names this task id. */
export function handoffFor(request: ScriptedRequest, taskId: string): boolean {
	return request.context.messages.some((message) => {
		const text = JSON.stringify(message);
		return text.includes("Background tool terminal handoff") && text.includes(taskId);
	});
}

/** The command of a bash tool call's validated arguments, or undefined when the arguments carry none. */
export function commandOf(args: unknown): unknown {
	return typeof args === "object" && args !== null && "command" in args ? args.command : undefined;
}

export function latestBatchResults(
	request: ScriptedRequest,
): Array<{ toolName: string; isError: boolean; text: string }> {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	const results: Array<{ toolName: string; isError: boolean; text: string }> = [];
	for (const message of messages.slice(start)) {
		if (message.role !== "toolResult") continue;
		const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n");
		results.push({ toolName: message.toolName, isError: message.isError, text });
	}
	return results;
}

/** Fails the step with the failing production result, so the journey stops at the call that broke. */
export function assertBatchOk(request: ScriptedRequest, label: string): void {
	for (const result of latestBatchResults(request)) {
		if (result.isError) throw new Error(`${label}: ${result.toolName} failed: ${result.text.slice(0, 600)}`);
	}
}

/**
 * The absolute path a request-visible `PATH ALIASES` legend line names. The model reads its legend from the request it is
 * sent, so the positive path oracle is that legend, never the raw transcript.
 */
export function requestTexts(request: ScriptedRequest): string[] {
	return request.context.messages.flatMap((message) =>
		typeof message.content === "string"
			? [message.content]
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
	);
}

/** The persisted alias rows of one session store, read through a read-only connection that is closed before returning. */
export function readPathAliases(path: string): Array<{ full_path: string; alias_id: string }> {
	const sqlite = process.getBuiltinModule("node:sqlite");
	if (sqlite === undefined) throw new Error("node:sqlite is unavailable");
	const database = new sqlite.DatabaseSync(path, { readOnly: true });
	try {
		return database.prepare("SELECT full_path, alias_id FROM path_aliases").all() as Array<{
			full_path: string;
			alias_id: string;
		}>;
	} finally {
		database.close();
	}
}

/** The messages of a persisted worker mailbox record, validated structurally before they are read. */
export function mailboxMessagesOf(
	mailbox: unknown,
): Array<{ messageId: string; content: string; deliveredAt?: string }> {
	if (
		typeof mailbox !== "object" ||
		mailbox === null ||
		!("messages" in mailbox) ||
		!Array.isArray(mailbox.messages)
	) {
		throw new Error("the mailbox record carries no messages");
	}
	return mailbox.messages.map((message: unknown) => {
		if (typeof message !== "object" || message === null || !("messageId" in message) || !("content" in message)) {
			throw new Error("a mailbox message is malformed");
		}
		const deliveredAt =
			"deliveredAt" in message && typeof message.deliveredAt === "string" ? message.deliveredAt : undefined;
		return {
			messageId: String(message.messageId),
			content: String(message.content),
			...(deliveredAt === undefined ? {} : { deliveredAt }),
		};
	});
}

/** The receipts of a persisted worker mailbox record, validated structurally before they are read. */
export function receiptsOf(mailbox: unknown): Array<{ kind: string; messageId: string }> {
	if (
		typeof mailbox !== "object" ||
		mailbox === null ||
		!("replayReceipts" in mailbox) ||
		!Array.isArray(mailbox.replayReceipts)
	) {
		throw new Error("the mailbox record carries no replay receipts");
	}
	return mailbox.replayReceipts.map((receipt: unknown) => {
		if (typeof receipt !== "object" || receipt === null || !("kind" in receipt) || !("messageId" in receipt)) {
			throw new Error("a replay receipt is malformed");
		}
		return { kind: String(receipt.kind), messageId: String(receipt.messageId) };
	});
}

/** Every `p/<id>=<absolute path>` line the request-visible legend carries, in order. */
export function legendLinesOf(request: ScriptedRequest): string[] {
	return requestTexts(request)
		.flatMap((text) => text.split("\n"))
		.filter((line) => /^p\/\S+=\S+$/.test(line));
}

/**
 * The alias the request-visible legend assigns to an absolute path, when the legend carries it. The legend names a file
 * relative to the project root or absolutely; both spellings resolve natively, so either form matches the same file.
 */
export function legendAliasFor(request: ScriptedRequest, absolutePath: string): string | undefined {
	const target = resolve(absolutePath);
	for (const text of requestTexts(request)) {
		for (const line of text.split("\n")) {
			const match = /^(p\/\S+)=(\S+)$/.exec(line);
			if (match?.[1] && resolve(HARNESS_PROJECT_CWD, match[2]) === target) return match[1];
		}
	}
	return undefined;
}

/** The text of a utf8 read: a non-text read is a broken oracle, so it fails instead of being coerced. */
export function utf8Text(content: string | Buffer): string {
	if (typeof content !== "string") throw new TypeError("a utf8 read returned bytes");
	return content;
}

export function legendPath(request: ScriptedRequest, alias: string): string {
	const pattern = new RegExp(`^${alias}=(\\S+)$`, "m");
	for (const text of requestTexts(request)) {
		const match = pattern.exec(text);
		if (match?.[1]) return resolve(HARNESS_PROJECT_CWD, match[1]);
	}
	throw new Error(`${alias} is not in the request-visible PATH ALIASES legend`);
}

/** The conflict block a read of the conflicted file shows, exactly as the request carries it. */
export function conflictBlockIn(request: ScriptedRequest): string {
	const read = latestBatchResults(request).find((result) => result.toolName === "read");
	const match = /<<<<<<< HEAD[\s\S]*?>>>>>>> [^\n]*/.exec(read?.text ?? "");
	if (!match) throw new Error(`no conflict block in the read result: ${read?.text ?? "no read"}`);
	return match[0];
}

/** The latest batch must hold a refused call whose text names the diagnostic. */
export function assertRefused(request: ScriptedRequest, label: string, diagnostic: string): void {
	const results = latestBatchResults(request);
	if (!results.some((result) => result.isError && result.text.includes(diagnostic))) {
		throw new Error(`${label}: expected a refusal naming "${diagnostic}", got ${JSON.stringify(results)}`);
	}
}

/** The structured details of the newest `worktree_sync` result in the transcript (not text-matched). */
/** The structured details of the newest result of `toolName` in the transcript (not text-matched). */
export function lastToolResultDetails(session: AgentSession, toolName: string): unknown {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "toolResult" && message.toolName === toolName) return message.details;
	}
	return undefined;
}

export function isStaleRefusal(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		"code" in details &&
		(details.code === "stale_lane" || details.code === "sync_required")
	);
}

export function isGateCommandRefusal(details: unknown): boolean {
	return typeof details === "object" && details !== null && "code" in details && details.code === "gate_command_unset";
}

/** A step whose tool calls depend on what production reported earlier. */
export function dynamicCalls(
	name: string,
	plan: (request: ScriptedRequest) => Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
	check?: (request: ScriptedRequest) => void,
): ScriptStep {
	return {
		name,
		check,
		reply: (request) => ({
			content: plan(request).map((call) => ({ type: "toolCall" as const, ...call })),
			stopReason: "toolUse",
		}),
	};
}

export const ORIGINAL_LIMITS = "export const MAX_RETRIES = 3;\n";
export const OWNER_DRAFT_V1 = "owner draft v1\n";
export const NOTES_V1 = "stage one\n";
export const OWNER_DRAFT_DIRTY = "owner draft v2 (unstaged, not mine)\n";

export const ICM_CREDENTIAL_KEY = ["AIza", "0123456789abcdefghijklmnopqrstuvwxy"].join("");

/** The judgments a plain owner request that leads to a tool call consumes (the E4 set). */
export const ICM_INTAKE_JUDGMENTS = {
	changes_model_pools: { kind: "noul", probability: 0.02 },
	local_commits_only: { kind: "noul", probability: 0.02 },
	lifts_delivery_block: { kind: "noul", probability: 0.02 },
	full_handoff: { kind: "noul", probability: 0.02 },
	optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	capabilities_authorized: { kind: "noul", probability: 0.02 },
} as const;

/** Valid ICM settings for the Pi-adaptative-memory continuous chat with a reasoning summary model. */
export function icmContinuousSettings(summaryTrack = "worker-c", extra?: Partial<Settings>): Partial<Settings> {
	return {
		memorySystem: "icm",
		contextPolicy: {
			memory: {
				history: {
					summaryModel: `${HARNESS_PROVIDER}/${summaryTrack}`,
					allowExternalSummaryEgress: true,
				},
			},
		},
		...extra,
	};
}

/** The continuous-chat store layout of `agentDir` for `HARNESS_PROJECT_CWD`. */
export function icmContinuousStore(agentDir: string) {
	const projectKey = getDirectoryResourceProfileInfo(HARNESS_PROJECT_CWD, agentDir).hash.toLowerCase();
	const root = stateFile(agentDir, "continuous-chat", projectKey);
	return {
		projectKey,
		root,
		mainDir: resolve(root, "main"),
		treeDir: resolve(root, "tree"),
		imagesDir: resolve(root, "images"),
		nodesDir: resolve(root, "nodes"),
		rootFile: resolve(root, "root.json"),
		queueFile: resolve(root, "queue.json"),
		turnViewFile: resolve(root, "view.json"),
		causalViewFile: resolve(root, "compaction-view.json"),
		messagesIdx: resolve(root, "messages.idx"),
		keysIdx: resolve(root, "keys.idx"),
		leaseFile: resolve(root, "runtime.lease.json"),
		migrationFile: resolve(root, "migration.json"),
		sessionsFile: resolve(root, "sessions.json"),
	};
}

export interface IcmStoredContinuousRecord {
	readonly id: number;
	readonly kind: string;
	readonly date: string;
	readonly text: string;
	readonly sourceKey: string;
	readonly images?: ReadonlyArray<{ readonly digest: string; readonly mimeType: string; readonly bytes: number }>;
	readonly toolClipping?: {
		readonly originalCharacters: number;
		readonly headCharacters: number;
		readonly tailCharacters: number;
	};
}

export interface IcmStoredContinuousNode {
	readonly level: number;
	readonly ordinal: number;
	readonly text: string;
	readonly size: number;
	readonly date: string;
	readonly children?: ReadonlyArray<{ readonly level: number; readonly ordinal: number }>;
}

/** Reads every persisted JSONL record in `store.mainDir` in segment and line order. */
export function icmReadContinuousRecords(
	world: HarnessWorld,
	store: ReturnType<typeof icmContinuousStore>,
): IcmStoredContinuousRecord[] {
	const prefix = `${store.mainDir}${sep}`;
	const segments = [...world.io.fileEntries()]
		.filter(([path]) => path.startsWith(prefix) && path.endsWith(".jsonl"))
		.sort(([left], [right]) => left.localeCompare(right));
	const records: IcmStoredContinuousRecord[] = [];
	for (const [, content] of segments) {
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			records.push(JSON.parse(line) as IcmStoredContinuousRecord);
		}
	}
	return records;
}

/** Reads every persisted tree node in `store.treeDir` in segment and line order. */
export function icmReadContinuousNodes(
	world: HarnessWorld,
	store: ReturnType<typeof icmContinuousStore>,
): IcmStoredContinuousNode[] {
	const prefix = `${store.treeDir}${sep}`;
	const segments = [...world.io.fileEntries()]
		.filter(([path]) => path.startsWith(prefix) && path.endsWith(".jsonl"))
		.sort(([left], [right]) => left.localeCompare(right));
	const nodes: IcmStoredContinuousNode[] = [];
	for (const [, content] of segments) {
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			nodes.push(JSON.parse(line) as IcmStoredContinuousNode);
		}
	}
	return nodes;
}

/**
 * Waits event-driven on `world.io` until the continuous chat under `agentDir` has published at least `expectedMessages`
 * and its work queue has settled with no running, ready, or blocked work.
 */
export async function icmWaitForChatIdle(
	world: HarnessWorld,
	agentDir: string,
	expectedMessages: number,
	predicate?: (records: readonly IcmStoredContinuousRecord[], nodes: readonly IcmStoredContinuousNode[]) => boolean,
): Promise<void> {
	const store = icmContinuousStore(agentDir);
	await withDeadline(
		world.trace,
		`ICM continuous chat idle (${expectedMessages} messages)`,
		world.io.waitForMutation(() => {
			const rootRaw = world.io.peekFile(store.rootFile);
			const queueRaw = world.io.peekFile(store.queueFile);
			if (rootRaw === undefined || queueRaw === undefined) return false;
			const root = JSON.parse(rootRaw) as { readonly nextId: number };
			if (root.nextId < expectedMessages) return false;
			const queueEnvelope = JSON.parse(queueRaw) as {
				readonly queue: {
					readonly running: readonly unknown[];
					readonly readyLeaves: readonly unknown[];
					readonly readyParents: readonly unknown[];
					readonly blocked: readonly unknown[];
				};
			};
			const { queue } = queueEnvelope;
			if (
				queue.running.length > 0 ||
				queue.readyLeaves.length > 0 ||
				queue.readyParents.length > 0 ||
				queue.blocked.length > 0
			) {
				return false;
			}
			return predicate
				? predicate(icmReadContinuousRecords(world, store), icmReadContinuousNodes(world, store))
				: true;
		}),
		60_000,
	);
}

/** The newest result of `toolName` in the request's latest tool batch; fails when the batch carried none. */
export function icmLatestResult(request: ScriptedRequest, toolName: string): { isError: boolean; text: string } {
	const result = latestBatchResults(request)
		.filter((candidate) => candidate.toolName === toolName)
		.at(-1);
	if (result === undefined) throw new Error(`the latest batch carries no ${toolName} result`);
	return result;
}
