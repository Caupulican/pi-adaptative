import "./fixtures/harness/builtin-install.ts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyUsage } from "@caupulican/pi-ai";
import type { CheckOptions, LockOptions, UnlockOptions } from "proper-lockfile";
import { expect, it } from "vitest";
import {
	decisionLedgerFile,
	orchestrationSessionDir,
	sessionRootMailboxFile,
	workerContextForkFile,
	workerProjectSpecializationFile,
} from "../src/core/agent-paths.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	type BackgroundToolTaskRecord,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "../src/core/background-tool-task-controller.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/default-tool-surface.ts";
import { sessionRootAddress, sessionRootReplyMessageId } from "../src/core/delegation/session-root-mailbox.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "../src/core/delegation/worker-mailbox-record.ts";
import { parseLocalWorkerProcessOwnerId } from "../src/core/delegation/worker-process-owner.ts";
import { WorkerRecoveryCoordinator } from "../src/core/delegation/worker-recovery-coordinator.ts";
import { WORKER_TERMINAL_OUTPUT_INLINE_BYTES } from "../src/core/delegation/worker-terminal-output-artifact.ts";
import { buildObjectiveRoutePrompt } from "../src/core/goals/goal-continuation-prompt.ts";
import { getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import {
	DEFAULT_OWNER_WAIT_TIMEOUT_MS,
	getLatestHumanInputSnapshots,
	getResumableHumanInputSnapshot,
} from "../src/core/human-input.ts";
import type { ObjectiveRoute } from "../src/core/objective-execution/objective-route.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../src/core/orchestration/profile-store.ts";
import { goalObjectiveId } from "../src/core/orchestration/work-state-projection.ts";
import { getInFlightWorkUnits } from "../src/core/reload-blockers.ts";
import { isCredentialSecretKey, mockCredentialFields } from "../src/core/secrets/credential-content-mock.ts";
import type { ExecutionState } from "../src/core/system-one/types.ts";
import { OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, readOptionalToolIntent } from "../src/core/tool-applicability-gate.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { localFileMutationIntentOperations } from "../src/core/tools/file-mutation-intent.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";
import { isRecordObject } from "../src/core/util/value-guards.ts";
import type { SessionManager } from "../src/kernel/session/session-manager.ts";
import type { ScriptedRequest, ScriptStep } from "./fixtures/harness/scripted-provider.ts";
import { calls, createBarrier, fail, text } from "./fixtures/harness/scripted-provider.ts";
import {
	HARNESS_PROJECT_CWD,
	type HarnessWorld,
	type HarnessWorldOptions,
	runHarnessWorld,
	type SystemOneDecodedRequest,
	settlementState,
	type WorkerProjectClaims,
	withDeadline,
} from "./fixtures/harness/session-fixture.ts";
import { VirtualShell } from "./fixtures/harness/virtual-shell.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
interface ProperLockfile {
	lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	lockSync(file: string, options?: LockOptions): () => void;
	unlock(file: string, options?: UnlockOptions): Promise<void>;
	unlockSync(file: string, options?: UnlockOptions): void;
	check(file: string, options?: CheckOptions): Promise<boolean>;
	checkSync(file: string, options?: CheckOptions): boolean;
}

const lockfileFs: { current: object | undefined } = { current: undefined };
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;
const bindVirtualFs = <T extends object>(options: T | undefined): T => {
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
async function runJourney(
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

const LIMITS_PATH = `${HARNESS_PROJECT_CWD}/src/limits.ts`;
const TASK_REQUEST = `Read ${LIMITS_PATH}, change MAX_RETRIES from 3 to 5, and remember that I prefer tabs over spaces.`;
const FOLLOW_UP_REQUEST = "Also keep the tab preference in mind.";

/** One production reference captured at module evaluation; every world must route it to its own tree. */
const CAPTURED_ACCESS = localFileMutationIntentOperations.access;

/**
 * The summarizer's scripted checkpoint. Production verifies it against the session's facts (read/edited files,
 * the active request, mandatory rules, open problems, done actions) and accepts it only when it carries them.
 */
const COMPACTION_SUMMARY = [
	"## Active Task",
	"User: Read /harness/project/src/limits.ts, change MAX_RETRIES from 3 to 5, and remember that I prefer tabs over spaces.",
	"",
	"### Mandatory Rules",
	"(none)",
	"",
	"## Working Set",
	"- /harness/project/src/limits.ts — EDIT",
	"",
	"## Files",
	"- /harness/project/src/limits.ts",
	"",
	"## Open Problems",
	"(none)",
	"",
	"## Done",
	"1. READ /harness/project/src/limits.ts",
	"2. EDIT /harness/project/src/limits.ts",
	"3. MEMORY saved the owner's tab preference to USER.md",
	"",
	"## Key Decisions",
	"- MAX_RETRIES is set to 5 as the owner asked.",
	"",
	"## Constraints & Preferences",
	"- The owner prefers tabs over spaces.",
	"",
	"## Critical Context",
	"- /harness/project/src/limits.ts holds MAX_RETRIES = 5 after the edit.",
].join("\n");

/**
 * The orchestration root's checkpoint while its verification obligation is open: the file it edited, the revision it
 * left failing, and the actions it took. Production verifies the recall of these facts before it accepts the checkpoint.
 */
const CHECKPOINT_SUMMARY = [
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
function bundleEntries(entries: ReadonlyMap<string, string>, bundleDir: string): Array<[string, string]> {
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
function failureText(error: unknown): string {
	if (error instanceof AggregateError) return error.errors.map(failureText).join(" | ");
	return error instanceof Error ? error.message : String(error);
}

/** Counters of the E0 stages a bound request actually carried, read by the journey after its integrate turn. */
interface E0Counters {
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

function zeroE0Counters(): E0Counters {
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
function bindE0Request(
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
function bindE0Completion(
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
function expectOwnerWords(input: {
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
			// Production appends a paused entry for the request before it classifies, so the expected previous intent is the
			// newest entry that is classified: the native ledger the intake continues from.
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
interface WireRecord {
	readonly role?: string;
	readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly id?: string }>;
}

/** The assistant text persisted in the admitted worker conversation for the message that carries one call id. */
function persistedGenerationText(
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
interface ConversationRecord {
	readonly role?: string;
	readonly toolCallId?: string;
	readonly isError?: boolean;
}

function toolOutcomes(session: AgentSession): string {
	return session.messages
		.flatMap((message) => {
			if (message.role !== "toolResult") return [];
			const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join(" ");
			return [`${message.toolName} isError=${message.isError}: ${text.slice(0, 900)}`];
		})
		.join("\n");
}

it("standalone root conversation: greeting, task with tools and memory, compaction, queued input, continuation", async () => {
	await runJourney(
		{
			name: "journey-1",
			// The E2 control's uncertain task relation emits one native warning, counted in its own block (not a broad allowance).
			// The long-path turn meets an unavailable evaluator on purpose: its owner intent stays unresolved, and only that
			// classified-as-unavailable warning is allowed.
			warningAllowances: [
				/^Optional integrations stay available; owner intent for them was not classified: Jev System One unavailable for impact 'read_only': TypeSafe HTTP 503\.$/,
				/^Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain\.$/,
				/^Failed to release worker write reservation [^:]+: Scripted IO fault e13-release-rename-fails\b/,
				/^Worker write reservation watcher [\s\S]+ teardown failed: Scripted IO fault e13j-watch-close-fails: watch\.close '[^']+'$/,
				/^Worker worker-\d+ provider request failed \(server_error\); retrying in \d+s \(attempt [23]\/3\)\.$/,
				/^Worker worker-\d+ failed \(server_error\); retrying from the persisted transcript in \d+s \(attempt 2\)\.$/,
				/^A queued message was not delivered because the session context changed before it was admitted\. It is kept in full in the pending queue; restore it to the editor to send it again: Queued owner input while the summary is held\.$/,
			],
			files: {
				[LIMITS_PATH]: "export const MAX_RETRIES = 3;\n",
				[`${HARNESS_PROJECT_CWD}/src/features/retry/configuration/limits.ts`]:
					'export const RETRY_CONFIGURATION = "long";\n',
			},
			// Guarded edge: no standing grant for destructive filesystem operations, so the operator is asked.
			settings: { edge: { allow: [] } },
		},
		async (world) => {
			const trace = world.trace;
			let mainSession: AgentSession | undefined;
			// The operation table captured at module evaluation must reach the virtual tree, not the host.
			await expect(localFileMutationIntentOperations.access(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
			await expect(
				localFileMutationIntentOperations.access(`${HARNESS_PROJECT_CWD}/missing.ts`, constants.R_OK),
			).rejects.toThrow("virtual filesystem");
			// Exclusive copy, as the production edit and write paths issue it: an existing destination is refused and
			// keeps its bytes; an absent destination is created in the virtual tree.
			const copySource = `${HARNESS_PROJECT_CWD}/src/copy-source.ts`;
			world.io.seed(copySource, "export const COPIED = true;\n");
			await expect(
				localFileMutationIntentOperations.copyFileExclusive(copySource, LIMITS_PATH),
			).rejects.toMatchObject({
				code: "EEXIST",
			});
			expect(world.io.readFileSync(LIMITS_PATH, "utf8")).toBe(ORIGINAL_LIMITS);
			const copyTarget = `${HARNESS_PROJECT_CWD}/src/copy-target.ts`;
			await expect(
				localFileMutationIntentOperations.copyFileExclusive(copySource, copyTarget),
			).resolves.toBeUndefined();
			expect(world.io.readFileSync(copyTarget, "utf8")).toBe("export const COPIED = true;\n");
			// The same captured reference resolves against this world's tree.
			await expect(CAPTURED_ACCESS(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
			// SQL boundary, before any session exists: an allowed RAM query runs, and a disk ATTACH is refused by the
			// authorizer. Only the labels this statement appended are consumed; anything else stays and fails settlement.
			const sqlite = process.getBuiltinModule("node:sqlite");
			if (sqlite === undefined) throw new Error("node:sqlite is unavailable");
			const database = new sqlite.DatabaseSync(":memory:");
			database.exec("CREATE TABLE limits (value INTEGER)");
			database.prepare("INSERT INTO limits (value) VALUES (?)").run(3);
			expect(database.prepare("SELECT value FROM limits").get()).toEqual({ value: 3 });
			const escapesBeforeAttach = world.guard.escapes.length;
			let refusal: unknown;
			try {
				database.exec(`ATTACH DATABASE '${HARNESS_PROJECT_CWD}/evil.db' AS evil`);
			} catch (error) {
				refusal = error;
			}
			expect(String(refusal), "a disk ATTACH must be refused by the RAM authorizer").toMatch(/not authorized/i);
			const appendedLabels = world.guard.escapes.slice(escapesBeforeAttach);
			expect(appendedLabels).toEqual(["sqlite.attach"]);
			world.guard.escapes.splice(escapesBeforeAttach, appendedLabels.length);
			// Each probe runs one statement and consumes only the labels that statement appended, so an unexpected denial
			// or label stays visible to the assertion instead of being cleared with the probe.
			const probeOn = (
				target: typeof database,
				statement: string,
			): { readonly error: string; readonly labels: readonly string[] } => {
				const before = world.guard.escapes.length;
				let error = "";
				try {
					target.exec(statement);
				} catch (caught) {
					error = String(caught);
				}
				const labels = world.guard.escapes.slice(before);
				world.guard.escapes.splice(before, labels.length);
				return { error, labels };
			};
			const probeSql = (statement: string): { readonly error: string; readonly labels: readonly string[] } =>
				probeOn(database, statement);
			try {
				// Storage pragmas redirect spill files to disk: upper-case, lower-case and mixed-case spellings are all refused.
				for (const statement of [
					"PRAGMA TEMP_STORE=FILE",
					"PRAGMA temp_store=FILE",
					`PRAGMA Temp_Store_Directory='${HARNESS_PROJECT_CWD}'`,
					`PRAGMA temp_store_directory='${HARNESS_PROJECT_CWD}'`,
				]) {
					const probe = probeSql(statement);
					expect(
						{ statement, error: probe.error, labels: probe.labels },
						"a storage pragma is refused by the RAM authorizer",
					).toEqual({
						statement,
						error: expect.stringMatching(/not authorized/i),
						labels: ["sqlite.storage_pragma"],
					});
				}
				// The default memory spill mode stays allowed through the same authorizer.
				database.exec("PRAGMA TEMP_STORE=MEMORY");
				expect(probeSql("PRAGMA temp_store=memory"), "the memory pragma runs with no recorded denial").toEqual({
					error: "",
					labels: [],
				});
				// VACUUM INTO writes a whole database file; load_extension runs native code. Both are controls the authorizer answers.
				const vacuum = probeSql(`VACUUM INTO '${HARNESS_PROJECT_CWD}/vacuum-target.db'`);
				expect(
					{ statement: "VACUUM INTO", error: vacuum.error, labels: vacuum.labels },
					"VACUUM INTO is refused by the RAM authorizer",
				).toEqual({
					statement: "VACUUM INTO",
					error: "Error: authorization denied",
					labels: ["sqlite.attach"],
				});
				const extension = probeSql(`SELECT load_extension('${HARNESS_PROJECT_CWD}/missing.so')`);
				expect(
					{ statement: "load_extension", error: extension.error, labels: extension.labels },
					"load_extension is refused by the RAM authorizer",
				).toEqual({
					statement: "load_extension",
					error: expect.stringMatching(/not authorized/i),
					labels: ["sqlite.load_extension"],
				});
			} finally {
				database.close();
			}
			// File-backed read-only consumer: the writer creates the file, then the read-only handle opens on that backing. The
			// read-only consumer may not change persistent metadata (refused by exact label); the writer's value stays unchanged,
			// and the connection-only busy_timeout setting stays supported on the read-only handle.
			const statePath = `${HARNESS_PROJECT_CWD}/state.db`;
			const writer = new sqlite.DatabaseSync(statePath);
			let reader: typeof writer | undefined;
			try {
				reader = new sqlite.DatabaseSync(statePath, { readOnly: true });
				const metadataRefusal = probeOn(reader, "PRAGMA user_version = 42");
				expect(
					{ statement: "PRAGMA user_version = 42", error: metadataRefusal.error, labels: metadataRefusal.labels },
					"a read-only handle refuses a metadata setter by exact label",
				).toEqual({
					statement: "PRAGMA user_version = 42",
					error: expect.stringMatching(/not authorized/i),
					labels: ["sqlite.readonly_pragma"],
				});
				expect(writer.prepare("PRAGMA user_version").get(), "the normal handle keeps its user_version").toEqual({
					user_version: 0,
				});
				const busyBefore = world.guard.escapes.length;
				reader.exec("PRAGMA busy_timeout = 100");
				expect(
					reader.prepare("PRAGMA busy_timeout").get(),
					"busy_timeout is supported on the read-only handle",
				).toEqual({
					timeout: 100,
				});
				expect(world.guard.escapes.slice(busyBefore), "the supported setting records no denial").toEqual([]);
			} finally {
				reader?.close();
				writer.close();
			}
			let sessionManager: SessionManager | undefined;
			const ownerSourceId = (): string => {
				if (sessionManager === undefined) throw new Error("Owner source requested before the session exists");
				const owner = sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes("prefer tabs"),
					);
				if (owner === undefined) throw new Error("Owner message with the cited words is not on the session branch");
				return `${sessionManager.getSessionId().slice(0, 8)}/${owner.id}`;
			};
			const compactionGate = createBarrier();
			world.provider.enqueue(
				"root",
				text("greeting", "Hello, ready for a task."),
				calls("read-limits", [{ id: "read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
				calls("edit-wrong-old-text", [
					{
						id: "edit-bad",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 4", newText: "MAX_RETRIES = 5" }] },
					},
				]),
				calls("edit-corrected", [
					{
						id: "edit-good",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
					},
				]),
				{
					// The owner's own words are the cited evidence; production checks the citation against its ledger.
					name: "remember-preference",
					reply: () => ({
						content: [
							{
								type: "toolCall",
								id: "memory-1",
								name: "memory",
								arguments: {
									action: "add",
									target: "user",
									scope: "global",
									basis: "explicit",
									content: "The owner prefers tabs over spaces.",
									evidence: [{ source: ownerSourceId(), quote: "I prefer tabs over spaces" }],
								},
							},
						],
						stopReason: "toolUse",
					}),
				},
				{
					name: "task-done",
					check: () => {
						const added = lastToolResultDetails(mainSession ?? session, "memory");
						if (typeof added !== "object" || added === null || !("success" in added) || added.success !== true) {
							throw new Error(`the memory add was not successful: ${JSON.stringify(added)}`);
						}
					},
					reply: {
						content: [{ type: "text", text: "MAX_RETRIES is now 5 and your tab preference is recorded." }],
					},
				},
				{
					name: "compaction-summary",
					gate: compactionGate.promise,
					reply: { content: [{ type: "text", text: COMPACTION_SUMMARY }] },
				},
				{
					name: "queued-input-reply",
					check: (request) => {
						const serialized = JSON.stringify(request.context);
						if (!serialized.includes("tabs over spaces"))
							throw new Error("Memory preference missing from projected context");
					},
					reply: { content: [{ type: "text", text: "Continuing with the limits task and your tab preference." }] },
				},
				// The owner's older and newer reordered inputs are queued and delivered as their own turns, after the tab preference turn.
				text("queued-older-reply", "The older owner input is noted."),
				text("queued-newer-reply", "The newer owner input is noted."),
				// After the queued unit of work ends, the reflection checkpoint runs one internal turn before the next owner input.
				{
					name: "queued-reflection-checkpoint",
					check: (request) => {
						if (!requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER)) {
							throw new Error("the turn after the queued inputs is not the reflection checkpoint");
						}
					},
					reply: { content: [{ type: "text", text: "The queued owner inputs are reviewed." }] },
				},
				text("continuation", "Still on track."),
			);

			const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const session = created.session;
			mainSession = session;
			sessionManager = created.sessionManager;
			const messageEnds: string[] = [];
			const compactionEnds: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
			// Ordering uses production events only: compaction started, and the follow-up admitted to the queue.
			const compactionStarted = createBarrier();
			const followUpAdmitted = createBarrier();
			session.subscribe((event) => {
				if (event.type === "message_end") messageEnds.push(event.message.role);
				if (event.type === "compaction_start") compactionStarted.release();
				if (event.type === "compaction_end") compactionEnds.push(event);
				if (event.type === "queue_update" && event.followUp.some((queued) => queued.includes("tab preference"))) {
					followUpAdmitted.release();
				}
			});

			// Each phase names the exact System One questions it expects; the owner's greeting is small talk.
			// The greeting turn asks no judgment: its classification is asked later, during the task turn.
			world.systemOne.enterPhase("greeting", {});
			trace.mark("root", "greeting.submit");
			await withDeadline(trace, "greeting reply", session.prompt("Hi there"));
			trace.mark("root", "greeting.reply");

			// The task changes no model pool, delivery rule or handoff; it names no optional tool.
			// The owner's words are checked on the decoded request: the task and its queued follow-up are the only owner inputs,
			// the screened message is the greeting, and the native optional tool is secret_store.
			const taskOracle = expectOwnerWords({
				sessionManager: () => created.sessionManager,
				userRequests: [TASK_REQUEST, FOLLOW_UP_REQUEST],
				ownerMessages: ["Hi there"],
				optionalToolNames: ["secret_store"],
			});
			world.systemOne.enterPhase(
				"task",
				{
					capabilities_authorized: { kind: "noul", probability: 0.02 },
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					// owner_messages[0] is still the greeting, and the owner names no optional tool in any message.
					carries_0: { kind: "noul", probability: 0.97 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				},
				{ expect: taskOracle },
			);
			trace.mark("root", "task.submit");
			await withDeadline(trace, "task turn", session.prompt(TASK_REQUEST));
			trace.mark("root", "task.reply");
			// The add is durable: its managed file holds the saved entry, bytes on disk, not only a success flag.
			expect(world.io.readFileSync(`${world.agentDir}/USER.md`, "utf8")).toContain(
				"The owner prefers tabs over spaces.",
			);
			expect(world.io.readFileSync(LIMITS_PATH, "utf8"), toolOutcomes(session)).toContain("MAX_RETRIES = 5");

			// The summary request holds at its gate. The follow-up is queued while compaction is pending, and only
			// the admission event opens the gate: the queued prompt's own promise resolves after its turn, later.
			const compaction = session.compact("Keep the limits task.");
			await withDeadline(trace, "compaction started", compactionStarted.promise);
			trace.mark("root", "compaction.started");
			// The SDK owner edits queued input while compaction is held: wordless input is admitted and taken back,
			// without replacing the standing intent or pretending that a semantic judgment was uncertain.
			const intentBeforeWordlessInput = created.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE);
			await withDeadline(trace, "wordless follow-up admitted", trace.track(session.followUp(" \t ")));
			expect(session.getFollowUpMessages(), "the native queue admits the wordless owner input").toEqual([" \t "]);
			expect(
				created.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE),
				"wordless admission preserves the standing semantic intent in either mode",
			).toEqual(intentBeforeWordlessInput);
			expect(
				session.takeQueuedMessages().followUp.map((input) => input.text),
				"the owner takes the input back",
			).toEqual([" \t "]);
			expect(session.getFollowUpMessages(), "the withdrawn input leaves no queued work").toEqual([]);
			const queuedTurn = session.prompt("Also keep the tab preference in mind.", { streamingBehavior: "followUp" });
			await withDeadline(trace, "follow-up admitted to the queue", followUpAdmitted.promise);
			trace.mark("root", "queued-input.admitted");
			// Held owner evaluation, reordered, inside the held compaction: an older input's evaluation is held at its gate, a
			// newer contradictory input is classified and admitted first, and the older evaluation returns last. The commit
			// boundary is the native followUp promise, which resolves after the input's classification and admission.
			const classifiedEntries = (): Array<{ id: string; data: unknown }> =>
				created.sessionManager.getEntries().flatMap((entry) => {
					if (entry.type !== "custom" || entry.customType !== OPTIONAL_TOOL_INTENT_CUSTOM_TYPE) return [];
					return readOptionalToolIntent(entry.data)?.status === "classified"
						? [{ id: entry.id, data: entry.data }]
						: [];
				});
			const OLDER_OWNER_WORDS = "Check the secret store status before the compaction.";
			const NEWER_OWNER_WORDS = "Stop using the secret store for the rest of this task.";
			if (world.systemOne.enabled) {
				const olderReached = createBarrier();
				const releaseOlder = createBarrier();
				world.systemOne.enterPhase(
					"owner-older",
					{
						changes_model_pools: { kind: "noul", probability: 0.02 },
						local_commits_only: { kind: "noul", probability: 0.02 },
						lifts_delivery_block: { kind: "noul", probability: 0.02 },
						full_handoff: { kind: "noul", probability: 0.02 },
						optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
					},
					{ gate: releaseOlder.promise, ignoresAbort: true, onAdmit: () => olderReached.release() },
				);
				const olderInput = trace.track(session.followUp(OLDER_OWNER_WORDS));
				await withDeadline(trace, "older owner evaluation reached System One", olderReached.promise);
				trace.mark("root", "owner-older.held");
				world.systemOne.enterPhase("owner-newer", {
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
				});
				await withDeadline(
					trace,
					"newer owner input classified and admitted",
					trace.track(session.followUp(NEWER_OWNER_WORDS)),
				);
				const committed = classifiedEntries().at(-1);
				expect(
					readOptionalToolIntent(committed?.data)?.revokedTools?.map((tool) => tool.toolName),
					"the newer input's revocation is the committed policy before the older evaluation returns",
				).toEqual(["secret_store"]);
				const committedId = committed?.id;
				releaseOlder.release();
				await withDeadline(trace, "physical older evaluation joined", world.systemOne.joinInFlight(), 60_000);
				await withDeadline(trace, "older owner input settled", olderInput, 60_000);
				expect(
					classifiedEntries().at(-1)?.id,
					"the late older evaluation does not replace the committed newer policy",
				).toBe(committedId);
				expect(
					session.getFollowUpMessages(),
					"both owner inputs remain admitted after the older evaluation returns",
				).toEqual(expect.arrayContaining([OLDER_OWNER_WORDS, NEWER_OWNER_WORDS]));
				// The reordered owner words are queued, not yet screened: their screen is the only request this delivery makes.
				world.systemOne.enterPhase("queued-delivery", {
					carries_0: { kind: "noul", probability: 0.02 },
				});
			} else {
				await withDeadline(trace, "older owner input queued", trace.track(session.followUp(OLDER_OWNER_WORDS)));
				await withDeadline(trace, "newer owner input queued", trace.track(session.followUp(NEWER_OWNER_WORDS)));
			}
			compactionGate.release();
			const compactionResult = await withDeadline(trace, "compaction result", compaction);
			trace.mark("root", "compaction.returned");
			await withDeadline(trace, "queued follow-up turn", queuedTurn);
			// Every queued owner input is delivered as its own turn: the wait covers the older and newer turns as well.
			await withDeadline(trace, "queued inputs settled", session.waitForForegroundIdle());
			trace.mark("root", "queued-input.delivered");
			// Negative controls on the production payload the transport recorded: the oracle rejects the decoded task request when
			// its previous intent is not the native ledger's, and when its owner words were never submitted. Both must be named.
			// System One off sends no requests, so there is no payload to control.
			if (world.systemOne.enabled) {
				const taskRequest = world.systemOne.decoded.find(
					(request) =>
						request.phase === "task" &&
						(request.state as { user_request?: unknown }).user_request === TASK_REQUEST,
				);
				if (taskRequest === undefined) throw new Error("the task request was never decoded by System One");
				const taskState = taskRequest.state as Record<string, unknown>;
				expect(() =>
					taskOracle({
						...taskRequest,
						state: {
							...taskState,
							previous_optional_tool_intent: {
								version: 1,
								status: "classified",
								taskRequest: "A stale intent the native ledger never held",
								allowedTools: [],
							},
						},
					}),
				).toThrow("is not the session's classified intent");
				expect(() => taskOracle({ ...taskRequest, state: { ...taskState, user_request: "Hi there" } })).toThrow(
					"is not one of the phase's owner inputs",
				);
			}

			// Applied means the production result, its compaction_end event, and the persisted session entry agree.
			const ended = compactionEnds.at(-1);
			expect(ended?.aborted, "compaction_end was not recorded as applied").toBe(false);
			expect(ended?.result?.summary).toBe(COMPACTION_SUMMARY);
			expect(compactionResult.summary).toBe(COMPACTION_SUMMARY);
			const compactionEntry = created.sessionManager.getEntries().find((entry) => entry.type === "compaction");
			expect(compactionEntry?.type === "compaction" ? compactionEntry.summary : undefined).toBe(COMPACTION_SUMMARY);
			expect(compactionEntry?.type === "compaction" ? compactionEntry.firstKeptEntryId : undefined).toBe(
				compactionResult.firstKeptEntryId,
			);
			expect(world.provider.reached).toContain("root:queued-input-reply");

			await withDeadline(trace, "continuation turn", session.prompt("Continue."));
			trace.mark("root", "continuation.reply");

			expect(messageEnds).toContain("user");
			expect(messageEnds).toContain("assistant");

			world.provider.enqueue(
				"root",
				calls("memory-list", [
					{ id: "memory-list-1", name: "memory", arguments: { action: "list", target: "user" } },
				]),
				{
					name: "memory-list-reply",
					check: (request) => {
						const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
						if (!listed?.text.includes("The owner prefers tabs over spaces.")) {
							throw new Error(
								`the fresh memory read did not return the saved entry: ${listed?.text ?? "no result"}`,
							);
						}
					},
					reply: { content: [{ type: "text", text: "Your preference is saved." }] },
				},
			);
			world.systemOne.enterPhase("memory-read", {
				// The queued "Continue." is screened and continues the task: the reordered revoke is the previous intent it reads.
				carries_0: { kind: "noul", probability: 0.02 },
				optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			});
			await withDeadline(trace, "memory read-back turn", session.prompt("Read back the preference you saved."));
			trace.mark("root", "memory.read-back");

			// Long project path after compaction. The first read names the raw path; the minted alias then appears in the
			// request-visible PATH ALIASES legend, and the model reads through that alias. The short limits.ts stays unaliased.
			const longPath = `${HARNESS_PROJECT_CWD}/src/features/retry/configuration/limits.ts`;
			let longAlias: string | undefined;
			const longRequest = `Read ${longPath} and summarize the retry configuration.`;
			const priorIntent = readOptionalToolIntent(
				created.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
			);
			const longPathJudgments = {
				optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			} as const;
			// The evaluator is unavailable for this whole turn: the owner's long-path request is classified by no one.
			world.systemOne.enterPhase("long-path", longPathJudgments, { outage: true });
			world.provider.enqueue(
				"root",
				calls("read-long-path", [{ id: "read-long-1", name: "read", arguments: { path: longPath } }]),
				dynamicCalls(
					"read-by-alias",
					(request) => {
						longAlias = legendAliasFor(request, longPath);
						if (longAlias === undefined) {
							throw new Error("the long path was not minted into the request-visible PATH ALIASES legend");
						}
						if (legendAliasFor(request, LIMITS_PATH) !== undefined) {
							throw new Error("the short limits path was aliased: the saving threshold is not in effect");
						}
						return [{ id: "read-alias-1", name: "read", arguments: { path: longAlias } }];
					},
					(request) => assertBatchOk(request, "read-long-path"),
				),
				{
					name: "long-alias-reported",
					check: (request) => {
						assertBatchOk(request, "read-by-alias");
						if (!latestBatchResults(request).some((result) => result.text.includes("RETRY_CONFIGURATION"))) {
							throw new Error("the read through the minted alias did not return the long file");
						}
					},
					reply: { content: [{ type: "text", text: "The retry configuration was read by its alias." }] },
				},
			);
			await withDeadline(trace, "long path turn", session.prompt(longRequest));
			if (longAlias === undefined) throw new Error("no alias was observed for the long path");
			trace.mark("root", "long-path.read");
			// The long-path request met an unavailable evaluator. Assert the CURRENT latest native branch entry, not the
			// append-only history: the intent is unresolved, the request is the pending words, the prior classified intent is
			// resumed, and no classification ever answered the request. Off runs send no requests, so they assert nothing here.
			if (world.systemOne.enabled) {
				expect(
					world.systemOne.intendedOutages.length,
					"the long-path intake met an unavailable evaluator",
				).toBeGreaterThan(0);
				const latestIntent = readOptionalToolIntent(
					created.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
				);
				expect(
					{
						status: latestIntent?.status,
						taskRequest: latestIntent?.taskRequest,
						pendingRequests: latestIntent?.pendingRequests,
					},
					"the unavailable evaluator leaves the current owner intent unresolved, with the request pending",
				).toEqual({ status: "unresolved", taskRequest: longRequest, pendingRequests: [longRequest] });
				expect(latestIntent?.resumeIntent, "the unresolved intent resumes the prior classified intent").toEqual(
					priorIntent,
				);
				const classifiedAsLong = created.sessionManager.getEntries().some((entry) => {
					if (entry.type !== "custom" || entry.customType !== OPTIONAL_TOOL_INTENT_CUSTOM_TYPE) return false;
					const data = readOptionalToolIntent(entry.data);
					return data?.status === "classified" && data.taskRequest === longRequest;
				});
				expect(classifiedAsLong, "no classification was fabricated for the unanswered request").toBe(false);
			}
			// The alias is persisted in the session's SQL alias store, not only in the transcript: read it back through a read-only
			// connection, then close that connection before the body continues.
			const aliasStore = `${world.agentDir}/work/context/sessions/${created.sessionManager.getSessionId()}/index/runtime.sqlite`;
			if (!world.io.existsSync(aliasStore)) throw new Error(`the alias store was not written: ${aliasStore}`);
			const storedAliases = readPathAliases(aliasStore);
			expect(storedAliases, "the alias store holds the minted mapping").toContainEqual({
				full_path: longPath,
				alias_id: longAlias,
			});

			// Approval. A destructive bash command asks the operator, who denies the first attempt: production refuses it before the
			// shell is reached, so nothing reaches the shell transport. The same command, approved, executes exactly one scripted effect.
			const decisions: Array<"deny" | "allow-once"> = ["deny", "allow-once"];
			const askedOperations: string[] = [];
			const confirmations = world.externalConfirmations;
			session.setEdgeConfirmation(async (request) => {
				askedOperations.push(request.operation);
				confirmations.asked += 1;
				confirmations.inFlight += 1;
				try {
					// The operator's answer settles after a turn of the event loop: the callback is genuinely in flight meanwhile.
					await new Promise((resolve) => setImmediate(resolve));
					return decisions.shift() ?? "deny";
				} finally {
					confirmations.inFlight -= 1;
					confirmations.settled += 1;
				}
			});
			let approvedEffects = 0;
			world.shell.enqueue({
				name: "approved-destructive",
				command: "rm -rf .git",
				cwd: HARNESS_PROJECT_CWD,
				output: "",
				exitCode: 0,
				effect: () => {
					approvedEffects += 1;
				},
			});
			world.provider.enqueue(
				"root",
				calls("bash-denied", [{ id: "bash-denied-1", name: "bash", arguments: { command: "rm -rf .git" } }]),
				{
					name: "denied-reported",
					check: (request) => {
						const denied = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (!denied?.isError || !denied.text.includes("declined")) {
							throw new Error(
								`the denied command was not refused by the operator: ${denied?.text ?? "no result"}`,
							);
						}
						if (world.shell.requests.length !== 0) {
							throw new Error(`a denied command reached the shell: ${JSON.stringify(world.shell.requests)}`);
						}
					},
					reply: {
						content: [{ type: "toolCall", id: "read-between-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				{
					name: "read-between-reported",
					check: (request) => {
						assertBatchOk(request, "denied-reported");
					},
					reply: {
						content: [
							{ type: "toolCall", id: "bash-approved-1", name: "bash", arguments: { command: "rm -rf .git" } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approved-reported",
					check: (request) => {
						const approved = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (approved?.isError) throw new Error(`the approved command failed: ${approved.text}`);
						if (world.shell.requests.length !== 1 || approvedEffects !== 1) {
							throw new Error(
								`the approved command ran ${world.shell.requests.length} time(s) with ${approvedEffects} effect(s)`,
							);
						}
					},
					reply: { content: [{ type: "text", text: "The approved removal ran once." }] },
				},
			);
			world.systemOne.enterPhase("approval", {
				carries_0: { kind: "noul", probability: 0.97 },
				optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			});
			await withDeadline(trace, "approval turn", session.prompt("Remove the .git directory of this project."));
			session.setEdgeConfirmation(undefined);
			expect(
				{ ...confirmations, decisionsLeft: decisions.length },
				"every asked confirmation settled, none in flight, no decision left over",
			).toEqual({ asked: askedOperations.length, inFlight: 0, settled: askedOperations.length, decisionsLeft: 0 });
			trace.mark("root", "approval.settled");
			// The next owner classification carries the unresolved long-path request as pending: the native state presents it again.
			if (world.systemOne.enabled) {
				const approvalIntake = world.systemOne.decoded.find(
					(request) =>
						request.phase === "approval" &&
						(request.state as { user_request?: unknown }).user_request ===
							"Remove the .git directory of this project.",
				);
				expect(
					(approvalIntake?.state as { pending_owner_requests?: unknown } | undefined)?.pending_owner_requests,
					"the approval classification re-presents the unresolved long-path request",
				).toEqual([longRequest]);
				// The latest usable state after the approval turn: the owner intent is classified again, not left unresolved.
				const usableIntent = readOptionalToolIntent(
					created.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
				);
				expect(usableIntent?.status, "the approval classification restores a usable owner intent").toBe(
					"classified",
				);
			}
			expect(askedOperations, "the operator is asked for each attempt").toHaveLength(2);
			expect(askedOperations.every((operation) => operation.includes("rm -rf .git"))).toBe(true);

			// Late approval. The operator's answer to a destructive command is still pending when the owner is aborted. That answer then
			// returns allow-once after the abort: it must reach no shell and record no native grant. The same command asks again on a fresh turn,
			// and that timely answer runs it exactly once.
			const lateGrantsBefore = session.getEdgeGrants();
			const lateAskedHeld = createBarrier();
			const lateAnswer = createBarrier();
			const lateOperations: string[] = [];
			session.setEdgeConfirmation(async (request) => {
				lateOperations.push(request.operation);
				confirmations.asked += 1;
				confirmations.inFlight += 1;
				try {
					if (lateOperations.length === 1) {
						lateAskedHeld.release();
						await lateAnswer.promise;
					} else {
						await new Promise((resolve) => setImmediate(resolve));
					}
					return "allow-once";
				} finally {
					confirmations.inFlight -= 1;
					confirmations.settled += 1;
				}
			});
			let lateEffects = 0;
			world.shell.enqueue({
				name: "late-approved-destructive",
				command: "rm -rf .git",
				cwd: HARNESS_PROJECT_CWD,
				output: "",
				exitCode: 0,
				effect: () => {
					lateEffects += 1;
				},
			});
			world.provider.enqueue(
				"root",
				calls("late-bash-held", [{ id: "late-bash-held-1", name: "bash", arguments: { command: "rm -rf .git" } }]),
				calls("late-bash-fresh", [
					{ id: "late-bash-fresh-1", name: "bash", arguments: { command: "rm -rf .git" } },
				]),
				{
					name: "late-fresh-reported",
					check: (request) => {
						const ran = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (ran?.isError) throw new Error(`the timely approval did not run: ${ran.text}`);
					},
					reply: { content: [{ type: "text", text: "The timely approval ran once." }] },
				},
			);
			const lateHeldPrompt = session
				.prompt("Remove the .git directory again, and wait for the operator.")
				.catch((error: unknown) => error);
			await withDeadline(trace, "late approval asked and held", lateAskedHeld.promise);
			const shellBeforeLate = world.shell.requests.length;
			const lateAbort = session.abort("the operator aborts while the approval is held");
			lateAnswer.release();
			await withDeadline(trace, "late approval owner aborted", lateAbort);
			await withDeadline(trace, "late approval held turn settled", lateHeldPrompt);
			expect(lateEffects, "a late allow-once after the abort runs no effect").toBe(0);
			expect(world.shell.requests.length, "a late allow-once after the abort reaches no shell").toBe(
				shellBeforeLate,
			);
			expect(session.getEdgeGrants(), "a late allow-once records no native grant").toEqual(lateGrantsBefore);
			expect(
				session.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"),
				"the held turn persists as aborted",
			).toBe(true);
			await withDeadline(
				trace,
				"late approval fresh turn",
				session.prompt("Remove the .git directory again, now that it is approved."),
			);
			session.setEdgeConfirmation(undefined);
			trace.mark("root", "late-approval.settled");
			expect(lateOperations, "the same operation asks again on the fresh turn").toHaveLength(2);
			expect(lateOperations.every((operation) => operation.includes("rm -rf .git"))).toBe(true);
			expect(lateEffects, "the timely approval runs the command exactly once").toBe(1);
			expect(world.shell.requests.length - shellBeforeLate, "the timely approval reaches the shell once").toBe(1);
			expect(confirmations.inFlight, "no late confirmation is left in flight").toBe(0);
			expect(confirmations.settled, "every late confirmation settled").toBe(confirmations.asked);
			expect(session.getEdgeGrants(), "allow-once records no native grant on either attempt").toEqual(
				lateGrantsBefore,
			);

			// Cancellation. The turn is held at its provider gate until the operator aborts it: the abort persists the turn
			// as aborted, the current input is answered by the next turn, the held reply never reaches the transcript, and
			// the cancelled root starts no worker.
			const providerReached = createBarrier();
			const neverReleased = createBarrier();
			const turnStarted = createBarrier();
			const unsubscribeTurnStart = session.subscribe((event) => {
				if (event.type === "turn_start") turnStarted.release();
			});
			world.provider.enqueue(
				"root",
				{
					name: "cancelled-turn",
					check: () => providerReached.release(),
					gate: neverReleased.promise,
					reply: { content: [{ type: "text", text: "This reply is never delivered." }] },
				},
				text("current-input-reply", "Current input handled."),
			);
			const cancelledPrompt = session
				.prompt("Start a long task that the operator cancels.")
				.catch((error: unknown) => error);
			await withDeadline(trace, "cancelled turn started", turnStarted.promise);
			await withDeadline(trace, "cancelled turn reached its provider gate", providerReached.promise);
			await session.abort("operator cancel");
			await withDeadline(trace, "cancelled prompt settled", cancelledPrompt);
			unsubscribeTurnStart();
			trace.mark("root", "turn.cancelled");
			expect(
				session.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"),
				"the cancelled turn must persist as an aborted assistant message",
			).toBe(true);
			await withDeadline(trace, "current input after the cancel", session.prompt("Current input after the cancel."));
			trace.mark("root", "current-input.reply");
			const transcript = JSON.stringify(session.messages);
			expect(transcript).toContain("Current input handled.");
			expect(transcript, "a cancelled turn's held reply must not reach the transcript").not.toContain(
				"This reply is never delivered.",
			);
			expect(delegateResultTexts(session), "a cancelled root starts no worker").toEqual([]);
			expect(world.provider.reached.filter((step) => !step.startsWith("root:"))).toEqual([]);

			// User bash, driven directly (no model turn). Prewarm with a configured backend starts nothing local; the default backend
			// runs the command through the scripted shell; a per-call operations override runs through its own backend instead.
			const explicitShell = new VirtualShell();
			world.shell.enqueue({
				name: "direct-default",
				command: "echo direct-default",
				cwd: HARNESS_PROJECT_CWD,
				output: "direct-default\n",
				exitCode: 0,
			});
			explicitShell.enqueue({
				name: "direct-explicit",
				command: "echo direct-explicit",
				cwd: HARNESS_PROJECT_CWD,
				output: "direct-explicit\n",
				exitCode: 0,
			});
			const shellRequestsBeforePrewarm = world.shell.requests.length;
			await withDeadline(trace, "prewarm settled", session.prewarmShell());
			expect(world.shell.requests.length, "prewarm with a configured backend runs nothing").toBe(
				shellRequestsBeforePrewarm,
			);
			const directDefault = await withDeadline(
				trace,
				"direct default bash",
				session.executeBash("echo direct-default"),
			);
			expect(directDefault.output).toContain("direct-default");
			expect(directDefault.exitCode).toBe(0);
			const directExplicit = await withDeadline(
				trace,
				"direct explicit bash",
				session.executeBash("echo direct-explicit", undefined, { operations: explicitShell }),
			);
			expect(directExplicit.output).toContain("direct-explicit");
			expect(world.shell.requests.map((request) => request.command)).not.toContain("echo direct-explicit");
			explicitShell.assertDrained();
			await explicitShell.dispose();

			// Transport races, driven directly through the shell port: the model tool is not involved, and only the model-tool route is
			// in scope here. A cancellation raised while a step's check runs must reject before its gate is awaited; a cancellation
			// raised by the final output callback must not report a successful exit.
			const checkAbort = new AbortController();
			const raceGate = createBarrier();
			world.shell.enqueue({
				name: "race-abort-during-check",
				command: "race-abort-during-check",
				cwd: HARNESS_PROJECT_CWD,
				output: "",
				exitCode: 0,
				gate: raceGate.promise,
				check: () => checkAbort.abort(),
			});
			const duringCheck = world.shell
				.exec("race-abort-during-check", HARNESS_PROJECT_CWD, {
					onData: () => undefined,
					signal: checkAbort.signal,
				})
				.then(
					() => "exited",
					(error: unknown) => failureText(error),
				);
			expect(await withDeadline(trace, "cancelled during check settled", duringCheck)).toBe("aborted");
			const finalAbort = new AbortController();
			world.shell.enqueue({
				name: "race-abort-after-output",
				command: "race-abort-after-output",
				cwd: HARNESS_PROJECT_CWD,
				output: "only chunk\n",
				exitCode: 0,
			});
			const afterOutput = world.shell
				.exec("race-abort-after-output", HARNESS_PROJECT_CWD, {
					onData: () => finalAbort.abort(),
					signal: finalAbort.signal,
				})
				.then(
					() => "exited",
					(error: unknown) => failureText(error),
				);
			expect(await withDeadline(trace, "cancelled after output settled", afterOutput)).toBe("aborted");
			expect(world.shell.reached).toEqual(
				expect.arrayContaining(["race-abort-during-check", "race-abort-after-output"]),
			);

			// Shutdown ownership. The main session's own disposal completes. A required SQL write that fails during a
			// session's path-alias release rejects its disposeAndWait, and the SQL connection is still released. Two
			// prompts leave a pending scanned fingerprint in a session that has already persisted one; only close writes it.
			// Decision ledger constructor fault through the real store: its schema exec fails with the scripted message, the constructor
			// disposes its database, the fault is consumed, and no application handle stays open. A normal construction then works.
			const ledgerPath = decisionLedgerFile(`${world.agentDir}-ledger`);
			// The open handles of the live sessions stay open: each construction is judged by the handles it adds or leaves.
			const openSqliteHandles = (): string[] => {
				try {
					world.guard.assertNoOpenSqliteHandles();
					return [];
				} catch (error) {
					return error instanceof Error
						? error.message.replace("Application SQLite handles leaked: ", "").split(", ")
						: [];
				}
			};
			const handlesBeforeFailure = openSqliteHandles();
			world.guard.failNextSqliteOperation("exec", "CREATE TABLE IF NOT EXISTS ledger_meta");
			let ledgerConstruction: unknown;
			try {
				new DecisionLedgerStore({ databasePath: ledgerPath });
			} catch (error) {
				ledgerConstruction = error;
			}
			expect(
				ledgerConstruction instanceof Error ? ledgerConstruction.message : undefined,
				"the schema exec failure is the scripted one",
			).toBe("Scripted SQLite exec failure: CREATE TABLE IF NOT EXISTS ledger_meta");
			world.guard.assertSqliteFaultsConsumed();
			expect(openSqliteHandles(), "the failed construction leaves no handle").toEqual(handlesBeforeFailure);
			const handlesBeforeNormal = openSqliteHandles();
			const normalLedger = new DecisionLedgerStore({ databasePath: ledgerPath });
			normalLedger.close();
			expect(openSqliteHandles(), "the normal construction closes its handle").toEqual(handlesBeforeNormal);

			// Credential content through the real field mock: the lane key that routes a worktree stays readable, secret-keyed values
			// are masked, and a token-shaped value is masked wherever it sits.
			// The api key control uses an opaque value that no token-shape rule matches, so only key classification can mask it.
			expect(isCredentialSecretKey("apiKey"), "apiKey is a credential key").toBe(true);
			expect(isCredentialSecretKey("laneKey"), "the exact laneKey is the only exempt key").toBe(false);
			const laneKeyFields = mockCredentialFields('{"laneKey":"rootwork","apiKey":"opaque-key-value-42"}');
			expect(laneKeyFields, "the lane key is retained").toContain('"laneKey":"rootwork"');
			expect(laneKeyFields, "the api key value is masked by key classification").not.toContain(
				"opaque-key-value-42",
			);
			expect(mockCredentialFields('{"password":"hunter2-secret"}'), "the password value is masked").not.toContain(
				"hunter2-secret",
			);
			const tokenLaneKey = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			expect(
				mockCredentialFields(`{"laneKey":"${tokenLaneKey}"}`),
				"a token-shaped lane key is masked",
			).not.toContain(tokenLaneKey);

			// The background turns ask no judgment of their own; the cleanup turns ask the owner-message question.
			const backgroundJudgments = {
				optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.02 },
			} as const;
			// A new session's first prompt asks the task questions as well, so the cleanup turns carry the full set.
			const cleanupJudgments = {
				...backgroundJudgments,
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				carries_0: { kind: "noul", probability: 0.97 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			} as const;

			// Background bash through the real task handoff. The start call is held at its shell gate; the explicit background request
			// hands off at once with a task id, and the completion is matched to that id in the handoff, not to command text.
			const backgroundGate = createBarrier();
			const backgroundHanded = createBarrier();
			const backgroundReflected = createBarrier();
			let backgroundTaskId: string | undefined;
			world.shell.enqueue({
				name: "background-check",
				command: "echo background-check",
				cwd: HARNESS_PROJECT_CWD,
				output: "background-check\n",
				exitCode: 0,
				gate: backgroundGate.promise,
			});
			world.systemOne.enterPhase("background", backgroundJudgments);
			world.provider.enqueue(
				"root",
				calls("background-start", [
					{
						id: "background-start-1",
						name: "bash",
						arguments: { command: "echo background-check", background: true },
					},
				]),
				{
					name: "background-started",
					check: (request) => {
						expect(
							session.getActiveToolNames(),
							"tool_task is active, so the handoff path is admitted",
						).toContain("tool_task");
						const bash = session.getToolDefinition("bash");
						expect(
							bash?.backgroundRequested?.({ command: "echo background-check", background: true } as never),
							"an explicit background bash call is requested in its definition",
						).toBe(true);
						expect(
							bash?.backgroundRequested?.({ command: "echo background-check" } as never),
							"a foreground bash call is not requested in its definition",
						).toBe(false);
						backgroundTaskId = backgroundTaskIdOf(request);
					},
					reply: { content: [{ type: "text", text: "The check runs in the background." }] },
				},
				{
					name: "background-reflection",
					check: (request) => {
						if (!requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER)) {
							throw new Error("the root turn is not the reflection checkpoint");
						}
						backgroundReflected.release();
					},
					reply: { content: [{ type: "text", text: "Nothing durable to record." }] },
				},
				{
					name: "background-handoff",
					check: (request) => {
						if (backgroundTaskId === undefined) throw new Error("the start result carried no task id");
						if (!handoffFor(request, backgroundTaskId)) {
							throw new Error(`the completion of ${backgroundTaskId} did not reach the foreground root`);
						}
						backgroundHanded.release();
					},
					reply: { content: [{ type: "text", text: "The background check is reported." }] },
				},
			);
			await withDeadline(trace, "background start turn", session.prompt("Start the check in the background."));
			trace.mark("root", "background.started");
			await withDeadline(trace, "background reflection turn", backgroundReflected.promise, 60_000);
			backgroundGate.release();
			await withDeadline(trace, "background handoff", backgroundHanded.promise, 60_000);
			await withDeadline(trace, "background handoff settled", session.waitForForegroundIdle(), 60_000);
			expect(
				world.shell.requests.filter((request) => request.command === "echo background-check"),
				"the background command physically ran once",
			).toHaveLength(1);

			// Old handoff against a newer owner turn: a background task started under owner turn A completes while owner turn B is
			// held at its provider gate. B's current request suffix must not carry A's handoff; the handoff is delivered once, on its
			// own idle turn, with the exact task id.
			const heldCheckGate = createBarrier();
			const heldCheckDone = createBarrier();
			const bHeld = createBarrier();
			const releaseB = createBarrier();
			const heldCheckHanded = createBarrier();
			let heldTaskId: string | undefined;
			world.shell.enqueue({
				name: "held-check",
				command: "echo held-check",
				cwd: HARNESS_PROJECT_CWD,
				output: "held-check\n",
				exitCode: 0,
				gate: heldCheckGate.promise,
				check: () => heldCheckDone.release(),
			});
			world.systemOne.enterPhase("held-background", backgroundJudgments);
			world.provider.enqueue(
				"root",
				calls("held-start", [
					{ id: "held-start-1", name: "bash", arguments: { command: "echo held-check", background: true } },
				]),
				{
					name: "held-started",
					check: (request) => {
						heldTaskId = backgroundTaskIdOf(request);
					},
					reply: { content: [{ type: "text", text: "The held check runs in the background." }] },
				},
				{
					name: "owner-b-held",
					gate: releaseB.promise,
					check: () => bHeld.release(),
					reply: {
						content: [{ type: "toolCall", id: "b-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				{
					name: "owner-b-boundary",
					check: (request) => {
						if (heldTaskId === undefined) throw new Error("the held start result carried no task id");
						if (handoffFor(request, heldTaskId)) {
							throw new Error(`the old handoff of ${heldTaskId} entered the newer owner turn's current suffix`);
						}
					},
					reply: { content: [{ type: "text", text: "Owner turn B reads the limits file." }] },
				},
				{
					name: "held-handoff",
					check: (request) => {
						if (heldTaskId === undefined) throw new Error("the held start result carried no task id");
						if (!handoffFor(request, heldTaskId)) {
							throw new Error(`the completion of ${heldTaskId} did not reach the foreground root`);
						}
						heldCheckHanded.release();
					},
					reply: { content: [{ type: "text", text: "The held check is reported after owner turn B." }] },
				},
			);
			await withDeadline(trace, "held start turn", session.prompt("Start the held check in the background."));
			trace.mark("root", "held.started");
			const ownerB = session.prompt("Read the limits file once more.");
			await withDeadline(trace, "owner turn B held at its provider gate", bHeld.promise, 60_000);
			heldCheckGate.release();
			await withDeadline(trace, "held background command completed", heldCheckDone.promise, 60_000);
			releaseB.release();
			await withDeadline(trace, "owner turn B ended", ownerB, 60_000);
			await withDeadline(trace, "old handoff delivered on its own turn", heldCheckHanded.promise, 60_000);
			await withDeadline(trace, "old handoff settled", session.waitForForegroundIdle(), 60_000);
			expect(
				world.shell.requests.filter((request) => request.command === "echo held-check"),
				"the held background command physically ran once",
			).toHaveLength(1);

			// Cleanup fault through the real preparation owner: the scoped background call registers a cleanup that throws, and its
			// start is gated so the explicit background handoff wins the race against completion. The operation still runs once, its
			// cleanup failure is retained, and shutdown rejects with that failure. The original hook is called unchanged.
			const cleanupSession = (await world.createRootSession("root", { agentDir: `${world.agentDir}-cleanup` }))
				.session;
			const originalHook = cleanupSession.agent.beforeToolCall;
			cleanupSession.agent.beforeToolCall = async (context, signal) => {
				if (context.toolCall.name === "bash" && commandOf(context.args) === "echo background-cleanup") {
					context.registerCleanup?.(() => {
						throw new Error("scripted cleanup fault");
					});
				}
				return originalHook ? await originalHook(context, signal) : undefined;
			};
			const cleanupGate = createBarrier();
			const cleanupHanded = createBarrier();
			let cleanupTaskId: string | undefined;
			world.shell.enqueue({
				name: "background-cleanup",
				command: "echo background-cleanup",
				cwd: HARNESS_PROJECT_CWD,
				output: "background-cleanup\n",
				exitCode: 0,
				gate: cleanupGate.promise,
			});
			world.systemOne.enterPhase("cleanup", cleanupJudgments);
			world.provider.enqueue(
				"root",
				calls("cleanup-start", [
					{
						id: "cleanup-start-1",
						name: "bash",
						arguments: { command: "echo background-cleanup", background: true },
					},
				]),
				{
					name: "cleanup-started",
					check: (request) => {
						cleanupTaskId = backgroundTaskIdOf(request);
					},
					reply: { content: [{ type: "text", text: "The cleanup check runs in the background." }] },
				},
				{
					name: "cleanup-handoff",
					check: (request) => {
						if (cleanupTaskId === undefined) throw new Error("the cleanup start result carried no task id");
						if (!handoffFor(request, cleanupTaskId)) {
							throw new Error(`the completion of ${cleanupTaskId} did not reach the foreground root`);
						}
						cleanupHanded.release();
					},
					reply: { content: [{ type: "text", text: "The cleanup check is reported." }] },
				},
			);
			const reflectionsBeforeCleanup = world.provider.requests.filter((request) =>
				requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER),
			).length;
			await withDeadline(
				trace,
				"cleanup start turn",
				cleanupSession.prompt("Start the cleanup check in the background."),
			);
			await withDeadline(trace, "cleanup foreground settled", cleanupSession.waitForForegroundIdle(), 60_000);
			expect(
				world.provider.requests.filter((request) => requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER))
					.length,
				"a fresh session's start turn makes no reflection due",
			).toBe(reflectionsBeforeCleanup);
			cleanupGate.release();
			await withDeadline(trace, "cleanup handoff", cleanupHanded.promise, 60_000);
			await withDeadline(trace, "cleanup handoff settled", cleanupSession.waitForForegroundIdle(), 60_000);
			cleanupSession.agent.beforeToolCall = originalHook;
			expect(
				world.shell.requests.filter((request) => request.command === "echo background-cleanup"),
				"the cleanup command physically ran once",
			).toHaveLength(1);
			const cleanupShutdown = await world.disposeSessionInBody(cleanupSession);
			const shutdownFailures =
				cleanupShutdown?.error instanceof AggregateError ? cleanupShutdown.error.errors.map(String) : [];
			expect(shutdownFailures, "shutdown rejects with the retained cleanup failure").toEqual([
				expect.stringMatching(/Background tool cleanup failed/),
			]);

			world.provider.enqueue(
				"root",
				{
					name: "reopened-check",
					check: (request) => {
						// The provider receives the restored history: the continuation of the session written before the reopen.
						if (!JSON.stringify(request.context).includes("Still on track.")) {
							throw new Error("the reopened request does not carry the restored history");
						}
						if (longAlias === undefined || legendAliasFor(request, longPath) !== longAlias) {
							throw new Error(`the reopened legend does not map the long path to ${longAlias ?? "its alias"}`);
						}
					},
					reply: { content: [{ type: "text", text: "Reopened and continuing." }] },
				},
				dynamicCalls("restored-alias-read", (request) => {
					const alias = legendAliasFor(request, longPath);
					if (alias === undefined || alias !== longAlias) {
						throw new Error(`the restored legend maps the long path to ${alias ?? "nothing"}, not ${longAlias}`);
					}
					return [{ id: "restored-read-1", name: "read", arguments: { path: alias } }];
				}),
				{
					name: "restored-alias-reported",
					check: (request) => {
						assertBatchOk(request, "restored-alias-read");
						if (!latestBatchResults(request).some((result) => result.text.includes("RETRY_CONFIGURATION"))) {
							throw new Error("the restored alias did not read the long file");
						}
					},
					reply: { content: [{ type: "text", text: "The restored alias reads the same file." }] },
				},
				text("probe-faulty-1", "Probe one."),
				text("probe-faulty-2", "Probe two."),
				text("probe-control-1", "Control one."),
				text("probe-control-2", "Control two."),
			);
			expect(await world.disposeSessionInBody(session), "the main session's disposal must complete").toBeUndefined();
			// Restore: the session file written to the virtual tree is reopened by its owner and continues the same conversation.
			const sessionFile = created.sessionManager.getSessionFile();
			if (sessionFile === undefined) throw new Error("the persisted session has no file");
			expect(world.io.existsSync(sessionFile), "the session file must be written to the virtual tree").toBe(true);
			const reopened = (
				await world.createRootSession("root", { sessionManager: world.openSessionManager(sessionFile) })
			).session;
			expect(JSON.stringify(reopened.messages), "the reopened history carries the continuation").toContain(
				"Still on track.",
			);
			await withDeadline(trace, "reopened turn", reopened.prompt("Continue after the reopen."));
			await withDeadline(
				trace,
				"restored alias turn",
				reopened.prompt("Read the retry configuration by its alias."),
			);
			expect(
				await world.disposeSessionInBody(reopened),
				"the reopened session must dispose cleanly",
			).toBeUndefined();
			// Factory lifecycle: a prepare failure inside the path-alias store factory, after its migrations, is surfaced as the
			// turn's error and must still close the connection the factory opened. No provider reply is involved: the turn fails
			// before the request is sent, so the probe is not queued.
			const prepareFaulted = (
				await world.createRootSession("root", { sessionManager: world.createSessionManager() })
			).session;
			world.guard.failNextSqliteOperation("prepare", "SELECT fingerprint FROM path_alias_scanned");
			await withDeadline(trace, "prepare-faulted turn", prepareFaulted.prompt("Prepare probe."));
			const surfaced = prepareFaulted.messages.at(-1);
			if (
				surfaced?.role !== "assistant" ||
				surfaced.stopReason !== "error" ||
				!surfaced.errorMessage?.includes(
					"Scripted SQLite prepare failure: SELECT fingerprint FROM path_alias_scanned",
				)
			) {
				throw new Error(`the prepare failure did not surface as the turn error: ${JSON.stringify(surfaced)}`);
			}
			world.guard.assertSqliteFaultsConsumed();
			expect(
				await world.disposeSessionInBody(prepareFaulted),
				"the factory failure must not block disposal",
			).toBeUndefined();
			world.guard.assertNoOpenSqliteHandles();
			const faulty = (await world.createRootSession()).session;
			await withDeadline(trace, "faulty probe one", faulty.prompt("Probe one."));
			await withDeadline(trace, "faulty probe two", faulty.prompt("Probe two."));
			world.guard.failNextSqliteOperation("run", "INSERT INTO path_alias_scanned");
			const rejection = await world.disposeSessionInBody(faulty);
			expect(rejection, "a failed required SQL write must reject disposeAndWait").toBeDefined();
			expect(failureText(rejection?.error)).toContain("Scripted SQLite run failure: INSERT INTO path_alias_scanned");
			world.guard.assertSqliteFaultsConsumed();
			world.guard.assertNoOpenSqliteHandles();
			// Negative control: the same release with no fault injected completes cleanly.
			const control = (await world.createRootSession()).session;
			await withDeadline(trace, "control probe one", control.prompt("Control one."));
			await withDeadline(trace, "control probe two", control.prompt("Control two."));
			expect(await world.disposeSessionInBody(control), "a release without a fault must complete").toBeUndefined();
			world.guard.assertNoOpenSqliteHandles();
			// Logical durable cut of a pending native question. The ask is captured at its UI presentation, the live owner is
			// cancelled and settled, and a fresh owner restores only the captured bytes. This qualifies logical restoration of the
			// captured cut: it is not crash, dead-owner or fsync durability.
			const ASK_CALL_ID = "ask-scope-1";
			const scopeQuestion = {
				id: "scope",
				header: "Scope",
				question: "Which limit applies to this run?",
				options: [
					{ label: "Staging", description: "Use the staging limit." },
					{ label: "Production", description: "Use the production limit." },
				],
			};
			const cutPath = "/harness/durable-cut/ask-scope.jsonl";
			const presented = createBarrier();
			const holdAsk = createBarrier();
			let presentedRequestId: string | undefined;
			let capturedCut: string | undefined;
			const askRoot = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			await askRoot.session.bindExtensions({ uiContext: world.humanInput.ui });
			world.provider.enqueue(
				"root",
				calls("ask-scope", [{ id: ASK_CALL_ID, name: "ask_question", arguments: { questions: [scopeQuestion] } }]),
				{
					name: "ask-answer-reported",
					check: (request) => {
						const answered = request.context.messages.some(
							(message) =>
								message.role === "toolResult" &&
								message.toolCallId === ASK_CALL_ID &&
								message.content.some((block) => block.type === "text" && block.text.includes("Staging")),
						);
						if (!answered) throw new Error("the resumed question's answer is not in the provider context");
					},
					reply: { content: [{ type: "text", text: "The staging limit is recorded." }] },
				},
			);
			world.humanInput.enqueue({
				name: "ask-scope-presented",
				gate: holdAsk.promise,
				check: (request) => {
					const sessionFile = askRoot.sessionManager.getSessionFile();
					if (sessionFile === undefined) throw new Error("the asking session has no file to cut");
					if (world.io.existsSync(cutPath))
						throw new Error("the durable cut is already written: cuts are immutable");
					const bytes = String(world.io.readFileSync(sessionFile, "utf8"));
					world.io.mkdirSync("/harness/durable-cut", { recursive: true });
					world.io.writeFileSync(cutPath, bytes);
					capturedCut = bytes;
					presentedRequestId = request.requestId;
					presented.release();
				},
				reply: { answers: [], cancelled: true, reason: "interrupted", imageContents: [] },
			});
			const askTurn = askRoot.session.prompt("Ask which limit applies before you edit anything.");
			await withDeadline(trace, "ask presentation reached", presented.promise);
			trace.mark("root", "ask.presented");
			// The live owner is cancelled: the abort settles the external presentation, the join proves it, and only then is the
			// old session disposed. Its presentation is never released, so only the cancellation can end it.
			const aborted = askRoot.session.abort("the owner aborts while the question is pending");
			await withDeadline(trace, "external presentation settled", world.humanInput.join());
			await withDeadline(trace, "old ask owner aborted", aborted);
			await withDeadline(
				trace,
				"aborted ask turn ended",
				askTurn.catch(() => undefined),
			);
			expect(await world.disposeSessionInBody(askRoot.session), "the cut owner disposes cleanly").toBeUndefined();
			holdAsk.release();
			if (capturedCut === undefined || presentedRequestId === undefined) {
				throw new Error("the ask presentation was never captured");
			}
			// The captured cut holds the assistant's call and the native pending question, and no result for that call.
			const parsed = capturedCut
				.split("\n")
				.filter((line) => line.length > 0)
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string;
							message?: { role?: string; toolCallId?: string; content?: Array<{ type: string; id?: string }> };
						},
				);
			expect(
				parsed.some(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "assistant" &&
						(entry.message.content ?? []).some((block) => block.type === "toolCall" && block.id === ASK_CALL_ID),
				),
				"the captured cut holds the assistant's ask_question call",
			).toBe(true);
			expect(
				parsed.some(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "toolResult" &&
						entry.message.toolCallId === ASK_CALL_ID,
				),
				"the captured cut holds no result for the ask",
			).toBe(false);
			const pending = getResumableHumanInputSnapshot(world.openSessionManager(cutPath));
			expect(
				{ status: pending?.status, requestId: pending?.request.requestId, toolCallId: pending?.request.toolCallId },
				"the captured cut restores exactly one pending native question",
			).toEqual({ status: "pending", requestId: presentedRequestId, toolCallId: ASK_CALL_ID });
			// The canonical native start of the ask, read from the captured cut: the terminal that closes it must name this tuple.
			const cutEntries = world.openSessionManager(cutPath).getEntries();
			const askStarts = cutEntries.flatMap((entry) =>
				entry.type === "foreground_tool_start" && entry.callId === ASK_CALL_ID ? [entry] : [],
			);
			expect(askStarts, "the cut holds exactly one canonical foreground start for the ask").toHaveLength(1);
			const [askStart] = askStarts;
			if (askStart === undefined) throw new Error("the cut holds no canonical foreground start for the ask");
			const askTuple = {
				requestId: askStart.requestId,
				assistantMessageEntryId: askStart.assistantMessageEntryId,
				callId: askStart.callId,
				toolName: askStart.toolName,
			};
			expect(
				cutEntries.some((entry) => entry.type === "foreground_tool_terminal" && entry.callId === ASK_CALL_ID),
				"the cut holds no terminal for the ask",
			).toBe(false);
			// The fresh owner opens the captured bytes unchanged and answers the same request once; a second resume finds nothing.
			const restored = await world.createRootSession("root", { sessionManager: world.openSessionManager(cutPath) });
			await restored.session.bindExtensions({ uiContext: world.humanInput.ui });
			world.humanInput.enqueue({
				name: "ask-scope-resumed",
				check: (request) => {
					if (request.requestId !== presentedRequestId)
						throw new Error("the resumed presentation names another request");
				},
				reply: {
					answers: [
						{
							id: "scope",
							header: "Scope",
							question: scopeQuestion.question,
							selected: ["Staging"],
							skipped: false,
						},
					],
					cancelled: false,
					imageContents: [],
				},
			});
			expect(
				{
					pending: getResumableHumanInputSnapshot(restored.sessionManager)?.status,
					streaming: restored.session.isStreaming,
				},
				"the restored owner's own view holds the pending question before it resumes",
			).toEqual({ pending: "pending", streaming: false });
			// The branch's native companions of the ask, read from the restored owner's own manager: terminals and tool results.
			const askEntriesNow = () => {
				const entries = restored.sessionManager.getEntries();
				return {
					terminals: entries.flatMap((entry) =>
						entry.type === "foreground_tool_terminal" && entry.callId === ASK_CALL_ID ? [entry] : [],
					),
					results: entries.flatMap((entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === ASK_CALL_ID
							? [entry]
							: [],
					),
				};
			};
			expect(
				await withDeadline(trace, "pending question resumed", restored.session.resumePendingHumanInput()),
				"the restored owner resumes the pending question",
			).toBe(true);
			await withDeadline(trace, "resumed turn settled", restored.session.waitForForegroundIdle());
			expect(
				world.humanInput.requests.filter((request) => request.requestId === presentedRequestId),
				"the same request is presented once to the old owner and once to the restored owner",
			).toHaveLength(2);
			// The native companion: the answer closes the canonical original start through exactly one terminal, and that terminal
			// names the actual tool result entry. No placeholder result stands in for the answer, and the branch stays balanced.
			const askAfterAnswer = askEntriesNow();
			expect(askAfterAnswer.results, "exactly one result answers the question").toHaveLength(1);
			const [askResult] = askAfterAnswer.results;
			expect(
				askResult?.type === "message" &&
					askResult.message.role === "toolResult" &&
					askResult.message.content.some((block) => block.type === "text" && block.text.includes("Staging")),
				"the single result carries the owner's answer, not a placeholder",
			).toBe(true);
			expect(askAfterAnswer.terminals, "exactly one native terminal closes the ask").toHaveLength(1);
			const [askTerminal] = askAfterAnswer.terminals;
			expect(
				{
					requestId: askTerminal?.requestId,
					assistantMessageEntryId: askTerminal?.assistantMessageEntryId,
					callId: askTerminal?.callId,
					toolName: askTerminal?.toolName,
				},
				"the terminal closes the canonical original start captured from the cut",
			).toEqual(askTuple);
			expect(askTerminal?.resultMessageEntryId, "the terminal names the actual answering tool result").toBe(
				askResult?.id,
			);
			expect(
				restored.sessionManager.inspectSessionLifecycle().balanced,
				"every lifecycle prefix is balanced after the answer",
			).toBe(true);
			expect(
				await withDeadline(trace, "second resume", restored.session.resumePendingHumanInput()),
				"nothing is pending after the answer",
			).toBe(false);
			expect(askEntriesNow(), "the second resume appends no result and no terminal").toEqual(askAfterAnswer);
			expect(
				await world.disposeSessionInBody(restored.session),
				"the restored owner disposes cleanly",
			).toBeUndefined();
			// Companion: the same captured prefix, copied unchanged to a fresh path, reopened by a fresh owner with no UI bound. Without
			// a UI there is no presentation, so the resume records the question as unanswered (owner_unavailable): no answer and no
			// authority. The owner's own 300000 ms window is not elapsed here; it is covered by the separate deadline case at the end.
			const unavailableCutPath = "/harness/durable-cut/ask-scope-unavailable.jsonl";
			expect(world.io.existsSync(unavailableCutPath), "the companion prefix path is fresh").toBe(false);
			world.io.writeFileSync(unavailableCutPath, capturedCut);
			expect(
				String(world.io.readFileSync(unavailableCutPath, "utf8")),
				"the companion prefix is the captured bytes",
			).toBe(capturedCut);
			const unavailableOwner = await world.createRootSession("root", {
				sessionManager: world.openSessionManager(unavailableCutPath),
			});
			expect(
				getResumableHumanInputSnapshot(unavailableOwner.sessionManager)?.request.requestId,
				"the fresh owner restores the same pending request",
			).toBe(presentedRequestId);
			world.provider.enqueue("root", {
				name: "unavailable-reported",
				check: (request) => {
					const unanswered = request.context.messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.toolCallId === ASK_CALL_ID &&
							message.details !== undefined &&
							typeof message.details === "object" &&
							"reason" in message.details &&
							message.details.reason === "owner_unavailable",
					);
					if (!unanswered) throw new Error("the unavailable owner's result does not record owner_unavailable");
				},
				reply: { content: [{ type: "text", text: "The question stays unanswered without an owner." }] },
			});
			const presentationsBeforeUnavailable = world.humanInput.requests.length;
			expect(
				await withDeadline(trace, "unavailable owner resumes", unavailableOwner.session.resumePendingHumanInput()),
				"the unanswered question is recorded once",
			).toBe(true);
			await withDeadline(trace, "unavailable owner settled", unavailableOwner.session.waitForForegroundIdle());
			expect(world.humanInput.requests.length, "no presentation is made without a UI").toBe(
				presentationsBeforeUnavailable,
			);
			const unavailableResults = unavailableOwner.session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolCallId === ASK_CALL_ID ? [message] : [],
			);
			expect(unavailableResults, "exactly one result records the unanswered question").toHaveLength(1);
			const [unavailableResult] = unavailableResults;
			expect(
				unavailableResult?.details !== undefined &&
					typeof unavailableResult.details === "object" &&
					"reason" in unavailableResult.details &&
					unavailableResult.details.reason === "owner_unavailable",
				"the recorded result names the owner as unavailable",
			).toBe(true);
			expect(
				unavailableResult?.content.some((block) => block.type === "text" && block.text.includes("Staging")),
				"the unanswered result carries no answer",
			).toBe(false);
			expect(
				await withDeadline(trace, "second unavailable resume", unavailableOwner.session.resumePendingHumanInput()),
				"nothing is pending after the unanswered record",
			).toBe(false);
			expect(
				await world.disposeSessionInBody(unavailableOwner.session),
				"the unavailable owner disposes cleanly",
			).toBeUndefined();
			// E2 (uncertainty and standing revoke, on mode only): a standing revoke survives an uncertain tool judgment and a sub-floor
			// request; only an explicit request above the native floor (hard_gate_auto_confidence .93) lifts it. An uncertain task relation yields an unresolved intent,
			// which the call-time gate reads as no owner decision (its documented contract, asserted as written, not as approval).
			if (world.systemOne.enabled) {
				const e2Owner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
				const e2Base = {
					changes_model_pools: { kind: "noul", probability: 0.02 },
					capabilities_authorized: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
				} as const;
				const e2Latest = () =>
					readOptionalToolIntent(
						e2Owner.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
					);
				const e2ToolText = (toolCallId: string): string => {
					const entry = e2Owner.sessionManager
						.getBranch()
						.find(
							(candidate) =>
								candidate.type === "message" &&
								candidate.message.role === "toolResult" &&
								candidate.message.toolCallId === toolCallId,
						);
					if (entry?.type !== "message" || entry.message.role !== "toolResult") {
						throw new Error(`no durable tool result for ${toolCallId}`);
					}
					return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				};
				// One owner turn: the read classifies the words, then the secret store is called in the same message, so its outcome reads the new intent.
				// The durable native result of one E2 call: its owner-reported details, not only its text.
				const e2ToolDetails = (toolCallId: string): unknown => {
					const entry = e2Owner.sessionManager
						.getBranch()
						.find(
							(candidate) =>
								candidate.type === "message" &&
								candidate.message.role === "toolResult" &&
								candidate.message.toolCallId === toolCallId,
						);
					if (entry?.type !== "message" || entry.message.role !== "toolResult") {
						throw new Error(`no durable tool result for ${toolCallId}`);
					}
					return entry.message.details;
				};
				const e2Turn = async (
					index: number,
					words: string,
					judgments: Parameters<typeof world.systemOne.enterPhase>[1],
				): Promise<string> => {
					world.systemOne.enterPhase(`e2-t${index}`, judgments, {
						expect: expectOwnerWords({
							sessionManager: () => e2Owner.sessionManager,
							userRequests: [words],
							optionalToolNames: ["secret_store"],
						}),
					});
					world.provider.enqueue(
						"root",
						calls(`e2t${index}`, [
							{ id: `e2t${index}-read`, name: "read", arguments: { path: LIMITS_PATH } },
							{ id: `e2t${index}-store`, name: "secret_store", arguments: { action: "activate" } },
						]),
						{ name: `e2t${index}-done`, reply: { content: [{ type: "text", text: `Turn ${index} is done.` }] } },
					);
					await withDeadline(trace, `E2 turn ${index}`, e2Owner.session.prompt(words));
					return e2ToolText(`e2t${index}-store`);
				};
				const FORBIDDEN = "was forbidden by the owner";
				// T1: an explicit request classifies the secret store as allowed.
				const storeT1 = await e2Turn(1, "Use the secret store to read the key.", {
					...e2Base,
					optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
				});
				expect(
					e2Latest()?.allowedTools.map((tool) => tool.toolName),
					"T1: the request allows the secret store",
				).toEqual(["secret_store"]);
				expect(e2Latest()?.revokedTools, "T1: nothing is forbidden yet").toBeUndefined();
				expect(storeT1, "T1: the allowed store call is not refused").not.toContain(FORBIDDEN);
				// T2: an explicit revoke, relation continue, forbids the secret store at call time.
				const storeT2 = await e2Turn(2, "Stop using the secret store for the rest of this task.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
				});
				expect(
					e2Latest()?.revokedTools?.map((tool) => tool.toolName),
					"T2: the revoke names the secret store",
				).toEqual(["secret_store"]);
				expect(storeT2, "T2: the forbidden store call is refused").toContain(FORBIDDEN);
				// T3: an uncertain per-tool judgment keeps the prior revoke.
				const storeT3 = await e2Turn(3, "Keep going without the secret store.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "uncertain", confidence: 0.97 },
				});
				expect(
					e2Latest()?.revokedTools?.map((tool) => tool.toolName),
					"T3: an uncertain judgment keeps the revoke",
				).toEqual(["secret_store"]);
				expect(storeT3, "T3: the store stays refused").toContain(FORBIDDEN);
				// T4: a request below the confidence floor is no owner decision, so the revoke stands.
				const storeT4 = await e2Turn(4, "Use the secret store again, please.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "request", confidence: 0.5 },
				});
				expect(
					e2Latest()?.revokedTools?.map((tool) => tool.toolName),
					"T4: a sub-floor request keeps the revoke",
				).toEqual(["secret_store"]);
				expect(e2Latest()?.allowedTools, "T4: a sub-floor request allows nothing").toEqual([]);
				expect(storeT4, "T4: the store stays refused").toContain(FORBIDDEN);
				// T5: an explicit request above the native .93 floor (scripted .97) is the only lift of the revoke.
				const storeT5 = await e2Turn(5, "Use the secret store now.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
				});
				expect(
					e2Latest()?.allowedTools.map((tool) => tool.toolName),
					"T5: the explicit request lifts the revoke",
				).toEqual(["secret_store"]);
				expect(e2Latest()?.revokedTools, "T5: no revoke remains after the explicit request").toBeUndefined();
				expect(storeT5, "T5: the lifted store call is not refused").not.toContain(FORBIDDEN);
				// T6: a fresh explicit revoke forbids again.
				const storeT6 = await e2Turn(6, "Stop using the secret store for the rest of this task.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
				});
				expect(
					e2Latest()?.revokedTools?.map((tool) => tool.toolName),
					"T6: the new revoke names the secret store",
				).toEqual(["secret_store"]);
				expect(storeT6, "T6: the forbidden store call is refused again").toContain(FORBIDDEN);
				// T7: an uncertain task relation yields an unresolved intent, which the call-time gate reads as no owner decision.
				const uncertainWarningsBefore = world.warnings.filter(
					(message) =>
						message ===
						"Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain.",
				).length;
				const storeT7 = await e2Turn(7, "Something unrelated to the store.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "uncertain", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				});
				expect(e2Latest()?.status, "T7: an uncertain relation yields an unresolved intent").toBe("unresolved");
				expect(storeT7, "T7: an unresolved intent is no owner decision at call time, as documented").not.toContain(
					FORBIDDEN,
				);
				expect(
					world.warnings.filter(
						(message) =>
							message ===
							"Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain.",
					).length - uncertainWarningsBefore,
					"T7's uncertain relation emits exactly one native warning",
				).toBe(1);
				// T8: the unresolved turn kept the last classified intent as its resume intent, so the relation is asked against the revoke;
				// the explicit request above the native .93 floor lifts it.
				const storeT8 = await e2Turn(8, "Use the secret store once more.", {
					...e2Base,
					optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
					optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
				});
				expect(e2Latest()?.revokedTools, "T8: the explicit request lifts the resumed revoke").toBeUndefined();
				expect(
					e2Latest()?.allowedTools.map((tool) => tool.toolName),
					"T8: the explicit request allows the store again",
				).toEqual(["secret_store"]);
				expect(storeT8, "T8: the allowed store call is not refused").not.toContain(FORBIDDEN);
				// Each lifted or unresolved call reached the native owner and received its safe unavailability, not a refusal or an unknown tool.
				for (const [label, toolCallId] of [
					["T1", "e2t1-store"],
					["T5", "e2t5-store"],
					["T7", "e2t7-store"],
					["T8", "e2t8-store"],
				] as const) {
					expect(
						e2ToolDetails(toolCallId),
						`${label}: the native activate outcome is the owner's safe unavailability`,
					).toMatchObject({
						action: "activate",
						status: "unavailable",
						code: "owner_setup_required",
					});
				}
				expect(
					await world.disposeSessionInBody(e2Owner.session),
					"the E2 control owner disposes cleanly",
				).toBeUndefined();
			}
			// E2 (on -> off, persisted ban): an on-mode owner's real classified ban persists in its own file. An off session restored
			// from that original file makes no System One request, adds no optional intent, keeps the banned tool out of its active
			// surface, and still reads. Nothing is seeded and no ban is cleared. Only the on-mode world carries this case.
			if (world.systemOne.enabled) {
				const BAN_WORDS = "Stop using the secret store for the rest of this task.";
				const banOwner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
				world.systemOne.enterPhase(
					"ban-owner",
					{
						changes_model_pools: { kind: "noul", probability: 0.02 },
						capabilities_authorized: { kind: "noul", probability: 0.02 },
						local_commits_only: { kind: "noul", probability: 0.02 },
						lifts_delivery_block: { kind: "noul", probability: 0.02 },
						full_handoff: { kind: "noul", probability: 0.02 },
						optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
					},
					{
						expect: expectOwnerWords({
							sessionManager: () => banOwner.sessionManager,
							userRequests: [BAN_WORDS],
							optionalToolNames: ["secret_store"],
						}),
					},
				);
				// The owner's words are classified where their outcome is read: the tool call is that read, so the turn reads first.
				world.provider.enqueue(
					"root",
					calls("ban-read", [{ id: "ban-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
					{
						name: "ban-read-reported",
						check: (request) => assertBatchOk(request, "ban-read"),
						reply: { content: [{ type: "text", text: "The secret store stays stopped." }] },
					},
				);
				await withDeadline(trace, "ban owner turn", banOwner.session.prompt(BAN_WORDS));
				const banned = readOptionalToolIntent(
					banOwner.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
				);
				expect(banned?.status, "the owner's words classify into a ban").toBe("classified");
				expect(
					banned?.revokedTools?.map((tool) => tool.toolName),
					"the ban names the secret store",
				).toEqual(["secret_store"]);
				const banFile = banOwner.sessionManager.getSessionFile();
				if (banFile === undefined) throw new Error("the ban owner has no session file");
				expect(
					await world.disposeSessionInBody(banOwner.session),
					"the ban owner disposes cleanly",
				).toBeUndefined();

				const optionalIntentIds = (manager: SessionManager): string[] =>
					manager
						.getEntries()
						.flatMap((entry) =>
							entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE ? [entry.id] : [],
						);
				const offManager = world.openSessionManager(banFile);
				const intentIdsBefore = optionalIntentIds(offManager);
				const requestsBefore = world.systemOne.requests.length;
				world.systemOne.enterPhase("ban-off", {});
				const offRoot = await world.createRootSession("root", {
					sessionManager: offManager,
					systemOneEnabled: false,
				});
				expect(
					offRoot.session.systemOneController,
					"the off session binds no System One controller",
				).toBeUndefined();
				// The banned tool's non-metadata action is refused at call time by the standing ban, while its metadata stays intentionally available; a plain read still works.
				world.provider.enqueue(
					"root",
					calls("off-secret", [{ id: "off-secret-1", name: "secret_store", arguments: { action: "activate" } }]),
					{
						name: "off-secret-denied",
						check: (request) => {
							const denied = latestBatchResults(request).find((result) => result.toolName === "secret_store");
							if (!denied?.isError || !denied.text.includes("was forbidden by the owner")) {
								throw new Error(`the banned secret store call was not denied: ${denied?.text ?? "no result"}`);
							}
						},
						reply: {
							content: [{ type: "toolCall", id: "off-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
							stopReason: "toolUse",
						},
					},
					{
						name: "off-read-reported",
						check: (request) => assertBatchOk(request, "off-read"),
						reply: {
							content: [{ type: "text", text: "The limits file reads while the secret store stays stopped." }],
						},
					},
				);
				await withDeadline(
					trace,
					"off turn",
					offRoot.session.prompt("Read the limits file while the secret store stays stopped."),
				);
				expect(world.systemOne.requests.length, "the off session makes no System One request").toBe(requestsBefore);
				expect(optionalIntentIds(offRoot.sessionManager), "the off session adds no optional intent").toEqual(
					intentIdsBefore,
				);
				expect(
					readOptionalToolIntent(
						offRoot.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
					)?.revokedTools?.map((tool) => tool.toolName),
					"the ban is still the latest intent in the off session",
				).toEqual(["secret_store"]);
				expect(
					offRoot.session.messages.some(
						(message) => message.role === "toolResult" && message.toolName === "read" && !message.isError,
					),
					"the plain read works in the off session",
				).toBe(true);
				expect(
					await world.disposeSessionInBody(offRoot.session),
					"the off session disposes cleanly",
				).toBeUndefined();
			}
			// E0 (native incremental frames, positive): one root tool call streams in partial frames. The session's own message updates
			// carry the progressive arguments before the call starts; the complete call then runs exactly once and completes natively.
			const e0Root = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e0Log: Array<{ kind: "partial"; args: unknown } | { kind: "start" }> = [];
			let e0Starts = 0;
			const e0OwnedCall = {
				type: "toolCall" as const,
				id: "e0-read-1",
				name: "read",
				arguments: { path: LIMITS_PATH },
			};
			const e0EndSeen = createBarrier();
			const e0EndGate = createBarrier();
			let e0CapturedEnd: { call: unknown; partialArguments: unknown } | undefined;
			const e0Unsubscribe = e0Root.session.subscribe((event) => {
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					event.assistantMessageEvent.type === "toolcall_delta"
				) {
					const block = event.message.content[event.assistantMessageEvent.contentIndex];
					if (block?.type === "toolCall" && block.id === "e0-read-1") {
						e0Log.push({ kind: "partial", args: JSON.parse(JSON.stringify(block.arguments)) });
					}
				}
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					event.assistantMessageEvent.type === "toolcall_start"
				) {
					const block = event.message.content[event.assistantMessageEvent.contentIndex];
					if (block?.type === "toolCall" && block.id === "e0-read-1") {
						e0Log.push({ kind: "partial", args: JSON.parse(JSON.stringify(block.arguments)) });
					}
				}
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					event.assistantMessageEvent.type === "toolcall_end"
				) {
					const endBlock = event.message.content[event.assistantMessageEvent.contentIndex];
					e0CapturedEnd = {
						call: event.assistantMessageEvent.toolCall,
						partialArguments: endBlock?.type === "toolCall" ? endBlock.arguments : undefined,
					};
					e0EndSeen.release();
				}
				if (event.type === "tool_execution_start" && event.toolCallId === "e0-read-1") {
					e0Starts += 1;
					e0Log.push({ kind: "start" });
				}
			});
			const e0Judgments = {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			} as const;
			world.systemOne.enterPhase("e0-stream", e0Judgments, {
				expect: expectOwnerWords({
					sessionManager: () => e0Root.sessionManager,
					userRequests: ["Read the limits file in pieces."],
					optionalToolNames: ["secret_store"],
				}),
			});
			world.provider.enqueue(
				"root",
				{
					name: "e0-frames",
					frames: [
						{
							partialContent: [{ type: "toolCall", id: "e0-read-1", name: "read", arguments: {} }],
							event: { type: "toolcall_start", contentIndex: 0 },
						},
						{
							partialContent: [
								{
									type: "toolCall",
									id: "e0-read-1",
									name: "read",
									arguments: { path: `${HARNESS_PROJECT_CWD}/src` },
								},
							],
							event: { type: "toolcall_delta", contentIndex: 0, delta: `{"path":"${HARNESS_PROJECT_CWD}/src` },
						},
						{
							partialContent: [
								{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } },
							],
							event: { type: "toolcall_delta", contentIndex: 0, delta: '/limits.ts"}' },
						},
						{
							partialContent: [
								{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } },
							],
							event: { type: "toolcall_end", contentIndex: 0, toolCall: e0OwnedCall },
						},
						{
							partialContent: [
								{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } },
								{ type: "text", text: "" },
							],
							event: { type: "text_start", contentIndex: 1 },
							gate: e0EndGate.promise,
						},
					],
					reply: {
						content: [{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				{ name: "e0-done", reply: { content: [{ type: "text", text: "The streamed read completed." }] } },
			);
			const e0Turn = e0Root.session.prompt("Read the limits file in pieces.");
			const e0Failures: unknown[] = [];
			try {
				await withDeadline(trace, "E0 native toolcall_end observed", e0EndSeen.promise, 60_000);
				e0OwnedCall.arguments.path = `${HARNESS_PROJECT_CWD}/src/mutated-by-scenario.ts`;
			} catch (error) {
				e0Failures.push(error);
			} finally {
				e0EndGate.release();
			}
			try {
				await withDeadline(trace, "E0 streamed turn", e0Turn);
			} catch (error) {
				e0Failures.push(error);
			} finally {
				e0Unsubscribe();
			}
			if (e0Failures.length === 1) throw e0Failures[0];
			if (e0Failures.length > 1) {
				throw new AggregateError(e0Failures, "the E0 streamed turn failed before and after its join");
			}
			expect(
				e0CapturedEnd?.call,
				"the native end event keeps the admitted call after the scenario mutates its own object",
			).toEqual({
				type: "toolCall",
				id: "e0-read-1",
				name: "read",
				arguments: { path: LIMITS_PATH },
			});
			expect(e0CapturedEnd?.partialArguments, "the native partial keeps the admitted path").toEqual({
				path: LIMITS_PATH,
			});
			expect(e0CapturedEnd?.call, "the native end event is not the scenario's own object").not.toBe(e0OwnedCall);
			expect(e0Starts, "the streamed call starts exactly once").toBe(1);
			expect(e0Log.at(-1), "the start is the last native event: every partial precedes execution").toEqual({
				kind: "start",
			});
			const e0Intermediate = e0Log
				.flatMap((entry) => (entry.kind === "partial" ? [JSON.stringify(entry.args)] : []))
				.filter((args, index, all) => index === 0 || all[index - 1] !== args);
			expect(e0Intermediate, "the partial arguments are exactly the three native frames, in order").toEqual([
				JSON.stringify({}),
				JSON.stringify({ path: `${HARNESS_PROJECT_CWD}/src` }),
				JSON.stringify({ path: LIMITS_PATH }),
			]);
			expect(
				e0Root.session.messages.some(
					(message) => message.role === "toolResult" && message.toolCallId === "e0-read-1" && !message.isError,
				),
				"the complete call completes once with a successful result",
			).toBe(true);
			expect(await world.disposeSessionInBody(e0Root.session), "the E0 owner disposes cleanly").toBeUndefined();
			// E0 (native incremental frames, abort mid-stream): the owner is aborted while one frame of the aborted call is held. The admitted
			// transport request's own abort signal is observed before the held frame is released. The aborted call never starts; the aborted
			// assistant terminal binds it; a distinct same-owner continuation runs its own call, and the aborted call's start count stays zero.
			const e0Abort = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			// The abort owner binds System One exactly as the world does; the presence check is the native binding, not a declared phase.
			expect(
				e0Abort.session.systemOneController !== undefined,
				"the abort owner binds System One with the world mode",
			).toBe(world.systemOne.enabled);
			const e0AbortPartials = createBarrier();
			const e0RequestAborted = createBarrier();
			const e0AbortRelease = createBarrier();
			let e0AbortStarts = 0;
			let e0ContinueStarts = 0;
			const e0AbortUnsubscribe = e0Abort.session.subscribe((event) => {
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					event.assistantMessageEvent.type === "toolcall_delta"
				) {
					const block = event.message.content[event.assistantMessageEvent.contentIndex];
					if (
						block?.type === "toolCall" &&
						block.id === "e0-abort-1" &&
						JSON.stringify(block.arguments) === JSON.stringify({ path: `${HARNESS_PROJECT_CWD}/src` })
					) {
						e0AbortPartials.release();
					}
				}
				if (event.type === "tool_execution_start") {
					if (event.toolCallId === "e0-abort-1") e0AbortStarts += 1;
					if (event.toolCallId === "e0-continue-1") e0ContinueStarts += 1;
				}
			});
			world.provider.enqueue("root", {
				name: "e0-abort-frames",
				frames: [
					{
						partialContent: [{ type: "toolCall", id: "e0-abort-1", name: "read", arguments: {} }],
						event: { type: "toolcall_start", contentIndex: 0 },
					},
					{
						partialContent: [
							{
								type: "toolCall",
								id: "e0-abort-1",
								name: "read",
								arguments: { path: `${HARNESS_PROJECT_CWD}/src` },
							},
						],
						event: { type: "toolcall_delta", contentIndex: 0, delta: `{"path":"${HARNESS_PROJECT_CWD}/src` },
					},
					{
						partialContent: [
							{ type: "toolCall", id: "e0-abort-1", name: "read", arguments: { path: LIMITS_PATH } },
						],
						event: { type: "toolcall_delta", contentIndex: 0, delta: '/limits.ts"}' },
						check: (request) => {
							const signal = request.options?.signal;
							if (signal === undefined)
								throw new Error("the admitted transport request carries no abort signal");
							if (signal.aborted) {
								e0RequestAborted.release();
								return;
							}
							const onAbort = () => {
								signal.removeEventListener("abort", onAbort);
								e0RequestAborted.release();
							};
							signal.addEventListener("abort", onAbort, { once: true });
						},
						gate: e0AbortRelease.promise,
					},
				],
				reply: {
					content: [{ type: "toolCall", id: "e0-abort-1", name: "read", arguments: { path: LIMITS_PATH } }],
					stopReason: "toolUse",
				},
			});
			// The aborted turn reaches no semantic evaluation, so its phase declares no judgments.
			world.systemOne.enterPhase(
				"e0-abort",
				{},
				{
					expect: expectOwnerWords({
						sessionManager: () => e0Abort.sessionManager,
						userRequests: ["Read the limits file, then stop."],
						optionalToolNames: ["secret_store"],
					}),
				},
			);
			const e0AbortPrompt = e0Abort.session.prompt("Read the limits file, then stop.");
			try {
				await withDeadline(trace, "E0 partial arguments observed", e0AbortPartials.promise, 60_000);
				const e0AbortWork = e0Abort.session.abort("the scenario aborts the held E0 frame");
				await withDeadline(trace, "E0 transport request signal aborted", e0RequestAborted.promise, 60_000);
				e0AbortRelease.release();
				await withDeadline(trace, "E0 owner aborted", e0AbortWork, 60_000);
				const e0AbortOutcome = await withDeadline(
					trace,
					"E0 aborted prompt joined",
					e0AbortPrompt.then(
						() => "resolved",
						(error: unknown) => {
							if (error instanceof Error && error.name === "AbortError") return "AbortError";
							throw error;
						},
					),
					60_000,
				);
				expect(["resolved", "AbortError"], "the aborted prompt settles with a native outcome").toContain(
					e0AbortOutcome,
				);
				expect(e0AbortStarts, "the aborted call never starts").toBe(0);
				expect(
					e0Abort.session.messages.some(
						(message) => message.role === "toolResult" && message.toolCallId === "e0-abort-1",
					),
					"the aborted call produces no result at the abort",
				).toBe(false);
				expect(
					e0Abort.session.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason === "aborted" &&
							message.content.some((block) => block.type === "toolCall" && block.id === "e0-abort-1"),
					),
					"the aborted assistant terminal binds the aborted call",
				).toBe(true);
				// Same-owner continuation: a distinct call runs once; the aborted call's start count stays zero through it.
				world.provider.enqueue(
					"root",
					calls("e0-continue", [{ id: "e0-continue-1", name: "read", arguments: { path: LIMITS_PATH } }]),
					{
						name: "e0-continue-done",
						reply: { content: [{ type: "text", text: "The limits file reads again." }] },
					},
				);
				// Continuation phase: request-local families come from the transported state; nothing is copied from the positive phase.
				// The pending inputs are read from the owner's branch right now: the aborted input stays pending when this prompt starts.
				const e0PendingInputs = e0Abort.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
					)
					.map((content) =>
						typeof content === "string"
							? content
							: content.map((block) => (block.type === "text" ? block.text : "")).join(""),
					);
				world.systemOne.enterPhase("e0-continue", e0Judgments, {
					expect: expectOwnerWords({
						sessionManager: () => e0Abort.sessionManager,
						userRequests: ["Read the limits file, then stop.", "Read the limits file again."],
						ownerMessages: e0PendingInputs,
						optionalToolNames: ["secret_store"],
					}),
					families: { carries_: { kind: "noul", probability: 0.02 } },
				});
				await withDeadline(
					trace,
					"E0 same-owner continuation",
					e0Abort.session.prompt("Read the limits file again."),
				);
				expect(e0AbortStarts, "the aborted call never starts, through the continuation too").toBe(0);
				expect(e0ContinueStarts, "the continuation's own call runs exactly once").toBe(1);
				expect(
					e0Abort.session.messages.some(
						(message) =>
							message.role === "toolResult" && message.toolCallId === "e0-continue-1" && !message.isError,
					),
					"the continuation's call completes with a successful result",
				).toBe(true);
			} finally {
				e0AbortRelease.release();
				e0AbortUnsubscribe();
			}
			expect(
				await world.disposeSessionInBody(e0Abort.session),
				"the E0 abort owner disposes cleanly",
			).toBeUndefined();
			// E4 (branch-memory reload): a user memory is user-scoped, so a memory saved on one branch survives the tree moving to an earlier point.
			// The new branch lists that entry once, and a reload of the same session file lists the same single entry on the same leaf.
			const E4_PREFERENCE = "The owner prefers short functions.";
			const e4Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e4Session = e4Created.session;
			const e4Manager = e4Created.sessionManager;
			const e4Source = (): string => {
				const owner = e4Manager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes("short functions"),
					);
				if (owner === undefined) throw new Error("Owner message with the cited words is not on the session branch");
				return `${e4Manager.getSessionId().slice(0, 8)}/${owner.id}`;
			};
			const e4Count = (text: string): number => text.split(E4_PREFERENCE).length - 1;
			const e4Judgments = {
				changes_model_pools: { kind: "noul" as const, probability: 0.02 },
				local_commits_only: { kind: "noul" as const, probability: 0.02 },
				lifts_delivery_block: { kind: "noul" as const, probability: 0.02 },
				full_handoff: { kind: "noul" as const, probability: 0.02 },
				optional_tool_0: { kind: "choice" as const, choice: "unchanged", confidence: 0.97 },
				capabilities_authorized: { kind: "noul" as const, probability: 0.02 },
			};
			const e4ListCheck = (label: string) => (request: ScriptedRequest) => {
				const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
				if (listed?.isError || e4Count(listed?.text ?? "") !== 1) {
					throw new Error(
						`${label}: the saved preference is not listed exactly once: ${listed?.text ?? "no result"}`,
					);
				}
			};
			// The save, on the first branch: a memory add cited to the owner's own words.
			world.systemOne.enterPhase("e4-save", e4Judgments);
			world.provider.enqueue(
				"root",
				{
					name: "e4-save-call",
					reply: () => ({
						content: [
							{
								type: "toolCall",
								id: "e4-memory-1",
								name: "memory",
								arguments: {
									action: "add",
									target: "user",
									scope: "global",
									basis: "explicit",
									content: E4_PREFERENCE,
									evidence: [{ source: e4Source(), quote: "I prefer short functions" }],
								},
							},
						],
						stopReason: "toolUse",
					}),
				},
				{
					name: "e4-save-reply",
					check: () => {
						const added = lastToolResultDetails(e4Session, "memory");
						if (typeof added !== "object" || added === null || !("success" in added) || added.success !== true) {
							throw new Error(`the E4 memory add was not successful: ${JSON.stringify(added)}`);
						}
					},
					reply: { content: [{ type: "text", text: "Short functions are recorded." }] },
				},
			);
			await withDeadline(trace, "E4 save turn", e4Session.prompt("Remember that I prefer short functions."));
			// The tree moves back to the owner entry: the save's branch is abandoned, and the new branch starts from the owner's message.
			const e4Owner = e4Manager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (e4Owner === undefined) throw new Error("E4 has no owner entry");
			const e4Nav = await withDeadline(trace, "E4 navigate to the owner entry", e4Session.navigateTree(e4Owner.id));
			// Selecting a user message moves the leaf to its parent and hands its text back for editing.
			expect(e4Nav.editorText, "the owner text is handed back for editing").toContain("short functions");
			if (e4Owner.parentId === null) throw new Error("the E4 owner has no parent entry");
			expect(e4Manager.getLeafId(), "the tree moved to the owner parent").toBe(e4Owner.parentId);
			expect(
				e4Manager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "e4-memory-1",
					),
				"the save sits on an abandoned branch after the move",
			).toBe(false);
			// The new branch lists the user memory once: the memory is not branch-scoped.
			world.systemOne.enterPhase("e4-branch", e4Judgments);
			world.provider.enqueue(
				"root",
				calls("e4-list", [{ id: "e4-list-1", name: "memory", arguments: { action: "list", target: "user" } }]),
				{
					name: "e4-list-reply",
					check: e4ListCheck("the new branch"),
					reply: { content: [{ type: "text", text: "The saved preference is listed once." }] },
				},
			);
			await withDeadline(trace, "E4 branch turn", e4Session.prompt("List the saved preferences from this branch."));
			// A reload of the same session file restores the same leaf and lists the same single entry.
			const e4File = e4Manager.getSessionFile();
			if (e4File === undefined) throw new Error("the E4 session has no file");
			expect(await world.disposeSessionInBody(e4Session), "the E4 owner disposes cleanly").toBeUndefined();
			// Disposal writes the owner's final entries (abort, then close), so the tip a reload must restore is the tip after disposal.
			const e4Leaf = e4Manager.getLeafId();
			expect(
				e4Manager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "e4-list-1",
					),
				"the disposed tip still carries the branch listing",
			).toBe(true);
			const e4Reopened = await world.createRootSession("root", { sessionManager: world.openSessionManager(e4File) });
			expect(e4Reopened.sessionManager.getLeafId(), "the reopened owner restores the same leaf").toBe(e4Leaf);
			world.systemOne.enterPhase("e4-reload", e4Judgments);
			world.provider.enqueue(
				"root",
				calls("e4-reload-list", [
					{ id: "e4-reload-list-1", name: "memory", arguments: { action: "list", target: "user" } },
				]),
				{
					name: "e4-reload-reply",
					check: e4ListCheck("the reopened owner"),
					reply: { content: [{ type: "text", text: "The saved preference survives the reload." }] },
				},
			);
			await withDeadline(
				trace,
				"E4 reloaded turn",
				e4Reopened.session.prompt("List the saved preferences after the reload."),
			);
			expect(
				await world.disposeSessionInBody(e4Reopened.session),
				"the reopened E4 owner disposes cleanly",
			).toBeUndefined();
			trace.mark("root", "e4.branch-memory-reloaded");

			// E4 (branch-summary supersession): a held branch summary is superseded by a newer navigation, which aborts it. Owner input queued while
			// the summary is held waits until the navigation settles. A reload while the summary is active is refused; the same reload succeeds once
			// the session is idle. A reopen of the file is a separate control and restores the leaf the owner left.
			const s4Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const s4Session = s4Created.session;
			const s4Manager = s4Created.sessionManager;
			const s4SummaryAdmitted = createBarrier();
			const s4SummaryGate = createBarrier();
			const s4Queued = "Queued owner input while the summary is held.";
			world.provider.enqueue(
				"root",
				{ name: "s4-turn-a", reply: { content: [{ type: "text", text: "First step planned." }] } },
				{ name: "s4-turn-b", reply: { content: [{ type: "text", text: "Second step planned." }] } },
				{
					name: "s4-summary-held",
					check: () => s4SummaryAdmitted.release(),
					gate: s4SummaryGate.promise,
					reply: { content: [{ type: "text", text: "Summary of the abandoned branch." }] },
				},
			);
			world.systemOne.enterPhase("s4-a", {});
			await withDeadline(trace, "S4 turn A", s4Session.prompt("Plan the first step."));
			const s4TurnA = s4Manager.getLeafId();
			if (s4TurnA === null) throw new Error("S4 has no leaf after its first turn");
			world.systemOne.enterPhase("s4-b", { ...e4Judgments, carries_0: { kind: "noul", probability: 0.02 } });
			await withDeadline(trace, "S4 turn B", s4Session.prompt("Plan the second step."));
			const s4FirstUser = s4Manager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (s4FirstUser === undefined) throw new Error("S4 has no first owner entry");
			// Summarized navigation: the summarizer request is admitted and held at its gate.
			world.systemOne.enterPhase("s4-held", {});
			const s4Summary = s4Session.navigateTree(s4FirstUser.id, { summarize: true });
			await withDeadline(trace, "S4 summary held", s4SummaryAdmitted.promise);
			const s4Refusal = await s4Session.reload().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(
				s4Refusal instanceof Error ? s4Refusal.message : undefined,
				"a reload while the branch summary is active is refused",
			).toContain("branch summarization is active");
			const s4QueuedPrompt = s4Session.prompt(s4Queued, { streamingBehavior: "followUp" });
			expect(s4Session.getFollowUpMessages(), "owner input waits while the summary is held").toEqual([s4Queued]);
			// A newer navigation supersedes the held summary: the superseded one is cancelled and its summary never applies.
			const s4Second = s4Session.navigateTree(s4TurnA, { summarize: false });
			const s4SummaryResult = await withDeadline(trace, "S4 summary superseded", s4Summary);
			s4SummaryGate.release();
			expect(s4SummaryResult, "the superseded summary is cancelled, not applied").toMatchObject({
				cancelled: true,
				aborted: true,
			});
			const s4SecondResult = await withDeadline(trace, "S4 superseding navigation", s4Second);
			expect(s4SecondResult.cancelled, "the superseding navigation applies").toBe(false);
			const s4Leaf = s4Manager.getEntries().find((entry) => entry.id === s4Manager.getLeafId());
			expect(
				{ type: s4Leaf?.type, parentId: s4Leaf?.parentId },
				"the superseding navigation leaves a settled entry on the turn A reply",
			).toEqual({ type: "custom", parentId: s4TurnA });
			expect(
				s4Manager.getEntries().some((entry) => entry.type === "branch_summary"),
				"no branch summary entry is applied",
			).toBe(false);
			// The owner input held during the summary is delivered after the navigation settles, on the leaf it settles on.
			expect(
				s4Session.getFollowUpMessages(),
				"the held owner input stays in the pending queue after the navigation settles",
			).toEqual([s4Queued]);
			expect(
				world.warnings.filter((message) => message.includes(s4Queued)),
				"the held input is reported once, as context-changed",
			).toEqual([expect.stringContaining("the session context changed before it was admitted")]);
			await withDeadline(trace, "S4 held prompt settled", s4QueuedPrompt);
			expect(
				s4Manager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(s4Queued),
					),
				"the held input is never admitted to the branch",
			).toBe(false);
			expect(s4Session.clearQueue().followUp, "restoring the held input returns it from the queue").toEqual([
				s4Queued,
			]);
			// Idle reload: the same control now succeeds and rebuilds the context of the current branch.
			expect(s4Session.getFollowUpMessages(), "no owner input is left queued").toEqual([]);
			const s4ToolNamesBefore = s4Session.getActiveToolNames();
			const s4ReadBefore = s4Session.getToolDefinition("read");
			await withDeadline(trace, "S4 idle reload", s4Session.reload());
			expect(s4Session.getActiveToolNames(), "the idle reload keeps the active tool names").toEqual(
				s4ToolNamesBefore,
			);
			expect(s4Session.getToolDefinition("read"), "the idle reload rebinds the read tool definition").not.toBe(
				s4ReadBefore,
			);
			expect(s4Session.getToolDefinition("read")?.name, "the rebound definition is the read tool").toBe("read");
			expect(s4Session.messages.length, "the idle reload rebuilds the current branch context").toBe(
				s4Manager.buildSessionContext().messages.length,
			);
			// Reopen is a separate control: dispose, then reopen the file, and restore the same tip.
			expect(await world.disposeSessionInBody(s4Session), "the S4 owner disposes cleanly").toBeUndefined();
			const s4Tip = s4Manager.getLeafId();
			const s4File = s4Manager.getSessionFile();
			if (s4File === undefined) throw new Error("the S4 session has no file");
			const s4Reopened = await world.createRootSession("root", { sessionManager: world.openSessionManager(s4File) });
			expect(s4Reopened.sessionManager.getLeafId(), "the reopened S4 owner restores the disposed tip").toBe(s4Tip);
			expect(
				JSON.stringify(s4Reopened.session.messages),
				"the reopened S4 history carries no admitted copy of the held input",
			).not.toContain(s4Queued);
			expect(
				await world.disposeSessionInBody(s4Reopened.session),
				"the reopened S4 owner disposes cleanly",
			).toBeUndefined();
			trace.mark("root", "e4.summary-superseded");

			// E4 (delegated memory read): a read-only worker inherits the bounded memory read, never the mutation tool. Its valid query returns the saved
			// preference source-labelled; an over-bound query is refused; a mutation attempt and a raw path read do not reach the stored content.
			// The owner-authored reader preset: the delegated worker gets memory_read only through this preset's tool list and its memory.query ceiling.
			const M4_READER_PROFILE: OrchestrationProfile = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: "m4-reader",
				description: "Read-only reader with the bounded memory read.",
				role: "explorer",
				modelPolicy: {
					mode: "fixed",
					candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
				},
				capabilityCeiling: ["filesystem.read", "memory.query"],
				readOnly: true,
				toolNames: ["read", "memory_read"],
				resourceProfileNames: [],
				dispatchProfileIds: [],
				budget: {},
				maxConcurrent: 1,
				leaseTtlMs: 60_000,
				requireIndependentVerification: false,
				createdAt: "2026-10-08T00:00:00.000Z",
				updatedAt: "2026-10-08T00:00:00.000Z",
			};
			new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			}).save(M4_READER_PROFILE, "global");
			const m4Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const m4Session = m4Created.session;
			const m4WorkerDone = createBarrier();
			const m4Wake = createBarrier();
			const M4_RAW_PATH = `${world.agentDir}/memory/user.md`;
			const m4Query = "short functions";
			const m4OverBound = "x".repeat(4_097);
			world.provider.enqueue(
				"root",
				calls("m4-start", [
					{
						id: "m4-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "m4-reader",
							instructions: "Read the saved short-functions preference through memory, then submit your report.",
						},
					},
				]),
				{
					name: "m4-start-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)"))
							throw new Error(`the memory reader did not start: ${started?.text ?? "no result"}`);
					},
					reply: { content: [{ type: "text", text: "The memory reader is started." }] },
				},
				{
					name: "m4-wake",
					maxRequests: 8,
					until: (request) => {
						const everything = JSON.stringify(request.context.messages);
						const done =
							everything.includes("Background worker terminal handoff") && everything.includes("succeeded");
						if (done) m4Wake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			world.provider.enqueue(
				"worker-a",
				{
					name: "worker-a-read",
					check: (request) => {
						const offered = (request.context.tools ?? []).map((tool) => tool.name);
						if (!offered.includes("memory_read"))
							throw new Error(`the worker is not offered memory_read: ${offered.join(", ")}`);
						if (offered.includes("memory")) throw new Error("the worker is offered the root mutation tool");
					},
					reply: {
						content: [
							{ type: "toolCall", id: "m4-read-ok", name: "memory_read", arguments: { query: m4Query } },
							{ type: "toolCall", id: "m4-read-over", name: "memory_read", arguments: { query: m4OverBound } },
							{
								type: "toolCall",
								id: "m4-mutate",
								name: "memory",
								arguments: {
									action: "add",
									target: "user",
									scope: "global",
									basis: "explicit",
									content: "A worker-written fact.",
								},
							},
							{ type: "toolCall", id: "m4-raw", name: "read", arguments: { path: M4_RAW_PATH } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "worker-a-report",
					check: (request) => {
						const ok = latestBatchResults(request).find(
							(result) => result.toolName === "memory_read" && !result.isError,
						);
						if (!ok?.text.includes(m4Query))
							throw new Error(`the valid query did not return the saved preference: ${ok?.text ?? "none"}`);
						const over = latestBatchResults(request)
							.filter((result) => result.toolName === "memory_read")
							.find((result) => result.isError);
						if (over === undefined)
							throw new Error(
								`the over-bound query was not refused: ${JSON.stringify(latestBatchResults(request).map((result) => ({ tool: result.toolName, isError: result.isError, text: result.text.slice(0, 160) })))}`,
							);
						const mutate = latestBatchResults(request).find((result) =>
							result.text.includes("A worker-written fact."),
						);
						if (mutate !== undefined) throw new Error("a worker mutation reached the memory store");
						const raw = latestBatchResults(request).find((result) => result.toolName === "read");
						if (raw?.isError !== true)
							throw new Error(`the raw memory path was not refused: ${raw?.text ?? "none"}`);
						m4WorkerDone.release();
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "m4-report",
								name: "submit_report",
								arguments: { status: "completed", summary: "The preference was read through memory." },
							},
						],
						stopReason: "toolUse",
					},
				},
			);
			world.systemOne.enterPhase("m4-start", e4Judgments);
			await withDeadline(
				trace,
				"M4 start turn",
				m4Session.prompt("Start a reader for the short-functions preference."),
			);
			const m4Runtime = m4Session.backgroundLanes.getTaskRuntimeSnapshot();
			expect(
				Object.values(m4Runtime?.attempts ?? {}).map((attempt) => attempt.status),
				"the reader attempt is running after its start turn",
			).toEqual(["running"]);
			await withDeadline(trace, "M4 worker reported", m4WorkerDone.promise);
			// The terminal handoff wakes the idle root by itself; the wake step matches that turn, and the root is idle before the next prompt.
			await withDeadline(trace, "M4 handoff woke the root", m4Wake.promise, 60_000);
			await withDeadline(trace, "M4 root idle after the wake", m4Session.waitForForegroundIdle());
			world.provider.enqueue(
				"root",
				calls("m4-store", [{ id: "m4-store-1", name: "memory", arguments: { action: "list", target: "user" } }]),
				{
					name: "m4-store-reply",
					check: (request) => {
						e4ListCheck("the store after the denied worker mutation")(request);
						const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
						if (listed?.text.includes("A worker-written fact."))
							throw new Error("the denied worker mutation reached the store");
					},
					reply: { content: [{ type: "text", text: "The store holds only the saved preference." }] },
				},
			);
			world.systemOne.enterPhase("m4-store", e4Judgments);
			await withDeadline(
				trace,
				"M4 store re-read",
				m4Session.prompt("List the saved preferences after the reader finished."),
			);
			expect(
				world.provider.reached.filter((name) => name.startsWith("worker-a")),
				"the memory reader ran its two worker steps exactly once",
			).toEqual(["worker-a:worker-a-read", "worker-a:worker-a-report"]);
			expect(await world.disposeSessionInBody(m4Session), "the M4 owner disposes cleanly").toBeUndefined();
			trace.mark("root", "e4.delegated-memory");

			// E8 (worker budget and bash): a read-only worker runs its bash through the scripted shell. Each provider response is charged to the
			// preset's token budget, with cache reads at the cache-read weight: 1,000 input and 20,000 cache-read tokens charge 3,000, not 21,000.
			// The second response exhausts the 5,500 budget, so its read is refused and no third provider request reaches the scripted provider.
			const E8_BUDGET_PROFILE: OrchestrationProfile = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: "e8-budget",
				description: "Read-only worker with a 5,500-token budget.",
				role: "explorer",
				modelPolicy: {
					mode: "fixed",
					candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
				},
				capabilityCeiling: ["filesystem.read"],
				readOnly: true,
				toolNames: ["read"],
				resourceProfileNames: [],
				dispatchProfileIds: [],
				budget: { maxTokens: 5_500 },
				maxConcurrent: 1,
				leaseTtlMs: 60_000,
				requireIndependentVerification: false,
				createdAt: "2026-10-08T00:00:00.000Z",
				updatedAt: "2026-10-08T00:00:00.000Z",
			};
			new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			}).save(E8_BUDGET_PROFILE, "global");
			const e8Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e8Session = e8Created.session;
			const e8Wake = createBarrier();
			const E8_USAGE = { ...createEmptyUsage(), input: 1_000, cacheRead: 20_000, totalTokens: 21_000 };
			world.shell.enqueue({
				name: "e8-echo",
				command: "echo e8-bash",
				cwd: HARNESS_PROJECT_CWD,
				output: "e8-bash\n",
				exitCode: 0,
			});
			world.provider.enqueue(
				"root",
				calls("e8-start", [
					{
						id: "e8-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "e8-budget",
							instructions: "Run the echo check, then read the limits file.",
						},
					},
				]),
				{
					name: "e8-start-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the budget reader did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The budget reader is started." }] },
				},
				{
					name: "e8-wake",
					maxRequests: 8,
					until: (request) => {
						const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
						if (done) e8Wake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			world.provider.enqueue(
				"worker-a",
				{
					name: "e8-worker-bash",
					check: (request) => {
						const offered = (request.context.tools ?? []).map((tool) => tool.name);
						if (!offered.includes("bash") || !offered.includes("read")) {
							throw new Error(`the budget reader is not offered bash and read: ${offered.join(", ")}`);
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "e8-bash-1", name: "bash", arguments: { command: "echo e8-bash" } },
						],
						stopReason: "toolUse",
						usage: E8_USAGE,
					},
				},
				{
					name: "e8-worker-read",
					check: (request) => {
						const bash = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (bash?.isError || !bash?.text.includes("e8-bash")) {
							throw new Error(`the bash call did not run through the shell: ${bash?.text ?? "no result"}`);
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "e8-second-1", name: "bash", arguments: { command: "echo e8-second" } },
						],
						stopReason: "toolUse",
						usage: E8_USAGE,
					},
				},
			);
			world.systemOne.enterPhase("e8-start", {
				...e4Judgments,
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
			});
			const e8ReachedBefore = world.provider.reached.length;
			await withDeadline(trace, "E8 start turn", e8Session.prompt("Start the budget reader."));
			await withDeadline(trace, "E8 handoff woke the root", e8Wake.promise, 90_000);
			await withDeadline(trace, "E8 root idle", e8Session.waitForForegroundIdle());
			expect(
				world.provider.reached.slice(e8ReachedBefore).filter((name) => name.startsWith("worker-a")),
				"the budgeted worker reaches exactly two provider requests: the third is refused before the provider",
			).toEqual(["worker-a:e8-worker-bash", "worker-a:e8-worker-read"]);
			expect(
				world.shell.requests.filter((request) => request.command === "echo e8-second"),
				"the budget refuses the second effect before it reaches the shell",
			).toHaveLength(0);
			expect(
				world.shell.requests.filter((request) => request.command === "echo e8-bash").length,
				"the worker's bash ran exactly once through the shell",
			).toBe(1);
			expect(
				Object.values(e8Session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).map(
					(attempt) => attempt.status,
				),
				"the budget denial terminalizes the worker's only attempt",
			).toEqual(["partial"]);
			expect(await world.disposeSessionInBody(e8Session), "the E8 owner disposes cleanly").toBeUndefined();
			trace.mark("root", "e8.budget");

			// E8 (transient provider failures): a worker's provider request that fails transiently is retried inside the attempt, three attempts
			// at most with the worker's 2 s base; when those are spent the durable ladder (two attempts, 5 s base) starts one more attempt. Request
			// admission times are recorded to check the gaps against those bases, with jitter bounds.
			const E8_TRANSIENT_PROFILE: OrchestrationProfile = {
				...E8_BUDGET_PROFILE,
				profileId: "e8-transient",
				description: "Read-only worker for the transient-failure check.",
				budget: { maxTokens: 50_000 },
			};
			new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			}).save(E8_TRANSIENT_PROFILE, "global");
			const e8tCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e8tSession = e8tCreated.session;
			const e8tWake = createBarrier();
			const e8tAdmitted: number[] = [];
			const e8tStamp = (): { check: () => void } => ({
				check: () => {
					e8tAdmitted.push(Date.now());
				},
			});
			world.provider.enqueue(
				"root",
				calls("e8t-start", [
					{
						id: "e8t-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "e8-transient",
							instructions: "Read the limits file, then report.",
						},
					},
				]),
				{
					name: "e8t-start-reply",
					reply: { content: [{ type: "text", text: "The transient reader is started." }] },
				},
				{
					name: "e8t-wake",
					maxRequests: 8,
					until: (request) => {
						const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
						if (done) e8tWake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			const E8_TRANSIENT_ERROR = "503 service unavailable (scripted transient)";
			world.provider.enqueue(
				"worker-a",
				{ ...fail("e8t-fail-1", E8_TRANSIENT_ERROR), ...e8tStamp() },
				{ ...fail("e8t-fail-2", E8_TRANSIENT_ERROR), ...e8tStamp() },
				{ ...fail("e8t-fail-3", E8_TRANSIENT_ERROR), ...e8tStamp() },
				{
					name: "e8t-report",
					...e8tStamp(),
					reply: {
						content: [
							{
								type: "toolCall",
								id: "e8t-report-1",
								name: "submit_report",
								arguments: { status: "completed", summary: "The limits file was read." },
							},
						],
						stopReason: "toolUse",
					},
				},
			);
			world.systemOne.enterPhase("e8t-start", e4Judgments);
			await withDeadline(trace, "E8 transient start turn", e8tSession.prompt("Start the transient reader."));
			await withDeadline(trace, "E8 transient handoff woke the root", e8tWake.promise, 120_000);
			await withDeadline(trace, "E8 transient root idle", e8tSession.waitForForegroundIdle());
			expect(
				world.provider.reached.filter((name) => name.startsWith("worker-a:e8t-")),
				"the transient failures are retried inside one attempt, then one ladder attempt succeeds",
			).toEqual(["worker-a:e8t-fail-1", "worker-a:e8t-fail-2", "worker-a:e8t-fail-3", "worker-a:e8t-report"]);
			expect(
				world.warnings.filter(
					(message) =>
						message.includes("(server_error); retrying") ||
						message.includes("retrying from the persisted transcript"),
				),
				"the retries announce two inner waits and one ladder wait, and nothing else",
			).toHaveLength(3);
			const e8tGaps = e8tAdmitted.slice(1).map((time, index) => time - (e8tAdmitted[index] ?? time));
			expect(e8tGaps.length, "four admissions give three gaps").toBe(3);
			expect(e8tGaps[0] ?? 0, "the first inner retry waits about the 2 s base").toBeGreaterThanOrEqual(1_500);
			expect(e8tGaps[1] ?? 0, "the second inner retry waits about twice the base").toBeGreaterThanOrEqual(3_000);
			expect(e8tGaps[2] ?? 0, "the durable ladder waits about its 5 s base").toBeGreaterThanOrEqual(4_000);
			expect(
				await world.disposeSessionInBody(e8tSession),
				"the E8 transient owner disposes cleanly",
			).toBeUndefined();
			trace.mark("root", "e8.transient");

			// E8 one attempt (owner-authored maxAttempts 1, transient failures): the same three transient 503 failures run inside one attempt, the
			// inner retries are the only retries announced, and the durable ladder never starts. The lane terminalizes failed with completion_error.
			const E8_ONE_ATTEMPT_PROFILE: OrchestrationProfile = {
				...E8_TRANSIENT_PROFILE,
				profileId: "e8-one-attempt",
				description: "Read-only worker whose owner allows exactly one attempt.",
				budget: { maxTokens: 50_000, maxAttempts: 1 },
			};
			new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			}).save(E8_ONE_ATTEMPT_PROFILE, "global");
			const e8oCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e8oSession = e8oCreated.session;
			const e8oWake = createBarrier();
			const e8oAdmitted: number[] = [];
			const e8oStamp = (): { check: () => void } => ({
				check: () => {
					e8oAdmitted.push(Date.now());
				},
			});
			world.provider.enqueue(
				"root",
				calls("e8o-start", [
					{
						id: "e8o-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "e8-one-attempt",
							instructions: "Read the limits file, then report.",
						},
					},
				]),
				{
					name: "e8o-start-reply",
					reply: { content: [{ type: "text", text: "The one-attempt reader is started." }] },
				},
				{
					name: "e8o-wake",
					maxRequests: 8,
					until: (request) => {
						const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
						if (done) e8oWake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			const e8oWarningsBefore = world.warnings.length;
			world.provider.enqueue(
				"worker-a",
				{ ...fail("e8o-fail-1", E8_TRANSIENT_ERROR), ...e8oStamp() },
				{ ...fail("e8o-fail-2", E8_TRANSIENT_ERROR), ...e8oStamp() },
				{ ...fail("e8o-fail-3", E8_TRANSIENT_ERROR), ...e8oStamp() },
			);
			world.systemOne.enterPhase("e8o-start", e4Judgments);
			await withDeadline(trace, "E8 one-attempt start turn", e8oSession.prompt("Start the one-attempt reader."));
			await withDeadline(trace, "E8 one-attempt handoff woke the root", e8oWake.promise, 120_000);
			await withDeadline(trace, "E8 one-attempt root idle", e8oSession.waitForForegroundIdle());
			expect(
				world.provider.reached.filter((name) => name.startsWith("worker-a:e8o-")),
				"the transient failures run as exactly three inner requests, with no fourth request",
			).toEqual(["worker-a:e8o-fail-1", "worker-a:e8o-fail-2", "worker-a:e8o-fail-3"]);
			const e8oWarnings = world.warnings.slice(e8oWarningsBefore);
			expect(
				e8oWarnings.filter((message) => message.includes("retrying from the persisted transcript")),
				"the one-attempt owner announces no durable ladder retry",
			).toHaveLength(0);
			expect(
				e8oWarnings.filter((message) => message.includes("provider request failed (server_error); retrying")),
				"the transient failures announce exactly their two inner retries",
			).toHaveLength(2);
			const e8oAttempts = Object.values(e8oSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
			expect(
				e8oAttempts.map((attempt) => attempt.status),
				"the lane's single attempt terminalizes failed",
			).toEqual(["failed"]);
			expect(e8oAttempts[0]?.result?.reasonCode, "the failed attempt names its completion error").toBe(
				"completion_error",
			);
			expect(e8oAttempts[0]?.retry, "the attempt never entered the durable retry ladder").toBeUndefined();
			const e8oGaps = e8oAdmitted.slice(1).map((time, index) => time - (e8oAdmitted[index] ?? time));
			expect(e8oGaps.length, "three admissions give two gaps").toBe(2);
			expect(e8oGaps[0] ?? 0, "the first inner retry waits about the 2 s base").toBeGreaterThanOrEqual(1_500);
			expect(e8oGaps[1] ?? 0, "the second inner retry waits about twice the base").toBeGreaterThanOrEqual(3_000);
			expect(
				await world.disposeSessionInBody(e8oSession),
				"the E8 one-attempt owner disposes cleanly",
			).toBeUndefined();
			trace.mark("root", "e8.one-attempt");

			// E8 unknown failure: a provider failure that matches no classifier pattern is not transient, so it is requested once. The inner loop
			// stops at once, the durable ladder announces no retry, and the lane terminalizes failed with completion_error.
			const e8uCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e8uSession = e8uCreated.session;
			const e8uWake = createBarrier();
			const E8_OPAQUE_ERROR = "scripted opaque failure xyz";
			world.provider.enqueue(
				"root",
				calls("e8u-start", [
					{
						id: "e8u-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "e8-transient",
							instructions: "Read the limits file, then report.",
						},
					},
				]),
				{
					name: "e8u-start-reply",
					reply: { content: [{ type: "text", text: "The opaque reader is started." }] },
				},
				{
					name: "e8u-wake",
					maxRequests: 8,
					until: (request) => {
						const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
						if (done) e8uWake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			const e8uWarningsBefore = world.warnings.length;
			world.provider.enqueue("worker-a", fail("e8u-fail", E8_OPAQUE_ERROR));
			world.systemOne.enterPhase("e8u-start", e4Judgments);
			await withDeadline(trace, "E8 opaque start turn", e8uSession.prompt("Start the opaque reader."));
			await withDeadline(trace, "E8 opaque handoff woke the root", e8uWake.promise, 120_000);
			await withDeadline(trace, "E8 opaque root idle", e8uSession.waitForForegroundIdle());
			expect(
				world.provider.reached.filter((name) => name.startsWith("worker-a:e8u-")),
				"the opaque failure is requested exactly once",
			).toEqual(["worker-a:e8u-fail"]);
			const e8uWarnings = world.warnings.slice(e8uWarningsBefore);
			expect(
				e8uWarnings.filter(
					(message) =>
						message.includes("provider request failed") ||
						message.includes("retrying from the persisted transcript"),
				),
				"the opaque failure announces no inner or ladder retry",
			).toHaveLength(0);
			const e8uAttempts = Object.values(e8uSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
			expect(
				e8uAttempts.map((attempt) => attempt.status),
				"the lane's single attempt terminalizes failed",
			).toEqual(["failed"]);
			expect(e8uAttempts[0]?.result?.reasonCode, "the opaque failure terminalizes as a completion error").toBe(
				"completion_error",
			);
			expect(await world.disposeSessionInBody(e8uSession), "the E8 opaque owner disposes cleanly").toBeUndefined();
			trace.mark("root", "e8.unknown");

			// E8 cost budget (provider-reported cost): the first provider reply reports a consistent cost of 0.3 USD, above the owner's 0.2 USD
			// cap. Its tool call is refused by the grant's own cost check before any effect, and that refusal terminalizes the only attempt partial
			// with the exact native reason. The worker's second provider request never happens.
			const E8C_INPUT_COST = 0.25;
			const E8C_OUTPUT_COST = 0.05;
			const E8C_TOTAL_COST = E8C_INPUT_COST + E8C_OUTPUT_COST;
			const E8C_PROFILE: OrchestrationProfile = {
				...E8_BUDGET_PROFILE,
				profileId: "e8-cost",
				description: "Read-only worker with a 0.2 USD cost cap.",
				budget: { maxTokens: 50_000, maxCostUsd: 0.2 },
			};
			new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			}).save(E8C_PROFILE, "global");
			const e8cCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e8cSession = e8cCreated.session;
			const e8cWake = createBarrier();
			world.provider.enqueue(
				"root",
				calls("e8c-start", [
					{
						id: "e8c-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "e8-cost",
							instructions: "Read the limits file, then report.",
						},
					},
				]),
				{
					name: "e8c-start-reply",
					reply: { content: [{ type: "text", text: "The cost-capped reader is started." }] },
				},
				{
					name: "e8c-wake",
					maxRequests: 8,
					until: (request) => {
						const tail = request.context.messages.at(-1);
						const done =
							tail?.role === "user" && JSON.stringify(tail).includes("Background worker terminal handoff");
						if (done) e8cWake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "e8c-read",
				reply: {
					content: [{ type: "toolCall", id: "e8c-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
					stopReason: "toolUse",
					usage: {
						...createEmptyUsage(),
						input: 1_000,
						output: 100,
						totalTokens: 1_100,
						cost: {
							...createEmptyUsage().cost,
							input: E8C_INPUT_COST,
							output: E8C_OUTPUT_COST,
							total: E8C_TOTAL_COST,
						},
					},
				},
			});
			world.systemOne.enterPhase("e8c-start", e4Judgments);
			await withDeadline(trace, "E8 cost start turn", e8cSession.prompt("Start the cost-capped reader."));
			await withDeadline(trace, "E8 cost handoff woke the root", e8cWake.promise, 120_000);
			await withDeadline(trace, "E8 cost root idle", e8cSession.waitForForegroundIdle());
			expect(
				world.provider.reached.filter((name) => name.startsWith("worker-a:e8c-")),
				"the cost-capped worker reaches exactly one provider request: the second is never made",
			).toEqual(["worker-a:e8c-read"]);
			const e8cAttempts = Object.values(e8cSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
			expect(
				e8cAttempts.map((attempt) => attempt.status),
				"the cost refusal terminalizes the worker's only attempt partial",
			).toEqual(["partial"]);
			expect(
				e8cAttempts[0]?.result?.reasonCode,
				"the native reason is the grant's cost refusal, not a tree refusal",
			).toBe("cost_budget_exhausted");
			expect(await world.disposeSessionInBody(e8cSession), "the E8 cost owner disposes cleanly").toBeUndefined();
			trace.mark("root", "e8.cost");

			// Held native read-only Bash (E4 active reload): a read-only check is held at its shell gate after its tool has started. A reload while the
			// tool is active is refused, and the durable entries and the lifecycle snapshot are the ones captured at the tool start. The gate is released
			// and the turn joined in finally, so a failed assertion never leaves the shell held; the turn completes once, then the same reload succeeds.
			const hbLifecycleChanged = (before: object, after: object): string[] =>
				Object.keys(before)
					.filter((key) => JSON.stringify(Reflect.get(before, key)) !== JSON.stringify(Reflect.get(after, key)))
					.map((key) =>
						`${key}: ${JSON.stringify(Reflect.get(before, key))} -> ${JSON.stringify(Reflect.get(after, key))}`.slice(
							0,
							1200,
						),
					);
			const hbCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const hbSession = hbCreated.session;
			const hbManager = hbCreated.sessionManager;
			const hbToolStarted = createBarrier();
			const hbGate = createBarrier();
			const hbShellAdmitted = createBarrier();
			world.shell.enqueue({
				name: "held-readonly-bash",
				command: "echo held-check",
				cwd: HARNESS_PROJECT_CWD,
				output: "held-check\n",
				exitCode: 0,
				gate: hbGate.promise,
				check: (request) => {
					if (request.command !== "echo held-check" || request.cwd !== HARNESS_PROJECT_CWD) {
						throw new Error(
							`the held shell admitted an unexpected command: ${request.command} in ${request.cwd}`,
						);
					}
					hbShellAdmitted.release();
				},
			});
			world.provider.enqueue(
				"root",
				calls("hb-bash", [{ id: "hb-bash-1", name: "bash", arguments: { command: "echo held-check" } }]),
				{
					name: "hb-reply",
					check: (request) => {
						const result = latestBatchResults(request).find((item) => item.toolName === "bash");
						if (result?.isError || !result?.text.includes("held-check")) {
							throw new Error(`the held check did not finish through the shell: ${result?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The held check finished." }] },
				},
			);
			const hbUnsubscribe = hbSession.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "bash") hbToolStarted.release();
			});
			world.systemOne.enterPhase("hb-held", {
				...e4Judgments,
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.02 },
			});
			let hbOutcome: unknown;
			const hbPrompt = hbSession.prompt("Run the held read-only check.").catch((error: unknown) => error);
			try {
				await withDeadline(trace, "held bash tool started", hbToolStarted.promise);
				await withDeadline(trace, "held bash admitted at the shell", hbShellAdmitted.promise);
				const hbEntriesAtGate = JSON.stringify(hbManager.getEntries());
				const hbCountAtGate = hbManager.getEntries().length;
				const hbLifecycleAtGate = hbSession.getResourceSnapshot();
				const hbRefusal = await hbSession.reload().then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(
					hbRefusal instanceof Error ? hbRefusal.message : undefined,
					"a reload while the held tool is active is refused",
				).toContain("while the agent is streaming or a tool call is active");
				const hbAppended = hbManager
					.getEntries()
					.slice(hbCountAtGate)
					.map((entry) => ({
						id: entry.id,
						type: entry.type,
						parentId: entry.parentId,
						toolCallId:
							entry.type === "message" && entry.message.role === "toolResult"
								? entry.message.toolCallId
								: undefined,
						text: JSON.stringify(entry),
					}));
				expect(
					{
						appended: hbAppended,
						prefixUnchanged: JSON.stringify(hbManager.getEntries().slice(0, hbCountAtGate)) === hbEntriesAtGate,
						lifecycleChangedKeys: hbLifecycleChanged(hbLifecycleAtGate, hbSession.getResourceSnapshot()),
					},
					"the refused reload leaves the durable entries and lifecycle unchanged while the held tool runs",
				).toEqual({ appended: [], prefixUnchanged: true, lifecycleChangedKeys: [] });
			} finally {
				hbGate.release();
				hbOutcome = await withDeadline(trace, "held bash turn joined", hbPrompt);
				hbUnsubscribe();
			}
			expect(hbOutcome, "the held turn completes once, without an error").toBeUndefined();
			expect(
				hbSession.messages.some(
					(message) =>
						message.role === "assistant" && JSON.stringify(message.content).includes("The held check finished."),
				),
				"the held turn's reply is recorded",
			).toBe(true);
			const hbReadBefore = hbSession.getToolDefinition("read");
			await withDeadline(trace, "held bash idle reload", hbSession.reload());
			expect(hbSession.getToolDefinition("read"), "the idle reload rebinds the read tool definition").not.toBe(
				hbReadBefore,
			);
			expect(await world.disposeSessionInBody(hbSession), "the held bash owner disposes cleanly").toBeUndefined();
			trace.mark("root", "e4.held-bash-reload");

			// E13 (required write-reservation release): a writer holds its exact lease, claim and execution hold while its gated worker runs. Everything
			// the teardown must keep is predeclared from the pre-fault identity: the exact lease, the exact claim tuple with its shutdown shape, the hold
			// count, and the durable reservation bytes. The reservation store's unlink fails before mutation. The owner's certificate accepts exactly that
			// predeclared retention. A later process reaps the dead owner's lease when a fresh owner starts a writer on the same scope.
			const E13_SCOPE = `${HARNESS_PROJECT_CWD}/e13/out`;
			const e13Admitted = createBarrier();
			const e13Gate = createBarrier();
			const e13Wake = createBarrier();
			const e13Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e13Session = e13Created.session;
			const e13Start = (instructions: string) => ({
				id: "e13-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [E13_SCOPE],
					instructions,
				},
			});
			world.provider.enqueue("root", calls("e13-start-first", [e13Start("E13-WRITER holds its scope.")]), {
				name: "e13-first-reply",
				check: (request) => {
					const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
					if (started?.isError || !started?.text.includes("delegate started (running)")) {
						throw new Error(`the first writer did not start: ${started?.text ?? "no result"}`);
					}
				},
				reply: { content: [{ type: "text", text: "The first writer is started." }] },
			});
			world.provider.enqueue("worker-a", {
				name: "e13-writer-hold",
				check: () => e13Admitted.release(),
				gate: e13Gate.promise,
				reply: { content: [{ type: "text", text: "E13-WRITER reached its gate." }] },
			});
			world.systemOne.enterPhase("e13-first", e4Judgments);
			await withDeadline(trace, "E13 first writer started", e13Session.prompt("Start the scope writer."));
			await withDeadline(trace, "E13 writer admitted", e13Admitted.promise);
			// Predeclared before any fault: the exact lease, the exact claim tuple, the hold count, and the durable reservation bytes.
			const e13Pre = e13Session.getResourceSnapshot().workers;
			if (e13Pre === undefined) throw new Error("the E13 owner reports no worker snapshot before teardown");
			const e13Leases = e13Pre.reservations.heldLeases;
			const e13Holds = e13Pre.executingHolds;
			const e13PreClaims = e13Pre.ownedProjectClaims;
			expect(e13Leases, "the admitted writer holds exactly one write lease before teardown").toHaveLength(1);
			expect(e13PreClaims, "the admitted writer owns exactly one project claim before teardown").toHaveLength(1);
			const e13PreAgent = e13PreClaims[0]?.agents[0];
			if (e13PreAgent === undefined) throw new Error("the admitted claim carries no agent");
			const e13Store = [...world.io.fileEntries()].filter(([storePath]) =>
				storePath.includes("worker-write-reservations"),
			);
			expect(
				e13Store.map(([, content]) => content.includes(e13Leases[0]?.reservationId ?? "")),
				"the admitted lease is durably stored before the fault",
			).toEqual([true]);
			const [e13StorePath, e13StoreBytes] = e13Store[0] ?? [];
			if (e13StorePath === undefined || e13StoreBytes === undefined)
				throw new Error("the reservation store is not in the virtual tree");
			const e13ExpectedClaims: WorkerProjectClaims = e13PreClaims.map((claim) => ({
				...claim,
				agents: [
					{
						agentId: e13PreAgent.agentId,
						agentStatus: "suspended",
						attemptId: e13PreAgent.attemptId,
						attemptStatus: "suspended",
						executingHoldCount: e13PreAgent.executingHoldCount,
						mailboxLoaded: true,
						mailbox: {
							parentSessionId: e13Created.sessionManager.getSessionId(),
							agentId: e13PreAgent.agentId,
							listenerCount: 0,
							hasOpenObligation: false,
							pendingMessageIds: [],
							replyAcknowledgementIds: [],
						},
					},
				],
			}));
			world.io.failNext({
				name: "e13-release-unlink-fails",
				kind: "unlink",
				matches: (operation) => operation.path === e13StorePath,
				code: "EIO",
				times: 1,
			});
			const e13Teardown = await world.disposeSessionInBody(e13Session);
			await world.provider.waitForProducers();
			const e13Failure = e13Teardown === undefined ? "no failure" : failureText(e13Teardown.error);
			expect(e13Failure, "the required release failure keeps the original scripted cause").toContain(
				"e13-release-unlink-fails",
			);
			world.io.assertFaultsConsumed();
			expect(world.io.consumedFaults.at(-1), "the reservation unlink fault fired on the store before mutation").toBe(
				"e13-release-unlink-fails",
			);
			expect(
				world.io.fileEntries().get(e13StorePath),
				"the failed unlink leaves the durable reservation bytes unchanged",
			).toBe(e13StoreBytes);
			const e13Post = e13Session.getResourceSnapshot().workers;
			expect(e13Post?.reservations.heldLeases, "the retained lease is the original owner, fence and paths").toEqual(
				e13Leases,
			);
			expect(e13Post?.executingHolds, "the execution hold count stays original").toEqual(e13Holds);
			expect(e13Post?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
				e13ExpectedClaims,
			);
			expect(e13Post?.reservations.watchCount, "the owner's reservation watch is closed by teardown").toBe(0);
			world.certifyDisposedOwner(e13Session, e13ExpectedClaims, { leases: e13Leases, executingHolds: e13Holds });
			// The dead owner's exact lease is reaped at the native boundary: its pid is parsed from the exact lease and probed with signal 0 by the fresh
			// owner, the exact old reservation is absent from the durable store at the fresh admission, and the fresh admitted lease is a different
			// owner, attempt and fence on the same scope. No start receipt text is used as the oracle.
			const e13StoreContent = (): string[] =>
				[...world.io.fileEntries()]
					.filter(([storePath]) => storePath.includes("worker-write-reservations"))
					.map(([, content]) => content);
			const e13OldLease = e13Leases[0];
			if (e13OldLease === undefined) throw new Error("the E13 owner has no exact lease to reap");
			const e13OldPid = parseLocalWorkerProcessOwnerId(e13OldLease.ownerId)?.pid;
			expect(e13OldPid, "the exact lease names the process that owns it").toBe(world.processTable.self);
			expect(
				e13StoreContent().some((content) => content.includes(e13OldLease.reservationId)),
				"the exact old reservation is durable before the process advance",
			).toBe(true);
			world.processTable.advanceProcess();
			const e13ProbeBase = world.processTable.probes.length;
			const e13Fresh = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e13EntranceStoreBefore = e13StoreContent();
			e13Fresh.session.getLaneRecords();
			const e13EntranceProbes = world.processTable.probes.slice(e13ProbeBase);
			expect(
				e13EntranceProbes.some((probe) => probe.pid === e13OldPid && probe.signal === 0),
				"the recovery entrance probes the exact dead owner pid with signal 0",
			).toBe(true);
			expect(
				e13EntranceStoreBefore.some((content) => content.includes(e13OldLease.reservationId)),
				"the exact old reservation is durable before the recovery entrance",
			).toBe(true);
			expect(
				e13StoreContent().some((content) => content.includes(e13OldLease.reservationId)),
				"the recovery entrance releases the exact old reservation from the durable store",
			).toBe(false);
			let e13SecondTaskId: string | undefined;
			world.provider.enqueue(
				"root",
				calls("e13-start-second", [e13Start("E13-WRITER-2 takes the scope.")]),
				{
					name: "e13-second-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the second writer was not admitted as running: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The second writer is started." }] },
				},
				{
					name: "e13-wake",
					maxRequests: 8,
					until: (request) => {
						const everything = JSON.stringify(request.context.messages);
						const done = e13SecondTaskId !== undefined && everything.includes(`- ${e13SecondTaskId}: succeeded`);
						if (done) e13Wake.release();
						return done;
					},
					reply: { content: [{ type: "text", text: "Background work is still settling." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "e13-writer-two",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "e13-report-2",
							name: "submit_report",
							arguments: { status: "completed", summary: "The second writer finished." },
						},
					],
					stopReason: "toolUse",
				},
			});
			expect(
				Object.values(e13Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}),
				"the fresh owner has no attempt before its second start",
			).toHaveLength(0);
			world.systemOne.enterPhase("e13-second", e4Judgments);
			await withDeadline(
				trace,
				"E13 second writer started",
				e13Fresh.session.prompt("Start the second scope writer."),
			);
			const e13Failures: unknown[] = [];
			try {
				const e13Running = e13Fresh.session.getResourceSnapshot().workers?.reservations.heldLeases ?? [];
				const e13Adm = {
					leases: e13Running,
					probes: world.processTable.probes.slice(e13ProbeBase),
					store: e13StoreContent(),
				};
				e13SecondTaskId = e13Running[0]?.taskId;
				expect(
					e13Adm.probes.some((probe) => probe.pid === e13OldPid && probe.signal === 0),
					"the fresh owner probes the exact dead owner pid with signal 0 before its admission",
				).toBe(true);
				expect(
					e13Adm.store.some((content) => content.includes(e13OldLease.reservationId)),
					"the exact old reservation is absent from the durable store at the fresh admission",
				).toBe(false);
				expect(e13Adm.leases, "the fresh admission holds exactly one lease").toHaveLength(1);
				const e13Second = e13Adm.leases[0];
				expect(e13Second?.ownerId, "the fresh lease has a different owner").not.toBe(e13OldLease.ownerId);
				expect(e13Second?.attemptId, "the fresh lease has a different attempt").not.toBe(e13OldLease.attemptId);
				expect(e13Second?.reservationId, "the fresh lease has a different reservation").not.toBe(
					e13OldLease.reservationId,
				);
				expect(e13Second?.parentSessionId, "the fresh lease names the fresh parent session").toBe(
					e13Fresh.sessionManager.getSessionId(),
				);
				expect(e13Second?.writeScopes, "the fresh lease keeps the exact scope").toEqual([E13_SCOPE]);
				const e13FreshAttempt = Object.values(
					e13Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {},
				).find((attempt) => attempt.attemptId === e13Second?.attemptId);
				expect(e13FreshAttempt?.taskId, "the fresh lease names the admitted task").toBe(e13Second?.taskId);
				// The fresh owner had no attempt before its start (asserted before the start), so the prior fence is zero: fence = 0 + 1.
				const e13PriorFence = 0;
				expect(e13Second?.fencingToken, "the fresh lease fence is one above its attempt's prior lease").toBe(
					e13PriorFence + 1,
				);
				expect(e13Second?.fencingToken, "the stored fence is the active native attempt lease fence").toBe(
					e13FreshAttempt?.lease?.fencingToken,
				);
				expect(e13Second?.writeScopes, "the fresh lease keeps the same scope").toEqual(e13OldLease.writeScopes);
				expect(
					e13Adm.store.some((content) => content.includes(e13Second?.reservationId ?? "")),
					"the fresh admitted lease is durable",
				).toBe(true);
			} catch (error) {
				e13Failures.push(error);
			} finally {
				// The admitted task's own terminal handoff and the foreground tail are joined while this owner is live, before its disposal.
				try {
					await withDeadline(trace, "E13 second writer handed off", e13Wake.promise, 90_000).catch(
						(error: unknown) => {
							throw new Error(
								`${failureText(error)}; fresh attempts: ${JSON.stringify(Object.values(e13Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).map((attempt) => JSON.stringify(Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== "dispatch" && key !== "grant"))).slice(0, 1200)))}; fresh workers: ${JSON.stringify(e13Fresh.session.getResourceSnapshot().workers?.executingHolds)}`,
							);
						},
					);
					await withDeadline(trace, "E13 fresh root idle", e13Fresh.session.waitForForegroundIdle());
				} catch (error) {
					e13Failures.push(error);
				}
				try {
					expect(
						await world.disposeSessionInBody(e13Fresh.session),
						"the E13 fresh owner disposes cleanly",
					).toBeUndefined();
				} catch (error) {
					e13Failures.push(error);
				}
			}
			if (e13Failures.length === 1) throw e13Failures[0];
			if (e13Failures.length > 1) {
				throw new AggregateError(e13Failures, "the E13 second writer failed before and during its cleanup");
			}
			trace.mark("root", "e13.required-release");

			// E13 after-mutation (required release): the store unlink completes and then fails. The durable store has lost the lease while the owner still
			// holds it in memory, so the required release keeps the lease, its execution hold and its claim, and the disposal reports the exact unlink
			// cause together with the retained lease. Every identity is predeclared from the admitted writer before the fault.
			const E13A_SCOPE = `${HARNESS_PROJECT_CWD}/e13a/out`;
			const e13aAdmitted = createBarrier();
			const e13aGate = createBarrier();
			const e13aCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e13aSession = e13aCreated.session;
			world.provider.enqueue(
				"root",
				calls("e13a-start-first", [
					{
						id: "e13a-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							writePaths: [E13A_SCOPE],
							instructions: "E13A-WRITER holds its scope.",
						},
					},
				]),
				{
					name: "e13a-first-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the after-mutation writer did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The after-mutation writer is started." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "e13a-writer-hold",
				check: () => e13aAdmitted.release(),
				gate: e13aGate.promise,
				reply: { content: [{ type: "text", text: "E13A-WRITER reached its gate." }] },
			});
			world.systemOne.enterPhase("e13a-first", e4Judgments);
			await withDeadline(trace, "E13A first writer started", e13aSession.prompt("Start the after-mutation writer."));
			await withDeadline(trace, "E13A writer admitted", e13aAdmitted.promise);
			const e13aPre = e13aSession.getResourceSnapshot().workers;
			if (e13aPre === undefined) throw new Error("the E13A owner reports no worker snapshot before teardown");
			const e13aLeases = e13aPre.reservations.heldLeases;
			const e13aHolds = e13aPre.executingHolds;
			const e13aPreClaims = e13aPre.ownedProjectClaims;
			expect(e13aLeases, "the after-mutation writer holds exactly one write lease before teardown").toHaveLength(1);
			expect(e13aPreClaims, "the after-mutation writer owns exactly one project claim before teardown").toHaveLength(
				1,
			);
			const e13aPreAgent = e13aPreClaims[0]?.agents[0];
			if (e13aPreAgent === undefined) throw new Error("the E13A claim carries no agent");
			const e13aLease = e13aLeases[0];
			if (e13aLease === undefined) throw new Error("the E13A owner has no exact lease");
			const e13aStore = [...world.io.fileEntries()].filter(([storePath]) =>
				storePath.includes("worker-write-reservations"),
			);
			expect(
				e13aStore.map(([, content]) => content.includes(e13aLease.reservationId)),
				"the E13A lease is durably stored before the fault",
			).toContain(true);
			const e13aStorePath = e13aStore.find(([, content]) => content.includes(e13aLease.reservationId))?.[0];
			if (e13aStorePath === undefined) throw new Error("the E13A lease has no durable store entry");
			const e13aExpectedClaims: WorkerProjectClaims = e13aPreClaims.map((claim) => ({
				...claim,
				agents: [
					{
						agentId: e13aPreAgent.agentId,
						agentStatus: "suspended",
						attemptId: e13aPreAgent.attemptId,
						attemptStatus: "suspended",
						executingHoldCount: e13aPreAgent.executingHoldCount,
						mailboxLoaded: true,
						mailbox: {
							parentSessionId: e13aCreated.sessionManager.getSessionId(),
							agentId: e13aPreAgent.agentId,
							listenerCount: 0,
							hasOpenObligation: false,
							pendingMessageIds: [],
							replyAcknowledgementIds: [],
						},
					},
				],
			}));
			world.io.failNext({
				name: "e13a-release-unlink-after",
				kind: "unlink",
				matches: (operation) => operation.path === e13aStorePath,
				phase: "after",
				code: "EIO",
				times: 1,
			});
			const e13aTeardown = await world.disposeSessionInBody(e13aSession);
			await world.provider.waitForProducers();
			const e13aFailure = e13aTeardown === undefined ? "no failure" : failureText(e13aTeardown.error);
			expect(e13aFailure, "the after-mutation failure keeps its exact unlink cause").toContain(
				"e13a-release-unlink-after",
			);
			expect(e13aFailure, "the after-mutation failure names the exact retained lease").toContain(
				`${e13aLease.taskId}:${e13aLease.attemptId}:${e13aLease.fencingToken}`,
			);
			world.io.assertFaultsConsumed();
			expect(world.io.consumedFaults.at(-1), "the after-mutation fault is the one that fires").toBe(
				"e13a-release-unlink-after",
			);
			expect(
				world.io.fileEntries().get(e13aStorePath) ?? "",
				"the unlink completed before it failed: the durable store no longer names the lease",
			).not.toContain(e13aLease.reservationId);
			const e13aPost = e13aSession.getResourceSnapshot().workers;
			expect(e13aPost?.reservations.heldLeases, "the owner still holds its exact lease in memory").toEqual(
				e13aLeases,
			);
			expect(e13aPost?.executingHolds, "the execution hold count stays original").toEqual(e13aHolds);
			expect(e13aPost?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
				e13aExpectedClaims,
			);
			expect(e13aPost?.reservations.watchCount, "this writer registered no observer").toBe(0);
			world.certifyDisposedOwner(e13aSession, e13aExpectedClaims, { leases: e13aLeases, executingHolds: e13aHolds });

			// E13 joined teardown (required release): one owner holds a live writer while its reservation observer close and its store unlink fail
			// in the same teardown. Both exact causes are joined into the disposal error, the native observer stays registered with its listeners,
			// the lease and hold stay exact, and the observer is cut off only after this native proof. Every identity is predeclared before the faults.
			expect(
				world.io.getWatcherSnapshot().filter((watcher) => watcher.path.includes("worker-write-reservations")),
				"no reservation observer outlives the disposed owners before the joined control's owner exists",
			).toEqual([]);
			const e13jAdmitted = createBarrier();
			const e13jGate = createBarrier();
			const e13jCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e13jSession = e13jCreated.session;
			world.provider.enqueue(
				"root",
				calls("e13j-start-first", [
					{
						id: "e13j-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							writePaths: [E13_SCOPE],
							instructions: "E13J-WRITER holds its scope.",
						},
					},
				]),
				{
					name: "e13j-first-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the joined-teardown writer did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The joined-teardown writer is started." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "e13j-writer-hold",
				check: () => e13jAdmitted.release(),
				gate: e13jGate.promise,
				reply: { content: [{ type: "text", text: "E13J-WRITER reached its gate." }] },
			});
			world.systemOne.enterPhase("e13j-first", e4Judgments);
			await withDeadline(
				trace,
				"E13J first writer started",
				e13jSession.prompt("Start the joined-teardown writer."),
			);
			await withDeadline(trace, "E13J writer admitted", e13jAdmitted.promise);

			const e13jPre = e13jSession.getResourceSnapshot().workers;
			if (e13jPre === undefined) throw new Error("the E13J owner reports no worker snapshot before teardown");
			const e13jLeases = e13jPre.reservations.heldLeases;
			const e13jHolds = e13jPre.executingHolds;
			const e13jPreClaims = e13jPre.ownedProjectClaims;
			expect(e13jLeases, "the E13J writer holds exactly one write lease before teardown").toHaveLength(1);
			expect(e13jPreClaims, "the E13J writer owns exactly one project claim before teardown").toHaveLength(1);
			const e13jPreAgent = e13jPreClaims[0]?.agents[0];
			if (e13jPreAgent === undefined) throw new Error("the E13J claim carries no agent");
			const e13jLease = e13jLeases[0];
			if (e13jLease === undefined) throw new Error("the E13J owner has no exact lease");
			const e13jStore = [...world.io.fileEntries()].filter(([storePath]) =>
				storePath.includes("worker-write-reservations"),
			);
			expect(
				e13jStore.map(([, content]) => content.includes(e13jLease.reservationId)),
				"the E13J lease is the only durable store entry before the faults",
			).toEqual([true]);
			const [e13jStorePath, e13jStoreBytes] = e13jStore[0] ?? [];
			if (e13jStorePath === undefined || e13jStoreBytes === undefined)
				throw new Error("the E13J reservation store is not in the virtual tree");
			// A granted writer registers no observer; the owner's observer exists only once a waiter subscribes to availability. A bounded wait on
			// the running writer is that subscription: it times out by design and leaves the owner's observer registered for the watcher-only teardown.
			world.provider.enqueue(
				"root",
				calls("e13j-wait", [
					{
						id: "e13j-wait-1",
						name: "delegate",
						arguments: { action: "wait", agentId: e13jPreAgent.agentId, timeoutMs: 1000 },
					},
				]),
				{
					name: "e13j-wait-reply",
					check: (request) => {
						const waited = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (waited?.isError) throw new Error(`the bounded wait on the writer failed: ${waited.text}`);
					},
					reply: { content: [{ type: "text", text: "The joined-teardown writer is still running." }] },
				},
			);
			world.systemOne.enterPhase("e13j-wait", e4Judgments);
			await withDeadline(
				trace,
				"E13J bounded wait",
				e13jSession.prompt("Wait briefly for the joined-teardown writer."),
			);
			const e13jWatchPre = world.io
				.getWatcherSnapshot()
				.filter((watcher) => watcher.path === dirname(e13jStorePath));
			expect(
				e13jWatchPre.length,
				"the bounded wait registers at least one observer on the store directory",
			).toBeGreaterThan(0);
			expect(
				e13jSession.getResourceSnapshot().workers?.reservations.watchCount,
				"the owner's observer count equals the observers the bounded wait registered on the store directory",
			).toBe(e13jWatchPre.length);
			// One observer per host workspace key may share the store directory. Watchers close in registration order, so the
			// first registered observer is the one the single scripted close fault meets; it is the one the teardown retains.
			const e13jWatch = e13jWatchPre[0];
			if (e13jWatch === undefined) throw new Error("the E13J store directory carries no observer");
			if (e13jWatch === undefined) throw new Error("the E13J store directory carries no observer");
			const e13jExpectedClaims: WorkerProjectClaims = e13jPreClaims.map((claim) => ({
				...claim,
				agents: [
					{
						agentId: e13jPreAgent.agentId,
						agentStatus: "suspended",
						attemptId: e13jPreAgent.attemptId,
						attemptStatus: "suspended",
						executingHoldCount: e13jPreAgent.executingHoldCount,
						mailboxLoaded: true,
						mailbox: {
							parentSessionId: e13jCreated.sessionManager.getSessionId(),
							agentId: e13jPreAgent.agentId,
							listenerCount: 0,
							hasOpenObligation: false,
							pendingMessageIds: [],
							replyAcknowledgementIds: [],
						},
					},
				],
			}));
			world.io.failNext({
				name: "e13j-watch-close-fails",
				kind: "watch.close",
				matches: (operation) => operation.path === e13jWatch.path,
				code: "EIO",
				times: 1,
			});
			world.io.failNext({
				name: "e13j-release-unlink-fails",
				kind: "unlink",
				matches: (operation) => operation.path === e13jStorePath,
				code: "EIO",
				times: 1,
			});
			const e13jTeardown = await world.disposeSessionInBody(e13jSession);
			await world.provider.waitForProducers();
			const e13jFailure = e13jTeardown === undefined ? "no failure" : failureText(e13jTeardown.error);
			expect(e13jFailure, "the joined teardown keeps the observer close cause").toContain("e13j-watch-close-fails");
			expect(e13jFailure, "the joined teardown keeps the physical unlink cause").toContain(
				"e13j-release-unlink-fails",
			);
			expect(e13jFailure, "the joined teardown names the exact retained lease").toContain(
				`${e13jLease.taskId}:${e13jLease.attemptId}:${e13jLease.fencingToken}`,
			);
			world.io.assertFaultsConsumed();
			// Native teardown order: the attempt's child cleanup releases the lease first (unlink), then the owner's coordinator closes its observers.
			expect(
				world.io.consumedFaults.slice(-2),
				"both faults fire in native teardown order: lease release, then observer close",
			).toEqual(["e13j-release-unlink-fails", "e13j-watch-close-fails"]);
			expect(
				world.io.fileEntries().get(e13jStorePath),
				"the failed unlink leaves the durable reservation bytes unchanged",
			).toBe(e13jStoreBytes);
			const e13jPost = e13jSession.getResourceSnapshot().workers;
			expect(e13jPost?.reservations.heldLeases, "the retained lease is the original owner, fence and paths").toEqual(
				e13jLeases,
			);
			expect(e13jPost?.executingHolds, "the execution hold count stays original").toEqual(e13jHolds);
			expect(e13jPost?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
				e13jExpectedClaims,
			);
			expect(e13jPost?.reservations.watchCount, "the failed observer close keeps its native registration").toBe(1);
			expect(
				world.io.getWatcherSnapshot().filter((watcher) => watcher.path === dirname(e13jStorePath)),
				"the retained observer is the first registered one with its listeners intact",
			).toEqual([e13jWatch]);
			// External transport cutoff of the one observer the native teardown retained, only after the native proof above.
			world.io.cutoffRetainedWatcher({ id: e13jWatch.id, path: e13jWatch.path });
			world.certifyDisposedOwner(e13jSession, e13jExpectedClaims, {
				leases: e13jLeases,
				executingHolds: e13jHolds,
				watchCount: 1,
			});

			const E13W_SCOPE = `${HARNESS_PROJECT_CWD}/e13w/out`;
			// E13 watcher-only teardown (required release): one owner runs a writer to a typed completion; native cleanup releases its lease, claim and
			// hold. The owner then keeps only its reservation observer: no availability subscribers remain, and the physical observer keeps its one native change callback. That observer's close fails at disposal: the cause is
			// reported, the owner's registration stays, and the observer is cut off only after this native proof. Identities are predeclared before the fault.
			const e13wAdmitted = createBarrier();
			const e13wGate = createBarrier();
			const e13wCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e13wSession = e13wCreated.session;
			world.provider.enqueue(
				"root",
				calls("e13w-start-first", [
					{
						id: "e13w-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							writePaths: [E13W_SCOPE],
							instructions: "E13W-WRITER holds its scope.",
						},
					},
				]),
				{
					name: "e13w-first-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the joined-teardown writer did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The joined-teardown writer is started." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "e13w-writer-hold",
				check: () => e13wAdmitted.release(),
				gate: e13wGate.promise,
				reply: {
					content: [
						{
							type: "toolCall",
							id: "e13w-report",
							name: "submit_report",
							arguments: { status: "completed", summary: "E13W-WRITER finished its scope." },
						},
					],
					stopReason: "toolUse",
				},
			});
			world.systemOne.enterPhase("e13w-first", e4Judgments);
			await withDeadline(
				trace,
				"E13W first writer started",
				e13wSession.prompt("Start the joined-teardown writer."),
			);
			await withDeadline(trace, "E13W writer admitted", e13wAdmitted.promise);

			try {
				const e13wPre = e13wSession.getResourceSnapshot().workers;
				if (e13wPre === undefined) throw new Error("the E13W owner reports no worker snapshot before teardown");
				const e13wLeases = e13wPre.reservations.heldLeases;
				const e13wHolds = e13wPre.executingHolds;
				const e13wPreClaims = e13wPre.ownedProjectClaims;
				expect(e13wLeases, "the E13W writer holds exactly one write lease before teardown").toHaveLength(1);
				expect(e13wPreClaims, "the E13W writer owns exactly one project claim before teardown").toHaveLength(1);
				// The live writer is executing at its gate: its one execution hold is the pre-fault identity, the settled state below holds none.
				expect(e13wHolds, "the live E13W writer holds exactly its own execution at its gate").toEqual([
					{ agentId: e13wPreClaims[0]?.agents[0]?.agentId, count: 1 },
				]);
				const e13wPreAgent = e13wPreClaims[0]?.agents[0];
				if (e13wPreAgent === undefined) throw new Error("the E13W claim carries no agent");
				const e13wLease = e13wLeases[0];
				if (e13wLease === undefined) throw new Error("the E13W owner has no exact lease");
				const e13wStore = [...world.io.fileEntries()].filter(([storePath]) =>
					storePath.includes("worker-write-reservations"),
				);
				expect(
					e13wStore.map(([, content]) => content.includes(e13wLease.reservationId)),
					"the E13W lease is the only durable store entry before the faults",
				).toEqual([true]);
				const [e13wStorePath, e13wStoreBytes] = e13wStore[0] ?? [];
				if (e13wStorePath === undefined || e13wStoreBytes === undefined)
					throw new Error("the E13W reservation store is not in the virtual tree");
				// A granted writer registers no observer; the owner's observer exists only once a waiter subscribes to availability. A bounded wait on
				// the running writer is that subscription: it times out by design and leaves the owner's observer registered for the joined teardown.
				world.provider.enqueue(
					"root",
					calls("e13w-wait", [
						{
							id: "e13w-wait-1",
							name: "delegate",
							arguments: { action: "wait", agentId: e13wPreAgent.agentId, timeoutMs: 1000 },
						},
					]),
					{
						name: "e13w-wait-reply",
						check: (request) => {
							const waited = latestBatchResults(request).find((result) => result.toolName === "delegate");
							if (waited?.isError) throw new Error(`the bounded wait on the writer failed: ${waited.text}`);
						},
						reply: { content: [{ type: "text", text: "The joined-teardown writer is still running." }] },
					},
				);
				world.systemOne.enterPhase("e13w-wait", e4Judgments);
				await withDeadline(
					trace,
					"E13W bounded wait",
					e13wSession.prompt("Wait briefly for the joined-teardown writer."),
				);
				const e13wWatchPre = world.io
					.getWatcherSnapshot()
					.filter((watcher) => watcher.path === dirname(e13wStorePath));
				expect(
					e13wWatchPre.length,
					"the bounded wait registers at least one observer on the store directory",
				).toBeGreaterThan(0);
				expect(
					e13wSession.getResourceSnapshot().workers?.reservations.watchCount,
					"the owner's observer count equals the observers the bounded wait registered on the store directory",
				).toBe(e13wWatchPre.length);
				// One observer per host workspace key may share the store directory. Watchers close in registration order, so the
				// first registered observer is the one the single scripted close fault meets; it is the one the teardown retains.
				const e13wWatch = e13wWatchPre[0];
				if (e13wWatch === undefined) throw new Error("the E13W store directory carries no observer");
				// The root's terminal wait observes the writer's exact completion; the released gate lets the writer send its typed report.
				world.provider.enqueue(
					"root",
					calls("e13w-terminal", [
						{
							id: "e13w-terminal-1",
							name: "delegate",
							arguments: { action: "wait", agentId: e13wPreAgent.agentId, timeoutMs: 60_000 },
						},
					]),
					{
						name: "e13w-terminal-reply",
						check: (request) => {
							const waited = latestBatchResults(request).find((result) => result.toolName === "delegate");
							if (waited?.isError) throw new Error(`the terminal wait on the writer failed: ${waited.text}`);
						},
						reply: { content: [{ type: "text", text: "The joined-teardown writer finished." }] },
					},
				);
				world.systemOne.enterPhase("e13w-terminal", e4Judgments);
				e13wGate.release();
				await withDeadline(
					trace,
					"E13W writer terminal observed",
					e13wSession.prompt("Wait for the writer to finish."),
				);
				await withDeadline(trace, "E13W settled", e13wSession.waitForForegroundIdle());
				const e13wSettled = e13wSession.getResourceSnapshot().workers;
				if (e13wSettled === undefined)
					throw new Error("the E13W owner reports no worker snapshot after the writer finished");
				expect(
					e13wSettled.reservations.heldLeases,
					"the finished writer's lease is released before the fault",
				).toEqual([]);
				expect(e13wSettled.executingHolds, "the finished writer holds no execution before the fault").toEqual([]);
				expect(e13wSettled.ownedProjectClaims, "the finished writer's claim is released before the fault").toEqual(
					[],
				);
				expect(
					world.io.fileEntries().get(e13wStorePath) ?? "",
					"the released lease leaves the durable store before the fault",
				).not.toContain(e13wLease.reservationId);
				// Every observer on the store directory is registered by the coordinator, one per host workspace key, and each carries exactly its native change
				// callback. The first registration is the bounded wait's observer; the single close fault meets it first and the coordinator retains it.
				const e13wObservers = world.io
					.getWatcherSnapshot()
					.filter((watcher) => watcher.path === dirname(e13wStorePath));
				expect(
					e13wObservers.length,
					"the settled owner counts every observer it registered on the store directory",
				).toBe(e13wSettled.reservations.watchCount);
				expect(e13wObservers[0]?.id, "the first registered observer is the bounded wait's").toBe(e13wWatch.id);
				expect(
					e13wObservers.every((watcher) => watcher.listenerCount === 1),
					"each registered observer carries exactly its native change callback",
				).toBe(true);
				world.io.failNext({
					name: "e13w-watch-close-fails",
					kind: "watch.close",
					matches: (operation) => operation.path === e13wWatch.path,
					code: "EIO",
					times: 1,
				});
				const e13wTeardown = await world.disposeSessionInBody(e13wSession);
				await world.provider.waitForProducers();
				const e13wFailure = e13wTeardown === undefined ? "no failure" : failureText(e13wTeardown.error);
				expect(e13wFailure, "the watcher-only teardown keeps the observer close cause").toContain(
					"e13w-watch-close-fails",
				);
				expect(e13wFailure, "the watcher-only teardown retains no write lease").not.toContain("retained");
				world.io.assertFaultsConsumed();
				expect(world.io.consumedFaults.at(-1), "the observer close fault is the one that fires").toBe(
					"e13w-watch-close-fails",
				);
				const e13wPost = e13wSession.getResourceSnapshot().workers;
				expect(e13wPost?.reservations.heldLeases, "the disposed owner keeps no lease").toEqual([]);
				expect(e13wPost?.executingHolds, "the disposed owner keeps no execution hold").toEqual([]);
				expect(e13wPost?.ownedProjectClaims, "the disposed owner keeps no claim").toEqual([]);
				expect(e13wPost?.reservations.watchCount, "the failed observer close keeps its native registration").toBe(
					1,
				);
				expect(
					world.io
						.getWatcherSnapshot()
						.filter((watcher) => watcher.path === dirname(e13wStorePath))
						.map((watcher) => ({ id: watcher.id, listenerCount: watcher.listenerCount })),
					"the disposed owner retains only the first observer, with its native callback, and the other one closed",
				).toEqual([{ id: e13wWatch.id, listenerCount: 1 }]);
				// External transport cutoff of the one observer the native teardown retained, only after the native proof above.
				world.io.cutoffRetainedWatcher({ id: e13wWatch.id, path: e13wWatch.path });
				world.certifyDisposedOwner(e13wSession, [], { leases: [], executingHolds: [], watchCount: 1 });
			} finally {
				// Failure-safe: an assertion that fails before the normal release must not leave the writer gated for the journey's cleanup.
				e13wGate.release();
			}
			// E13 failed inner join, recomposed: the writer's bash tool runs inside its isolated completion, and its shell call ignores abort. Owner
			// cancellation leaves that public promise pending, so the physical join is the only settlement the owner can report. The public promise is
			// observed pending before the shell gate is released, and the gate is released in a finally so the producer can join even when the teardown fails.
			const e13bAdmitted = createBarrier();
			const e13bShellGate = createBarrier();
			const E13B_SCOPE = `${HARNESS_PROJECT_CWD}/e13b/out`;
			const e13bCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const e13bSession = e13bCreated.session;
			world.shell.enqueue({
				name: "e13b-shell",
				command: "echo e13b-shell",
				cwd: HARNESS_PROJECT_CWD,
				output: "e13b-shell\n",
				exitCode: 0,
				gate: e13bShellGate.promise,
				ignoresAbort: true,
				check: () => e13bAdmitted.release(),
			});
			world.provider.enqueue(
				"root",
				calls("e13b-start-first", [
					{
						id: "e13b-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							writePaths: [E13B_SCOPE],
							instructions: "E13B-WRITER runs its shell command.",
						},
					},
				]),
				{
					name: "e13b-first-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the shell writer did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The shell writer is started." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "e13b-worker-bash",
				reply: {
					content: [
						{ type: "toolCall", id: "e13b-bash-1", name: "bash", arguments: { command: "echo e13b-shell" } },
					],
					stopReason: "toolUse",
				},
			});
			world.systemOne.enterPhase("e13b-first", {
				...e4Judgments,
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
			});
			await withDeadline(trace, "E13B first writer started", e13bSession.prompt("Start the shell writer."));
			await withDeadline(trace, "E13B shell admitted", e13bAdmitted.promise);

			const e13bPre = e13bSession.getResourceSnapshot().workers;
			if (e13bPre === undefined) throw new Error("the E13B owner reports no worker snapshot before teardown");
			const e13bLeases = e13bPre.reservations.heldLeases;
			const e13bHolds = e13bPre.executingHolds;
			const e13bPreClaims = e13bPre.ownedProjectClaims;
			const e13bLaneAborts = e13bPre.laneAbortControllerCount;
			expect(e13bLeases, "the shell writer holds exactly one write lease before teardown").toHaveLength(1);
			expect(e13bPreClaims, "the shell writer owns exactly one project claim before teardown").toHaveLength(1);
			const e13bPreAgent = e13bPreClaims[0]?.agents[0];
			if (e13bPreAgent === undefined) throw new Error("the E13B claim carries no agent");
			const e13bLease = e13bLeases[0];
			if (e13bLease === undefined) throw new Error("the E13B owner has no exact lease");
			expect(e13bLease.attemptId, "the exact lease belongs to the admitted attempt").toBe(e13bPreAgent.attemptId);
			const e13bCompletions = world.isolatedCompletions.slice();
			// The reload observable: the lane registration and the isolated registration are the in-flight units this owner holds.
			const e13bUnitsPre = structuredClone(getInFlightWorkUnits(world.agentDir));
			expect(
				e13bUnitsPre.map((unit) => unit.kind).sort(),
				"the shell writer holds exactly its lane and its isolated completion in flight before teardown",
			).toEqual(["isolated-completion", "lane"]);
			expect(
				e13bUnitsPre.find((unit) => unit.kind === "lane")?.label,
				"the in-flight lane is labelled by its exact worker lane id",
			).toBe(`worker:${e13bLease.taskId}`);
			const e13bBefore = await Promise.all(e13bCompletions.map((completion) => settlementState(completion)));
			expect(
				e13bBefore.filter((state) => state === "pending"),
				"exactly one isolated completion is pending while its shell call is gated",
			).toHaveLength(1);
			const e13bExpectedClaims: WorkerProjectClaims = e13bPreClaims.map((claim) => ({
				...claim,
				agents: [
					{
						agentId: e13bPreAgent.agentId,
						agentStatus: "suspended",
						attemptId: e13bPreAgent.attemptId,
						attemptStatus: "suspended",
						executingHoldCount: e13bPreAgent.executingHoldCount,
						mailboxLoaded: true,
						mailbox: {
							parentSessionId: e13bCreated.sessionManager.getSessionId(),
							agentId: e13bPreAgent.agentId,
							listenerCount: 0,
							hasOpenObligation: false,
							pendingMessageIds: [],
							replyAcknowledgementIds: [],
						},
					},
				],
			}));
			const e13bJoinPrefix = `Worker ${e13bPreAgent.agentId} attempt ${e13bPreAgent.attemptId} physical settlement timed out after 5000ms with `;

			try {
				const e13bTeardown = await withDeadline(
					trace,
					"E13B failed-join teardown",
					world.disposeSessionInBody(e13bSession),
					60_000,
				);
				const e13bFailure = e13bTeardown === undefined ? "no failure" : failureText(e13bTeardown.error);
				expect(e13bFailure, "the failed inner join names the exact attempt and the grace bound").toContain(
					e13bJoinPrefix,
				);
				const e13bDuring = await Promise.all(e13bCompletions.map((completion) => settlementState(completion)));
				expect(
					e13bDuring.filter((state) => state === "pending"),
					"the public isolated completion is still pending after owner cancellation, before the shell gate is released",
				).toHaveLength(1);
				expect(
					getInFlightWorkUnits(world.agentDir),
					"the failed join keeps the exact in-flight units while the public completion is pending",
				).toEqual(e13bUnitsPre);
				const e13bPost = e13bSession.getResourceSnapshot().workers;
				expect(e13bPost?.reservations.heldLeases, "the unresolved lane retains its exact fenced lease").toEqual(
					e13bLeases,
				);
				expect(e13bPost?.executingHolds, "the unresolved lane keeps its execution hold").toEqual(e13bHolds);
				expect(e13bPost?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
					e13bExpectedClaims,
				);
				expect(e13bPost?.laneAbortControllerCount, "the unresolved lane keeps its lane abort controller").toBe(
					e13bLaneAborts,
				);
				expect(e13bPost?.reservations.watchCount, "this writer registered no observer").toBe(0);
				world.certifyDisposedOwner(e13bSession, e13bExpectedClaims, {
					leases: e13bLeases,
					executingHolds: e13bHolds,
					laneAbortControllers: e13bLaneAborts,
				});
			} finally {
				// Released even when the teardown fails: the gated shell call then settles, and the public completion joins.
				e13bShellGate.release();
			}
			await world.provider.waitForProducers();
			// The shell gate released, the public completion settles and its isolated registration leaves; the lane registration stays,
			// because a failed physical join never deregisters its lane and its cached failure is not re-run.
			await Promise.allSettled(e13bCompletions);
			expect(
				getInFlightWorkUnits(world.agentDir),
				"after the public completion settles only the lane registration remains in flight",
			).toEqual(e13bUnitsPre.filter((unit) => unit.kind === "lane"));

			// VU verifier UNKNOWN restart (positive). A read-only subject requires independent verification; its verifier is the automatic verifier of
			// the native profile, never model-manufactured. The verifier's bash check is held at a shell gate after its assistant call is persisted
			// and its attempt lease is running, and the owner is cut there. The captured owned bytes are restored, and a fresh owner recovers the
			// suspended verifier: the unmatched call is repaired once with the native UNKNOWN result, the verifier runs a fresh check and submits its
			// typed verdict, and the native reconciliation publishes it. Plain text is never a verdict.
			const VU_SUBJECT_PROFILE: OrchestrationProfile = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: "vu-subject",
				description: "Read-only subject whose automatic independent verifier checks it.",
				role: "explorer",
				modelPolicy: {
					mode: "fixed",
					candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
				},
				capabilityCeiling: ["filesystem.read"],
				readOnly: true,
				toolNames: ["read"],
				resourceProfileNames: [],
				dispatchProfileIds: [],
				budget: {},
				maxConcurrent: 1,
				leaseTtlMs: 60_000,
				requireIndependentVerification: true,
				verificationProfileId: "vu-verifier",
				createdAt: "2026-10-09T00:00:00.000Z",
				updatedAt: "2026-10-09T00:00:00.000Z",
			};
			const VU_VERIFIER_PROFILE: OrchestrationProfile = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: "vu-verifier",
				description:
					"Independent verifier that checks the subject with a read-only shell command and submits a typed verdict.",
				role: "verifier",
				modelPolicy: {
					mode: "fixed",
					candidates: [{ provider: "harness-script", modelId: "worker-b", thinkingLevel: "off" }],
				},
				capabilityCeiling: ["filesystem.read", "process.exec"],
				readOnly: true,
				toolNames: ["read", "bash"],
				resourceProfileNames: [],
				dispatchProfileIds: [],
				budget: {},
				maxConcurrent: 1,
				leaseTtlMs: 60_000,
				requireIndependentVerification: false,
				createdAt: "2026-10-09T00:00:00.000Z",
				updatedAt: "2026-10-09T00:00:00.000Z",
			};
			const vuProfileStore = new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			});
			vuProfileStore.save(VU_VERIFIER_PROFILE, "global");
			vuProfileStore.save(VU_SUBJECT_PROFILE, "global");

			const vuHeld = createBarrier();
			const vuAdmitted = createBarrier();
			const vuFreshGate = createBarrier();
			const vuFreshAdmitted = createBarrier();
			const vuWake = createBarrier();
			world.shell.enqueue({
				name: "vu-held-check",
				command: "echo vu-check",
				cwd: HARNESS_PROJECT_CWD,
				output: "vu-check\n",
				exitCode: 0,
				gate: vuHeld.promise,
				check: () => vuAdmitted.release(),
			});
			world.shell.enqueue({
				name: "vu-fresh-check",
				command: "echo vu-fresh",
				cwd: HARNESS_PROJECT_CWD,
				output: "vu-fresh\n",
				exitCode: 0,
				gate: vuFreshGate.promise,
				check: () => vuFreshAdmitted.release(),
			});
			const vuOwnerCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const vuOwner = vuOwnerCreated.session;
			world.provider.enqueue(
				"root",
				calls("vu-start", [
					{
						id: "vu-start-1",
						name: "delegate",
						arguments: { action: "start", profileId: "vu-subject", instructions: "VU-SUBJECT reads the record." },
					},
				]),
				{
					name: "vu-start-reply",
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (started?.isError || !started?.text.includes("delegate started (running)")) {
							throw new Error(`the verification subject did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The verification subject is started." }] },
				},
			);
			world.provider.enqueue("worker-a", {
				name: "vu-subject-report",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "vu-report-subject",
							name: "submit_report",
							arguments: { status: "completed", summary: "The verification subject finished." },
						},
					],
					stopReason: "toolUse",
				},
			});
			world.provider.enqueue("worker-b", {
				name: "vu-verifier-check",
				check: (request) => {
					if (!(request.context.tools ?? []).some((tool) => tool.name === "bash")) {
						throw new Error("the automatic verifier is not offered bash");
					}
				},
				reply: {
					content: [{ type: "toolCall", id: "vu-bash-1", name: "bash", arguments: { command: "echo vu-check" } }],
					stopReason: "toolUse",
				},
			});
			world.provider.enqueue("worker-b", {
				name: "vu-verifier-fresh-check",
				check: (request) => {
					const repairs = request.context.messages.filter(
						(message) => message.role === "toolResult" && message.toolCallId === "vu-bash-1",
					).length;
					if (repairs !== 1)
						throw new Error(`the recovered verifier carries ${repairs} native UNKNOWN results, not one`);
				},
				reply: {
					content: [{ type: "toolCall", id: "vu-bash-2", name: "bash", arguments: { command: "echo vu-fresh" } }],
					stopReason: "toolUse",
				},
			});
			world.provider.enqueue("worker-b", {
				name: "vu-verifier-verdict",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "vu-report-verifier",
							name: "submit_report",
							arguments: {
								status: "completed",
								summary: "The subject record matches the check.",
								verdict: "accepted",
								reasonCodes: ["vu_record_matches"],
							},
						},
					],
					stopReason: "toolUse",
				},
			});
			world.provider.enqueue("root", {
				name: "vu-continue",
				reply: { content: [{ type: "text", text: "The recovered verification is still running." }] },
			});
			world.provider.enqueue("root", {
				name: "vu-wake",
				maxRequests: 8,
				until: (request) => {
					const messages = JSON.stringify(request.context.messages);
					const subjectId = agentIdForTrack(request, "worker-a");
					const settled =
						messages.includes(`- ${subjectId}: `) && messages.includes("independent_verification_accepted");
					if (settled) vuWake.release();
					return settled;
				},
				reply: { content: [{ type: "text", text: "Verification is still settling." }] },
			});
			const vuJudgments = {
				...e4Judgments,
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.02 },
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
			} as const;
			world.systemOne.enterPhase("vu-start", vuJudgments);
			await withDeadline(trace, "VU subject started", vuOwner.prompt("Start the verification subject."));
			await withDeadline(trace, "VU verifier held at its shell check", vuAdmitted.promise, 90_000);

			// The pre-cut identity: exactly one running verifier attempt with its lease, its agent, and the subject it verifies.
			const vuPre = vuOwner.backgroundLanes.getTaskRuntimeSnapshot();
			if (vuPre === undefined) throw new Error("the VU owner reports no task runtime before the cut");
			const vuRunning = Object.values(vuPre.attempts).filter((attempt) => attempt.status === "running");
			expect(vuRunning, "exactly one verifier attempt is running at its held check").toHaveLength(1);
			const vuAttempt = vuRunning[0];
			if (vuAttempt === undefined || vuAttempt.agentId === undefined || vuAttempt.lease === undefined) {
				throw new Error("the held verifier attempt has no agent or no execution lease");
			}
			const vuVerifierTaskId = vuAttempt.taskId;
			const vuAgentId = vuAttempt.agentId;
			const vuSubjectTaskIds = Object.keys(vuPre.tasks).filter((taskId) => taskId !== vuVerifierTaskId);
			expect(vuSubjectTaskIds, "the verified subject is the only other task").toHaveLength(1);
			const vuSubjectTaskId = vuSubjectTaskIds[0] ?? "";
			const vuSubjectAgentId = Object.values(vuPre.attempts).find(
				(attempt) => attempt.taskId === vuSubjectTaskId,
			)?.agentId;
			if (vuSubjectAgentId === undefined) throw new Error("the subject carries no agent");
			expect(vuPre.tasks[vuSubjectTaskId]?.task.status, "the subject waits for its verifier").toBe("blocked");
			expect(
				vuPre.tasks[vuSubjectTaskId]?.verification,
				"the subject has no verdict before its verifier settles",
			).toBe(undefined);
			const vuPreWorkers = vuOwner.getResourceSnapshot().workers;
			expect(vuPreWorkers?.ownedProjectClaims, "the automatic verifier holds no project claim").toEqual([]);
			expect(vuPreWorkers?.executingHolds, "the running verifier holds exactly its own execution").toEqual([
				{ agentId: vuAgentId, count: 1 },
			]);
			const vuVerifierAgent = vuPre.agents[vuAgentId];
			if (vuVerifierAgent === undefined) throw new Error("the verifier has no binding");
			expect(
				new WorkerConversationStore().getProjectContextBinding({
					agentDir: world.agentDir,
					resumeContext: vuVerifierAgent.resumeContext,
					expectedLogicalAgentId: vuAgentId,
				}),
				"the automatic verifier never allocated project context",
			).toBeUndefined();
			const vuOpen = (session: AgentSession, agentId: string) => {
				const agent = session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[agentId];
				if (agent === undefined) throw new Error(`no binding for ${agentId}`);
				return new WorkerConversationStore().open({
					agentDir: world.agentDir,
					resumeContext: agent.resumeContext,
					expectedLogicalAgentId: agentId,
				});
			};
			const vuPersisted = vuOpen(vuOwner, vuAgentId).getRawTranscript().at(-1);
			expect(
				vuPersisted?.role === "assistant" &&
					vuPersisted.content.some((content) => content.type === "toolCall" && content.id === "vu-bash-1"),
				"the verifier's assistant call is persisted before its shell check",
			).toBe(true);
			const vuPreGrant = vuAttempt.grant;
			const vuPreDispatch = vuAttempt.dispatch;
			const vuPreFence = vuAttempt.lease.fencingToken;

			// The owned files at the held point: the aux session file, the parent's control-plane bundle without leases or SQLite, and the
			// verifier and subject session files with their sidecars. The cap is explicit; a breach fails.
			const VU_MAX_FILES = 512;
			const VU_MAX_BYTES = 8 * 1024 * 1024;
			const vuAuxFile = vuOwnerCreated.sessionManager.getSessionFile();
			if (vuAuxFile === undefined) throw new Error("the VU owner has no session file");
			const vuManifest = (): Map<string, string> => {
				const entries = world.io.fileEntries();
				const selected = new Map<string, string>();
				const take = (path: string | undefined): void => {
					if (path === undefined) return;
					const content = entries.get(path);
					if (content !== undefined) selected.set(path, content);
				};
				take(vuAuxFile);
				for (const [path, content] of bundleEntries(
					entries,
					orchestrationSessionDir(world.agentDir, vuOwnerCreated.sessionManager.getSessionId()),
				)) {
					selected.set(path, content);
				}
				for (const agentId of [vuAgentId, vuSubjectAgentId]) {
					const sessionFile = vuPre.agents[agentId]?.resumeContext.sessionFile;
					if (sessionFile === undefined) throw new Error(`no session file for ${agentId}`);
					take(sessionFile);
					take(`${sessionFile}.worker.json`);
				}
				const bytes = [...selected.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
				if (selected.size > VU_MAX_FILES || bytes > VU_MAX_BYTES) {
					throw new Error(`the VU manifest exceeds its caps: ${selected.size} files, ${bytes} bytes`);
				}
				return selected;
			};
			const vuCapture = vuManifest();

			// The old owner ends: its shell check is cancelled by the abort, the transport producers join, and the disposed owner certifies
			// before any byte is restored.
			expect(
				await world.disposeSessionInBody(vuOwner),
				"the VU owner disposes cleanly after the cut point",
			).toBeUndefined();
			await world.provider.waitForProducers();
			expect(world.provider.failures, "no transport callback failed during the old owner's life").toEqual([]);
			world.certifyDisposedOwner(vuOwner, []);
			for (const [path] of vuManifest()) {
				if (!vuCapture.has(path)) world.io.unlinkSync(path);
			}
			for (const [path, content] of vuCapture) {
				world.io.mkdirSync(resolve(path, ".."), { recursive: true });
				world.io.writeFileSync(path, content);
			}
			expect(vuManifest(), "the cut restores exactly the captured owned files").toEqual(vuCapture);
			world.processTable.advanceProcess();

			// A fresh owner recovers twice through the native entrance, and the suspended verifier resumes on its own.
			const vuFresh = await world.createRootSession("root", { sessionManager: world.openSessionManager(vuAuxFile) });
			vuFresh.session.getLaneRecords();
			vuFresh.session.getLaneRecords();
			world.systemOne.enterPhase("vu-continue", vuJudgments);
			await withDeadline(trace, "VU recovered root turn", vuFresh.session.prompt("Continue after the restart."));
			await withDeadline(trace, "VU verifier resumed to its fresh check", vuFreshAdmitted.promise, 90_000);
			const vuResumed = vuFresh.session.backgroundLanes.getTaskRuntimeSnapshot();
			const vuResumedAttempt = vuResumed?.attempts[vuAttempt.attemptId];
			expect(vuResumedAttempt?.status, "the same verifier attempt is running again").toBe("running");
			expect(vuResumedAttempt?.taskId, "the resumed attempt belongs to the same verifier task").toBe(
				vuVerifierTaskId,
			);
			expect(vuResumedAttempt?.grant, "the resumed attempt keeps its original grant").toEqual(vuPreGrant);
			expect(vuResumedAttempt?.dispatch, "the resumed attempt keeps its compiled dispatch").toEqual(vuPreDispatch);
			expect(
				(vuResumedAttempt?.lease?.fencingToken ?? 0) > vuPreFence,
				"the resumed attempt's execution lease fence advanced",
			).toBe(true);
			const vuRepairs = vuOpen(vuFresh.session, vuAgentId)
				.getRawTranscript()
				.filter((message) => message.role === "toolResult" && message.toolCallId === "vu-bash-1");
			expect(vuRepairs, "the unmatched call is repaired exactly once").toHaveLength(1);
			expect(vuRepairs[0]?.role === "toolResult" && vuRepairs[0].isError, "the repair is an error outcome").toBe(
				true,
			);
			expect(JSON.stringify(vuRepairs[0]?.content), "the repair is the native UNKNOWN outcome").toContain(
				"Execution outcome is unknown",
			);
			expect(
				vuResumed?.tasks[vuSubjectTaskId]?.task.status,
				"the subject stays pending until its verifier settles",
			).toBe("blocked");
			expect(
				new WorkerConversationStore().getProjectContextBinding({
					agentDir: world.agentDir,
					resumeContext: vuResumed?.agents[vuAgentId]?.resumeContext ?? vuVerifierAgent.resumeContext,
					expectedLogicalAgentId: vuAgentId,
				}),
				"the recovered verifier still never allocated project context",
			).toBeUndefined();
			vuFreshGate.release();
			await withDeadline(trace, "VU verdict published", vuWake.promise);

			// The native verdict: the subject completes on the accepted verdict of its real verifier, under the same verifier identity.
			const vuDone = vuFresh.session.backgroundLanes.getTaskRuntimeSnapshot();
			const vuSubject = vuDone?.tasks[vuSubjectTaskId];
			expect(vuSubject?.task.status, "the verified subject completes on its accepted verdict").toBe("completed");
			expect(vuSubject?.verification?.verdict, "the real verifier's typed verdict is accepted").toBe("accepted");
			expect(vuSubject?.verification?.reasonCode, "the accepted verdict names the independent verification").toBe(
				"independent_verification_accepted",
			);
			expect(vuSubject?.verification?.verifierTaskId, "the verdict names the same verifier task").toBe(
				vuVerifierTaskId,
			);
			expect(vuSubject?.verification?.verifierAttemptId, "the verdict names the same verifier attempt").toBe(
				vuAttempt.attemptId,
			);
			const vuFinal = vuDone?.attempts[vuAttempt.attemptId];
			expect(vuFinal?.grant, "the verifier keeps its original grant to the end").toEqual(vuPreGrant);

			// Repeated settled recovery: the entrance again repeats nothing: no provider request, no repair, no output.
			const vuProvidersBefore = world.provider.reached.filter((name) => name.startsWith("worker-b:")).length;
			vuFresh.session.getLaneRecords();
			vuFresh.session.getLaneRecords();
			expect(
				world.provider.reached.filter((name) => name.startsWith("worker-b:")).length,
				"the settled recovery makes no new verifier provider request",
			).toBe(vuProvidersBefore);
			expect(
				vuOpen(vuFresh.session, vuAgentId)
					.getRawTranscript()
					.filter((message) => message.role === "toolResult" && message.toolCallId === "vu-bash-1"),
				"the settled recovery repeats no repair",
			).toHaveLength(1);
			expect(
				await world.disposeSessionInBody(vuFresh.session),
				"the recovered VU owner disposes cleanly",
			).toBeUndefined();
			// Windows shell contract (Node contract, not a Windows host): the platform bash definition for win32, with its own session key, runs through the
			// released Windows engine adapter. The process platform stays POSIX; this proves the native Windows wiring, not Python, Windows or CI.
			const winOwnedKey = "j1-windows-contract";
			const winTool = createBashToolDefinition(HARNESS_PROJECT_CWD, { platform: "win32", sessionKey: winOwnedKey });
			const winCommand = "Write-Output 'win-contract'";
			const winMissing = "Get-Item 'win-missing.txt'";
			// A real directory of the seeded project. The persistent cd changes the native cwd; the commands after it must run from that changed cwd.
			const winDir = `${HARNESS_PROJECT_CWD}/src/features/retry/configuration`;
			const winChange = 'cd "src/features/retry/configuration"';
			const winAfter = "Get-Item 'limits.ts'";
			const winPlan = [winCommand, winChange, winAfter, winMissing];
			world.shell.enqueue({
				name: "win-contract-echo",
				command: winCommand,
				cwd: HARNESS_PROJECT_CWD,
				output: "win-contract\n",
				exitCode: 0,
			});
			world.shell.enqueue({
				name: "win-contract-change",
				command: winChange,
				cwd: HARNESS_PROJECT_CWD,
				output: "",
				exitCode: 0,
				resultCwd: winDir,
			});
			world.shell.enqueue({
				name: "win-contract-after",
				command: winAfter,
				cwd: winDir,
				output: "limits.ts\n",
				exitCode: 0,
			});
			world.shell.enqueue({
				name: "win-contract-missing",
				command: winMissing,
				cwd: winDir,
				output: "Get-Item: win-missing.txt not found\n",
				exitCode: 1,
			});
			const winCreated = await world.createRootSession("root", {
				sessionManager: world.createSessionManager(),
				customTools: [winTool],
				omitShellOperations: true,
			});
			const winSession = winCreated.session;
			world.provider.enqueue(
				"root",
				calls("win-start", [{ id: "win-call-1", name: winTool.name, arguments: { command: winCommand } }]),
				{
					name: "win-reply",
					check: (request) => {
						const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
						if (result?.isError || !result?.text.includes("win-contract")) {
							throw new Error(
								`the Windows contract result is not the scripted output: ${result?.text ?? "no result"}`,
							);
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "win-call-2", name: winTool.name, arguments: { command: winChange } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "win-reply-changed",
					check: (request) => {
						const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
						if (result?.isError) throw new Error(`the persistent cd failed: ${result.text}`);
					},
					reply: {
						content: [
							{ type: "toolCall", id: "win-call-3", name: winTool.name, arguments: { command: winAfter } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "win-reply-after",
					check: (request) => {
						const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
						if (result?.isError || !result?.text.includes("limits.ts")) {
							throw new Error(
								`the command after cd did not run in the changed directory: ${result?.text ?? "no result"}`,
							);
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "win-call-4", name: winTool.name, arguments: { command: winMissing } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "win-reply-missing",
					check: (request) => {
						const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
						if (result?.isError !== true || !result?.text.includes("not found")) {
							throw new Error(
								`the normal failure is not reported as the native error result: ${result?.text ?? "no result"}`,
							);
						}
					},
					reply: { content: [{ type: "text", text: "The Windows contract command ran." }] },
				},
			);
			world.systemOne.enterPhase("win-contract", {
				...e4Judgments,
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
			});
			const winErrors: unknown[] = [];
			try {
				// The offered tool is the bash definition whose backend is the platform shell (PowerShell for win32); the catalog is traced before any authored call.
				expect(winTool.name, "the win32 definition is offered under the bash tool name").toBe("bash");
				expect(winSession.getActiveToolNames(), "the session offers the win32 platform shell").toContain(
					winTool.name,
				);
				await withDeadline(trace, "Windows contract turn", winSession.prompt("Run the Windows contract command."));
				await withDeadline(trace, "Windows contract settled", winSession.waitForForegroundIdle());
				expect(
					world.shell.requests.filter((request) => request.command === winCommand).length,
					"the Windows contract command reaches the shared shell exactly once",
				).toBe(1);
				// Native requests and frames: the cd's reported cwd is the state the next request carries; the nonzero exit stays a native frame.
				const winRequests = world.windowsShell.requests.filter((record) => winPlan.includes(record.command));
				expect(
					winRequests.map((record) => ({
						command: record.command,
						cwd: record.cwd,
						outcome: record.outcome,
						exitCode: record.exitCode,
						reportedCwd: record.reportedCwd,
						powershell: record.powershell,
					})),
					`the adapter's requests and native frames follow the declared cd state; observed ${JSON.stringify(
						winRequests.map(({ requestId, command, cwd, outcome, exitCode, reportedCwd }) => ({
							requestId,
							command,
							cwd,
							outcome,
							exitCode,
							reportedCwd,
						})),
					)}`,
				).toEqual([
					{
						command: winCommand,
						cwd: HARNESS_PROJECT_CWD,
						outcome: "completed",
						exitCode: 0,
						reportedCwd: HARNESS_PROJECT_CWD,
						powershell: false,
					},
					{
						command: winChange,
						cwd: HARNESS_PROJECT_CWD,
						outcome: "completed",
						exitCode: 0,
						reportedCwd: winDir,
						powershell: false,
					},
					{
						command: winAfter,
						cwd: winDir,
						outcome: "completed",
						exitCode: 0,
						reportedCwd: winDir,
						powershell: false,
					},
					{
						command: winMissing,
						cwd: winDir,
						outcome: "completed",
						exitCode: 1,
						reportedCwd: winDir,
						powershell: false,
					},
				]);
				expect(
					new Set(winRequests.map((record) => record.requestId)).size,
					"every command carries its own request nonce",
				).toBe(winPlan.length);
			} catch (error) {
				winErrors.push(error);
			} finally {
				// Session abort, join and disposal first, then the shell session this owner's key names, while the effect guard stays installed.
				const winDisposal = await world.disposeSessionInBody(winSession);
				if (winDisposal !== undefined) winErrors.push(winDisposal.error);
				try {
					await disposeShellExecutionSessionAndWait(winOwnedKey);
				} catch (error) {
					winErrors.push(error);
				}
			}
			if (winErrors.length === 1) throw winErrors[0];
			if (winErrors.length > 1)
				throw new AggregateError(winErrors, "the Windows contract phase failed and its cleanup failed");
			trace.mark("root", "windows.contract");

			// Whole-journey count of the E2 uncertain-relation warning: one on the relation's own turn, none off. The global allowance only
			// admits the text; this exact count keeps any extra occurrence fatal.
			expect(
				world.warnings.filter(
					(message) =>
						message ===
						"Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain.",
				).length,
				"the uncertain relation warns exactly once on and never off across the whole journey",
			).toBe(world.systemOne.enabled ? 1 : 0);
			// The intentional evaluator outage (the long-path turn) emits exactly one warning on; off runs no System One and emits none.
			expect(
				world.warnings.filter((message) => message.includes("Jev System One unavailable")).length,
				"the intentional evaluator outage warns exactly as its scripted turn requires",
			).toBe(world.systemOne.enabled ? 1 : 0);
			// Default owner window, not shortened: a question nobody answers stays open for the native default window, then resolves to the
			// unanswered result. The presenter's gate is never released, so only the native deadline's abort can settle the presentation.
			const DEADLINE_CALL_ID = "deadline-ask-1";
			const deadlinePresented = createBarrier();
			const deadlineNeverAnswered = createBarrier();
			let deadlineRequestId: string | undefined;
			const deadlineAsk = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			await deadlineAsk.session.bindExtensions({ uiContext: world.humanInput.ui });
			world.provider.enqueue(
				"root",
				calls("deadline-ask", [
					{
						id: DEADLINE_CALL_ID,
						name: "ask_question",
						arguments: {
							questions: [
								{
									id: "deadline",
									header: "Deadline",
									question: "Which limit applies once the owner window closes?",
									options: [
										{ label: "Staging", description: "Use the staging limit." },
										{ label: "Production", description: "Use the production limit." },
									],
								},
							],
						},
					},
				]),
				{
					name: "deadline-unanswered-reported",
					check: (request) => {
						const unanswered = request.context.messages.some(
							(message) =>
								message.role === "toolResult" &&
								message.toolCallId === DEADLINE_CALL_ID &&
								message.content.some(
									(block) => block.type === "text" && block.text.includes("Owner did not answer"),
								),
						);
						if (!unanswered)
							throw new Error("the expired question's unanswered result is not in the provider context");
					},
					reply: { content: [{ type: "text", text: "No owner decision was granted." }] },
				},
			);
			world.humanInput.enqueue({
				name: "deadline-presented",
				gate: deadlineNeverAnswered.promise,
				check: (request) => {
					deadlineRequestId = request.requestId;
					deadlinePresented.release();
				},
				reply: { answers: [], cancelled: true, reason: "interrupted", imageContents: [] },
			});
			const deadlineStarted = Date.now();
			const deadlineTurn = deadlineAsk.session.prompt("Ask which limit applies once the owner window closes.");
			await withDeadline(trace, "deadline question presented", deadlinePresented.promise);
			await withDeadline(
				trace,
				"default owner window elapsed",
				deadlineTurn,
				DEFAULT_OWNER_WAIT_TIMEOUT_MS + 60_000,
			);
			expect(
				Date.now() - deadlineStarted,
				"the owner window elapsed in full: the presented question waited the native default before it settled",
			).toBeGreaterThanOrEqual(DEFAULT_OWNER_WAIT_TIMEOUT_MS - 1_000);
			await withDeadline(trace, "deadline presentation settled", world.humanInput.join());
			expect(
				getLatestHumanInputSnapshots(deadlineAsk.sessionManager).find(
					(snapshot) => snapshot.request.requestId === deadlineRequestId,
				)?.status,
				"the expired question's durable snapshot stays pending: no answer, cancellation or decision was recorded",
			).toBe("pending");
			expect(
				await world.disposeSessionInBody(deadlineAsk.session),
				"the deadline owner disposes cleanly",
			).toBeUndefined();
			trace.mark("root", "deadline.window");
		},
	);
}, 900_000);

/** Text of every `delegate` tool result the session recorded, in order (structured, not line-prefix matched). */
function delegateResultTexts(session: AgentSession): string[] {
	return session.messages.flatMap((message) => {
		if (message.role !== "toolResult" || message.toolName !== "delegate") return [];
		return [message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n")];
	});
}

/** The stable agent id production assigned to the worker that runs on `track` (its effective model). */
function agentIdForTrack(request: ScriptedRequest, track: string): string {
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
function rawReplyAcknowledgements(mailbox: unknown): unknown[] {
	if (typeof mailbox !== "object" || mailbox === null || !("replyAcknowledgements" in mailbox)) {
		throw new Error("the raw source mailbox carries no reply acknowledgements");
	}
	const list: unknown = mailbox.replyAcknowledgements;
	if (!Array.isArray(list)) throw new Error("the raw source reply acknowledgements are not a list");
	const values: unknown[] = list;
	return values;
}

/** The raw source mailbox's receipt for one request message, narrowed from the unknown record (no cast, no any). */
function rawReplyReceiptOf(mailbox: unknown, requestMessageId: string): unknown {
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
function latestAgentIdForTrack(request: ScriptedRequest, track: string): string {
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

it("orchestration: goal, three delegated agents, blocked report, follow-up reply, goal completion", async () => {
	await runJourney(
		{
			name: "journey-2",
			// The planned two large reports and their chunked artifact read need more than the default 32k root window. The window is
			// set once for the provider and the registry, so manual compaction and its keep budget still see one model.
			modelOptions: { root: { contextWindow: 131_072 } },
			// Exact expected refusal of the E7 negative control: the busy, dead-owner A is never resumed, and nothing else is allowed.
			warningAllowances: [
				/^Worker conversation setup failed: Worker queued context has no proof of never-started, dead-owner recovery\.$/,
			],
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n" },
			// A clean checkout on main: a fresh writer worker gets its own worktree lane (dirty checkouts fall back to shared).
			repository: { committed: { "src/limits.ts": "export const MAX_RETRIES = 3;\n" } },
			// Deliberate control, not a budget fix: a 1k recent-keep moves the kept tail past the failed run, so the open
			// obligation must outlive the receipt that created it. The checkpoint asserts the receipt is absent from the provider
			// context while the obligation's trusted identity stays in the compaction details.
			settings: {
				defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"],
				edge: { allow: [] },
				compaction: { keepRecentTokens: 1_000 },
			},
		},
		async (world) => {
			const trace = world.trace;
			const allReported = createBarrier();
			const workersMayRead = createBarrier();
			let blockedAgentId: string | undefined;
			let mainBeforeApproval: string | undefined;
			const scratchDir = `${HARNESS_PROJECT_CWD}/scratch`;
			const scratchGit = `${scratchDir}/.git`;
			let orchestrationRoot: AgentSession | undefined;
			// The same captured reference, in a second world: its own file resolves, and the first world's file does not.
			await expect(CAPTURED_ACCESS(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
			await expect(CAPTURED_ACCESS(`${HARNESS_PROJECT_CWD}/src/copy-source.ts`, constants.R_OK)).rejects.toThrow(
				"virtual filesystem",
			);

			world.provider.enqueue(
				"root",
				calls("goal-start", [
					{
						id: "goal-1",
						name: "goal",
						arguments: { action: "start", goalId: "limits-goal", userGoal: "Set MAX_RETRIES to 5." },
					},
				]),
				calls("goal-requirement", [
					{ id: "goal-2", name: "goal", arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" } },
				]),
				calls("dispatch-three", [
					{
						id: "dispatch-a",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							instructions: "Inspect the limits file and report whether the retry count is confirmed.",
						},
					},
					{
						id: "dispatch-b",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-b" },
							instructions: "Inspect the limits file and report the current value.",
						},
					},
					{
						id: "dispatch-c",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Inspect the limits file and report the current value.",
						},
					},
				]),
				calls("status-overlap", [
					{ id: "status-overlap-1", name: "worktree_sync", arguments: { action: "status" } },
				]),
				{
					name: "overlap-checked",
					check: (request) => {
						const root = orchestrationRoot;
						if (root === undefined) throw new Error("the root session is not created yet");
						const lanes = lanesOf(lastToolResultDetails(root, "worktree_sync"));
						const bound = lanes.flatMap((lane) => (lane.boundLaneId === undefined ? [] : [lane.boundLaneId]));
						const agents = ["worker-a", "worker-b", "worker-c"].map((track) => agentIdForTrack(request, track));
						if (bound.length !== agents.length || !agents.every((id) => bound.includes(id))) {
							throw new Error(`worker lanes are not bound to their agents: ${JSON.stringify(lanes)}`);
						}
						const paths = lanes.map((lane) => lane.worktreePath);
						if (new Set(paths).size !== paths.length)
							throw new Error(`lane checkouts collide: ${paths.join(", ")}`);
						// Approval while the workers are active: a harmless scratch .git is removed only after the operator approves it.
						mainBeforeApproval = world.git.refSha("refs/heads/main");
						world.io.mkdirSync(scratchDir, { recursive: true });
						world.io.writeFileSync(scratchGit, "gitdir: nowhere\n");
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "bash-denied-1",
								name: "bash",
								arguments: { command: "rm -rf scratch/.git" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approval-denied-reported",
					check: (request) => {
						const denied = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (!denied?.isError || !denied.text.includes("declined")) {
							throw new Error(
								`the denied removal was not refused by the operator: ${denied?.text ?? "no result"}`,
							);
						}
						if (world.shell.requests.length !== 0 || !world.io.existsSync(scratchGit)) {
							throw new Error("a denied removal reached the shell or removed the scratch .git");
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "read-between-approval", name: "read", arguments: { path: LIMITS_PATH } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approval-read-between",
					check: (request) => assertBatchOk(request, "approval-denied-reported"),
					reply: {
						content: [
							{
								type: "toolCall",
								id: "bash-approved-1",
								name: "bash",
								arguments: { command: "rm -rf scratch/.git" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approval-approved-reported",
					check: (request) => {
						assertBatchOk(request, "approval-read-between");
						if (world.shell.requests.length !== 1 || world.io.existsSync(scratchGit)) {
							throw new Error("the approved removal did not run exactly once");
						}
						if (
							world.git.refSha("refs/heads/main") !== mainBeforeApproval ||
							!world.io.existsSync(`${HARNESS_PROJECT_CWD}/.git`)
						) {
							throw new Error("the approval touched the main repository");
						}
						workersMayRead.release();
					},
					reply: { content: [{ type: "text", text: "Dispatched three agents; waiting for their reports." }] },
				},
				{
					name: "follow-up-blocked-agent",
					reply: (request) => {
						const blockedAgent = agentIdForTrack(request, "worker-a");
						blockedAgentId = blockedAgent;
						return {
							content: [
								{
									type: "toolCall",
									id: "follow-a",
									name: "delegate",
									arguments: {
										action: "follow_up",
										agentId: blockedAgent,
										message: "The confirmed retry count is 5.",
									},
								},
							],
							stopReason: "toolUse",
						};
					},
				},
				text("root-after-follow-up", "Reply sent to the blocked agent."),
				// Terminal handoffs may coalesce into fewer root turns, so the step stays at the head until the
				// production context carries every worker's successful terminal handoff.
				{
					name: "reports-received",
					until: (request) => {
						const handoffs = request.context.messages
							.flatMap((message) =>
								message.role === "user" && typeof message.content !== "string" ? message.content : [],
							)
							.map((block) => (block.type === "text" ? block.text : ""))
							.filter((text) => text.includes("Background worker terminal handoff"))
							.join("\n");
						const done = [
							/- mailbox-turn-[0-9a-f]+: succeeded reason=worker_completed[\s\S]*?Retry count confirmed as 5\./,
							/- worker-2: succeeded/,
							/- worker-3: succeeded/,
						].every((pattern) => pattern.test(handoffs));
						if (done) allReported.release();
						return done;
					},
					reply: (request) => {
						const handoffs = JSON.stringify(request.context.messages);
						const done = /- worker-3: succeeded/.test(handoffs);
						return {
							content: [
								{
									type: "text",
									text: done ? "All three agents reported." : "Waiting for the remaining reports.",
								},
							],
						};
					},
				},
			);
			world.provider.enqueue(
				"worker-a",
				{
					name: "worker-a-read",
					gate: workersMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "wa-read", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("worker-a-blocked", [
					{
						id: "wa-report-blocked",
						name: "submit_report",
						arguments: {
							status: "blocked",
							summary: "Need the owner to confirm the retry count.",
							blockers: ["Owner must confirm the retry count."],
						},
					},
				]),
				calls("worker-a-resumed", [
					{
						id: "wa-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "Retry count confirmed as 5." },
					},
				]),
			);
			world.provider.enqueue(
				"worker-b",
				{
					name: "worker-b-read",
					gate: workersMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "wb-read", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("worker-b-report", [
					{
						id: "wb-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "Current value is 3." },
					},
				]),
			);
			world.provider.enqueue(
				"worker-c",
				{
					name: "worker-c-read",
					gate: workersMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "wc-read", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("worker-c-report", [
					{
						id: "wc-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "Current value is 3." },
					},
				]),
			);

			// File-backed root: the checkpoint below reopens it from its session file, as its owner would after a restart.
			let created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			let session = created.session;
			orchestrationRoot = session;
			const warnings: string[] = [];
			session.subscribe((event) => {
				if (event.type === "warning") warnings.push(event.message);
			});
			trace.mark("root", "session.created");

			// The goal turn: the owner's request is not small talk and names no tool or delivery rule; before any
			// worker reports, no action has accomplished the step, so postflight holds the plan on `continue`.
			// Owner-word oracle for each phase: the owner words System One classifies must be this phase's own inputs, and the
			// previous intent must be the native ledger's. The expected values come from scenario literals and the session's entries.
			const ownerWords = (...userRequests: string[]) =>
				expectOwnerWords({
					sessionManager: () => created.sessionManager,
					userRequests,
					optionalToolNames: ["secret_store"],
				});
			world.systemOne.enterPhase(
				"orchestration-goal",
				{
					capabilities_authorized: { kind: "noul", probability: 0.02 },
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				},
				{
					expect: ownerWords(
						"Goal: set MAX_RETRIES to 5 in the limits file. Dispatch agents to confirm it and report back.",
					),
				},
			);
			trace.mark("root", "owner.task");
			// The operator answers the destructive-removal confirmation: deny the first attempt, approve the revised one.
			const decisions: Array<"deny" | "allow-once"> = ["deny", "allow-once"];
			const askedOperations: string[] = [];
			const confirmations = world.externalConfirmations;
			session.setEdgeConfirmation(async (request) => {
				askedOperations.push(request.operation);
				confirmations.asked += 1;
				confirmations.inFlight += 1;
				try {
					// The operator's answer settles after a turn of the event loop: the callback is genuinely in flight meanwhile.
					await new Promise((resolve) => setImmediate(resolve));
					return decisions.shift() ?? "deny";
				} finally {
					confirmations.inFlight -= 1;
					confirmations.settled += 1;
				}
			});
			world.shell.enqueue({
				name: "approved-scratch-removal",
				command: "rm -rf scratch/.git",
				cwd: HARNESS_PROJECT_CWD,
				output: "",
				exitCode: 0,
				effect: () => {
					world.io.rmSync(scratchGit, { force: true });
				},
			});
			await withDeadline(
				trace,
				"orchestration task turn",
				session.prompt(
					"Goal: set MAX_RETRIES to 5 in the limits file. Dispatch agents to confirm it and report back.",
				),
			);
			trace.mark("root", "owner.task.settled");
			session.setEdgeConfirmation(undefined);
			expect(
				{ ...confirmations, decisionsLeft: decisions.length },
				"every asked confirmation settled, none in flight, no decision left over",
			).toEqual({ asked: askedOperations.length, inFlight: 0, settled: askedOperations.length, decisionsLeft: 0 });
			expect(askedOperations, "the operator is asked once per attempt").toHaveLength(2);
			expect(askedOperations.every((operation) => operation.includes("rm -rf scratch/.git"))).toBe(true);
			// Delegation admission is observable as soon as the dispatch turn settles: every start must be admitted.
			const admissions = delegateResultTexts(session);
			expect(
				admissions.map((text) => text.includes("delegate started (running)")),
				`delegate admission outcomes\n${toolOutcomes(session)}\nwarnings: ${warnings.join(" | ")}`,
			).toEqual([true, true, true]);

			await withDeadline(trace, "all agent reports delivered", allReported.promise, 30_000).catch(
				(error: unknown) => {
					throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
				},
			);
			trace.mark("root", "all-reports-received");
			// Durable receipt, read from the persisted mailbox file rather than from scripted claims: the follow-up the operator sent
			// to the blocked agent is delivered, and its control receipt is recorded in that agent's mailbox on disk.
			if (blockedAgentId === undefined) throw new Error("the blocked agent's follow-up was never sent");
			const mailboxFile = workerMailboxPath(world.agentDir, created.sessionManager.getSessionId(), blockedAgentId);
			expect(world.io.existsSync(mailboxFile), "the worker mailbox is written to the virtual tree").toBe(true);
			const { mailbox } = readWorkerMailboxRecord(mailboxFile);
			const followUp = mailboxMessagesOf(mailbox).find(
				(message) => message.content === "The confirmed retry count is 5.",
			);
			expect(followUp?.deliveredAt, "the follow-up is delivered in the persisted mailbox").toEqual(
				expect.any(String),
			);
			expect(
				receiptsOf(mailbox).filter(
					(receipt) => receipt.messageId === followUp?.messageId && receipt.kind === "control",
				),
				"the follow-up has exactly one durable control receipt",
			).toHaveLength(1);
			// The reports release the barrier while the root turn that answers them is still finishing; the operator waits for idle.
			await withDeadline(trace, "root idle after the reports", session.waitForForegroundIdle());

			// Steering phase. The fourth agent is held at its provider gate until the interrupt is in place, so the halt is taken
			// at its next request boundary. Its handoff reports `worker_interrupted`; retirement keeps the binding and transcript.
			const fourthReached = createBarrier();
			const fourthGate = createBarrier();
			const handedOff = createBarrier();
			const retired = createBarrier();
			world.provider.enqueue(
				"worker-c",
				{
					name: "fourth-read",
					check: () => fourthReached.release(),
					gate: fourthGate.promise,
					reply: {
						content: [{ type: "toolCall", id: "fourth-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				text("fourth-halted", "Halted before a value was confirmed."),
			);
			world.provider.enqueue(
				"root",
				calls("start-fourth", [
					{
						id: "start-4",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Read the limits file and report the value.",
						},
					},
				]),
				text("fourth-started", "Fourth agent started and running."),
				dynamicCalls(
					"interrupt-fourth",
					(request) => [
						{
							id: "interrupt-4",
							name: "delegate",
							arguments: {
								action: "interrupt",
								agentId: latestAgentIdForTrack(request, "worker-c"),
								message: "The operator halts the fourth agent.",
							},
						},
					],
					(request) => assertBatchOk(request, "start-fourth"),
				),
				{
					name: "interrupt-sent",
					check: (request) => {
						assertBatchOk(request, "interrupt-fourth");
						const sent = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (!sent?.text.includes("halt requested"))
							throw new Error(`the interrupt was not accepted: ${sent?.text ?? "no result"}`);
						fourthGate.release();
					},
					reply: { content: [{ type: "text", text: "Interrupt sent." }] },
				},
				dynamicCalls(
					"retire-fourth",
					(request) => [
						{
							id: "retire-4",
							name: "delegate",
							arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-c") },
						},
					],
					(request) => {
						if (!JSON.stringify(request.context.messages).includes("worker_interrupted")) {
							throw new Error("the halted agent's handoff does not report worker_interrupted");
						}
						handedOff.release();
					},
				),
				{
					name: "retired",
					check: (request) => {
						assertBatchOk(request, "retire-fourth");
						const gone = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (!gone?.text.includes("retired"))
							throw new Error(`the retirement was not recorded: ${gone?.text ?? "no result"}`);
						retired.release();
					},
					reply: { content: [{ type: "text", text: "Fourth agent retired." }] },
				},
			);
			world.systemOne.enterPhase(
				"steer-start",
				{
					capabilities_authorized: { kind: "noul", probability: 0.02 },
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				},
				{ expect: ownerWords("Start a fourth agent on the third track.") },
			);
			await withDeadline(trace, "fourth agent started", session.prompt("Start a fourth agent on the third track."));
			await withDeadline(trace, "fourth agent reached its gate", fourthReached.promise);
			world.systemOne.enterPhase(
				"steer-interrupt",
				{
					capabilities_authorized: { kind: "noul", probability: 0.02 },
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				},
				{ expect: ownerWords("Interrupt the fourth agent.") },
			);
			await withDeadline(
				trace,
				"operator interrupts the fourth agent",
				session.prompt("Interrupt the fourth agent."),
			);
			await withDeadline(trace, "interrupted agent handed off", handedOff.promise, 60_000);
			await withDeadline(trace, "interrupted agent retired", retired.promise, 60_000);

			await withDeadline(trace, "interrupt turn settled", session.waitForForegroundIdle(), 90_000);
			world.systemOne.enterPhase("objective-cycle", {
				objective_coherent: { kind: "noul", probability: 0.97 },
				ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
				missing_information: { kind: "noul", probability: 0.02 },
				acceptance_complete: { kind: "noul", probability: 0.97 },
				grounding_sufficient: { kind: "noul", probability: 0.97 },
				work_remaining: { kind: "noul", probability: 0.97 },
				missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
				evidence_sufficient: { kind: "noul", probability: 0.02 },
				semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
				strategy_repetition: { kind: "noul", probability: 0.02 },
				context_stale: { kind: "noul", probability: 0.02 },
				independent_worker_required: { kind: "noul", probability: 0.02 },
				capability_escalation_required: { kind: "noul", probability: 0.02 },
				capability_gap_suspected: { kind: "noul", probability: 0.02 },
				completion_plausible: { kind: "noul", probability: 0.02 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			});
			world.provider.enqueue("root", text("objective-cycle-root", "Objective cycle reply."));
			const cycle = await withDeadline(
				trace,
				"objective cycle",
				session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 }),
				120_000,
			);
			trace.mark("root", "objective-cycle.settled");
			expect(session.executionLoopMode, "the root uses its normal loop for the selected mode").toBe(
				world.systemOne.enabled ? "objective_primary" : "legacy_goal",
			);
			expect(session.systemOneController !== undefined, "only the enabled mode binds System One").toBe(
				world.systemOne.enabled,
			);
			expect(
				session.objectiveExecutionController !== undefined,
				"the semantic objective controller is bound only with System One; off uses the native goal loop",
			).toBe(world.systemOne.enabled);
			expect(session.getActiveToolNames(), "the root keeps goal and delegate on its foreground surface").toEqual(
				expect.arrayContaining(["goal", "delegate"]),
			);
			const lastRoute = session.objectiveExecutionController?.getLastRoute();
			if (world.systemOne.enabled) {
				expect(lastRoute, "System One routed the objective live during the journey").toBeDefined();
				expect(lastRoute?.route, "System One's preflight route is applied to the objective").toBe("retrieve");
				expect(lastRoute?.reason_codes).toContain("system_one_preflight_retrieve");
			} else {
				expect(lastRoute, "normal goal continuation needs no semantic objective route").toBeUndefined();
			}
			expect(cycle.stopReason, "the bounded cycle submitted its one root turn").toBe("max_turns_reached");
			expect(cycle.turnsSubmitted).toBe(1);

			// Replay through the public admission API. The same idempotency key admitted twice is one durable message and one
			// worker turn: the second admission returns the first message's id and starts nothing. The persisted mailbox proves it.
			if (blockedAgentId === undefined) throw new Error("the blocked agent id was not recorded");
			const operatorNote = "Operator note: MAX_RETRIES is 5.";
			const replayKey = "operator-note-1";
			const workerTurnsBefore = world.provider.reached.filter((step) => step.startsWith("worker-a:")).length;
			const noteReached = createBarrier();
			const handoffReached = createBarrier();
			world.provider.enqueue("worker-a", {
				name: "replay-note-reply",
				check: () => noteReached.release(),
				reply: { content: [{ type: "text", text: "Noted: MAX_RETRIES is 5." }] },
			});
			world.provider.enqueue("root", {
				name: "replay-handoff-reply",
				check: () => handoffReached.release(),
				reply: { content: [{ type: "text", text: "The worker acknowledged the operator note." }] },
			});
			const firstAdmission = session.backgroundLanes.followUpSessionRootWorkerAgent(blockedAgentId, operatorNote, {
				idempotencyKey: replayKey,
			});
			if (!firstAdmission.started)
				throw new Error(`first admission: ${JSON.stringify({ ...firstAdmission, record: undefined })}`);
			await withDeadline(trace, "worker noted the operator note", noteReached.promise, 60_000);
			await withDeadline(trace, "worker handoff turn", handoffReached.promise, 60_000);
			await withDeadline(trace, "first admission turn settled", session.waitForForegroundIdle(), 60_000);
			const replayAdmission = session.backgroundLanes.followUpSessionRootWorkerAgent(blockedAgentId, operatorNote, {
				idempotencyKey: replayKey,
			});
			expect(replayAdmission.messageId, "a replayed key names the same durable message").toBe(
				firstAdmission.messageId,
			);
			expect(replayAdmission.started, "a replayed key starts no second worker turn").toBe(false);
			await withDeadline(trace, "replay settled", session.waitForForegroundIdle(), 60_000);
			expect(
				world.provider.reached.filter((step) => step.startsWith("worker-a:")).length - workerTurnsBefore,
				"exactly one worker turn ran for the two admissions",
			).toBe(1);
			const replayMailbox = readWorkerMailboxRecord(
				workerMailboxPath(world.agentDir, created.sessionManager.getSessionId(), blockedAgentId),
			).mailbox;
			expect(
				mailboxMessagesOf(replayMailbox).filter((message) => message.messageId === firstAdmission.messageId),
				"one durable message per idempotency key",
			).toHaveLength(1);

			// Verification with a held lane. While a failed run's obligation is open, a held worker waits at its provider gate and a quick
			// worker completes; production refuses completion while the held lane is goal-owned and active, and after both workers are
			// retired the still-open obligation alone refuses it. Each Vitest run checks the file value it reports on: the failing run
			// sees a revision of 4, and the passing recheck follows a real edit back to 5.
			const VITEST_COMMAND = "vitest run test/limits.test.ts";
			const vitestFailed = ["Test Files  1 failed (1)\n", "Tests  1 failed (1)\n"];
			const vitestPassed = ["Test Files  1 passed (1)\n", "Tests  1 passed (1)\n"];
			// The same command run from another directory is a different verification identity: its pass must not clear the
			// obligation the failure opened in the project directory.
			const GAP5_DIR = `${HARNESS_PROJECT_CWD}/gap5/elsewhere`;
			const gap5Command = `cd ${GAP5_DIR} && ${VITEST_COMMAND}`;
			const limitsIs = (value: number): void => {
				const actual = world.io.readFileSync(LIMITS_PATH, "utf8");
				if (actual !== `export const MAX_RETRIES = ${value};\n`) {
					throw new Error(`the run saw ${JSON.stringify(actual)}, expected MAX_RETRIES = ${value}`);
				}
			};
			// The background verification run starts after the passing setup and is held until after the newer failure, so it
			// completes with the revision-era obligation already open. Its shell step sits between the two foreground runs.
			const backgroundVerifyGate = createBarrier();
			let backgroundVerifyTaskId: string | undefined;
			world.shell.enqueue(
				{
					name: "vitest-pass-setup",
					command: VITEST_COMMAND,
					output: vitestPassed,
					exitCode: 0,
					check: () => limitsIs(5),
				},
				{
					name: "vitest-pass-background",
					command: VITEST_COMMAND,
					output: vitestPassed,
					exitCode: 0,
					gate: backgroundVerifyGate.promise,
				},
				{
					name: "vitest-fail-revision",
					command: VITEST_COMMAND,
					output: vitestFailed,
					exitCode: 1,
					check: () => limitsIs(4),
				},
				{
					name: "vitest-pass-elsewhere",
					command: gap5Command,
					output: vitestPassed,
					exitCode: 0,
					resultCwd: GAP5_DIR,
					check: () => limitsIs(4),
				},
				{
					name: "vitest-pass-recheck",
					command: VITEST_COMMAND,
					output: vitestPassed,
					exitCode: 0,
					check: () => limitsIs(5),
				},
			);
			const requirementFrom = (request: ScriptedRequest): string => {
				const goal = latestBatchResults(request).find((result) => result.toolName === "goal");
				const match = /req-[0-9a-f]+/.exec(goal?.text ?? "");
				if (!match) throw new Error(`no requirement id in the goal state: ${goal?.text ?? "no goal result"}`);
				return match[0];
			};
			const refusedGoal = (request: ScriptedRequest, label: string, diagnostic: string): void => {
				const refused = latestBatchResults(request).find((result) => result.toolName === "goal");
				if (!refused?.isError || !refused.text.includes(diagnostic)) {
					throw new Error(
						`${label}: expected a refusal naming "${diagnostic}", got ${refused?.text ?? "no goal result"}`,
					);
				}
			};
			const verifyJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			} as const;
			const operationClasses = {
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
			} as const;
			const completionStates = {
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.97 },
			} as const;
			const completionJudgments = {
				outcomes_achieved: { kind: "noul", probability: 0.97 },
				required_behavior_unverified: { kind: "noul", probability: 0.02 },
				material_claim_unsupported: { kind: "noul", probability: 0.02 },
				missing_requirement: { kind: "noul", probability: 0.02 },
			} as const;
			const quickHandedOff = createBarrier();
			const heldHandedOff = createBarrier();
			const heldMayRead = createBarrier();
			// The held worker waits at its first request until the root releases it; the quick worker completes at once.
			world.provider.enqueue(
				"worker-b",
				{
					name: "held-read",
					gate: heldMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "held-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("held-report", [
					{
						id: "held-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "The held value is read." },
					},
				]),
			);
			world.provider.enqueue(
				"worker-c",
				calls("quick-read", [{ id: "quick-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
				calls("quick-report", [
					{
						id: "quick-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "The quick value is read." },
					},
				]),
			);
			// Setup: the limit is set to 5 and the passing run becomes evidence for the requirement.
			world.systemOne.enterPhase(
				"verify-setup",
				{
					...verifyJudgments,
					...operationClasses,
					...completionStates,
					// The setup answer reports the passing run as recorded evidence: a current-work success claim.
					states_tests_pass: { kind: "choice", choice: "current_success", confidence: 0.97 },
				},
				{ expect: ownerWords("Set the limit to 5 and record the passing run.") },
			);
			world.provider.enqueue(
				"root",
				calls("edit-to-five", [
					{
						id: "edit-five-1",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
					},
				]),
				calls("vitest-pass", [{ id: "verify-pass-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				calls("background-verify-start", [
					{ id: "background-verify-1", name: "bash", arguments: { command: VITEST_COMMAND, background: true } },
				]),
				{
					name: "background-verify-started",
					check: (request) => {
						backgroundVerifyTaskId = backgroundTaskIdOf(request);
					},
					reply: {
						content: [{ type: "toolCall", id: "goal-get-1", name: "goal", arguments: { action: "get" } }],
						stopReason: "toolUse",
					},
				},
				dynamicCalls(
					"add-evidence",
					(request) => [
						{
							id: "evidence-1",
							name: "goal",
							arguments: {
								action: "add_evidence",
								kind: "test",
								uri: "verify-pass-1",
								summary: "vitest passed: MAX_RETRIES is 5",
								requirementIds: [requirementFrom(request)],
							},
						},
					],
					(request) => assertBatchOk(request, "goal-get"),
				),
				text("evidence-recorded", "The passing run is recorded as evidence."),
			);
			await withDeadline(
				trace,
				"verification setup",
				session.prompt("Set the limit to 5 and record the passing run."),
			);
			trace.mark("root", "verification.setup");
			// Revision: the limit is changed to 4, the test fails, and two workers start: one held, one quick.
			world.systemOne.enterPhase(
				"verify-revision",
				{ ...verifyJudgments, ...completionStates },
				{ expect: ownerWords("Revise the limit to 4, run the test, and start the checks.") },
			);
			world.provider.enqueue(
				"root",
				calls("edit-to-four", [
					{
						id: "edit-four-1",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 5", newText: "MAX_RETRIES = 4" }] },
					},
				]),
				calls("vitest-fail", [{ id: "verify-fail-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				calls("start-held", [
					{
						id: "start-held-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-b" },
							instructions: "Read src/limits.ts and report its value once the owner releases you.",
						},
					},
				]),
				calls("start-quick", [
					{
						id: "start-quick-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Read src/limits.ts and report its value.",
						},
					},
				]),
				text("revision-started", "The revision failed its test; two checks are running."),
			);
			world.provider.enqueue(
				"root",
				// The quick worker's terminal handoff starts this root turn while the held worker still waits at its gate.
				{
					name: "quick-handoff",
					check: (request) => {
						if (!JSON.stringify(request.context.messages).includes("The quick value is read.")) {
							throw new Error("the quick worker's handoff is not in the root turn");
						}
						quickHandedOff.release();
					},
					reply: {
						content: [{ type: "text", text: "The quick check is reported; the held check is still running." }],
					},
				},
			);
			await withDeadline(
				trace,
				"revision turn",
				session.prompt("Revise the limit to 4, run the test, and start the checks."),
			);
			trace.mark("root", "verification.revised");
			await withDeadline(trace, "quick worker handed off", quickHandedOff.promise, 90_000);
			await withDeadline(trace, "quick handoff turn settled", session.waitForForegroundIdle(), 90_000);
			// The other lane completed; the held lane is still running, so completion is refused by the goal-owned lane.
			world.systemOne.enterPhase(
				"verify-refused",
				{ ...verifyJudgments, ...completionStates },
				{ expect: ownerWords("Check whether the goal can complete now.") },
			);
			world.provider.enqueue(
				"root",
				calls("complete-refused", [{ id: "complete-1", name: "goal", arguments: { action: "complete" } }]),
				{
					name: "refusal-reported",
					check: (request) => {
						refusedGoal(
							request,
							"completion while the held lane runs",
							"goal-owned worker lane(s) are still active",
						);
					},
					reply: { content: [{ type: "text", text: "Completion waits for the held check." }] },
				},
			);
			await withDeadline(trace, "refused completion", session.prompt("Check whether the goal can complete now."));
			trace.mark("root", "completion.refused");
			if (world.provider.reached.includes("worker-b:held-report")) {
				throw new Error("the held worker reported before the owner released it");
			}
			// The held lane is released: it reads, reports, and its handoff starts a root turn.
			world.systemOne.enterPhase("verify-held", completionStates);
			world.provider.enqueue("root", {
				name: "held-handoff",
				check: (request) => {
					if (!JSON.stringify(request.context.messages).includes("The held value is read.")) {
						throw new Error("the held worker's handoff is not in the root turn");
					}
					heldHandedOff.release();
				},
				reply: { content: [{ type: "text", text: "Both checks are reported." }] },
			});
			heldMayRead.release();
			await withDeadline(trace, "held worker handed off", heldHandedOff.promise, 90_000);
			await withDeadline(trace, "held handoff turn settled", session.waitForForegroundIdle(), 90_000);
			// The older pass completes first; then both workers are retired and the open obligation alone refuses completion.
			// The reply that reports the old pass is a historical claim: no current success exists for the newer failure.
			world.systemOne.enterPhase(
				"verify-obligation",
				{
					...verifyJudgments,
					...completionStates,
					states_tests_pass: { kind: "choice", choice: "historical_only", confidence: 0.97 },
				},
				{ expect: ownerWords("Retire the checks and check completion again.") },
			);
			// The older background pass completes now, after the newer failure. Its handoff runs its own root turn, and the
			// obligation the failure opened must survive it: only a new matching pass can clear that failure.
			const oldPassHanded = createBarrier();
			world.provider.enqueue("root", {
				name: "old-background-pass-reported",
				check: (request) => {
					if (backgroundVerifyTaskId === undefined)
						throw new Error("the background verification start was never observed");
					if (!handoffFor(request, backgroundVerifyTaskId)) {
						throw new Error(`the completion of ${backgroundVerifyTaskId} did not reach the foreground root`);
					}
					oldPassHanded.release();
				},
				reply: {
					content: [{ type: "text", text: "The background check passed; the newer failure still stands." }],
				},
			});
			backgroundVerifyGate.release();
			await withDeadline(trace, "old background pass handed off", oldPassHanded.promise, 90_000);
			await withDeadline(trace, "old background handoff settled", session.waitForForegroundIdle(), 90_000);
			expect(
				world.shell.requests.filter((request) => request.command === VITEST_COMMAND),
				"the old pass ran once, alongside the setup run and the revision failure",
			).toHaveLength(3);
			trace.mark("root", "old-background-pass.handed-off");
			world.provider.enqueue(
				"root",
				dynamicCalls("retire-workers", (request) => [
					{
						id: "retire-held-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-b") },
					},
					{
						id: "retire-quick-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-c") },
					},
				]),
				dynamicCalls("mixed-batch", (request) => {
					const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
					if (
						retirements.length !== 2 ||
						retirements.some((result) => result.isError || !result.text.includes("retired"))
					)
						throw new Error(`the held and quick workers were not both retired: ${JSON.stringify(retirements)}`);
					// One terminal batch: two reads and two status calls. The status of the retired held worker links back to its start receipt.
					return [
						{ id: "mixed-ok-1", name: "read", arguments: { path: LIMITS_PATH } },
						{
							id: "mixed-fail-1",
							name: "read",
							arguments: { path: `${HARNESS_PROJECT_CWD}/src/does-not-exist.ts` },
						},
						{
							id: "mixed-status-ok-1",
							name: "delegate",
							arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-b") },
						},
						{
							id: "mixed-status-fail-1",
							name: "delegate",
							arguments: { action: "status", agentId: "agent-does-not-exist" },
						},
					];
				}),
				{
					name: "mixed-recorded",
					check: (request) => {
						// Four calls in one terminal batch: the reads split into a success and a missing-file failure, and the status of the retired held
						// worker names that worker's agent id (its start receipt), while the unknown-agent status fails.
						const results = latestBatchResults(request);
						const [ok, failed, status, statusFailed] = results;
						const agentId = latestAgentIdForTrack(request, "worker-b");
						if (
							results.length !== 4 ||
							ok?.isError !== false ||
							failed?.isError !== true ||
							!ok.text.includes("MAX_RETRIES") ||
							status?.isError !== false ||
							!status.text.includes(agentId) ||
							statusFailed?.isError !== true
						)
							throw new Error(`the mixed batch did not split as expected: ${JSON.stringify(results)}`);
					},
					reply: {
						content: [{ type: "toolCall", id: "complete-3", name: "goal", arguments: { action: "complete" } }],
						stopReason: "toolUse",
					},
				},
				{
					name: "obligation-reported",
					check: (request) => {
						refusedGoal(
							request,
							"completion after the held lane completed",
							"active verification obligation(s) remain",
						);
					},
					reply: { content: [{ type: "text", text: "The obligation is still open." }] },
				},
			);
			await withDeadline(
				trace,
				"retirement and obligation refusal",
				session.prompt("Retire the checks and check completion again."),
			);
			trace.mark("root", "obligation.still-open");
			// The durable batch: each call's result is persisted under its own call id, in call order, with its own outcome.
			const mixedCallIds = ["mixed-ok-1", "mixed-fail-1", "mixed-status-ok-1", "mixed-status-fail-1"];
			const mixedResults = created.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					mixedCallIds.includes(entry.message.toolCallId)
						? [entry.message]
						: [],
				);
			expect(
				mixedResults.map((message) => ({
					toolCallId: message.toolCallId,
					isError: message.isError,
					failureRecord:
						typeof message.details === "object" &&
						message.details !== null &&
						"piToolFailureMemory" in message.details,
				})),
				"the durable mixed batch pairs each call with its own result and outcome",
			).toEqual([
				{ toolCallId: "mixed-ok-1", isError: false, failureRecord: false },
				{ toolCallId: "mixed-fail-1", isError: true, failureRecord: true },
				{ toolCallId: "mixed-status-ok-1", isError: false, failureRecord: false },
				{ toolCallId: "mixed-status-fail-1", isError: true, failureRecord: true },
			]);
			// The durable receipt link: the status call names the agent that its durable retire call named, and the result carries that id.
			const retiredHeldAgent = created.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? entry.message.content.flatMap((block) =>
								block.type === "toolCall" && block.id === "retire-held-1" ? [block.arguments.agentId] : [],
							)
						: [],
				);
			const statusText = (mixedResults[2]?.content ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			expect(retiredHeldAgent, "the durable retire call names the held worker").toHaveLength(1);
			expect(statusText, "the durable status result carries the agent id its retire call named").toContain(
				String(retiredHeldAgent[0]),
			);
			const obligationsBeforeGap5 = session.getVerificationObligations();
			// Gap 5: a passing run of the same command from another directory is another verification identity. The obligation the
			// failure opened in the project directory must survive it; only the recheck from the project directory clears it.
			world.systemOne.enterPhase(
				"verify-elsewhere",
				{ ...verifyJudgments, ...operationClasses, ...completionStates },
				{ expect: ownerWords("Run the check from another directory, then check completion.") },
			);
			world.provider.enqueue(
				"root",
				calls("gap5-run", [{ id: "gap5-verify-1", name: "bash", arguments: { command: gap5Command } }]),
				{
					name: "gap5-run-reported",
					check: (request) => {
						const run = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (!run || run.isError) {
							throw new Error(
								`the other-directory pass did not complete cleanly: ${run?.text ?? "no bash result"}`,
							);
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "gap5-complete-1", name: "goal", arguments: { action: "complete" } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "gap5-refusal-reported",
					check: (request) => {
						refusedGoal(
							request,
							"completion after the other-directory pass",
							"active verification obligation(s) remain",
						);
					},
					reply: { content: [{ type: "text", text: "The other-directory pass does not clear the obligation." }] },
				},
			);
			await withDeadline(
				trace,
				"other-directory pass and obligation refusal",
				session.prompt("Run the check from another directory, then check completion."),
			);
			trace.mark("root", "gap5.still-open");

			// D (open verification across a worker's budget terminal, held in the admitting turn): the cost-capped worker is admitted by the root's
			// start call. The root's next provider request is held inside that same turn, and the worker is held at its first request. A passive
			// subscriber is armed before the worker is released; its exact terminal event pins the attempt while the turn is still held. The root
			// gate is then released, and the next provider boundary of the same turn carries the worker's handoff; the completion is refused naming
			// the same open obligation ids. No global idle wait and no owner input is involved.
			const D_COST_PROFILE: OrchestrationProfile = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: "j2-cost",
				description: "Read-only worker with a 0.2 USD cost cap.",
				role: "explorer",
				modelPolicy: {
					mode: "fixed",
					candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
				},
				capabilityCeiling: ["filesystem.read"],
				readOnly: true,
				toolNames: ["read"],
				resourceProfileNames: [],
				dispatchProfileIds: [],
				budget: { maxTokens: 50_000, maxCostUsd: 0.2 },
				maxConcurrent: 1,
				leaseTtlMs: 60_000,
				requireIndependentVerification: false,
				createdAt: "2026-10-09T00:00:00.000Z",
				updatedAt: "2026-10-09T00:00:00.000Z",
			};
			new OrchestrationProfileStore({
				agentDir: world.agentDir,
				cwd: HARNESS_PROJECT_CWD,
				projectTrusted: false,
			}).save(D_COST_PROFILE, "global");
			// The worker's terminal handoff is the worker-handoff notice, one entry per lane; the tool-handoff notice is a different message.
			const dWorkerHandoff = (request: ScriptedRequest, laneId: string): boolean =>
				request.context.messages.some((message) => {
					const text = JSON.stringify(message);
					return text.includes("Background worker terminal handoff") && text.includes(`- ${laneId}:`);
				});
			const dObligationsBefore = session.getVerificationObligations().map((obligation) => obligation.id);
			expect(
				dObligationsBefore.length,
				"the project-directory failure is open before the budget worker runs",
			).toBeGreaterThan(0);
			const dAdmitted = createBarrier();
			const dGate = createBarrier();
			const dRootGate = createBarrier();
			const dTerminal = createBarrier();
			let dAttemptId: string | undefined;
			let dLaneId: string | undefined;
			const dRecords: Array<{ readonly laneId: string; readonly status: string }> = [];
			const dCost = { ...createEmptyUsage().cost, input: 0.25, output: 0.05, total: 0.25 + 0.05 };
			world.provider.enqueue("worker-a", {
				name: "d-budget-read",
				check: () => dAdmitted.release(),
				gate: dGate.promise,
				reply: {
					content: [{ type: "toolCall", id: "d-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
					stopReason: "toolUse",
					usage: { ...createEmptyUsage(), input: 1_000, output: 100, totalTokens: 1_100, cost: dCost },
				},
			});
			world.provider.enqueue(
				"root",
				calls("d-start", [
					{
						id: "d-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "j2-cost",
							instructions: "Read the limits file, then report.",
						},
					},
				]),
				{
					name: "d-held",
					gate: dRootGate.promise,
					check: (request) => {
						const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (!started?.text.includes("delegate started (running)")) {
							throw new Error(`the budget worker did not start: ${started?.text ?? "no result"}`);
						}
					},
					reply: {
						content: [{ type: "toolCall", id: "d-held-get", name: "goal", arguments: { action: "get" } }],
						stopReason: "toolUse",
					},
				},
				{
					name: "d-wake",
					check: (request) => {
						if (dLaneId === undefined || !dWorkerHandoff(request, dLaneId)) {
							throw new Error("the budget worker's terminal handoff is not in the same-turn boundary request");
						}
					},
					reply: {
						content: [{ type: "toolCall", id: "d-complete-1", name: "goal", arguments: { action: "complete" } }],
						stopReason: "toolUse",
					},
				},
				{
					name: "d-refused",
					check: (request) => {
						refusedGoal(
							request,
							"completion after the budget worker terminal",
							"active verification obligation(s) remain",
						);
					},
					reply: { content: [{ type: "text", text: "The open obligation still refuses completion." }] },
				},
			);
			world.systemOne.enterPhase(
				"verify-budget-worker",
				{ ...verifyJudgments },
				{
					expect: ownerWords("Start the cost-capped check, then check completion."),
				},
			);
			const dPrompt = session.prompt("Start the cost-capped check, then check completion.");
			await withDeadline(trace, "budget worker admitted", dAdmitted.promise, 90_000);
			const dRunning = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
				(attempt) => attempt.status === "running",
			);
			expect(dRunning, "exactly one budget attempt is admitted and held").toHaveLength(1);
			const dAttempt = dRunning[0];
			if (dAttempt === undefined) throw new Error("the admitted budget attempt is missing");
			dAttemptId = dAttempt.attemptId;
			dLaneId = dAttempt.taskId;
			const offD = session.subscribe((event) => {
				if (event.type !== "delegate_workers") return;
				for (const record of event.terminalSinceFlush) {
					dRecords.push({ laneId: record.laneId, status: record.status });
					if (record.laneId === dLaneId) dTerminal.release();
				}
			});
			try {
				if (session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[dAttemptId]?.status !== "running") {
					dTerminal.release();
				}
				dGate.release();
				await withDeadline(trace, "budget worker terminal observed", dTerminal.promise, 120_000);
			} finally {
				offD();
			}
			const dTerminalAttempt = session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[dAttemptId];
			expect(dTerminalAttempt?.status, "the budget worker terminalizes partial").toBe("partial");
			const dRecord = dRecords.find((record) => record.laneId === dLaneId);
			expect(dRecord?.laneId, "the exact terminal event names the admitted lane").toBe(dLaneId);
			expect(dRecord?.status, "the exact terminal event carries the lane budget terminal").toBe("budget_exhausted");
			expect(
				session.backgroundLanes.getWorkerAttemptResult(dAttemptId)?.reasonCode,
				"the budget terminal names the grant's cost refusal",
			).toBe("cost_budget_exhausted");
			expect(
				session.getVerificationObligations().map((obligation) => obligation.id),
				"the budget terminal leaves exactly the obligation ids that were open before the worker ran",
			).toEqual(dObligationsBefore);
			dRootGate.release();
			await withDeadline(trace, "budget turn settled", dPrompt, 120_000);
			expect(
				session.getVerificationObligations().map((obligation) => obligation.id),
				"the completion refusal leaves the open obligation ids unchanged",
			).toEqual(dObligationsBefore);
			trace.mark("root", "gap5.budget-worker");
			// The native verification record carries the identity: the failure is in the project directory, the other-directory pass
			// is a distinct identity in its own directory, and the pass ran exactly once there.
			type ReceiptIdentity = {
				readonly id: string;
				readonly cwd: string;
				readonly status: string;
				readonly repairGroup?: string;
			};
			const isReceiptIdentity = (value: unknown): value is ReceiptIdentity =>
				typeof value === "object" &&
				value !== null &&
				"id" in value &&
				typeof value.id === "string" &&
				"cwd" in value &&
				typeof value.cwd === "string" &&
				"status" in value &&
				typeof value.status === "string" &&
				(!("repairGroup" in value) || typeof value.repairGroup === "string");
			const verificationOf = (toolCallId: string): unknown => {
				const entry = created.sessionManager
					.getBranch()
					.find(
						(candidate) =>
							candidate.type === "message" &&
							candidate.message.role === "toolResult" &&
							candidate.message.toolCallId === toolCallId,
					);
				const details =
					entry?.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
				return typeof details === "object" && details !== null && "piVerification" in details
					? details.piVerification
					: undefined;
			};
			expect(
				verificationOf("verify-fail-1"),
				"the revision failure is recorded in the project directory",
			).toMatchObject({
				cwd: HARNESS_PROJECT_CWD,
				status: "failed",
			});
			expect(
				verificationOf("gap5-verify-1"),
				"the other-directory pass is recorded in its own directory",
			).toMatchObject({
				cwd: GAP5_DIR,
				status: "passed",
			});
			expect(
				world.shell.requests.filter((request) => request.command === gap5Command),
				"the other-directory pass ran once",
			).toHaveLength(1);
			// Native receipts only: both runs share one canonical stage list and workspace (the cd is stripped from the identity stages and
			// the cwd varies), so the repair group matches while the receipt ids differ. Raw display commands are not compared.
			const revision = verificationOf("verify-fail-1");
			const elsewhere = verificationOf("gap5-verify-1");
			if (!isReceiptIdentity(revision) || !isReceiptIdentity(elsewhere)) {
				throw new Error(
					`a verification receipt is not a native identity: ${JSON.stringify([revision, elsewhere])}`,
				);
			}
			expect(elsewhere.id, "the other-directory pass has its own native receipt id").not.toBe(revision.id);
			expect(revision.repairGroup, "the project failure carries a native repair group").toEqual(expect.any(String));
			expect(elsewhere.repairGroup, "the other-directory pass carries the same native repair group").toBe(
				revision.repairGroup,
			);
			expect(
				session.getVerificationObligations(),
				"the other-directory pass leaves the open obligation unchanged",
			).toEqual(obligationsBeforeGap5);
			expect(
				session.getVerificationObligations().map((obligation) => obligation.id),
				"the open obligation is the failure's own native receipt",
			).toEqual([revision.id]);
			const autonomy = world.settingsManager.getAutonomySettings();
			const settlement: Partial<
				Record<
					| "afterObligationOpen"
					| "afterE11Start"
					| "afterE11Settled"
					| "beforeCompact"
					| "afterApply"
					| "afterFreshOpen"
					| "afterHostResume"
					| "afterAutoResume",
					ReturnType<typeof settlementFacts>
				>
			> = {};
			settlement.afterObligationOpen = settlementFacts(session, created.sessionManager, autonomy);
			// E11 (large worker output through the native artifact, read back by native status): a worker emits a large distinct text
			// block and a truthful typed report in one final assistant message. The raw text becomes the artifact; status by agentId
			// names it; a small follow-up report must borrow no older pointer; the historical lane keeps its own pointer.
			const E11_LARGE = [
				"E11-LARGE-OUTPUT-MARKER",
				...Array.from(
					{ length: 1400 },
					(_unused, index) =>
						`E11 report line ${index}: checkpoint ${index % 97} recorded value ${(index * 2654435761) % 1000003}.`,
				),
			].join("\n");
			// A second, distinct large generation: its own marker and lines, so each generation has its own digest.
			const E11_LARGE_SECOND = [
				"E11-SECOND-LARGE-MARKER",
				...Array.from(
					{ length: 1400 },
					(_unused, index) =>
						`E11 second report line ${index}: segment ${index % 89} recorded value ${(index * 1103515245) % 999983}.`,
				),
			].join("\n");
			const E11_REPORT = "The large output is reported.";
			const E11_REPORT_SECOND = "The second large output is reported.";
			const E11_SMALL = "Small report is ready.";
			expect(Buffer.byteLength(E11_LARGE), "the output exceeds the inline threshold").toBeGreaterThan(
				WORKER_TERMINAL_OUTPUT_INLINE_BYTES,
			);
			const e11Reported = createBarrier();
			const e11SecondReported = createBarrier();
			// The second generation's provider turn is held before its terminal: the status reads happen while it runs.
			const e11SecondHeld = createBarrier();
			const e11SecondRelease = createBarrier();
			const e11SmallReported = createBarrier();
			const startIdentity = (): { agentId: string; laneId: string } => {
				for (const message of session.messages) {
					if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
					const details = message.details as
						| { started?: unknown; label?: unknown; agentId?: unknown; laneId?: unknown }
						| undefined;
					if (
						details?.started === true &&
						details.label === "Report the large output once." &&
						typeof details.agentId === "string" &&
						typeof details.laneId === "string"
					) {
						return { agentId: details.agentId, laneId: details.laneId };
					}
				}
				throw new Error("the start result carries no agent or lane id");
			};
			// The first generation's artifact file, resolved from the admitted attempt's native result at the read's request.
			const e11ArtifactPath = (): string => {
				// Pure projection read: the admitted agent's first attempt that carries a native result, at the read's request.
				const attempt = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
					(candidate) => candidate.taskId === startIdentity().laneId && candidate.result !== undefined,
				);
				const uri = attempt?.result?.artifacts[0]?.uri;
				if (typeof uri !== "string") throw new Error("the first large attempt carries no artifact");
				return fileURLToPath(uri);
			};
			// The continuation offset a truncated read announces; a read without one is the last chunk.
			const e11ContinuationOffset = (request: ScriptedRequest, toolCallId: string): number => {
				const result = request.context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
				);
				const text =
					result?.role === "toolResult"
						? result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
						: "";
				const match = /Use offset=(\d+) to continue\./.exec(text);
				if (!match) throw new Error(`the read ${toolCallId} announces no continuation`);
				return Number(match[1]);
			};
			const e11Observed: {
				sequence?: number;
				stopReason?: string;
				blockTypes?: string[];
				textBytes?: number;
				markerCount?: number;
			} = {};
			world.provider.enqueue(
				"worker-c",
				{
					name: "e11-large-report",
					onTerminal: (request, message) => {
						const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
						e11Observed.sequence = request.sequence;
						e11Observed.stopReason = message.stopReason;
						e11Observed.blockTypes = message.content.map((block) => block.type);
						e11Observed.textBytes = Buffer.byteLength(text);
						e11Observed.markerCount = text.split("E11-LARGE-OUTPUT-MARKER").length - 1;
					},
					reply: {
						content: [
							{ type: "text", text: E11_LARGE },
							{
								type: "toolCall",
								id: "e11-report-1",
								name: "submit_report",
								arguments: { status: "completed", summary: E11_REPORT },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "e11-second-large-report",
					check: () => {
						e11SecondHeld.release();
					},
					gate: e11SecondRelease.promise,
					reply: {
						content: [
							{ type: "text", text: E11_LARGE_SECOND },
							{
								type: "toolCall",
								id: "e11-report-2",
								name: "submit_report",
								arguments: { status: "completed", summary: E11_REPORT_SECOND },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "e11-small-report",
					reply: {
						content: [
							{
								type: "toolCall",
								id: "e11-small-1",
								name: "submit_report",
								arguments: { status: "completed", summary: E11_SMALL },
							},
						],
						stopReason: "toolUse",
					},
				},
			);
			world.provider.enqueue(
				"root",
				calls("e11-start", [
					{
						id: "e11-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Report the large output once.",
						},
					},
				]),
				{ name: "e11-started", reply: { content: [{ type: "text", text: "The large worker is running." }] } },
				dynamicCalls(
					"e11-handoff",
					(request) => [
						{
							id: "e11-status-1",
							name: "delegate",
							arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-c") },
						},
					],
					(request) => {
						if (!JSON.stringify(request.context.messages).includes(E11_REPORT)) {
							throw new Error("the large worker's report did not reach the root");
						}
						if (
							JSON.stringify(world.provider.getPendingStepNames("worker-c")) !==
							JSON.stringify(["e11-second-large-report", "e11-small-report"])
						) {
							throw new Error(
								`the large turn left other steps pending: ${JSON.stringify(world.provider.getPendingStepNames("worker-c"))}`,
							);
						}
						e11Reported.release();
					},
				),
				{ name: "e11-read", reply: { content: [{ type: "text", text: "The large output is read." }] } },
				dynamicCalls("e11-chunk-1", () => [
					{ id: "e11-read-1", name: "read", arguments: { path: e11ArtifactPath() } },
				]),
				dynamicCalls("e11-chunk-2", (request) => [
					{
						id: "e11-read-2",
						name: "read",
						arguments: { path: e11ArtifactPath(), offset: e11ContinuationOffset(request, "e11-read-1") },
					},
				]),
				{ name: "e11-chunked", reply: { content: [{ type: "text", text: "The artifact is read in chunks." }] } },
				dynamicCalls("e11-follow-large", (request) => [
					{
						id: "e11-follow-large-1",
						name: "delegate",
						arguments: {
							action: "follow_up",
							agentId: latestAgentIdForTrack(request, "worker-c"),
							message: "Report the second large output.",
						},
					},
				]),
				{
					name: "e11-follow-large-started",
					reply: { content: [{ type: "text", text: "The second large report is running." }] },
				},
				dynamicCalls("e11-status-current", () => [
					{
						id: "e11-status-current-1",
						name: "delegate",
						arguments: { action: "status", agentId: startIdentity().agentId },
					},
				]),
				dynamicCalls("e11-status-historical-held", () => [
					{
						id: "e11-status-historical-1",
						name: "delegate",
						arguments: { action: "status", laneId: startIdentity().laneId },
					},
				]),
				{
					name: "e11-held-read",
					reply: { content: [{ type: "text", text: "The second report is still running." }] },
				},
				dynamicCalls(
					"e11-second-handoff",
					(request) => [
						{
							id: "e11-status-4",
							name: "delegate",
							arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-c") },
						},
					],
					(request) => {
						if (!JSON.stringify(request.context.messages).includes(E11_REPORT_SECOND)) {
							throw new Error("the second large report did not reach the root");
						}
						e11SecondReported.release();
					},
				),
				{
					name: "e11-second-read",
					reply: { content: [{ type: "text", text: "The second large output is read." }] },
				},
				dynamicCalls("e11-follow", (request) => [
					{
						id: "e11-follow-1",
						name: "delegate",
						arguments: {
							action: "follow_up",
							agentId: latestAgentIdForTrack(request, "worker-c"),
							message: "Report briefly.",
						},
					},
				]),
				{
					name: "e11-follow-started",
					reply: { content: [{ type: "text", text: "The brief follow-up is running." }] },
				},
				dynamicCalls(
					"e11-small-handoff",
					(request) => [
						{
							id: "e11-status-2",
							name: "delegate",
							arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-c") },
						},
					],
					(request) => {
						if (!JSON.stringify(request.context.messages).includes(E11_SMALL)) {
							throw new Error("the small follow-up report did not reach the root");
						}
						e11SmallReported.release();
					},
				),
				dynamicCalls("e11-historical", () => [
					{
						id: "e11-status-3",
						name: "delegate",
						arguments: { action: "status", laneId: startIdentity().laneId },
					},
				]),
				dynamicCalls("e11-retire", () => [
					{
						id: "e11-retire-1",
						name: "delegate",
						arguments: { action: "retire", agentId: startIdentity().agentId },
					},
				]),
				{ name: "e11-done", reply: { content: [{ type: "text", text: "Both reports are read." }] } },
			);
			// The E11 owner words are classified where the turn reads the policy: this phase carries the verification families and the
			// continuation family the previous intent now asks.
			world.systemOne.enterPhase("e11", {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			});
			await withDeadline(
				trace,
				"E11 start turn",
				session.prompt("Start the large report worker and read its output."),
			);
			settlement.afterE11Start = settlementFacts(session, created.sessionManager, autonomy);
			await withDeadline(trace, "large worker reported", e11Reported.promise, 90_000);
			await withDeadline(trace, "E11 read turn settled", session.waitForForegroundIdle(), 90_000);
			await withDeadline(trace, "chunked artifact read", session.prompt("Read the large output in chunks."), 90_000);
			await withDeadline(
				trace,
				"second large report requested",
				session.prompt("Ask for the second large report."),
				90_000,
			);
			await withDeadline(trace, "second large held", e11SecondHeld.promise, 90_000);
			await withDeadline(
				trace,
				"held status turn",
				session.prompt("Check the second report while it runs."),
				90_000,
			);
			// Bounded control: while the second generation runs, its display carries no first-generation claim, pointer or digest and no
			// terminal result. It shows no current terminal yet; generation identity is pinned separately below.
			const e11HeldDetails = (toolCallId: string): Record<string, unknown> => {
				const entry = created.sessionManager
					.getBranch()
					.find(
						(candidate) =>
							candidate.type === "message" &&
							candidate.message.role === "toolResult" &&
							candidate.message.toolCallId === toolCallId,
					);
				if (entry?.type !== "message" || entry.message.role !== "toolResult") {
					throw new Error(`no durable status result for ${toolCallId}`);
				}
				return (entry.message.details ?? {}) as Record<string, unknown>;
			};
			const e11Running = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
				(attempt) => attempt.agentId === startIdentity().agentId && attempt.status === "running",
			);
			if (e11Running === undefined) throw new Error("the second generation has no running attempt");
			const e11Current = e11HeldDetails("e11-status-current-1");
			const e11Historical = e11HeldDetails("e11-status-historical-1");
			expect(
				{ agentId: e11Current.agentId, laneId: e11Current.laneId },
				"the running display names the admitted agent and its own lane",
			).toEqual({ agentId: startIdentity().agentId, laneId: e11Running.taskId });
			expect(e11Current.claimSummary, "the running attempt borrows no first-generation claim").toBeUndefined();
			expect(
				e11Current.outputArtifactUri,
				"the running attempt borrows no first-generation pointer",
			).toBeUndefined();
			expect(JSON.stringify(e11Current), "the running display carries no first-generation proof").not.toContain(
				E11_REPORT,
			);
			expect(JSON.stringify(e11Current), "the running display carries no first-generation digest").not.toContain(
				createHash("sha256").update(E11_LARGE).digest("hex"),
			);
			expect(
				{ laneId: e11Historical.laneId, claimSummary: e11Historical.claimSummary },
				"the historical lane still names the first generation's claim",
			).toEqual({ laneId: startIdentity().laneId, claimSummary: E11_REPORT });
			expect(typeof e11Historical.outputArtifactUri, "the historical lane keeps its first pointer").toBe("string");
			e11SecondRelease.release();
			await withDeadline(trace, "second large report", e11SecondReported.promise, 90_000);
			await withDeadline(trace, "second large read settled", session.waitForForegroundIdle(), 90_000);
			await withDeadline(trace, "brief follow-up", session.prompt("Ask for a brief follow-up report."), 90_000);
			await withDeadline(trace, "small worker reported", e11SmallReported.promise, 90_000);
			await withDeadline(trace, "E11 foreground settled", session.waitForForegroundIdle(), 90_000);
			settlement.afterE11Settled = settlementFacts(session, created.sessionManager, autonomy);
			// Accepted native receipt linkage: the first generation's completed report has its matched successful submit receipt on the worker's own
			// persisted transcript, under its own call id. The incomplete side is pinned in the late block; this is the accepted side.
			const e11WorkerId = startIdentity().agentId;
			const e11Binding = session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[e11WorkerId];
			if (e11Binding === undefined) throw new Error("the E11 worker has no binding for its receipts");
			const e11Transcript = new WorkerConversationStore()
				.open({
					agentDir: world.agentDir,
					resumeContext: e11Binding.resumeContext,
					expectedLogicalAgentId: e11WorkerId,
				})
				.getRawTranscript();
			expect(
				matchedSubmitReceiptIn(e11Transcript, "e11-report-1"),
				"the accepted report has its matched successful submit receipt on the worker's persisted transcript",
			).toBe(true);
			// Durable canonical identities: each status read is found on the branch by its own tool call id, never by position.
			const e11Branch = created.sessionManager.getBranch();
			const e11Status = (toolCallId: string) => {
				const entry = e11Branch.find(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolCallId === toolCallId,
				);
				if (entry?.type !== "message" || entry.message.role !== "toolResult") {
					throw new Error(`no durable status result for ${toolCallId}`);
				}
				return entry.message.details as
					| {
							outputArtifactUri?: unknown;
							outputArtifactSizeBytes?: unknown;
							agentId?: unknown;
							laneId?: unknown;
							claimSummary?: unknown;
					  }
					| undefined;
			};
			const latestStatus = e11Status("e11-status-1");
			const followedStatus = e11Status("e11-status-2");
			const historicalStatus = e11Status("e11-status-3");
			const admitted = startIdentity();
			expect(
				{ agentId: latestStatus?.agentId, laneId: latestStatus?.laneId, claimSummary: latestStatus?.claimSummary },
				"the latest status names the admitted agent and its lane, and its own summary",
			).toEqual({ agentId: admitted.agentId, laneId: admitted.laneId, claimSummary: E11_REPORT });
			expect(followedStatus?.agentId, "the follow-up stays on the admitted agent").toBe(admitted.agentId);
			expect(followedStatus?.laneId, "the follow-up status names its own lane, not the first").not.toBe(
				admitted.laneId,
			);
			expect(followedStatus?.claimSummary, "the follow-up summary is its own").toBe(E11_SMALL);
			// The small third generation is its own admitted task: the one attempt that is neither the first nor the captured second.
			const e11Third = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
				(attempt) =>
					attempt.agentId === admitted.agentId &&
					attempt.attemptId !== e11Running.attemptId &&
					attempt.taskId !== admitted.laneId,
			);
			expect(
				e11Third.map((attempt) => attempt.taskId),
				"exactly one third attempt is admitted",
			).toHaveLength(1);
			expect(followedStatus?.laneId, "the small status names the third attempt's own task").toBe(
				e11Third[0]?.taskId,
			);
			expect(e11Observed, "the large step emitted one text-and-tool-call terminal with the exact text").toEqual({
				sequence: expect.any(Number),
				stopReason: "toolUse",
				blockTypes: ["text", "toolCall"],
				textBytes: Buffer.byteLength(E11_LARGE),
				markerCount: 1,
			});
			// Capture, native result and projection are separate observables, checked in that order: the file on disk under its
			// content digest, then the admitted attempt's native result, then the status pointer.
			// One observable chain, checked once so the failure names the layer: the file system, the admitted attempt's native
			// result, and the status pointer. Only names, counts, digests and sizes are recorded, never the raw text.
			const largeSha = createHash("sha256").update(E11_LARGE).digest("hex");
			const outputFiles = [...world.io.fileEntries().keys()].filter((path) =>
				path.includes("worker-output-artifacts"),
			);
			// The admitted task's own attempt, read from the native task runtime: the start lane is the task id of its first attempt.
			const admittedAttemptId = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
				(attempt) => attempt.taskId === admitted.laneId && attempt.result !== undefined,
			)?.attemptId;
			if (admittedAttemptId === undefined) throw new Error("the admitted lane carries no attempt id");
			const nativeAttempt = session.backgroundLanes.getWorkerAttemptResult(admittedAttemptId);
			const nativeUri = nativeAttempt?.artifacts[0]?.uri;
			const persistedReport = [...world.io.fileEntries()]
				.filter(([path]) => path.includes("worker-conversations") && path.endsWith(".jsonl"))
				.flatMap(([, content]) => content.split("\n").filter((line) => line.length > 0))
				.map(
					(line) =>
						JSON.parse(line) as {
							message?: { role?: string; content?: Array<{ type: string; text?: string; id?: string }> };
						} & { role?: string; content?: Array<{ type: string; text?: string; id?: string }> },
				)
				.map((entry) => entry.message ?? entry)
				.find(
					(message) =>
						message.role === "assistant" &&
						message.content?.some((block) => block.type === "toolCall" && block.id === "e11-report-1"),
				);
			const persistedText = (persistedReport?.content ?? [])
				.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
				.join("");
			const e11Chain = {
				persistedAssistantTextBytes: Buffer.byteLength(persistedText),
				persistedMarkerCount: persistedText.split("E11-LARGE-OUTPUT-MARKER").length - 1,
				outputArtifactFileCount: outputFiles.length,
				matchingDigestFileCount: outputFiles.filter((path) => path.endsWith(`-${largeSha}.txt`)).length,
				nativeResultPresent: nativeAttempt !== undefined,
				nativeArtifactDigests: nativeAttempt?.artifacts.map((artifact) => artifact.digest),
				nativeArtifactSizes: nativeAttempt?.artifacts.map((artifact) => artifact.sizeBytes),
				nativeEvidenceCount: nativeAttempt?.evidence.length,
				projectedUri: latestStatus?.outputArtifactUri,
			};
			expect(
				e11Chain,
				"the large output is persisted, captured to disk, carried by the native attempt, and projected by status",
			).toEqual({
				persistedAssistantTextBytes: Buffer.byteLength(E11_LARGE),
				persistedMarkerCount: 1,
				outputArtifactFileCount: 2,
				matchingDigestFileCount: 1,
				nativeResultPresent: true,
				nativeArtifactDigests: [largeSha],
				nativeArtifactSizes: [Buffer.byteLength(E11_LARGE)],
				nativeEvidenceCount: expect.any(Number),
				projectedUri: nativeUri,
			});
			const artifactUri = latestStatus?.outputArtifactUri;
			if (typeof artifactUri !== "string") throw new Error("the latest status carries no artifact pointer");
			expect(artifactUri.startsWith("file:"), "the pointer is a file URI").toBe(true);
			const artifactPath = fileURLToPath(artifactUri);
			expect(String(world.io.readFileSync(artifactPath, "utf8")), "the artifact holds the exact raw output").toBe(
				E11_LARGE,
			);
			expect(
				artifactPath.endsWith(`-${createHash("sha256").update(E11_LARGE).digest("hex")}.txt`),
				"the file name carries the content digest",
			).toBe(true);
			expect(latestStatus?.outputArtifactSizeBytes, "the pointer size matches the bytes").toBe(
				Buffer.byteLength(E11_LARGE),
			);
			expect(followedStatus?.outputArtifactUri, "a small follow-up report borrows no older pointer").toBeUndefined();
			expect(historicalStatus?.outputArtifactUri, "the historical lane keeps its own pointer").toBe(artifactUri);
			// Two distinct large generations, then a small current report: each status names its own generation, and the
			// chunked root read of the first generation reconstructs the exact bytes that the host verifies by digest.
			const secondStatus = e11Status("e11-status-4");
			const secondUri = secondStatus?.outputArtifactUri;
			if (typeof secondUri !== "string") throw new Error("the second large status carries no artifact pointer");
			const secondPath = fileURLToPath(secondUri);
			// Exact generation pins: the second status names the attempt captured while it ran, its pointer and size are that attempt's
			// own result, and its persisted assistant text is the second report's exact bytes in the admitted conversation.
			const admittedConversation =
				session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[admitted.agentId]?.resumeContext.sessionFile;
			expect(admittedConversation, "the admitted resume context names its conversation file").toBeDefined();
			expect(secondStatus?.laneId, "the second status names the captured second attempt's task").toBe(
				e11Running.taskId,
			);
			const secondAttemptArtifact = session.backgroundLanes.getWorkerAttemptResult(e11Running.attemptId)
				?.artifacts[0];
			expect(
				{ uri: secondUri, sizeBytes: secondStatus?.outputArtifactSizeBytes },
				"the second pointer and size are the captured attempt's own artifact",
			).toEqual({ uri: secondAttemptArtifact?.uri, sizeBytes: secondAttemptArtifact?.sizeBytes });
			expect(
				createHash("sha256")
					.update(String(world.io.readFileSync(secondPath, "utf8")))
					.digest("hex"),
				"the file hashes to the attempt's own content digest",
			).toBe(secondAttemptArtifact?.digest);
			expect(
				secondAttemptArtifact?.metadata,
				"the attempt's artifact metadata names sha256 and completeness",
			).toMatchObject({
				digestAlgorithm: "sha256",
				complete: true,
			});
			expect(
				persistedGenerationText(world, "e11-report-2", admittedConversation),
				"the second report's persisted text is its exact bytes",
			).toBe(E11_LARGE_SECOND);
			expect(
				{
					agentId: secondStatus?.agentId,
					claimSummary: secondStatus?.claimSummary,
					sizeBytes: secondStatus?.outputArtifactSizeBytes,
				},
				"the second large status names the admitted agent, its own summary and its size",
			).toEqual({
				agentId: admitted.agentId,
				claimSummary: E11_REPORT_SECOND,
				sizeBytes: Buffer.byteLength(E11_LARGE_SECOND),
			});
			expect(secondPath, "the second generation has its own artifact file").not.toBe(artifactPath);
			expect(
				secondPath.endsWith(`-${createHash("sha256").update(E11_LARGE_SECOND).digest("hex")}.txt`),
				"the second artifact is named by its own digest",
			).toBe(true);
			expect(String(world.io.readFileSync(secondPath, "utf8")), "the second artifact holds the exact output").toBe(
				E11_LARGE_SECOND,
			);
			// Durable canonical read results by call id, without the provider envelope or the continuation notice.
			const readText = (toolCallId: string): string => {
				const entry = e11Branch.find(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolCallId === toolCallId,
				);
				if (entry?.type !== "message" || entry.message.role !== "toolResult") {
					throw new Error(`no durable read result for ${toolCallId}`);
				}
				return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			};
			const withoutReadEnvelope = (text: string): string =>
				text
					.replace(/^<untrusted_content[^>]*>\n?/, "")
					.replace(/\n?<\/untrusted_content>$/, "")
					.replace(/\n*\[Showing lines [^\n]*\]$/, "");
			expect(readText("e11-read-2"), "the final chunk announces no further continuation").not.toContain(
				"Use offset=",
			);
			const reconstructed = [readText("e11-read-1"), readText("e11-read-2")].map(withoutReadEnvelope).join("\n");
			expect(reconstructed, "the chunked root read reconstructs the exact first output").toBe(E11_LARGE);
			expect(
				createHash("sha256").update(reconstructed).digest("hex"),
				"the chunked bytes match the content digest the attempt carries",
			).toBe(largeSha);
			expect(
				createHash("sha256")
					.update(String(world.io.readFileSync(artifactPath, "utf8")))
					.digest("hex"),
				"the host reads the same bytes from the artifact file",
			).toBe(largeSha);
			// The same bounded goal continuation runs through each mode's native loop: semantic objective routing on,
			// ordinary goal continuation off. Goal and delegate remain available in both; no profile trims the root surface.
			// Checkpoint while the failed obligation stays open: the root compacts past the failed receipt, is disposed, and the
			// file-backed session reopens. The reopened root still refuses completion, and an unrelated successful read clears nothing.
			world.provider.enqueue("root", {
				name: "checkpoint-summary",
				reply: { content: [{ type: "text", text: CHECKPOINT_SUMMARY }] },
			});
			// Every judgment the checkpoint phase meets: the goal's own continuation cycles (objective-cycle routing, per-turn
			// step routing, and the completion gate). No user prompt is submitted here, so no intake family is declared.
			const checkpointJudgments = {
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				...completionJudgments,
				// The completion cycle after the host resume asks the claim and patch questions of the repaired, rechecked work.
				claim_supported: { kind: "noul", probability: 0.97 },
				patch_matches_requirements: { kind: "noul", probability: 0.97 },
				side_effects_acceptable: { kind: "noul", probability: 0.97 },
				work_remaining: { kind: "noul", probability: 0.97 },
				missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
				evidence_sufficient: { kind: "noul", probability: 0.02 },
				semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
				strategy_repetition: { kind: "noul", probability: 0.02 },
				context_stale: { kind: "noul", probability: 0.02 },
				independent_worker_required: { kind: "noul", probability: 0.02 },
				capability_escalation_required: { kind: "noul", probability: 0.02 },
				capability_gap_suspected: { kind: "noul", probability: 0.02 },
				completion_plausible: { kind: "noul", probability: 0.02 },
			} as const;
			// The exact trusted obligation identity before the checkpoint: every later check compares against these ids.
			const obligationsBefore = session.getVerificationObligations();
			expect(
				obligationsBefore.map((obligation) => obligation.command),
				"the failed run is the one open verification obligation",
			).toEqual([VITEST_COMMAND]);
			// Every earlier tool pair is dropped from the context, the failed run included: the obligation must outlive its receipt.
			world.systemOne.enterPhase("verify-checkpoint", checkpointJudgments, {
				families: {
					"keep_call::": { kind: "noul", probability: 0.02 },
					"keep_result::": { kind: "noul", probability: 0.02 },
				},
			});
			settlement.beforeCompact = settlementFacts(session, created.sessionManager, autonomy);
			const checkpoint = await withDeadline(
				trace,
				"checkpoint compaction",
				session.compact("Keep the limits task and its open verification."),
			);
			trace.mark("root", "checkpoint.compacted");
			settlement.afterApply = settlementFacts(session, created.sessionManager, autonomy);
			// The applied checkpoint persists the exact obligation snapshot the decorated details carry: trusted ids and the command.
			const persistedCheckpoint = created.sessionManager.getEntries().find((entry) => entry.type === "compaction");
			// Exact, not a subset: every captured obligation's id, command and cwd, as the native snapshot persisted them.
			const trustedDescriptions = obligationsBefore.map((obligation) => ({
				id: obligation.id,
				command: obligation.command,
				cwd: obligation.cwd,
			}));
			const persistedDetails = persistedCheckpoint?.type === "compaction" ? persistedCheckpoint.details : undefined;
			const persistedObligations =
				typeof persistedDetails === "object" &&
				persistedDetails !== null &&
				"piVerificationObligations" in persistedDetails
					? persistedDetails.piVerificationObligations
					: undefined;
			expect(
				persistedObligations,
				"the applied checkpoint keeps the exact verification obligation metadata",
			).toEqual({
				version: 1,
				activeIds: obligationsBefore.map((obligation) => obligation.id),
				descriptions: trustedDescriptions,
			});
			// Production rewrites the Active Task to the session's own task, so the applied summary is compared with the persisted entry.
			expect(checkpoint.summary, "the checkpoint summary keeps its open problem").toContain("## Open Problems");
			const persisted = created.sessionManager.getEntries().find((entry) => entry.type === "compaction");
			expect(
				persisted?.type === "compaction" ? persisted.summary : undefined,
				"the applied checkpoint is persisted",
			).toBe(checkpoint.summary);
			// Scripted before the reopen, in the order the root reaches them: the explicit refusal turn, then the goal's own idle
			// continuation, which repairs the limit, rechecks it, and completes the goal (the natural stop of the loop).
			world.provider.enqueue(
				"root",
				calls("read-after-reopen", [{ id: "read-after-reopen-1", name: "read", arguments: { path: LIMITS_PATH } }]),
				{
					name: "read-after-reopen-reported",
					check: (request) => assertBatchOk(request, "read-after-reopen"),
					reply: {
						content: [
							{ type: "toolCall", id: "complete-checkpoint-1", name: "goal", arguments: { action: "complete" } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "checkpoint-refusal-reported",
					check: (request) => {
						refusedGoal(
							request,
							"completion after the checkpoint and reopen",
							"active verification obligation(s) remain",
						);
						// The deliberate 1k recent-keep moves the kept tail past the failed run, so its output is outside the provider
						// context: the obligation must outlive a receipt the model can no longer see.
						// Exact identity, not only the output text: neither the failing call nor its result may be rebuilt into the context,
						// since redaction could erase the text while the receipt itself is retained.
						const replayedFailure = request.context.messages.some(
							(message) =>
								(message.role === "assistant" &&
									message.content.some(
										(block) => block.type === "toolCall" && block.id === "verify-fail-1",
									)) ||
								(message.role === "toolResult" && message.toolCallId === "verify-fail-1"),
						);
						if (replayedFailure || JSON.stringify(request.context.messages).includes("Tests  1 failed (1)")) {
							throw new Error(
								"the failed receipt (verify-fail-1) is still in the provider context after the checkpoint",
							);
						}
						// Trusted identity, not a summary word: the refusal names the exact obligation ids that were open before the
						// checkpoint, and the reopened root's own view reports those same ids and no others.
						const trustedIds = obligationsBefore.map((obligation) => obligation.id);
						const refusal = latestBatchResults(request).find((result) => result.toolName === "goal");
						if (!trustedIds.every((id) => refusal?.text.includes(id))) {
							throw new Error(`the refusal does not name ${JSON.stringify(trustedIds)}: ${refusal?.text ?? ""}`);
						}
						const reopenedIds = session.getVerificationObligations().map((obligation) => obligation.id);
						if (JSON.stringify(reopenedIds) !== JSON.stringify(trustedIds)) {
							throw new Error(
								`the reopened view reports ${JSON.stringify(reopenedIds)}, expected ${JSON.stringify(trustedIds)}`,
							);
						}
					},
					reply: { content: [{ type: "text", text: "The obligation survives the checkpoint and the reopen." }] },
				},
				calls("edit-back-to-five", [
					{
						id: "edit-five-2",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 4", newText: "MAX_RETRIES = 5" }] },
					},
				]),
				calls("vitest-recheck", [{ id: "verify-pass-2", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				calls("complete-final", [{ id: "complete-2", name: "goal", arguments: { action: "complete" } }]),
				{
					name: "completed",
					check: (request) => {
						assertBatchOk(request, "complete-final");
						if (!latestBatchResults(request).some((result) => result.text.includes("goal complete recorded"))) {
							throw new Error("the goal was not completed after the passing recheck cleared the obligation");
						}
					},
					reply: { content: [{ type: "text", text: "The goal is complete." }] },
				},
			);
			const checkpointFile = created.sessionManager.getSessionFile();
			if (checkpointFile === undefined) throw new Error("the checkpointed session has no file");
			expect(
				await world.disposeSessionInBody(session),
				"the checkpointed root must dispose cleanly",
			).toBeUndefined();
			created = await world.createRootSession("root", { sessionManager: world.openSessionManager(checkpointFile) });
			session = created.session;
			orchestrationRoot = session;
			session.subscribe((event) => {
				if (event.type === "warning") warnings.push(event.message);
			});
			trace.mark("root", "checkpoint.reopened");
			settlement.afterFreshOpen = settlementFacts(session, created.sessionManager, autonomy);
			// The host resume the CLI performs on --resume, --continue and --session (main.ts): it restores the goal runtime and arms
			// its idle continuation. Constructing the session alone does not. The scripted cycles then run the refusal, the repair,
			// the recheck and the completion; the idle wait covers every cycle.
			session.restoreGoalRuntimeAfterResume();
			settlement.afterHostResume = settlementFacts(session, created.sessionManager, autonomy);
			await withDeadline(trace, "auto-resumed goal settled", session.waitForForegroundIdle(), 90_000);
			settlement.afterAutoResume = settlementFacts(session, created.sessionManager, autonomy);
			trace.mark("root", "goal.completed");
			expect(
				session.getGoalStateSnapshot()?.status,
				`the host records the goal as completed; native settlement: ${JSON.stringify(settlement)}`,
			).toBe("completed");
			expect(
				getLatestGoalStateSnapshot(created.sessionManager)?.status,
				"the persisted goal snapshot agrees with the host",
			).toBe("completed");
			expect(
				receiptsOf(replayMailbox).filter(
					(receipt) => receipt.messageId === firstAdmission.messageId && receipt.kind === "control",
				),
				"one durable control receipt per idempotency key",
			).toHaveLength(1);
			// E7 (queued, never-started recovery through the claim path): an auxiliary file-backed root starts a held worker A and
			// queues a fresh worker B behind it under the natural concurrency cap. The owned files are captured while B is queued,
			// the old owner joins and disposes, the files are cut back to that capture, the owner pid advances, and a fresh root
			// recovers twice. B resumes from its queued state; A's busy lease is refused by the queued-context guard and never resumed.
			// The judgments a plain start prompt consumes (the same set as the J2 dispatch phase); nothing undeclared is scripted.
			const e7Judgments = {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			} as const;
			const e7AHeldReached = createBarrier();
			const e7AHeld = createBarrier();
			// B's completion reaches the recovered root as a wake turn; that turn, not foreground idleness, is what proves B ran.
			const e7WakeReached = createBarrier();
			let e7AHeldRequests = 0;
			world.provider.enqueueTrack("worker-a", "worker-a", undefined, {
				name: "e7-a-held",
				check: () => {
					e7AHeldRequests += 1;
					e7AHeldReached.release();
				},
				gate: e7AHeld.promise,
				reply: { content: [{ type: "text", text: "Worker A reports the held value." }] },
			});
			// One SQLite connection at a time: the active root's journey assertions are complete, so it disposes before the auxiliary root opens.
			expect(
				await world.disposeSessionInBody(session),
				"the active root disposes before the auxiliary root opens",
			).toBeUndefined();
			// E positive (stale background pass, failure first): the main root has completed and disposed. An auxiliary native root, with no goal, runs the
			// failing check, then a matching background pass starts and is held. The pass is released while that root is idle, so its exact background
			// terminal hands off to the idle root, which consumes it; the obligation the failure opened clears on that handoff.
			const eBgGate = createBarrier();
			const eWake = createBarrier();
			const eAux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const eSession = eAux.session;
			const eJudgments = {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				...completionStates,
				shows_true_0: { kind: "noul", probability: 0.97 },
				shows_false_0: { kind: "noul", probability: 0.02 },
			} as const;
			world.shell.enqueue(
				{ name: "e-fail-stale", command: VITEST_COMMAND, output: vitestFailed, exitCode: 1 },
				{
					name: "e-pass-stale-bg",
					command: VITEST_COMMAND,
					output: vitestPassed,
					exitCode: 0,
					gate: eBgGate.promise,
				},
			);
			let eBgTaskId: string | undefined;
			world.provider.enqueue(
				"root",
				calls("e-fail", [{ id: "e-fail-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				{
					name: "e-fail-reported",
					check: (request) => {
						const run = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (run?.isError !== true)
							throw new Error(`the stale failure did not report a failed check: ${run?.text ?? "no result"}`);
					},
					reply: { content: [{ type: "text", text: "The stale check failed." }] },
				},
				calls("e-bg-start", [
					{ id: "e-bg-1", name: "bash", arguments: { command: VITEST_COMMAND, background: true } },
				]),
				{
					name: "e-bg-started",
					check: (request) => {
						eBgTaskId = backgroundTaskIdOf(request);
					},
					reply: { content: [{ type: "text", text: "The background check is running." }] },
				},
				{
					name: "e-wake",
					check: (request) => {
						if (eBgTaskId === undefined || !handoffFor(request, eBgTaskId)) {
							throw new Error("the background terminal does not reach the idle root");
						}
						eWake.release();
					},
					reply: { content: [{ type: "text", text: "The stale pass handed off." }] },
				},
			);
			world.systemOne.enterPhase("e-fail", eJudgments);
			await withDeadline(trace, "E aux failure reported", eSession.prompt("Run the stale check."));
			const eFailIds = eSession.getVerificationObligations().map((obligation) => obligation.id);
			expect(eFailIds.length, "the stale failure opens exactly one obligation").toBe(1);
			world.systemOne.enterPhase("e-bg", eJudgments);
			await withDeadline(trace, "E aux background pass started", eSession.prompt("Start the background check."));
			expect(
				eSession.getVerificationObligations().map((obligation) => obligation.id),
				"the held background pass leaves the failure's obligation open",
			).toEqual(eFailIds);
			eBgGate.release();
			await withDeadline(trace, "E aux handoff reached the idle root", eWake.promise, 120_000);
			await withDeadline(trace, "E aux settled", eSession.waitForForegroundIdle(), 120_000);
			expect(
				eSession.getVerificationObligations().map((obligation) => obligation.id),
				"the background terminal's handoff clears the failure's obligation",
			).toEqual([]);
			const eRecord = loadBackgroundToolTaskRecordsNewestFirst(eAux.sessionManager).find(
				(record): record is BackgroundToolTaskRecord => isRecordObject(record) && record.taskId === eBgTaskId,
			);
			expect(eRecord?.toolCallId, "the canonical background record names the held pass call").toBe("e-bg-1");
			expect(eRecord?.status, "the canonical background record is the completed terminal").toBe("completed");
			expect(eRecord?.terminalDelivery, "the terminal was delivered to the idle root").toBe("delivered");
			expect(eRecord?.piVerification?.status, "the canonical record carries the passing verification receipt").toBe(
				"passed",
			);
			expect(
				await world.disposeSessionInBody(eSession),
				"the auxiliary stale-pass root disposes cleanly",
			).toBeUndefined();
			trace.mark("root", "e-stale-pass");
			// E9 stall threshold, legacy goal mode: an auxiliary root holds an open requirement and its initial turn is held after admission.
			// The goal loop waits for that turn to settle, then twenty-one text-only continuation turns each record an implicit no_progress.
			if (!world.systemOne.enabled) {
				const e9Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
				const e9Session = e9Aux.session;
				const e9InitialReached = createBarrier();
				const e9Gate = createBarrier();
				const e9Seen: { snapshot?: ReturnType<typeof e9Session.getGoalRuntimeSnapshot>; recovery?: boolean } = {};
				world.provider.enqueue(
					"root",
					calls("e9-goal-start", [
						{
							id: "e9-goal-1",
							name: "goal",
							arguments: { action: "start", goalId: "e9-goal", userGoal: "Keep the limit at 5." },
						},
					]),
					calls("e9-requirement", [
						{
							id: "e9-req-1",
							name: "goal",
							arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
						},
					]),
					text("e9-goal-ready", "The goal is ready."),
					{
						name: "e9-initial",
						check: () => e9InitialReached.release(),
						gate: e9Gate.promise,
						reply: { content: [{ type: "text", text: "Working on the goal." }] },
					},
				);
				for (let turn = 1; turn <= 21; turn += 1) {
					world.provider.enqueue(
						"root",
						turn === 21
							? {
									name: "e9-continuation-21",
									check: (request) => {
										e9Seen.snapshot = e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
										e9Seen.recovery = requestTexts(request).some((value) =>
											value.includes("RECOVERY REQUIRED: 20 turns"),
										);
									},
									reply: { content: [{ type: "text", text: "No change yet." }] },
								}
							: text(`e9-continuation-${turn}`, "No change yet."),
					);
				}
				world.systemOne.enterPhase("e9-goal", {});
				await withDeadline(
					trace,
					"E9 goal ready",
					e9Session.prompt("Set up the goal.", { autoContinueGoal: false }),
				);
				const e9Before = e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
				expect(
					e9Before.continuation.openRequirementIds.length,
					"the setup leaves exactly one open requirement",
				).toBe(1);
				const e9Initial = e9Session.prompt("Work on the goal.", { autoContinueGoal: false });
				await withDeadline(trace, "E9 initial turn admitted", e9InitialReached.promise);
				const e9Loop = e9Session.continueGoalLoop({ maxTurns: 21, maxStallTurns: 20 });
				e9Gate.release();
				await withDeadline(trace, "E9 initial turn", e9Initial);
				const e9Result = await withDeadline(trace, "E9 goal loop", e9Loop, 300_000);
				const e9Snapshot = e9Seen.snapshot;
				expect(e9Snapshot?.goalState?.goalId, "the loop reaches the aux goal's twenty-first request").toBe(
					"e9-goal",
				);
				expect(
					e9Snapshot?.goalState?.progressRevision,
					"no progress was recorded, so the revision is unchanged",
				).toBe(e9Before.goalState?.progressRevision);
				expect(e9Snapshot?.continuation.action, "the stall threshold continues, it never stops").toBe("continue");
				expect(e9Snapshot?.continuation.reasonCode, "the threshold is named stall_limit_reached").toBe(
					"stall_limit_reached",
				);
				expect(e9Snapshot?.continuation.stallTurns, "twenty unchanged turns have run").toBe(20);
				expect(e9Snapshot?.continuation.maxStallTurns, "the configured threshold is twenty").toBe(20);
				expect(e9Snapshot?.continuation.openRequirementIds, "the open requirement stays open").toEqual(
					e9Before.continuation.openRequirementIds,
				);
				expect(e9Seen.recovery, "the twenty-first continuation carries the recovery instruction").toBe(true);
				expect(e9Result.stopReason, "the host invocation cap ends the loop after twenty-one turns").toBe(
					"max_turns_reached",
				);
				expect(e9Result.turnsSubmitted, "twenty-one continuation turns were submitted").toBe(21);
				expect(
					await world.disposeSessionInBody(e9Session),
					"the E9 auxiliary goal root disposes cleanly",
				).toBeUndefined();
				trace.mark("root", "e9-stall-legacy");
			}
			// E9 ON is host-driven: explicit continueGoalLoop({ maxTurns: 1 }) calls drive each cycle. The setup prompt passes
			// autoContinueGoal:false, so no scheduled auto-continue runs in this block. This qualifies E9 only; the default workflow and
			// global continuation policy are unchanged.
			// E9 stall threshold, objective-primary mode: three one-turn goal cycles on one objective. The first two route to implement with equal
			// reason codes; the third repeats the strategy and replans. Each route is read from the native controller and matched to its ledger row by cycle.
			if (world.systemOne.enabled) {
				const e9Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
				const e9Session = e9Aux.session;
				world.provider.enqueue(
					"root",
					calls("e9-goal-start", [
						{
							id: "e9-goal-1",
							name: "goal",
							arguments: { action: "start", goalId: "e9-goal", userGoal: "Keep the limit at 5." },
						},
					]),
					calls("e9-requirement", [
						{
							id: "e9-req-1",
							name: "goal",
							arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
						},
					]),
					text("e9-goal-ready", "The goal is ready."),
				);
				world.systemOne.enterPhase("e9-goal", {
					capabilities_authorized: { kind: "noul", probability: 0.02 },
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				});
				await withDeadline(
					trace,
					"E9 goal ready",
					e9Session.prompt("Set up the goal.", { autoContinueGoal: false }),
				);
				expect(
					e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 }).continuation.openRequirementIds.length,
					"the setup leaves exactly one open requirement",
				).toBe(1);
				// The cycle pattern of the orchestration objective cycle, routed to the executable edit path; the third cycle reports a repeated strategy.
				// Judgment groups by cycle. Objective intake is asked once, in the first cycle; the implement turn is checked for its patch and side effects;
				// the replan turn is checked for its repairs. The strategy_repetition answer is the only difference between the implement and replan groups.
				const e9Intake = {
					objective_coherent: { kind: "noul", probability: 0.97 },
					ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
					missing_information: { kind: "noul", probability: 0.02 },
					acceptance_complete: { kind: "noul", probability: 0.97 },
					grounding_sufficient: { kind: "noul", probability: 0.97 },
				} as const;
				const e9Shared = {
					work_remaining: { kind: "noul", probability: 0.97 },
					missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
					evidence_sufficient: { kind: "noul", probability: 0.97 },
					semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
					context_stale: { kind: "noul", probability: 0.02 },
					independent_worker_required: { kind: "noul", probability: 0.02 },
					capability_escalation_required: { kind: "noul", probability: 0.02 },
					capability_gap_suspected: { kind: "noul", probability: 0.02 },
					completion_plausible: { kind: "noul", probability: 0.02 },
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "edit", confidence: 0.97 },
					claim_supported: { kind: "noul", probability: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				} as const;
				const e9Implement = {
					strategy_repetition: { kind: "noul", probability: 0.02 },
					patch_matches_requirements: { kind: "noul", probability: 0.97 },
					side_effects_acceptable: { kind: "noul", probability: 0.97 },
				} as const;
				const e9Replan = {
					strategy_repetition: { kind: "noul", probability: 0.97 },
					repairs_sufficient: { kind: "noul", probability: 0.97 },
					root_cause_addressed: { kind: "noul", probability: 0.97 },
				} as const;
				const e9CycleJudgments = (cycle: number): Parameters<typeof world.systemOne.enterPhase>[1] => {
					if (cycle === 1) return { ...e9Shared, ...e9Intake, ...e9Implement };
					if (cycle === 2) return { ...e9Shared, ...e9Implement };
					return { ...e9Shared, ...e9Replan };
				};
				// The transport text each cycle's root request actually received, keyed by cycle.
				const e9CycleTexts = new Map<number, string[]>();
				// The E9 intake criteria bound to the native objective, counted before each answer; the cycle-1 callback is their only producer.
				const e9IntakeBinding = { criteria: 0 };
				const e9Routes: ObjectiveRoute[] = [];
				for (const cycle of [1, 2, 3]) {
					world.systemOne.enterPhase(
						`e9-cycle-${cycle}`,
						e9CycleJudgments(cycle),
						cycle === 1
							? {
									expect: (request) => {
										if (!isRecordObject(request.state) || !("acceptanceCriteria" in request.state)) return;
										const record =
											e9Session.backgroundLanes.getTaskRuntimeSnapshot()?.objectives[
												goalObjectiveId("e9-goal")
											]?.objective;
										if (record === undefined)
											throw new Error("the native runtime holds no objective for the E9 goal at intake");
										const requirements = e9Session.getGoalStateSnapshot()?.requirements ?? [];
										const decoded = request.state.acceptanceCriteria;
										if (!Array.isArray(decoded))
											throw new Error("the E9 intake carries no acceptance criteria list");
										expect(decoded.length, "the intake transports every native acceptance criterion").toBe(
											record.acceptanceCriteria.length,
										);
										for (const [index, native] of record.acceptanceCriteria.entries()) {
											const item: unknown = decoded[index];
											const requirement = requirements.find((candidate) => candidate.id === native.id);
											expect(
												isRecordObject(item) &&
													item.id === native.id &&
													item.description === native.description,
												`intake criterion ${index} is the native objective criterion`,
											).toBe(true);
											expect(
												requirement?.text === native.description,
												`intake criterion ${index} is the goal requirement text`,
											).toBe(true);
											e9IntakeBinding.criteria += 1;
										}
									},
								}
							: undefined,
					);
					world.provider.enqueue("root", {
						name: `e9-cycle-root-${cycle}`,
						check: (request) => {
							e9CycleTexts.set(cycle, requestTexts(request));
						},
						reply: { content: [{ type: "text", text: `Objective cycle ${cycle} reply.` }] },
					});
					const result = await withDeadline(
						trace,
						`E9 cycle ${cycle}`,
						e9Session.continueGoalLoop({ maxTurns: 1, maxStallTurns: 20 }),
						120_000,
					);
					expect(result.stopReason, `cycle ${cycle} submits its one root turn`).toBe("max_turns_reached");
					expect(result.turnsSubmitted, `cycle ${cycle} submits exactly one turn`).toBe(1);
					const route = e9Session.objectiveExecutionController?.getLastRoute();
					if (route === undefined) throw new Error(`E9 cycle ${cycle} recorded no objective route`);
					e9Routes.push(route);
				}
				expect(new Set(e9Routes.map((route) => route.cycle_id)).size, "each cycle has its own route identity").toBe(
					3,
				);
				expect(e9Routes[0]?.route, "the first cycle routes to implement").toBe("implement");
				expect(e9Routes[0]?.reason_codes, "the first cycle names its implementation reason").toEqual([
					"implementation_required",
				]);
				expect(e9Routes[1]?.route, "the second cycle routes to implement as well").toBe("implement");
				expect(e9Routes[1]?.reason_codes, "the first two routes carry equal reason codes").toEqual(
					e9Routes[0]?.reason_codes,
				);
				expect(e9Routes[2]?.route, "the third cycle replans on the repeated strategy").toBe("replan");
				expect(e9Routes[2]?.reason_codes, "the third route names the repeated strategy").toEqual([
					"strategy_repetition_detected",
				]);
				for (const [index, route] of e9Routes.entries()) {
					const owner = buildObjectiveRoutePrompt(route).text;
					expect(
						e9CycleTexts.get(index + 1)?.some((value) => value.includes(owner)) ?? false,
						`cycle ${index + 1} transport carries the owner route text for ${route.route}`,
					).toBe(true);
				}
				expect(
					e9IntakeBinding.criteria,
					"the E9 intake binds the native criteria before its answer",
				).toBeGreaterThan(0);
				const e9Objective = e9Routes[0]?.objective_id;
				if (e9Objective === undefined) throw new Error("E9 has no objective id");
				const e9Ledger = e9Session.getDecisionLedger()?.recentRoutes(e9Session.sessionId, e9Objective, 8) ?? [];
				const e9Matched = e9Routes.map((route) => e9Ledger.filter((row) => row.cycleId === route.cycle_id));
				e9Matched.forEach((rows, index) => {
					const route = e9Routes[index];
					if (route === undefined) throw new Error("E9 route index out of range");
					expect(rows, `cycle ${route.cycle_id} has exactly one ledger row`).toHaveLength(1);
					const [row] = rows;
					expect(row?.route, `the ledger row for cycle ${route.cycle_id} carries the route`).toBe(route.route);
					expect(
						row?.reasonCodes,
						`the ledger row for cycle ${route.cycle_id} carries the route's reason codes`,
					).toEqual(route.reason_codes);
					expect(row?.executor, `cycle ${route.cycle_id} is executed by the root`).toBe("root");
					expect(typeof row?.evidenceMarker, `cycle ${route.cycle_id} row carries a numeric evidence marker`).toBe(
						"number",
					);
				});
				const e9Markers = e9Matched.map((rows) => rows[0]?.evidenceMarker);
				expect(
					e9Markers,
					"the three matched rows share one evidence marker: no new evidence separates the replan from the implement cycles",
				).toEqual([e9Markers[0], e9Markers[0], e9Markers[0]]);
				expect(
					await world.disposeSessionInBody(e9Session),
					"the E9 auxiliary objective root disposes cleanly",
				).toBeUndefined();
				trace.mark("root", "e9-stall-objective");
			}
			const e7Owner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			// Explicit scenario host configuration: the native global layer keeps its existing workerDelegation fields and sets the cap.
			const e7GlobalDelegation = world.settingsManager.getGlobalSettings().workerDelegation ?? {};
			world.settingsManager.setWorkerDelegationSettings({ ...e7GlobalDelegation, maxConcurrent: 1 });
			expect(
				world.settingsManager.getWorkerDelegationSettings().maxConcurrent,
				"the scenario caps workers at one",
			).toBe(1);
			world.provider.enqueue(
				"root",
				calls("e7-start-a", [
					{
						id: "e7-start-a-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							instructions: "Read the limits file, then hold.",
							readOnly: true,
						},
					},
				]),
				{ name: "e7-a-reported", reply: { content: [{ type: "text", text: "Worker A is started." }] } },
			);
			world.systemOne.enterPhase("e7-start", e7Judgments, {
				expect: expectOwnerWords({
					sessionManager: () => e7Owner.sessionManager,
					userRequests: ["Start the held check."],
					optionalToolNames: ["secret_store"],
				}),
			});
			await withDeadline(trace, "E7 start A", e7Owner.session.prompt("Start the held check."));
			await withDeadline(trace, "E7 worker A held at its first request", e7AHeldReached.promise, 90_000);
			// B starts only after A is physically held, so A's running lease is what the natural cap counts.
			world.provider.enqueue(
				"root",
				calls("e7-start-b", [
					{
						id: "e7-start-b-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-b" },
							instructions: "Report the current limits value.",
						},
					},
				]),
				{ name: "e7-b-reported", reply: { content: [{ type: "text", text: "Worker B is queued." }] } },
			);
			world.systemOne.enterPhase("e7-queue", e7Judgments, {
				expect: expectOwnerWords({
					sessionManager: () => e7Owner.sessionManager,
					userRequests: ["Queue the second check behind it."],
					optionalToolNames: ["secret_store"],
				}),
			});
			await withDeadline(trace, "E7 queue B", e7Owner.session.prompt("Queue the second check behind it."));
			const e7Start = (toolCallId: string): { started: boolean; agentId: string; laneId: string; text: string } => {
				const entry = e7Owner.sessionManager
					.getBranch()
					.find(
						(candidate) =>
							candidate.type === "message" &&
							candidate.message.role === "toolResult" &&
							candidate.message.toolCallId === toolCallId,
					);
				if (entry?.type !== "message" || entry.message.role !== "toolResult") {
					throw new Error(`no durable start result for ${toolCallId}`);
				}
				const details = entry.message.details as
					| { started?: unknown; agentId?: unknown; laneId?: unknown }
					| undefined;
				if (typeof details?.agentId !== "string" || typeof details.laneId !== "string") {
					throw new Error(`the start result ${toolCallId} carries no agent or lane id`);
				}
				return {
					started: details.started === true,
					agentId: details.agentId,
					laneId: details.laneId,
					text: entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				};
			};
			const e7StartA = e7Start("e7-start-a-1");
			const e7StartB = e7Start("e7-start-b-1");
			expect({ a: e7StartA.started, b: e7StartB.started }, "both starts are accepted").toEqual({ a: true, b: true });
			expect(
				e7StartB.text.includes("capacity: 1 running of 1 allowed"),
				`B queues behind the natural capacity cap; its start receipt: ${e7StartB.text}`,
			).toBe(true);
			const e7Runtime = e7Owner.session.backgroundLanes.getTaskRuntimeSnapshot();
			if (e7Runtime === undefined) throw new Error("the auxiliary owner has no task runtime snapshot");
			const e7AttemptOf = (laneId: string) =>
				Object.values(e7Runtime.attempts)
					.filter((attempt) => attempt.taskId === laneId)
					.at(-1);
			expect(
				{
					bAgent: e7Runtime.agents[e7StartB.agentId]?.status,
					bActiveAttempt: e7Runtime.agents[e7StartB.agentId]?.activeAttemptId,
					bAttempt: e7AttemptOf(e7StartB.laneId)?.status,
					bLease: e7AttemptOf(e7StartB.laneId)?.lease,
				},
				"B is registered and queued with no lease or active attempt",
			).toEqual({ bAgent: "registered", bActiveAttempt: undefined, bAttempt: "queued", bLease: undefined });
			expect(e7AttemptOf(e7StartA.laneId)?.lease, "A holds a live lease at the cut").toBeDefined();
			// A's native authority is read-only and nonreserving: no edit, write, or python tool, and no write lease at the cut.
			expect(e7StartA.text, "A's granted tools exclude every editing tool").not.toMatch(
				/tools: [^;]*\b(edit|write|python)\b/,
			);
			const e7PreCutWorkers = e7Owner.session.getResourceSnapshot().workers;
			if (e7PreCutWorkers === undefined)
				throw new Error("the auxiliary owner reports no worker snapshot before the cut");
			expect(
				e7PreCutWorkers.reservations.heldLeases.filter((lease) => lease.taskId === e7StartA.laneId),
				"A holds no write reservation",
			).toEqual([]);
			// B's birth: a registered agent with no context origin, one birth attempt, and no agent, lease, or grant yet.
			const e7BTask = e7Runtime.tasks[e7StartB.laneId];
			const e7BAgent = e7Runtime.agents[e7StartB.agentId];
			const e7BAttempt = e7AttemptOf(e7StartB.laneId);
			expect(
				{
					contextOrigin: e7BAgent?.contextOrigin,
					attemptCount: e7BTask?.attemptIds.length,
					agentId: e7BAttempt?.agentId,
					lease: e7BAttempt?.lease,
					grantId: e7BAttempt?.grantId,
					grant: e7BAttempt?.grant,
				},
				"B is a fresh birth: no context origin, one birth attempt, and no agent, lease, or grant yet",
			).toEqual({
				contextOrigin: undefined,
				attemptCount: 1,
				agentId: undefined,
				lease: undefined,
				grantId: undefined,
				grant: undefined,
			});
			const e7BClaim = e7PreCutWorkers.ownedProjectClaims.find(
				(claim) => claim.sessionId === e7Runtime.agents[e7StartB.agentId]?.resumeContext.sessionId,
			);
			expect(e7BClaim?.claim.parentSessionId, "B's busy context is owned by the auxiliary parent").toBe(
				e7Owner.sessionManager.getSessionId(),
			);
			expect(
				e7BClaim?.claim.incarnation.startsWith(`pi-worker:${world.processTable.self}:`),
				"B's busy claim names this process as its owner",
			).toBe(true);
			// Owned files: the auxiliary session file, captured with the bounded referenced manifest below before any owner ends.
			const e7AuxFile = e7Owner.sessionManager.getSessionFile();
			if (e7AuxFile === undefined) throw new Error("the auxiliary root has no session file");
			const e7Context = (agentId: string): string => {
				const sessionId = e7Runtime.agents[agentId]?.resumeContext.sessionId;
				if (sessionId === undefined) throw new Error(`no resume context for ${agentId}`);
				return sessionId;
			};
			// Native conversation reads, taken once before the cut: each worker's validated project-context binding (enrollment included,
			// read-only) and its durable birth fork reference, which exists even for an empty fresh-birth snapshot.
			const e7Store = new WorkerConversationStore();
			const e7Native = new Map(
				[e7StartA.agentId, e7StartB.agentId].map((agentId) => {
					const agent = e7Runtime.agents[agentId];
					if (agent === undefined) throw new Error(`no binding for ${agentId}`);
					const options = {
						agentDir: world.agentDir,
						resumeContext: agent.resumeContext,
						expectedLogicalAgentId: agentId,
					};
					return [
						agentId,
						{
							binding: e7Store.getProjectContextBinding(options),
							birth: e7Store.open(options).getBirthContextForkReference(),
							dispatch: e7AttemptOf(agentId)?.dispatch.birthContextForkReference,
						},
					] as const;
				}),
			);
			// The canonical referenced manifest, bounded and explicit: the auxiliary session file, the control-plane children of this parent
			// (without the SQLite store or live work-lease markers), each worker's session file and sidecar, the specialization file its native
			// binding names, and the birth fork file its native reference names. A missing optional file is absent; a cap breach fails.
			const E7_MAX_FILES = 512;
			const E7_MAX_BYTES = 8 * 1024 * 1024;
			const e7Manifest = (): Map<string, string> => {
				const entries = world.io.fileEntries();
				const selected = new Map<string, string>();
				const take = (path: string | undefined): void => {
					if (path === undefined) return;
					const content = entries.get(path);
					if (content !== undefined) selected.set(path, content);
				};
				take(e7AuxFile);
				for (const [path, content] of bundleEntries(
					entries,
					orchestrationSessionDir(world.agentDir, e7Owner.sessionManager.getSessionId()),
				)) {
					selected.set(path, content);
				}
				for (const agentId of [e7StartA.agentId, e7StartB.agentId]) {
					const sessionFile = e7Runtime.agents[agentId]?.resumeContext.sessionFile;
					if (sessionFile === undefined) throw new Error(`no session file for ${agentId}`);
					take(sessionFile);
					take(`${sessionFile}.worker.json`);
					const native = e7Native.get(agentId);
					if (native?.binding !== undefined) {
						take(workerProjectSpecializationFile(world.agentDir, native.binding.specializationKey));
					}
					if (native?.birth !== undefined) {
						take(
							workerContextForkFile(
								world.agentDir,
								e7Owner.sessionManager.getSessionId(),
								native.birth.identityDigest,
								native.birth.contentDigest,
							),
						);
					}
				}
				const bytes = [...selected.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
				if (selected.size > E7_MAX_FILES || bytes > E7_MAX_BYTES) {
					throw new Error(`the E7 manifest exceeds its caps: ${selected.size} files, ${bytes} bytes`);
				}
				return selected;
			};
			const e7Capture = e7Manifest();
			// Native facts before the cut: each binding is busy, and each birth reference names a file the manifest captured.
			for (const [agentId, native] of e7Native) {
				expect(native.binding?.ownership.state, `${agentId}'s native project-context binding is busy`).toBe("busy");
				// The native binding owns exactly the pre-cut claim, and its reference names this aux parent and this worker.
				const preCutClaim = e7PreCutWorkers.ownedProjectClaims.find(
					(claim) => claim.sessionId === e7Runtime.agents[agentId]?.resumeContext.sessionId,
				)?.claim;
				expect(native.binding?.ownership.claim, `${agentId}'s binding owns its pre-cut claim`).toEqual(preCutClaim);
				expect(native.binding?.reference.parentSessionId, `${agentId}'s binding names the aux parent`).toBe(
					e7Owner.sessionManager.getSessionId(),
				);
				expect(native.binding?.reference.logicalAgentId, `${agentId}'s binding names its own worker`).toBe(agentId);
				// The attempt's dispatch carries the birth fork reference, which must be the one its conversation holds.
				expect(native.birth, `${agentId} has a durable birth fork reference`).toBeDefined();
				expect(native.dispatch, `${agentId}'s dispatch carries the reference its conversation holds`).toEqual(
					native.birth,
				);
				if (native.birth !== undefined) {
					const forkFile = workerContextForkFile(
						world.agentDir,
						e7Owner.sessionManager.getSessionId(),
						native.birth.identityDigest,
						native.birth.contentDigest,
					);
					expect(e7Capture.has(forkFile), `${agentId}'s birth fork reference names a captured file`).toBe(true);
				}
			}
			// A's exact retained claim, predeclared from its pre-cut identity: the original owner keeps it by design after disposal.
			const e7APreClaim = (e7Owner.session.getResourceSnapshot().workers?.ownedProjectClaims ?? []).find(
				(claim) => claim.sessionId === e7Context(e7StartA.agentId),
			);
			if (e7APreClaim === undefined) throw new Error("A holds no project claim before the cut");
			const e7ARetainedClaims: WorkerProjectClaims = [
				{
					...e7APreClaim,
					agents: [
						{
							agentId: e7StartA.agentId,
							agentStatus: "suspended",
							attemptId: e7AttemptOf(e7StartA.laneId)?.attemptId,
							attemptStatus: "suspended",
							executingHoldCount: 0,
							mailboxLoaded: true,
							mailbox: {
								parentSessionId: e7Owner.sessionManager.getSessionId(),
								agentId: e7StartA.agentId,
								listenerCount: 0,
								hasOpenObligation: false,
								pendingMessageIds: [],
								replyAcknowledgementIds: [],
							},
						},
					],
				},
			];
			expect(
				await world.disposeSessionInBody(e7Owner.session),
				"the auxiliary owner disposes cleanly",
			).toBeUndefined();
			// Physical join of the transport producers the disposed owner started: registrations and pending scripts stay for the fresh owner.
			await world.provider.waitForProducers();
			expect(world.provider.failures, "no transport callback failed during the old owner's life").toEqual([]);
			// Certified from the disposed owner itself, before any prefix is restored: the receipt names exactly A's predeclared claim.
			world.certifyDisposedOwner(e7Owner.session, e7ARetainedClaims);
			// Cut back to the capture: restore every captured owned file byte for byte and remove post-cut extras; SQLite is not rewound.
			for (const [path] of e7Manifest()) {
				if (!e7Capture.has(path)) world.io.unlinkSync(path);
			}
			// Directories are not captured as files: the original owner's disposal may have removed a lease directory, so each parent is recreated first.
			for (const [path, content] of e7Capture) {
				world.io.mkdirSync(resolve(path, ".."), { recursive: true });
				world.io.writeFileSync(path, content);
			}
			expect(e7Manifest(), "the cut restores exactly the captured owned files").toEqual(e7Capture);
			world.processTable.advanceProcess();
			const e7Fresh = await world.createRootSession("root", { sessionManager: world.openSessionManager(e7AuxFile) });
			expect(
				world.settingsManager.getWorkerDelegationSettings().maxConcurrent,
				"the recovered owner keeps the scenario cap",
			).toBe(1);
			// Only the CURRENT tail may answer a wake: a user-role worker handoff whose header names one of the phase's lanes. Earlier
			// history never counts, so unrelated words in old turns cannot admit a wake.
			const e7IsHandoffWake = (request: ScriptedRequest, lanes: readonly string[]): boolean => {
				const tail = request.context.messages.at(-1);
				if (tail?.role !== "user") return false;
				const text = JSON.stringify(tail);
				return (
					text.includes("Background worker terminal handoff") && lanes.some((lane) => text.includes(`- ${lane}:`))
				);
			};
			const e7WorkerHandoff = (request: ScriptedRequest, laneId: string, status: string): boolean => {
				const tail = request.context.messages.at(-1);
				if (tail?.role !== "user") return false;
				const text = JSON.stringify(tail);
				return text.includes("Background worker terminal handoff") && text.includes(`- ${laneId}: ${status}`);
			};
			// B's birth is a real admitted read and a truthful submitted report of the bytes it read.
			world.provider.enqueue(
				"worker-b",
				calls("e7-b-read", [{ id: "e7-b-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
				{
					...calls("e7-b-report", [
						{
							id: "e7-b-report-1",
							name: "submit_report",
							arguments: { status: "completed", summary: "The limits file holds MAX_RETRIES = 5." },
						},
					]),
					check: (request) => {
						const read = latestBatchResults(request).find((result) => result.toolName === "read");
						if (!read?.text.includes("MAX_RETRIES = 5")) {
							throw new Error(`B's read did not show the limits value: ${read?.text ?? "no read result"}`);
						}
					},
				},
			);
			// The recovered root's first prompt reply precedes B's wake turn; the prompt's foreground-idle boundary is what drains the queue.
			world.provider.enqueue("root", {
				name: "e7-resume-reported",
				reply: { content: [{ type: "text", text: "The restart is noted." }] },
			});
			// B's completion reaches the recovered root as a wake turn, possibly coalesced with earlier turns: the step answers each root
			// request until the production context carries B's succeeded handoff, and only then is the wake proven.
			world.provider.enqueue("root", {
				name: "e7-wake",
				maxRequests: 8,
				check: (request) => {
					if (!e7IsHandoffWake(request, [e7StartA.laneId, e7StartB.laneId])) {
						throw new Error("B's wake was not triggered by a user handoff");
					}
				},
				until: (request) => {
					const done = e7WorkerHandoff(request, e7StartB.laneId, "succeeded");
					if (done) e7WakeReached.release();
					return done;
				},
				reply: { content: [{ type: "text", text: "Background work is still settling." }] },
			});
			// Recovery is entered twice on purpose, after the tracks it resumes are queued. The first pass reconciles the cut; the
			// second pass must change no owned file.
			e7Fresh.session.getLaneRecords();
			const e7AfterFirstRecovery = e7Manifest();
			e7Fresh.session.getLaneRecords();
			expect(e7Manifest(), "a second recovery pass changes no owned file").toEqual(e7AfterFirstRecovery);
			world.systemOne.enterPhase("e7-resume", e7Judgments, {
				expect: expectOwnerWords({
					sessionManager: () => e7Fresh.sessionManager,
					userRequests: ["Continue after the restart."],
					optionalToolNames: ["secret_store"],
				}),
			});
			await withDeadline(trace, "E7 recovered root turn", e7Fresh.session.prompt("Continue after the restart."));
			await withDeadline(trace, "E7 B wake reached the recovered root", e7WakeReached.promise, 120_000);
			await withDeadline(trace, "E7 recovered work settled", e7Fresh.session.waitForForegroundIdle(), 120_000);
			expect(e7AHeldRequests, "A's held request is never resumed after the cut").toBe(1);
			const e7Settled = e7Fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
			if (e7Settled === undefined) throw new Error("the recovered owner has no task runtime snapshot");
			// B's birth attempt and its compiled contract survive the fresh recovery unchanged, now bound to B's own agent.
			const e7BSettled = Object.values(e7Settled.attempts)
				.filter((attempt) => attempt.taskId === e7StartB.laneId)
				.at(-1);
			expect(
				{ attemptId: e7BSettled?.attemptId, dispatch: e7BSettled?.dispatch, agentId: e7BSettled?.agentId },
				"B's birth attempt and its compiled contract survive the fresh recovery",
			).toEqual({ attemptId: e7BAttempt?.attemptId, dispatch: e7BAttempt?.dispatch, agentId: e7StartB.agentId });
			// Post-birth native control through the public seam: the recovered owner admits one follow-up to B with an explicit replay key,
			// a thread, and an expected reply. B's turn is held after the control is delivered; B's answer is then recorded through the public
			// reply path against the admitted message; only then is B released. Its handoff must name the admitted lane, and replaying the same
			// options after the tail settles returns the same message and starts nothing.
			const e7FollowUpKey = "e7-follow-up-1";
			const e7FollowUpThread = "e7-thread-1";
			const e7FollowUpMessage = "The confirmed retry count is 5.";
			const e7FollowUpOptions = { threadId: e7FollowUpThread, expectReply: true, idempotencyKey: e7FollowUpKey };
			const e7FollowUpWake = createBarrier();
			const e7FollowUpDelivered = createBarrier();
			const e7FollowUpRelease = createBarrier();
			world.provider.enqueue("worker-b", {
				...calls("e7-b-followup-held", [
					{
						id: "e7-b-followup-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "The confirmed retry count is 5." },
					},
				]),
				check: (request) => {
					const tail = JSON.stringify(request.context.messages.at(-1) ?? null);
					if (!tail.includes(e7FollowUpMessage)) throw new Error("B's follow-up did not reach its own turn");
					e7FollowUpDelivered.release();
				},
				gate: e7FollowUpRelease.promise,
			});
			const e7FollowUp = e7Fresh.session.backgroundLanes.followUpSessionRootWorkerAgent(
				e7StartB.agentId,
				e7FollowUpMessage,
				e7FollowUpOptions,
			);
			if (!e7FollowUp.started || e7FollowUp.record === undefined) {
				throw new Error(`the follow-up was not admitted: ${JSON.stringify({ ...e7FollowUp, record: undefined })}`);
			}
			const e7FollowUpLane = e7FollowUp.record.laneId;
			await withDeadline(trace, "E7 follow-up control delivered to B", e7FollowUpDelivered.promise, 120_000);
			// Paired outbox fault at the held boundary: the session-root target rename fails first; the source rollback rename fails only after
			// that target fault has fired. The reply throws both causes in order; root bytes and the source acknowledgement are inspected from the
			// raw records before any active getter, and the native listing then repairs the source outbox before B is released.
			const e7SessionId = e7Fresh.sessionManager.getSessionId();
			const e7RootMailbox = sessionRootMailboxFile(world.agentDir, e7SessionId);
			const e7SourceMailbox = workerMailboxPath(world.agentDir, e7SessionId, e7StartB.agentId);
			const e7ReplyId = sessionRootReplyMessageId(e7SessionId, e7StartB.agentId, e7FollowUp.messageId);
			// Held-boundary failure safety: whatever throws inside the boundary, B's reply is repaired and acked only on its exact admitted lineage,
			// B's gate is released, and B's foreground tail is joined while this owner is live. The primary and every cleanup error are thrown.
			const e7HeldFailures: unknown[] = [];
			let e7ReceiptBeforeRepair: unknown;
			// The wake is a root request triggered by a user handoff; only that bounded context is answered, and only B's own succeeded line
			// for this admitted lane completes the wait. Earlier coalesced wake requests get the generic settling reply.
			world.provider.enqueue("root", {
				name: "e7-follow-up-wake",
				maxRequests: 8,
				check: (request) => {
					if (!e7IsHandoffWake(request, [e7FollowUpLane, e7StartB.laneId])) {
						throw new Error("the follow-up wake was not triggered by a user handoff");
					}
				},
				until: (request) => {
					const done = e7WorkerHandoff(request, e7FollowUpLane, "succeeded");
					if (done) e7FollowUpWake.release();
					return done;
				},
				reply: { content: [{ type: "text", text: "Background work is still settling." }] },
			});
			// The repair: lists this admitted request's pending reply and acks it only when it is exactly that reply.
			// The admitted follow-up receipt: exactly one durable attempt names its control message, and it is B's completed attempt on the admitted lane.
			const e7PinAdmittedTerminal = (): void => {
				const admitted = e7Fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
				if (admitted === undefined)
					throw new Error("the recovered owner has no task runtime snapshot after the matched handoff");
				const receipts = Object.values(admitted.attempts).filter(
					(attempt) => attempt.dispatch.controlMessageId === e7FollowUp.messageId,
				);
				expect(receipts.length, "the admitted control message owns exactly one durable attempt").toBe(1);
				const [receipt] = receipts;
				expect(
					receipt === undefined
						? undefined
						: {
								agentId: receipt.agentId,
								taskId: receipt.taskId,
								logicalLaneId: receipt.dispatch.logicalLaneId,
								status: receipt.status,
							},
					"the admitted receipt pins B's agent, the admitted lane, and a completed attempt",
				).toEqual({
					agentId: e7StartB.agentId,
					taskId: e7FollowUpLane,
					logicalLaneId: e7StartB.agentId,
					status: "completed",
				});
			};
			const e7HeldRepair = (): void => {
				const pending = e7Fresh.session.backgroundLanes.listSessionRootReplies({
					sourceAgentId: e7StartB.agentId,
					requestMessageId: e7FollowUp.messageId,
				});
				if (pending.length > 1)
					throw new Error(`${pending.length} pending root replies name the admitted request; nothing is acked`);
				const reply = pending[0];
				if (reply !== undefined) {
					if (
						reply.messageId !== e7ReplyId ||
						reply.requestMessageId !== e7FollowUp.messageId ||
						reply.threadId !== e7FollowUpThread ||
						reply.content !== "Noted: the retry count is 5."
					)
						throw new Error(
							`the pending root reply ${reply.messageId} is not the admitted reply ${e7ReplyId}; its fence is kept and nothing is acked`,
						);
					if (typeof reply.ackToken !== "string")
						throw new Error(`the pending reply ${reply.messageId} carries no ack token`);
					if (!e7Fresh.session.backgroundLanes.acknowledgeSessionRootReply(reply.messageId, reply.ackToken))
						throw new Error(`the native ack refused the admitted reply ${reply.messageId}`);
				}
			};
			try {
				const e7RootBefore = world.io.fileEntries().get(e7RootMailbox);
				let e7TargetFaultFired = false;
				const e7ConsumedBefore = world.io.consumedFaults.length;
				world.io.failNext({
					name: "e7-session-root-target-rename-fails",
					kind: "rename",
					matches: (operation) => {
						if (operation.destination !== e7RootMailbox) return false;
						e7TargetFaultFired = true;
						return true;
					},
					code: "EIO",
					times: 1,
				});
				world.io.failNext({
					name: "e7-source-rollback-rename-fails",
					kind: "rename",
					matches: (operation) => e7TargetFaultFired && operation.destination === e7SourceMailbox,
					code: "EIO",
					times: 1,
				});
				let e7FaultError: unknown;
				try {
					e7Fresh.session.backgroundLanes.replyToWorkerAgentMessage(
						e7StartB.agentId,
						"Noted: the retry count is 5.",
						e7FollowUp.messageId,
					);
				} catch (error) {
					e7FaultError = error;
				}
				expect(e7TargetFaultFired, "the target rename fired before the rollback was attempted").toBe(true);
				world.io.assertFaultsConsumed();
				expect(
					world.io.consumedFaults.slice(e7ConsumedBefore),
					"the two armed faults are the newly consumed ones, in order",
				).toEqual(["e7-session-root-target-rename-fails", "e7-source-rollback-rename-fails"]);
				expect(e7FaultError, "the paired fault surfaces as an ordered AggregateError").toBeInstanceOf(
					AggregateError,
				);
				const e7Causes =
					e7FaultError instanceof AggregateError
						? e7FaultError.errors.map((cause) =>
								(cause instanceof Error ? cause.message : String(cause)).slice(
									0,
									(cause instanceof Error ? cause.message : String(cause)).indexOf(":"),
								),
							)
						: [];
				expect(e7Causes, `both raw causes are preserved in order: ${JSON.stringify(e7Causes)}`).toEqual([
					"Scripted IO fault e7-session-root-target-rename-fails",
					"Scripted IO fault e7-source-rollback-rename-fails",
				]);
				expect(
					world.io.fileEntries().get(e7RootMailbox),
					"the failed target leaves the root mailbox bytes unchanged",
				).toBe(e7RootBefore);
				// The held boundary after both faults, before any listing: the faulted reply already committed its native receipt to the source.
				// That raw receipt is the pre-repair baseline; the test reads it and computes no digest of its own.
				e7ReceiptBeforeRepair = rawReplyReceiptOf(
					readWorkerMailboxRecord(e7SourceMailbox).mailbox,
					e7FollowUp.messageId,
				);
				expect(
					e7ReceiptBeforeRepair,
					"the faulted reply committed its receipt to the source before any repair",
				).toEqual({
					replyMessageId: e7ReplyId,
					requestSenderId: sessionRootAddress(e7SessionId),
					contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				});
				expect(
					rawReplyAcknowledgements(readWorkerMailboxRecord(e7SourceMailbox).mailbox),
					"the raw source holds exactly the deterministic acknowledgement tuple before any repair",
				).toEqual([
					{
						messageId: e7FollowUp.messageId,
						acknowledgementId: e7ReplyId,
						replyContent: "Noted: the retry count is 5.",
					},
				]);
				const e7FollowUpReply = { messageId: e7ReplyId };
				// Lineage, while B is still held: the request-scoped list actively reconciles the source outbox and yields exactly one root reply.
				const e7Replies = e7Fresh.session.backgroundLanes.listSessionRootReplies({
					sourceAgentId: e7StartB.agentId,
					requestMessageId: e7FollowUp.messageId,
				});
				expect(e7Replies.length, "one root reply for the admitted control").toBe(1);
				const e7Reply = e7Replies[0];
				expect(
					{
						messageId: e7Reply?.messageId,
						requestMessageId: e7Reply?.requestMessageId,
						threadId: e7Reply?.threadId,
						content: e7Reply?.content,
						sourceReconciled: e7Reply?.sourceReconciledAt !== undefined,
						acknowledged: e7Reply?.acknowledgedAt,
					},
					"the reply names its admitted request, thread and content, is source-reconciled, and is unacknowledged",
				).toEqual({
					messageId: e7FollowUpReply.messageId,
					requestMessageId: e7FollowUp.messageId,
					threadId: e7FollowUpThread,
					content: "Noted: the retry count is 5.",
					sourceReconciled: true,
					acknowledged: undefined,
				});
				expect(e7Reply?.ackToken, "the reply carries an acknowledgement token").toEqual(expect.any(String));
				// After the repair the source keeps no acknowledgement marker, and its receipt is the pre-repair receipt, unchanged.
				const e7SourceAfter = readWorkerMailboxRecord(e7SourceMailbox).mailbox;
				expect(
					rawReplyAcknowledgements(e7SourceAfter),
					"the repaired source keeps zero acknowledgement markers",
				).toEqual([]);
				expect(
					rawReplyReceiptOf(e7SourceAfter, e7FollowUp.messageId),
					"the repair leaves the pre-repair native receipt unchanged",
				).toEqual(e7ReceiptBeforeRepair);
				// The native ack consumes the reply: no unacknowledged reply remains for this request.
				expect(
					e7Fresh.session.backgroundLanes.acknowledgeSessionRootReply(
						e7FollowUpReply.messageId,
						e7Reply?.ackToken ?? "",
					),
					"the native ack accepts the reply's own token",
				).toBe(true);
				expect(
					e7Fresh.session.backgroundLanes
						.listSessionRootReplies({ sourceAgentId: e7StartB.agentId, requestMessageId: e7FollowUp.messageId })
						.filter((reply) => reply.acknowledgedAt === undefined),
					"no unacknowledged reply remains after the ack",
				).toEqual([]);
			} catch (error) {
				e7HeldFailures.push(error);
			} finally {
				// The native repair lists only this admitted request's pending reply; it is acked only when it is exactly that reply.
				try {
					e7HeldRepair();
				} catch (error) {
					e7HeldFailures.push(error);
				}
				e7FollowUpRelease.release();
				try {
					// The matched handoff: the wake step releases only when B's own succeeded handoff for this admitted lane reaches the root.
					await withDeadline(trace, "E7 matched B handoff", e7FollowUpWake.promise, 120_000);
					// Pin the admitted task's terminal attempt from a fresh snapshot. Physical join of B's process stays with native disposal.
					e7PinAdmittedTerminal();
				} catch (error) {
					e7HeldFailures.push(error);
				}
				try {
					await withDeadline(
						trace,
						"E7 held B tail joins while the owner is live",
						e7Fresh.session.waitForForegroundIdle(),
						120_000,
					);
				} catch (error) {
					e7HeldFailures.push(error);
				}
			}
			if (e7HeldFailures.length === 1) throw e7HeldFailures[0];
			if (e7HeldFailures.length > 1)
				throw new AggregateError(e7HeldFailures, "the held E7 reply boundary failed before and during its cleanup");
			await withDeadline(trace, "E7 follow-up tail settled", e7Fresh.session.waitForForegroundIdle(), 120_000);
			// Replay after the real tail: the same key and the same options name the same durable control and start no second B turn.
			const e7Replay = e7Fresh.session.backgroundLanes.followUpSessionRootWorkerAgent(
				e7StartB.agentId,
				e7FollowUpMessage,
				e7FollowUpOptions,
			);
			expect(e7Replay.messageId, "a replayed key names the same durable control").toBe(e7FollowUp.messageId);
			expect(e7Replay.started, "a replayed key starts no second B turn").toBe(false);
			await withDeadline(trace, "E7 replay settled", e7Fresh.session.waitForForegroundIdle(), 120_000);
			expect(
				world.provider.reached.filter((name) => name.includes("e7-b-followup")).length,
				"B's follow-up ran exactly once",
			).toBe(1);
			// The replayed control reinserts no reply: the pending list stays empty after the tail, because acknowledged replies are not listed.
			expect(
				e7Fresh.session.backgroundLanes.listSessionRootReplies({
					sourceAgentId: e7StartB.agentId,
					requestMessageId: e7FollowUp.messageId,
				}).length,
				"the replay reinserts no pending root reply",
			).toBe(0);
			// Reply-level replay after the tail: the same B, request and content return the deterministic reply id and reinsert nothing,
			// distinct from the control-key replay above.
			const e7ReplyReplay = e7Fresh.session.backgroundLanes.replyToWorkerAgentMessage(
				e7StartB.agentId,
				"Noted: the retry count is 5.",
				e7FollowUp.messageId,
			);
			expect(e7ReplyReplay, "a reply replay returns the same deterministic reply id").toEqual({
				destination: "session_root",
				messageId: e7ReplyId,
			});
			expect(
				e7Fresh.session.backgroundLanes.listSessionRootReplies({
					sourceAgentId: e7StartB.agentId,
					requestMessageId: e7FollowUp.messageId,
				}).length,
				"the reply replay reinserts no pending root reply",
			).toBe(0);
			expect(
				rawReplyReceiptOf(readWorkerMailboxRecord(e7SourceMailbox).mailbox, e7FollowUp.messageId),
				"the reply receipt is unchanged across the tail and the reply replay",
			).toEqual(e7ReceiptBeforeRepair);
			// A repeated recovery after B's terminal repeats no provider step of B and publishes no new session entry.
			const e7EntriesBefore = e7Fresh.sessionManager.getEntries().length;
			const e7BStepsBefore = world.provider.reached.filter((name) => name.includes("e7-b-")).length;
			e7Fresh.session.getLaneRecords();
			expect(e7Fresh.sessionManager.getEntries().length, "a repeated recovery publishes nothing new").toBe(
				e7EntriesBefore,
			);
			expect(
				world.provider.reached.filter((name) => name.includes("e7-b-")).length,
				"a repeated recovery repeats no B provider step",
			).toBe(e7BStepsBefore);
			expect(
				Object.values(e7Settled.attempts)
					.filter((attempt) => attempt.taskId === e7StartB.laneId)
					.at(-1)?.status,
				"B resumes from its queued state and completes",
			).toBe("completed");
			expect(
				world.warnings.some((warning) => warning.includes("no proof of never-started")),
				"the queued-context guard refuses A's busy lease",
			).toBe(true);
			expect(
				await world.disposeSessionInBody(e7Fresh.session),
				"the recovered owner disposes cleanly",
			).toBeUndefined();
		},
	);
}, 360_000);

/**
 * Native settlement facts at one boundary, read through owner getters that neither admit nor recover work: the goal record, the task runtime projection,
 * foreground activity, streaming flags, the pending idle continuation timers, the resource snapshot, and the durable retire
 * receipts. It never calls `getLaneRecords`, `getSessionWorkState` or `getGoalRuntimeSnapshot`: those reach the worker recovery
 * coordinator (`WorkerDelegationController.getRecords` runs `recovery.recover()` while the delegate tool is active), so a read
 * through them is not passive. The task and resource getters may refresh or compact their storage, so the read is not zero IO.
 */
function settlementFacts(
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
function lanesOf(
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
const COMPLETION_REQUIREMENT_TEXT = "MAX_RETRIES equals 5 and the late module lands";
/** The statement prefix of the unsettled-item family for a statement that a change helps achieve a requirement. */
const CRITERION_STATEMENT_PREFIX = "This change helps achieve: ";

/** The evidence ids the goal ledger admitted, read from the durable goal results of a session branch. */
function durableGoalEvidenceIds(sessionManager: SessionManager): string[] {
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
function checkCompletionItems(
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
function checkEvidenceMarkers(request: SystemOneDecodedRequest, ledger: ReadonlyMap<string, boolean>): number {
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

function evidenceIdsOf(request: ScriptedRequest): string[] {
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
function requirementIdOf(request: ScriptedRequest): string {
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
const REFLECTION_CHECKPOINT_MARKER = "Reflection checkpoint: the unit of work above has ended.";

/** True when a request-visible message carries the marker text. */
function requestCarriesMarker(request: ScriptedRequest, marker: string): boolean {
	return request.context.messages.some((message) => JSON.stringify(message).includes(marker));
}

/**
 * A submit_report result whose host receipt matches its call: the same call id, and a completed, successful invocation. Tool
 * receipt, not host acceptance: it proves the host recorded the call, nothing about the claim's verdict.
 */
function matchedSubmitReceipt(request: ScriptedRequest, callId: string): boolean {
	return matchedSubmitReceiptIn(request.context.messages, callId);
}

/** A completed submit whose successful invocation is recorded on the message with this call id. */
function matchedSubmitReceiptIn(messages: ScriptedRequest["context"]["messages"], callId: string): boolean {
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
function currentRequestCarries(request: ScriptedRequest, text: string): boolean {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	return JSON.stringify(messages.slice(start)).includes(text);
}

/** The task id the latest bash start carried in its tool result details. */
function backgroundTaskIdOf(request: ScriptedRequest): string {
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
function handoffFor(request: ScriptedRequest, taskId: string): boolean {
	return request.context.messages.some((message) => {
		const text = JSON.stringify(message);
		return text.includes("Background tool terminal handoff") && text.includes(taskId);
	});
}

/** The command of a bash tool call's validated arguments, or undefined when the arguments carry none. */
function commandOf(args: unknown): unknown {
	return typeof args === "object" && args !== null && "command" in args ? args.command : undefined;
}

function latestBatchResults(request: ScriptedRequest): Array<{ toolName: string; isError: boolean; text: string }> {
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
function assertBatchOk(request: ScriptedRequest, label: string): void {
	for (const result of latestBatchResults(request)) {
		if (result.isError) throw new Error(`${label}: ${result.toolName} failed: ${result.text.slice(0, 600)}`);
	}
}

/**
 * The absolute path a request-visible `PATH ALIASES` legend line names. The model reads its legend from the request it is
 * sent, so the positive path oracle is that legend, never the raw transcript.
 */
function requestTexts(request: ScriptedRequest): string[] {
	return request.context.messages.flatMap((message) =>
		typeof message.content === "string"
			? [message.content]
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
	);
}

/** The persisted alias rows of one session store, read through a read-only connection that is closed before returning. */
function readPathAliases(path: string): Array<{ full_path: string; alias_id: string }> {
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
function mailboxMessagesOf(mailbox: unknown): Array<{ messageId: string; content: string; deliveredAt?: string }> {
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
function receiptsOf(mailbox: unknown): Array<{ kind: string; messageId: string }> {
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
function legendLinesOf(request: ScriptedRequest): string[] {
	return requestTexts(request)
		.flatMap((text) => text.split("\n"))
		.filter((line) => /^p\/\S+=\S+$/.test(line));
}

/** The alias the request-visible legend assigns to an absolute path, when the legend carries it. */
function legendAliasFor(request: ScriptedRequest, absolutePath: string): string | undefined {
	const display = absolutePath.startsWith(`${HARNESS_PROJECT_CWD}/`)
		? absolutePath.slice(HARNESS_PROJECT_CWD.length + 1)
		: absolutePath;
	for (const text of requestTexts(request)) {
		for (const line of text.split("\n")) {
			const match = /^(p\/\S+)=(\S+)$/.exec(line);
			if (
				match?.[1] &&
				(match[2] === absolutePath ||
					match[2] === display ||
					resolve(HARNESS_PROJECT_CWD, match[2]) === absolutePath)
			) {
				return match[1];
			}
		}
	}
	return undefined;
}

/** The text of a utf8 read: a non-text read is a broken oracle, so it fails instead of being coerced. */
function utf8Text(content: string | Buffer): string {
	if (typeof content !== "string") throw new TypeError("a utf8 read returned bytes");
	return content;
}

function legendPath(request: ScriptedRequest, alias: string): string {
	const pattern = new RegExp(`^${alias}=(\\S+)$`, "m");
	for (const text of requestTexts(request)) {
		const match = pattern.exec(text);
		if (match?.[1]) return resolve(HARNESS_PROJECT_CWD, match[1]);
	}
	throw new Error(`${alias} is not in the request-visible PATH ALIASES legend`);
}

/** The conflict block a read of the conflicted file shows, exactly as the request carries it. */
function conflictBlockIn(request: ScriptedRequest): string {
	const read = latestBatchResults(request).find((result) => result.toolName === "read");
	const match = /<<<<<<< HEAD[\s\S]*?>>>>>>> [^\n]*/.exec(read?.text ?? "");
	if (!match) throw new Error(`no conflict block in the read result: ${read?.text ?? "no read"}`);
	return match[0];
}

/** The latest batch must hold a refused call whose text names the diagnostic. */
function assertRefused(request: ScriptedRequest, label: string, diagnostic: string): void {
	const results = latestBatchResults(request);
	if (!results.some((result) => result.isError && result.text.includes(diagnostic))) {
		throw new Error(`${label}: expected a refusal naming "${diagnostic}", got ${JSON.stringify(results)}`);
	}
}

/** The structured details of the newest `worktree_sync` result in the transcript (not text-matched). */
/** The structured details of the newest result of `toolName` in the transcript (not text-matched). */
function lastToolResultDetails(session: AgentSession, toolName: string): unknown {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "toolResult" && message.toolName === toolName) return message.details;
	}
	return undefined;
}

function isStaleRefusal(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		"code" in details &&
		(details.code === "stale_lane" || details.code === "sync_required")
	);
}

function isGateCommandRefusal(details: unknown): boolean {
	return typeof details === "object" && details !== null && "code" in details && details.code === "gate_command_unset";
}

/** A step whose tool calls depend on what production reported earlier. */
function dynamicCalls(
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

const ORIGINAL_LIMITS = "export const MAX_RETRIES = 3;\n";
const OWNER_DRAFT_V1 = "owner draft v1\n";
const NOTES_V1 = "stage one\n";
const OWNER_DRAFT_DIRTY = "owner draft v2 (unstaged, not mine)\n";

it("mixed: a root lane and a worker lane in separate worktrees, a real conflict, explicit resolution, integration, owner edits kept", async () => {
	await runJourney(
		{
			name: "journey-3",
			// worktree_sync is opt-in: the owner's default-tools setting names it alongside the default surface. The owner's draft is
			// dirty from the start, so lanes are created explicitly and the worker is started on its request-visible lane checkout.
			settings: { defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"] },
			files: {
				[`${HARNESS_PROJECT_CWD}/src/limits.ts`]: ORIGINAL_LIMITS,
				[`${HARNESS_PROJECT_CWD}/src/owner.md`]: OWNER_DRAFT_DIRTY,
				[`${HARNESS_PROJECT_CWD}/src/notes.md`]: NOTES_V1,
				"/harness/e10-outside/d.txt": "E10-SENTINEL\n",
			},
			repository: {
				committed: { "src/limits.ts": ORIGINAL_LIMITS, "src/owner.md": OWNER_DRAFT_V1, "src/notes.md": NOTES_V1 },
				dirty: { "src/owner.md": OWNER_DRAFT_DIRTY },
			},
		},
		async (world) => {
			const trace = world.trace;
			const integrated = createBarrier();
			const workerMayEdit = createBarrier();
			const handedOff = createBarrier();
			let rootSession: AgentSession | undefined;
			let workerLaneKey: string | undefined;
			let mainBeforeRefusal: string | undefined;
			let mainBeforeStale: string | undefined;
			let mainAfterLand: string | undefined;
			let legendAtIntegration: string[] = [];
			const sessionOf = (): AgentSession => {
				if (rootSession === undefined) throw new Error("the root session is not created yet");
				return rootSession;
			};
			const laneKeyOrThrow = (): string => {
				if (workerLaneKey === undefined)
					throw new Error("the worker lane key was not read from the status details");
				return workerLaneKey;
			};
			const checkoutHandoffs = (request: ScriptedRequest): void => {
				if (!JSON.stringify(request.context.messages).includes("Background worker terminal handoff")) {
					throw new Error("the worker's terminal handoff is not in the root turn");
				}
			};
			// The worker: held at its first request until the root has committed its own lane; then edits its lane and reports.
			world.provider.enqueue(
				"worker-a",
				{
					name: "worker-edit",
					gate: workerMayEdit.promise,
					reply: {
						content: [
							{
								type: "toolCall",
								id: "worker-edit-1",
								name: "edit",
								arguments: {
									path: "src/limits.ts",
									edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }],
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				calls("worker-report", [
					{
						id: "worker-report-1",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Set MAX_RETRIES to 5 in my lane.",
							changes: [{ file: "src/limits.ts", what: "Raises MAX_RETRIES to 5 in the retries lane." }],
						},
					},
				]),
			);
			// Prompt one: the root creates its two lanes, starts the worker on the request-visible retries checkout, reads the lane
			// identities from the structured status, and works its own lane while the worker is held at its first request.
			world.provider.enqueue(
				"root",
				calls("goal-start", [
					{
						id: "goal-1",
						name: "goal",
						arguments: {
							action: "start",
							goalId: "retries-goal",
							userGoal: "Set MAX_RETRIES to 5 and keep the owner's draft.",
						},
					},
				]),
				calls("create-rootwork-lane", [
					{
						id: "lane-rootwork",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "rootwork", goalId: "retries-goal" },
					},
				]),
				calls("create-retries-lane", [
					{
						id: "lane-retries",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "retries", goalId: "retries-goal" },
					},
				]),
				dynamicCalls(
					"start-worker",
					(request) => {
						const retries = legendPath(request, "p/retries");
						return [
							{
								id: "start-worker-1",
								name: "delegate",
								arguments: {
									action: "start",
									model: { provider: "harness-script", modelId: "worker-a" },
									path: retries,
									writePaths: [`${retries}/src/limits.ts`],
									instructions:
										"Set MAX_RETRIES to 5 in src/limits.ts of your checkout, then submit your report.",
								},
							},
						];
					},
					(request) => assertBatchOk(request, "create-retries-lane"),
				),
				{
					name: "status-admitted",
					check: (request) => {
						assertBatchOk(request, "start-worker");
						if (
							!latestBatchResults(request).some((result) => result.text.includes("delegate started (running)"))
						) {
							throw new Error("the worker was not admitted");
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "status-1", name: "worktree_sync", arguments: { action: "status" } },
							{
								type: "toolCall",
								id: "mixed-read-fail-j3",
								name: "read",
								arguments: { path: `${HARNESS_PROJECT_CWD}/src/does-not-exist.ts` },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "identities-checked",
					check: (request) => {
						// The batch is mixed on purpose: the status must succeed, and the missing-file read must be the one refused call.
						const statusBatch = latestBatchResults(request);
						if (statusBatch.some((result) => result.toolName === "worktree_sync" && result.isError))
							throw new Error(`status-admitted: the worktree status failed: ${JSON.stringify(statusBatch)}`);
						if (!statusBatch.some((result) => result.toolName === "read" && result.isError))
							throw new Error(
								`the mixed batch's missing-file read did not fail: ${JSON.stringify(statusBatch)}`,
							);
						const details = lastToolResultDetails(sessionOf(), "worktree_sync");
						// Structured output round-trips: no credential placeholder replaces a lane key or path.
						if (JSON.stringify(details).includes("<mocked:")) {
							throw new Error(`the status details carry a redacted field: ${JSON.stringify(details)}`);
						}
						const lanes = lanesOf(details);
						const agent = agentIdForTrack(request, "worker-a");
						const retries = legendPath(request, "p/retries");
						const bound = lanes.filter((lane) => lane.boundLaneId !== undefined);
						const root = lanes.filter((lane) => lane.boundLaneId === undefined);
						if (lanes.length !== 2 || bound.length !== 1 || bound[0]?.boundLaneId !== agent) {
							throw new Error(`worker and root lanes are not separate: ${JSON.stringify(lanes)} agent ${agent}`);
						}
						if (bound[0]?.laneKey !== "retries" || bound[0]?.worktreePath !== retries) {
							throw new Error(`the worker is not bound to its requested checkout: ${JSON.stringify(bound)}`);
						}
						if (root[0]?.laneKey !== "rootwork")
							throw new Error(`the root lane is not rootwork: ${JSON.stringify(root)}`);
						// The lane key is read back from the structured output, and later steps use that value.
						workerLaneKey = bound[0].laneKey;
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "alias-negative-1",
								name: "edit",
								arguments: {
									path: "p/rootwork/src/limits.ts",
									edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 4" }],
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				dynamicCalls(
					"edit-rootwork",
					(request) => [
						{
							id: "edit-rootwork-1",
							name: "edit",
							arguments: {
								path: `${legendPath(request, "p/rootwork")}/src/limits.ts`,
								edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 4" }],
							},
						},
					],
					(request) => assertRefused(request, "the extrapolated alias", "Unminted path alias"),
				),
				calls("commit-rootwork", [
					{
						id: "add-rootwork",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "rootwork", paths: ["src/limits.ts"] },
					},
					{
						id: "commit-rootwork",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "rootwork", message: "Raise MAX_RETRIES to 4" },
					},
				]),
				{
					name: "rootwork-committed",
					check: (request) => {
						assertBatchOk(request, "commit-rootwork");
						// The worker is released only now: its lane edit overlaps the root's committed lane work.
						workerMayEdit.release();
					},
					reply: {
						content: [{ type: "text", text: "Rootwork is committed; the worker is still working in its lane." }],
					},
				},
			);
			// The worker's terminal handoff starts a root turn: the worker's lane is committed, its first land is refused by the
			// gate, the gate is opened explicitly, and the lane lands at epoch 1; the stale rootwork land is then refused.
			world.provider.enqueue(
				"root",
				dynamicCalls(
					"handoff-received",
					() => [
						{
							id: "add-worker-1",
							name: "worktree_sync",
							arguments: { action: "git_add", laneKey: laneKeyOrThrow(), paths: ["src/limits.ts"] },
						},
						{
							id: "commit-worker-1",
							name: "worktree_sync",
							arguments: { action: "git_commit", laneKey: laneKeyOrThrow(), message: "Set MAX_RETRIES to 5" },
						},
					],
					(request) => {
						checkoutHandoffs(request);
						handedOff.release();
					},
				),
				dynamicCalls(
					"land-worker-refused",
					() => [
						{
							id: "land-worker-1",
							name: "worktree_sync",
							arguments: { action: "land", laneKey: laneKeyOrThrow() },
						},
					],
					(request) => {
						assertBatchOk(request, "handoff-received");
						mainBeforeRefusal = world.git.refSha("refs/heads/main");
					},
				),
				dynamicCalls(
					"land-worker-positive",
					() => [
						{
							id: "land-worker-2",
							name: "worktree_sync",
							arguments: { action: "land", laneKey: laneKeyOrThrow() },
						},
					],
					(request) => {
						assertBatchOk(request, "land-worker-refused");
						if (!isGateCommandRefusal(lastToolResultDetails(sessionOf(), "worktree_sync"))) {
							throw new Error("the worker lane's first land was not refused by the gate");
						}
						if (world.git.refSha("refs/heads/main") !== mainBeforeRefusal)
							throw new Error("a refused land moved main");
						// The owner-level opt-out, recorded per land event, then the positive land runs with the gate off.
						world.settingsManager.applyOverrides({ worktreeSync: { gate: "off" } });
					},
				),
				{
					name: "worker-landed",
					check: (request) => {
						const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
						if (!landed?.text.includes("LANDED: epoch 1")) {
							throw new Error(`the worker lane did not land at epoch 1: ${landed?.text ?? "no land"}`);
						}
						mainBeforeStale = world.git.refSha("refs/heads/main");
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "land-rootwork-stale",
								name: "worktree_sync",
								arguments: { action: "land", laneKey: "rootwork" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "stale-refused",
					check: (request) => {
						assertBatchOk(request, "land-rootwork-stale");
						if (!isStaleRefusal(lastToolResultDetails(sessionOf(), "worktree_sync"))) {
							throw new Error(
								`the rootwork land was not refused as stale: ${JSON.stringify(lastToolResultDetails(sessionOf(), "worktree_sync"))}`,
							);
						}
						if (world.git.refSha("refs/heads/main") !== mainBeforeStale)
							throw new Error("a refused stale land moved main");
					},
					reply: {
						content: [{ type: "text", text: "The worker lane landed; the rootwork lane is behind main." }],
					},
				},
			);
			// Resolution turn: the rootwork lane syncs against the landed worker lane, the conflict is read and resolved through the
			// request-visible legend path, then the lane lands and the worker's landing is replayed.
			world.provider.enqueue(
				"root",
				calls("sync-rootwork", [
					{ id: "sync-rootwork-1", name: "worktree_sync", arguments: { action: "sync", laneKey: "rootwork" } },
				]),
				dynamicCalls(
					"read-conflict",
					(request) => [
						{
							id: "read-conflict-1",
							name: "read",
							arguments: { path: `${legendPath(request, "p/rootwork")}/src/limits.ts` },
						},
					],
					(request) => {
						const sync = latestBatchResults(request).find((result) => result.toolName === "worktree_sync");
						if (!sync?.text.toLowerCase().includes("conflict")) {
							throw new Error(`sync did not report a conflict: ${sync?.text ?? "no sync result"}`);
						}
					},
				),
				dynamicCalls(
					"resolve-conflict",
					(request) => [
						{
							id: "resolve-conflict-1",
							name: "edit",
							arguments: {
								path: `${legendPath(request, "p/rootwork")}/src/limits.ts`,
								edits: [{ oldText: conflictBlockIn(request), newText: "export const MAX_RETRIES = 5;" }],
							},
						},
					],
					(request) => {
						const read = latestBatchResults(request).find((result) => result.toolName === "read");
						if (!read?.text.includes("<<<<<<< HEAD"))
							throw new Error(`the conflicted file was not shown: ${read?.text ?? "no read"}`);
					},
				),
				calls("continue-rootwork", [
					{
						id: "continue-rootwork-1",
						name: "worktree_sync",
						arguments: { action: "continue", laneKey: "rootwork" },
					},
				]),
				calls("land-rootwork", [
					{ id: "land-rootwork-1", name: "worktree_sync", arguments: { action: "land", laneKey: "rootwork" } },
				]),
				dynamicCalls(
					"replay-worker-landing",
					() => [
						{
							id: "replay-worker-1",
							name: "worktree_sync",
							arguments: { action: "land", laneKey: laneKeyOrThrow() },
						},
					],
					(request) => {
						assertBatchOk(request, "land-rootwork");
						const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
						if (!landed?.text.includes("LANDED: epoch 2")) {
							throw new Error(
								`rootwork did not land at epoch 2: ${landed?.text ?? "no land"}\n${toolOutcomes(sessionOf())}`,
							);
						}
						mainAfterLand = world.git.refSha("refs/heads/main");
					},
				),
				{
					name: "integrated",
					check: (request) => {
						const replayed = latestBatchResults(request).find((result) => result.toolName === "worktree_sync");
						if (replayed?.text.includes("LANDED"))
							throw new Error(`a replayed land landed again: ${replayed.text}`);
						if (world.git.refSha("refs/heads/main") !== mainAfterLand)
							throw new Error("a replayed land moved main");
						legendAtIntegration = legendLinesOf(request);
						integrated.release();
					},
					reply: {
						content: [
							{
								type: "text",
								text: "Both lanes are integrated; MAX_RETRIES is 5 and the owner's draft is untouched.",
							},
						],
					},
				},
			);

			const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const session = created.session;
			rootSession = session;
			trace.mark("root", "session.created");
			// Judgments per turn: the setup turn asks the completion state claims and two read-output claims; the resolution turn
			// asks the steering family. Each phase declares exactly what its turns ask.
			const setupJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.97 },
			} as const;
			const resolveJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			} as const;
			// Owner-word oracle for each J3 phase: the owner words System One classifies are this phase's own inputs, and the previous
			// intent is the native ledger's. The expected values come from scenario literals and the session's entries.
			const ownerWords = (...userRequests: string[]) =>
				expectOwnerWords({
					sessionManager: () => created.sessionManager,
					userRequests,
					optionalToolNames: ["secret_store"],
				});
			world.systemOne.enterPhase("mixed-setup", setupJudgments, {
				expect: ownerWords(
					"Set MAX_RETRIES to 5: start a worker on its lane, edit the rootwork lane to 4, commit it.",
				),
			});
			await withDeadline(
				trace,
				"integration setup turn",
				session.prompt("Set MAX_RETRIES to 5: start a worker on its lane, edit the rootwork lane to 4, commit it."),
				120_000,
			).catch((error: unknown) => {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
			});
			// The durable batch: the create receipt, the status result and the failing read are persisted under their own call ids, in call order.
			const j3Batch = created.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					["lane-retries", "status-1", "mixed-read-fail-j3"].includes(entry.message.toolCallId)
						? [entry.message]
						: [],
				);
			expect(
				j3Batch.map((message) => ({
					toolCallId: message.toolCallId,
					isError: message.isError,
					failureRecord:
						typeof message.details === "object" &&
						message.details !== null &&
						"piToolFailureMemory" in message.details,
				})),
				"the durable batch pairs each call with its own result and outcome",
			).toEqual([
				{ toolCallId: "lane-retries", isError: false, failureRecord: false },
				{ toolCallId: "status-1", isError: false, failureRecord: false },
				{ toolCallId: "mixed-read-fail-j3", isError: true, failureRecord: true },
			]);
			// The durable receipt link: the status lane for the retries key reports the checkout that the persisted create result named.
			const createText = (j3Batch[0]?.content ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			const retriesLane = lanesOf(j3Batch[1]?.details).find((lane) => lane.laneKey === "retries");
			expect(retriesLane, "the durable status names the retries lane").toBeDefined();
			expect(createText, "the durable create result names the checkout the status lane reports").toContain(
				String(retriesLane?.worktreePath),
			);
			await withDeadline(trace, "worker handoff", handedOff.promise, 90_000);
			await withDeadline(trace, "worker handoff turn settled", session.waitForForegroundIdle(), 90_000);
			world.systemOne.enterPhase("mixed-resolve", resolveJudgments, {
				expect: ownerWords("Sync rootwork, resolve the conflict, land it, then replay the worker landing."),
			});
			await withDeadline(
				trace,
				"resolution turn",
				session.prompt("Sync rootwork, resolve the conflict, land it, then replay the worker landing."),
				120_000,
			).catch((error: unknown) => {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
			});
			await withDeadline(trace, "integration released", integrated.promise, 5_000);

			// Stale replacement after integration. An external atomic save renames a new node over the notes file while a
			// descriptor opened earlier is still held: the root's edit from its earlier read is refused, the held descriptor
			// keeps the bytes of the node it opened, and the path shows the replacement.
			const notesPath = `${HARNESS_PROJECT_CWD}/src/notes.md`;
			let heldDescriptor: number | undefined;
			// Late attempt through the real identity fence. A third worker holds its first request at a gate and ignores the request abort. The owner
			// force-suspends the exact attempt while that request is held and queues the valid-current run behind the physical hold. The stale
			// terminal is emitted after the abort, and only then does the valid-current write run. The stale edit never reaches the lane.
			// The resumed run reports incompletely (matched host receipt) and ends on plaintext with no replacement: the terminal claim keeps
			// the typed incomplete report, adverse and not unparseable. A follow-up on the same persistent agent then writes the module and
			// reports truthfully, and that handoff must carry the admitted identity.
			const lateReached = createBarrier();
			const lateMayEmit = createBarrier();
			const lateTerminal = createBarrier();
			let staleTerminalEmitted = false;
			let lateWriteAfterStaleTerminal = false;
			const lateCurrentStarted = createBarrier();
			const lateAdverse = createBarrier();
			const lateRepairStarted = createBarrier();
			const lateHanded = createBarrier();
			let lateAgentId: string | undefined;
			let lateLane: string | undefined;
			let lateLaneBefore: string | undefined;
			let lateRepairTaskId: string | undefined;
			// Claim-delivery judgments: System One asks for these only while a worker's claim is delivered, so only late-attempt declares them.
			const lateClaimJudgments = {
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.02 },
			} as const;
			const lateJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "reason", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.97 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			} as const;
			// Each correction is bound to the current host request (the suffix after the newest assistant turn), not the whole history.
			const reviewLine = "changed files with no explanation: src/late.ts";
			const recordedLine = "Files the host recorded as changed: src/late.ts";
			world.systemOne.enterPhase(
				"late-attempt",
				{ ...lateJudgments, ...lateClaimJudgments },
				{ expect: ownerWords("Start a late worker on a third lane.") },
			);
			world.provider.enqueue(
				"worker-b",
				{
					name: "late-edit",
					gate: lateMayEmit.promise,
					ignoresAbort: true,
					check: () => {
						lateReached.release();
					},
					onTerminal: () => {
						staleTerminalEmitted = true;
						lateTerminal.release();
					},
					reply: {
						content: [
							{ type: "text", text: "LATE-STALE-TEXT: the late edit is ready." },
							{
								type: "toolCall",
								id: "late-edit-1",
								name: "edit",
								arguments: {
									path: "src/limits.ts",
									edits: [{ oldText: "MAX_RETRIES = 5", newText: "MAX_RETRIES = 7" }],
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-write",
					check: () => {
						if (!staleTerminalEmitted) {
							throw new Error("the valid-current write started before the stale terminal was emitted");
						}
						lateWriteAfterStaleTerminal = true;
						lateCurrentStarted.release();
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "late-write-1",
								name: "write",
								arguments: { path: "src/late.ts", content: "export const LATE = true;\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-incomplete",
					reply: {
						content: [
							{
								type: "toolCall",
								id: "late-report-0",
								name: "submit_report",
								arguments: { status: "completed", summary: "LATE-INCOMPLETE-REPORT: the module is written." },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-correction",
					check: (request) => {
						if (!currentRequestCarries(request, "REPORT REVIEW") || !currentRequestCarries(request, reviewLine)) {
							throw new Error("the repair request does not review the unreported change");
						}
						if (!matchedSubmitReceipt(request, "late-report-0")) {
							throw new Error("the incomplete report has no matched completed host receipt for its call");
						}
					},
					reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-CORRECTION: the module is written." }] },
				},
				{
					name: "late-correction-final",
					check: (request) => {
						if (
							!currentRequestCarries(request, "REPORT REQUEST") ||
							!currentRequestCarries(request, "You declared the task done.") ||
							!currentRequestCarries(request, recordedLine)
						) {
							throw new Error("the second request is not the generic report request for the recorded change");
						}
					},
					reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-FINAL: no report follows." }] },
				},
				{
					name: "late-correction-3",
					check: (request) => {
						if (
							!currentRequestCarries(request, "REPORT REQUEST") ||
							!currentRequestCarries(
								request,
								"You answered in text. Submit the same report with the submit_report tool",
							) ||
							!currentRequestCarries(request, recordedLine)
						) {
							throw new Error("the third request is not the repeated report request for the recorded change");
						}
					},
					reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-ROUND-3: no report follows." }] },
				},
			);
			world.provider.enqueue(
				"root",
				calls("create-late-lane", [
					{
						id: "create-late-1",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "late", goalId: "retries-goal" },
					},
				]),
				dynamicCalls(
					"start-late",
					(request) => {
						const late = legendPath(request, "p/late");
						lateLane = late;
						lateLaneBefore = utf8Text(world.io.readFileSync(`${late}/src/limits.ts`, "utf8"));
						return [
							{
								id: "start-late-1",
								name: "delegate",
								arguments: {
									action: "start",
									model: { provider: "harness-script", modelId: "worker-b" },
									path: late,
									writePaths: [`${late}/src/limits.ts`, `${late}/src/late.ts`],
									instructions:
										"Set MAX_RETRIES to 7 in src/limits.ts of your checkout, then submit your report.",
								},
							},
						];
					},
					(request) => assertBatchOk(request, "create-late-lane"),
				),
				{
					name: "late-started",
					check: (request) => {
						assertBatchOk(request, "start-late");
						lateAgentId = latestAgentIdForTrack(request, "worker-b");
					},
					reply: { content: [{ type: "text", text: "The late worker is running." }] },
				},
				{
					name: "late-adverse",
					check: (request) => {
						const adverse = request.context.messages
							.map((message) => JSON.stringify(message))
							.find((text) => text.includes("LATE-INCOMPLETE-REPORT") && text.includes("terminal handoff"));
						if (adverse === undefined) {
							throw new Error(
								"the incomplete run's terminal handoff does not carry its typed incomplete report",
							);
						}
						if (adverse.includes("unparseable_output")) {
							throw new Error("the incomplete run's terminal claim degraded to unparseable output");
						}
						const view = session.backgroundLanes
							.listWorkerAgents()
							.find((agent) => agent.agentId === lateAgentId);
						if (view?.hostVerdict?.verdict !== "needs_more") {
							throw new Error(
								`the host verdict of the incomplete run is ${view?.hostVerdict?.verdict ?? "absent"}`,
							);
						}
						lateAdverse.release();
					},
					reply: { content: [{ type: "text", text: "The late worker ended incomplete." }] },
				},
				{
					name: "late-handoff",
					check: (request) => {
						const truthful = request.context.messages
							.map((message) => JSON.stringify(message))
							.find((text) => text.includes("LATE-CURRENT-REPORT") && text.includes("terminal handoff"));
						if (truthful === undefined) {
							throw new Error("the follow-up's report did not reach the foreground root");
						}
						// Two facts, asserted separately. The typed report is accepted by the host (Claim Status completed, Host verdict accepted).
						// The overall line is partial because the lane holds this worker's uncommitted change (host finding, intentional).
						// The handoff cuts each blocker value at 120 characters, so the visible integration note is the lane's opening clause.
						const identity = `- ${lateRepairTaskId}: partial reason=worker_host_findings`;
						if (
							lateRepairTaskId === undefined ||
							!truthful.includes(identity) ||
							!truthful.includes("Claim Status: completed") ||
							!truthful.includes("Host verdict: accepted") ||
							truthful.split("LATE-CURRENT-REPORT").length !== 2 ||
							!truthful.includes("Changed Files (untrusted worker evidence)") ||
							!truthful.includes("src/late.ts") ||
							!truthful.includes("worker_lane: this worker worked in its own worktree lane 'late'") ||
							truthful.includes("unparseable_output")
						) {
							throw new Error(
								`the follow-up's claim is not the admitted accepted claim of ${lateRepairTaskId ?? "no task"}: ${truthful.slice(0, 4000)}`,
							);
						}
						lateHanded.release();
					},
					reply: { content: [{ type: "text", text: "The late report is reported." }] },
				},
			);
			await withDeadline(trace, "late worker started", session.prompt("Start a late worker on a third lane."));
			trace.mark("root", "late.started");
			await withDeadline(trace, "late request held", lateReached.promise, 60_000);
			if (lateAgentId === undefined || lateLane === undefined || lateLaneBefore === undefined) {
				throw new Error("the late worker identity or lane was not captured");
			}
			expect(lateLaneBefore, "the late lane was created from the landed value 5").toBe(
				"export const MAX_RETRIES = 5;\n",
			);
			const suspended = session.backgroundLanes.interruptWorkerAgent(lateAgentId, undefined, { force: true });
			expect(suspended, "the exact attempt is force-suspended while its request is held").toEqual({
				interrupted: true,
				mode: "suspend",
			});
			// The valid current attempt is queued behind the stale attempt's physical hold and runs no request before the stale terminal.
			const queued = session.backgroundLanes.resumeWorkerAgent(lateAgentId);
			expect(queued.started, "the valid current attempt is queued behind the physical hold").toBe(true);
			expect(world.provider.reached, "no valid current request runs while the stale attempt is held").not.toContain(
				"worker-b:late-write",
			);
			lateMayEmit.release();
			await withDeadline(trace, "late terminal emitted", lateTerminal.promise, 60_000);
			expect(
				world.provider.terminals.filter(
					(terminal) => terminal.modelId === "worker-b" && terminal.ignoredRequestAbort,
				),
				"the late terminal was emitted after the abort it ignored",
			).toEqual([
				expect.objectContaining({ requestAborted: true, ignoredRequestAbort: true, stopReason: "toolUse" }),
			]);
			expect(world.io.readFileSync(`${lateLane}/src/limits.ts`, "utf8"), "the fence drops the late edit").toBe(
				lateLaneBefore,
			);
			expect(
				JSON.stringify(world.provider.requests.filter((request) => request.model.id === "root")),
				"no root turn sees the stale terminal",
			).not.toContain("LATE-STALE-TEXT");
			await withDeadline(trace, "resumed run writes", lateCurrentStarted.promise, 60_000);
			await withDeadline(trace, "incomplete run ends adverse", lateAdverse.promise, 60_000);
			await withDeadline(trace, "adverse foreground settled", session.waitForForegroundIdle(), 60_000);
			trace.mark("root", "late.adverse");
			// Native durable-reader control on the adverse attempt: the production lifecycle reopens the persisted event store, the store
			// opens the attempt's persisted conversation, and the real recovery coordinator reads its terminal completion. Only that read
			// is invoked: every scheduling and publication port throws if reached. This is a durable-reader control, not a normal resume.
			const adverseProjection = session.backgroundLanes.getTaskRuntimeSnapshot();
			if (adverseProjection === undefined) throw new Error("the task runtime projection is not readable");
			// The adverse attempt is the one terminal attempt of the late agent: any other match is ambiguous and refuses the control.
			const lateTerminalAttempts = Object.values(adverseProjection.attempts).filter(
				(attempt) =>
					(attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId && attempt.status !== "queued",
			);
			if (lateTerminalAttempts.length !== 1) {
				throw new Error(`the late agent has ${lateTerminalAttempts.length} terminal attempts, not exactly one`);
			}
			const adverseAttempt = lateTerminalAttempts[0];
			if (adverseAttempt === undefined) throw new Error("the adverse attempt is not in the projection");
			const adverseBindingKey = adverseAttempt.agentId ?? adverseAttempt.dispatch.logicalLaneId;
			if (adverseBindingKey === undefined) throw new Error("the adverse attempt names no agent");
			const adverseBinding = adverseProjection.agents[adverseBindingKey];
			if (adverseBinding?.resumeContext === undefined)
				throw new Error("the adverse agent has no persisted resume context");
			const unusedPort = (name: string) => (): never => {
				throw new Error(`the recovery reader control must not invoke ${name}`);
			};
			const readerWarnings: string[] = [];
			const readerLifecycle = new WorkerLifecycle({
				agentDir: world.agentDir,
				sessionId: created.sessionManager.getSessionId(),
			});
			const readerCoordinator = new WorkerRecoveryCoordinator({
				lifecycle: readerLifecycle,
				scheduler: { enqueue: unusedPort("scheduler.enqueue") },
				recoverWriteReservations: unusedPort("recoverWriteReservations"),
				publishTerminalRecord: unusedPort("publishTerminalRecord"),
				dispatchVerification: unusedPort("dispatchVerification"),
				recoverTaskBearingMailboxTurns: unusedPort("recoverTaskBearingMailboxTurns"),
				recoverSessionRootReplies: unusedPort("recoverSessionRootReplies"),
				warn: (message) => {
					readerWarnings.push(message);
				},
			});
			const adverseConversation = new WorkerConversationStore().open({
				agentDir: world.agentDir,
				resumeContext: adverseBinding.resumeContext,
				expectedLogicalAgentId: adverseBinding.contextOrigin?.logicalAgentId ?? adverseBinding.agentId,
			});
			const recovered = readerCoordinator.recoveredTerminalCompletion(adverseConversation, adverseAttempt.attemptId);
			expect(recovered?.attemptId, "the recovered completion names the exact adverse attempt").toBe(
				adverseAttempt.attemptId,
			);
			expect(recovered?.submittedReport?.summary, "the recovered report is the typed incomplete report").toContain(
				"LATE-INCOMPLETE-REPORT",
			);
			expect(
				readerCoordinator.recoveredTerminalCompletion(adverseConversation, "attempt-foreign-not-in-transcript"),
				"a foreign attempt id is refused",
			).toBeUndefined();
			expect(readerWarnings, "the reader control emits no warnings").toEqual([]);

			// The same persistent agent takes a new turn: its write is the current evidence, and its truthful report is the admitted repair.
			// The old phase is physically queued-empty before the distinct repair is appended: no worker-b step from it can serve the follow-up.
			expect(
				world.provider.getPendingStepNames("worker-b"),
				"the old worker-b phase is fully drained before the repair is appended",
			).toEqual([]);
			world.provider.enqueue(
				"worker-b",
				{
					name: "late-repair-write",
					check: () => {
						lateRepairStarted.release();
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "late-repair-write-1",
								name: "write",
								arguments: { path: "src/late.ts", content: "export const LATE = true;\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				calls("late-current", [
					{
						id: "late-report-1",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "LATE-CURRENT-REPORT: the lane is reported.",
							changes: [{ file: "src/late.ts", what: "Exports the LATE flag from the late module." }],
						},
					},
				]),
			);
			const repair = session.backgroundLanes.followUpSessionRootWorkerAgent(
				lateAgentId,
				"Submit the corrected report with the module change.",
				{
					idempotencyKey: "late-repair-1",
				},
			);
			expect(repair.started, "the follow-up admits a new turn on the same persistent agent").toBe(true);
			lateRepairTaskId = repair.record?.laneId;
			if (lateRepairTaskId === undefined) throw new Error("the follow-up admitted no task");
			await withDeadline(trace, "repair write starts", lateRepairStarted.promise, 60_000);
			await withDeadline(trace, "truthful handoff", lateHanded.promise, 60_000);
			await withDeadline(trace, "late handoff settled", session.waitForForegroundIdle(), 60_000);
			const admitted = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
				(attempt) => attempt.taskId === lateRepairTaskId,
			);
			expect(
				admitted.map((attempt) => attempt.status),
				"the admitted current attempt is partial: the host finding holds the uncommitted lane change",
			).toEqual(["partial"]);
			// Native proof of the admitted repair. The handoff renders each blocker clipped, so the uncommitted integration finding is read
			// from the persisted result in full, with the exact marker, and from the agent's latest host verdict.
			const repairResult = session.backgroundLanes.getWorkerResult(lateRepairTaskId);
			expect(repairResult?.status, "the repair result is partial because of the host finding").toBe("partial");
			expect(repairResult?.summary, "the repair result carries the current report").toContain("LATE-CURRENT-REPORT");
			expect(
				repairResult?.errors.map((error) => error.message),
				"the host finding names the lane and the uncommitted integration change",
			).toEqual(expect.arrayContaining([expect.stringContaining("its changes are there: uncommitted changes")]));
			const lateSnapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
			const lateView = session.backgroundLanes.listWorkerAgents().find((agent) => agent.agentId === lateAgentId);
			const lateDiagnostic = JSON.stringify({
				view: {
					hostVerdict: lateView?.hostVerdict,
					lastResult: lateView?.lastResult,
					dispatch: lateView?.dispatch,
					recommendedDisposition: lateView?.recommendedDisposition,
				},
				attempts: Object.values(lateSnapshot?.attempts ?? {})
					.filter((attempt) => (attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId)
					.map((attempt) => ({
						attemptId: attempt.attemptId,
						taskId: attempt.taskId,
						status: attempt.status,
						logicalLaneId: attempt.dispatch.logicalLaneId,
						result: attempt.result?.status,
					})),
				repairTaskId: lateRepairTaskId,
			});
			expect(
				lateView?.hostVerdict?.verdict,
				`the agent's latest report is accepted by the host: ${lateDiagnostic}`,
			).toBe("accepted");
			// The superseded adverse turn's unreported-change finding must not survive into the current view's verdict or advice.
			expect(
				JSON.stringify({ missing: lateView?.hostVerdict?.missing ?? [], advice: lateView?.recommendedDisposition }),
				"the latest view carries no reason from the superseded unreported-change turn",
			).not.toMatch(/unreported|no explanation/);
			expect(
				world.io.readFileSync(`${lateLane}/src/limits.ts`, "utf8"),
				"the stale edit never reached the limits",
			).toBe(lateLaneBefore);
			expect(world.io.readFileSync(`${lateLane}/src/late.ts`, "utf8"), "the current attempt wrote its module").toBe(
				"export const LATE = true;\n",
			);
			expect(lateWriteAfterStaleTerminal, "the valid-current write ran after the stale terminal").toBe(true);
			trace.mark("root", "late.reported");

			// E10 (one shared checkout, explicit overlapping write scopes): two writers name overlapping extra roots, so the second
			// waits on the reservation its start receipt names; a disjoint writer completes beside the held one; an out-of-scope write
			// is refused and leaves a pre-existing sentinel unchanged. Every start is bound to its own lane, task and attempt.
			const E10_MODEL = "worker-c";
			const E10_SHARED = `${HARNESS_PROJECT_CWD}/e10/shared`;
			const E10_NESTED = `${E10_SHARED}/nested`;
			const E10_C_SCOPE = `${HARNESS_PROJECT_CWD}/e10/other/c`;
			const E10_D_SCOPE = `${HARNESS_PROJECT_CWD}/e10/other/d`;
			const E10_OUTSIDE = "/harness/e10-outside/d.txt";
			const E10_SENTINEL = "E10-SENTINEL\n";
			const E10_INSTRUCTIONS = {
				a: "E10-WORKER-A writes its file in the shared checkout and reports.",
				b: "E10-WORKER-B writes its nested file in the shared checkout and reports.",
				c: "E10-WORKER-C writes its file beside the held scope and reports.",
				d: "E10-WORKER-D attempts an out-of-scope write and reports.",
			} as const;
			const E10_SUMMARIES = {
				a: "E10 A wrote its file.",
				b: "E10 B wrote its file.",
				c: "E10 C wrote its file.",
				d: "E10 D reported its refusal.",
			} as const;
			// Handoffs wake the root in this order: C completes first while A and D hold, then D, then A, then B.
			const E10_WAKE_ORDER = ["c", "d", "a", "b"] as const;
			const e10ReleaseA = createBarrier();
			const e10ReleaseD = createBarrier();
			const e10ReleaseC = createBarrier();
			const e10Woke = { a: createBarrier(), b: createBarrier(), c: createBarrier(), d: createBarrier() };
			// A worker's tail is joined by the foreground submission epoch its wake turn ran under: that epoch is released with no active run.
			const e10Tails = { c: createBarrier(), d: createBarrier() };
			const e10Epochs: Partial<Record<"c" | "d", { readonly epoch: number; readonly requestSequence: number }>> = {};
			const e10TailDone: Record<"c" | "d", boolean> = { c: false, d: false };
			let e10ATerminal = false;
			let e10BFirstRequest:
				| Array<{
						readonly taskId: string;
						readonly attemptId: string;
						readonly ownerId: string;
						readonly fencingToken: number;
						readonly writeScopes: string[];
				  }>
				| undefined;
			let e10BAttemptLease: { readonly ownerId: string; readonly fencingToken: number } | undefined;
			const e10Matches = (marker: string) => (request: ScriptedRequest) =>
				JSON.stringify(request.context.messages).includes(marker);
			const e10Report = (
				id: string,
				key: keyof typeof E10_SUMMARIES,
				changes: readonly { readonly file: string; readonly what: string }[] = [],
				status: "completed" | "blocked" = "completed",
			): ScriptStep => ({
				name: `e10-${key}-report`,
				reply: {
					content: [
						{
							type: "toolCall",
							id,
							name: "submit_report",
							arguments: { status, summary: E10_SUMMARIES[key], changes: [...changes] },
						},
					],
					stopReason: "toolUse",
				},
			});
			world.provider.enqueueTrack(
				"e10-a",
				E10_MODEL,
				e10Matches("E10-WORKER-A"),
				{
					name: "e10-a-write",
					gate: e10ReleaseA.promise,
					reply: {
						content: [
							{
								type: "toolCall",
								id: "e10-a-write-1",
								name: "write",
								arguments: { path: `${E10_SHARED}/a.txt`, content: "A-WRITTEN\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					...e10Report("e10-a-report-1", "a", [{ file: `${E10_SHARED}/a.txt`, what: "Writes the shared file." }]),
					onTerminal: () => {
						e10ATerminal = true;
					},
				},
			);
			world.provider.enqueueTrack(
				"e10-b",
				E10_MODEL,
				e10Matches("E10-WORKER-B"),
				{
					name: "e10-b-write",
					check: () => {
						// Physical, not wire: the held writer's reservation lease must be gone before this request is admitted.
						const held = session.getResourceSnapshot().workers?.reservations.heldLeases ?? [];
						if (held.some((lease) => lease.taskId === e10Start("e10-start-a-1").laneId)) {
							throw new Error("the second writer reached a request while the held writer's lease is still held");
						}
						e10BFirstRequest = held.map((lease) => ({
							taskId: lease.taskId,
							attemptId: lease.attemptId,
							ownerId: lease.ownerId,
							fencingToken: lease.fencingToken,
							writeScopes: [...lease.writeScopes],
						}));
						e10BAttemptLease = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
							.filter((attempt) => attempt.taskId === e10Start("e10-start-b-1").laneId)
							.map((attempt) => attempt.lease)
							.find((lease) => lease !== undefined);
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "e10-b-write-1",
								name: "write",
								arguments: { path: `${E10_NESTED}/b.txt`, content: "B-WRITTEN\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				e10Report("e10-b-report-1", "b", [{ file: `${E10_NESTED}/b.txt`, what: "Writes the nested file." }]),
			);
			world.provider.enqueueTrack(
				"e10-c",
				E10_MODEL,
				e10Matches("E10-WORKER-C"),
				{
					name: "e10-c-write",
					gate: e10ReleaseC.promise,
					reply: {
						content: [
							{
								type: "toolCall",
								id: "e10-c-write-1",
								name: "write",
								arguments: { path: `${E10_C_SCOPE}/c.txt`, content: "C-WRITTEN\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				e10Report("e10-c-report-1", "c", [{ file: `${E10_C_SCOPE}/c.txt`, what: "Writes the disjoint file." }]),
			);
			world.provider.enqueueTrack(
				"e10-d",
				E10_MODEL,
				e10Matches("E10-WORKER-D"),
				{
					name: "e10-d-write",
					gate: e10ReleaseD.promise,
					reply: {
						content: [
							{
								type: "toolCall",
								id: "e10-d-write-1",
								name: "write",
								arguments: { path: E10_OUTSIDE, content: "D-OUTSIDE\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				e10Report("e10-d-report-1", "d", [], "blocked"),
			);
			// A start while a compatible writer runs is refused as busy unless parallelWork names the running agents it is independent of.
			// The agent ids come from the earlier start receipts, read when this request is made.
			const e10StartCall = (
				key: keyof typeof E10_INSTRUCTIONS,
				writePaths: readonly string[],
				independentKeys: readonly (keyof typeof E10_INSTRUCTIONS)[] = [],
			) =>
				dynamicCalls(`e10-start-${key}`, () => [
					{
						id: `e10-start-${key}-1`,
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: E10_MODEL },
							instructions: E10_INSTRUCTIONS[key],
							writePaths: [...writePaths],
							...(independentKeys.length > 0
								? {
										parallelWork: {
											independentOf: independentKeys.map(
												(other) => e10Start(`e10-start-${other}-1`).agentId,
											),
											justification: `Overlapping writer on the one shared checkout: ${E10_INSTRUCTIONS[key]}`,
										},
									}
								: {}),
						},
					},
				]);
			const e10WakeSteps = E10_WAKE_ORDER.map((key, index): ScriptStep => {
				const delivered = E10_WAKE_ORDER.slice(0, index + 1);
				return {
					name: `e10-wake-${key}`,
					check: (request) => {
						const serialized = JSON.stringify(request.context.messages);
						for (const other of E10_WAKE_ORDER) {
							const present = serialized.includes(E10_SUMMARIES[other]);
							if (delivered.includes(other) !== present) {
								throw new Error(
									`the wake for ${key} expects ${other} ${delivered.includes(other) ? "present" : "absent"}`,
								);
							}
						}
						if (key === "c" || key === "d") {
							const activity = session.getForegroundActivity();
							if (activity.epoch === undefined)
								throw new Error(`the ${key} wake turn runs under no submission epoch`);
							e10Epochs[key] = { epoch: activity.epoch, requestSequence: request.sequence };
						}
						e10Woke[key].release();
					},
					reply: { content: [{ type: "text", text: `Writer ${key} is reported.` }] },
				};
			});
			world.provider.enqueue(
				"root",
				e10StartCall("a", [E10_SHARED]),
				e10StartCall("b", [E10_NESTED], ["a"]),
				e10StartCall("c", [E10_C_SCOPE], ["a", "b"]),
				e10StartCall("d", [E10_D_SCOPE], ["a", "b", "c"]),
				{
					name: "e10-started",
					reply: { content: [{ type: "text", text: "The overlapping writers are started." }] },
				},
				...e10WakeSteps,
			);
			// The durable start receipt of one call: whether it started, its skip reason, and the exact agent and lane it names.
			const e10Start = (
				toolCallId: string,
			): { started: boolean; skipReason?: string; agentId: string; laneId: string; text: string } => {
				const entry = created.sessionManager
					.getBranch()
					.find(
						(candidate) =>
							candidate.type === "message" &&
							candidate.message.role === "toolResult" &&
							candidate.message.toolCallId === toolCallId,
					);
				if (entry?.type !== "message" || entry.message.role !== "toolResult") {
					throw new Error(`no durable start result for ${toolCallId}`);
				}
				const details = entry.message.details as
					| { started?: unknown; skipReason?: unknown; agentId?: unknown; laneId?: unknown }
					| undefined;
				if (typeof details?.agentId !== "string" || typeof details.laneId !== "string") {
					throw new Error(`the start result ${toolCallId} carries no agent or lane id`);
				}
				return {
					started: details.started === true,
					...(typeof details.skipReason === "string" ? { skipReason: details.skipReason } : {}),
					agentId: details.agentId,
					laneId: details.laneId,
					text: entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				};
			};
			// The attempt a lane names: the task's own attempt. The lane id is the task id, so a reused agent's older attempts never match.
			const e10AttemptOf = (laneId: string) =>
				Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
					.filter((attempt) => attempt.taskId === laneId)
					.at(-1);
			const e10HeldLease = (laneId: string) =>
				(session.getResourceSnapshot().workers?.reservations.heldLeases ?? []).find(
					(lease) => lease.taskId === laneId,
				);
			const e10Held = (): string[] =>
				(session.getResourceSnapshot().workers?.reservations.heldLeases ?? []).map((lease) => lease.taskId).sort();
			// The persisted completion of a wake: the handoff entry in the root branch, then the next assistant entry.
			const e10WakeCompletion = (
				summary: string,
			): { readonly stopReason: string | undefined; readonly text: string } => {
				const branch = created.sessionManager.getBranch();
				const delivered = branch.findIndex(
					(entry) => entry.type === "custom_message" && JSON.stringify(entry).includes(summary),
				);
				if (delivered < 0) throw new Error(`no persisted handoff carries ${summary}`);
				const completion = branch
					.slice(delivered + 1)
					.find((entry) => entry.type === "message" && entry.message.role === "assistant");
				if (completion?.type !== "message" || completion.message.role !== "assistant") {
					throw new Error(`no persisted assistant completion follows ${summary}`);
				}
				return {
					stopReason: completion.message.stopReason,
					text: completion.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				};
			};
			const e10ToolResultError = (toolCallId: string): boolean | undefined => {
				for (const [path, content] of world.io.fileEntries()) {
					if (!path.includes("worker-conversations") || !path.endsWith(".jsonl")) continue;
					for (const line of content.split("\n")) {
						if (!line.includes(toolCallId)) continue;
						// The persisted entry wraps its message; the message itself carries the role, call id and error flag.
						const entry = JSON.parse(line) as ConversationRecord & { readonly message?: ConversationRecord };
						const message: ConversationRecord = entry.message ?? entry;
						if (message.role === "toolResult" && message.toolCallId === toolCallId) return message.isError;
					}
				}
				return undefined;
			};
			// Observer seam: the activity listener is subscribed before the wake turns. A tail is joined when its captured epoch is
			// released and no foreground run is active; no timer, poll, or global-idle wait is involved while A and D hold.
			const offE10Tail = session.subscribeForegroundActivity(() => {
				for (const key of ["c", "d"] as const) {
					const captured = e10Epochs[key];
					if (captured === undefined || e10TailDone[key]) continue;
					if (session.getForegroundActivity().epoch === captured.epoch) continue;
					if (session.getResourceSnapshot().foregroundRecovery.activeRuns !== 0) continue;
					e10TailDone[key] = true;
					e10Tails[key].release();
				}
			});
			world.systemOne.enterPhase(
				"e10",
				{
					changes_model_pools: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "inspect", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
					states_committed: { kind: "noul", probability: 0.02 },
					states_pushed: { kind: "noul", probability: 0.02 },
					states_published: { kind: "noul", probability: 0.02 },
					states_files_changed: { kind: "noul", probability: 0.97 },
				},
				{
					expect: ownerWords("Start the overlapping writers on the shared checkout."),
				},
			);
			try {
				await withDeadline(
					trace,
					"E10 start turn",
					session.prompt("Start the overlapping writers on the shared checkout."),
					120_000,
				);
				e10ReleaseC.release();
				// C is released only after the start prompt's full tail has returned: its wake is not folded into that turn.
				// Immediate receipts, before any wait on the held writers: every start is accepted with its agent and lane. A and D run
				// gated; B's receipt names the reservation it waits on, and the held lease carries A's own attempt and scope.
				const e10StartA = e10Start("e10-start-a-1");
				const e10StartB = e10Start("e10-start-b-1");
				const e10StartC = e10Start("e10-start-c-1");
				const e10StartD = e10Start("e10-start-d-1");
				expect(
					{ a: e10StartA.started, b: e10StartB.started, c: e10StartC.started, d: e10StartD.started },
					"each start receipt records an accepted start",
				).toEqual({ a: true, b: true, c: true, d: true });
				expect(
					[e10StartA.skipReason, e10StartB.skipReason, e10StartC.skipReason, e10StartD.skipReason],
					"no start receipt carries a skip reason",
				).toEqual([undefined, undefined, undefined, undefined]);
				expect(e10StartB.text, "B's receipt names the reservation it waits on").toContain(
					"waiting: write_reservation: ",
				);
				expect(e10StartB.text, "B's wait is on a worker of this session").toContain(
					"held by a worker of this session",
				);
				const laneA = e10StartA.laneId;
				const laneB = e10StartB.laneId;
				const laneD = e10StartD.laneId;
				expect(
					{
						a: e10AttemptOf(laneA)?.status,
						b: e10AttemptOf(laneB)?.status,
						d: e10AttemptOf(laneD)?.status,
					},
					"right after the start turn A and D run gated and B waits behind A",
				).toEqual({ a: "running", b: "queued", d: "running" });
				expect(e10HeldLease(laneA)?.attemptId, "A's held lease is A's own attempt").toBe(
					e10AttemptOf(laneA)?.attemptId,
				);
				expect(e10HeldLease(laneA)?.writeScopes, "A's held lease covers the shared scope").toContain(E10_SHARED);
				expect(e10HeldLease(laneD)?.writeScopes, "D's held lease covers its own scope").toContain(E10_D_SCOPE);
				await withDeadline(trace, "C reported", e10Woke.c.promise, 90_000).catch((error: unknown) => {
					throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
				});
				await withDeadline(trace, "C tail released", e10Tails.c.promise, 90_000);
				expect(
					e10WakeCompletion(E10_SUMMARIES.c),
					"C's persisted completion after its handoff is the scripted stop and answer",
				).toEqual({ stopReason: "stop", text: "Writer c is reported." });
				const laneC = e10StartC.laneId;
				// The completed disjoint writer proves the held scope did not block it; A and D stay held; B still waits.
				expect(
					{
						a: e10AttemptOf(laneA)?.status,
						b: e10AttemptOf(laneB)?.status,
						c: e10AttemptOf(laneC)?.status,
						d: e10AttemptOf(laneD)?.status,
					},
					"at C's tail A and D hold, B waits behind A, and C completed",
				).toEqual({ a: "running", b: "queued", c: "completed", d: "running" });
				expect(e10Held(), "the held leases are A's and D's lanes only").toEqual([laneA, laneD].sort());
				e10ReleaseD.release();
				await withDeadline(trace, "D reported", e10Woke.d.promise, 90_000);
				await withDeadline(trace, "D tail released", e10Tails.d.promise, 90_000);
				expect(
					e10WakeCompletion(E10_SUMMARIES.d),
					"D's persisted completion after its handoff is the scripted stop and answer",
				).toEqual({ stopReason: "stop", text: "Writer d is reported." });
				// D's out-of-scope write is refused by the file gate, persisted as an error result, and leaves the pre-existing sentinel.
				expect(e10AttemptOf(laneD)?.status, "D's honest blocked report is its native adverse terminal").toBe(
					"blocked",
				);
				expect(e10ToolResultError("e10-d-write-1"), "the out-of-scope write is refused").toBe(true);
				expect(world.io.existsSync(E10_OUTSIDE), "the sentinel outside the scope still exists").toBe(true);
				expect(
					String(world.io.readFileSync(E10_OUTSIDE, "utf8")),
					"the refused write leaves the sentinel bytes",
				).toBe(E10_SENTINEL);
				expect(e10AttemptOf(laneB)?.status, "B still waits behind A after D's terminal").toBe("queued");
				// Release A: its terminal ends the hold, and the release event admits B; B's first request is after A's terminal.
				e10ReleaseA.release();
				await withDeadline(trace, "A reported", e10Woke.a.promise, 90_000);
				await withDeadline(trace, "B reported", e10Woke.b.promise, 90_000);
				expect(e10ATerminal, "the held writer reached its wire terminal first").toBe(true);
				expect(
					e10BFirstRequest?.some((lease) => lease.taskId === e10StartA.laneId),
					"A's physical lease is absent when B's first request runs",
				).toBe(false);
				expect(
					e10BFirstRequest
						?.filter((lease) => lease.taskId === laneB)
						.map((lease) => ({
							attemptId: lease.attemptId,
							nested: lease.writeScopes.some((scope) => scope.endsWith("/e10/shared/nested")),
						})),
					"B's physical lease at its first request is its own attempt over its nested scope",
				).toEqual([{ attemptId: e10AttemptOf(laneB)?.attemptId, nested: true }]);
				// The reservation lease carries the admitted attempt's own lease fence and owner, observed at its first request.
				expect(
					e10BFirstRequest
						?.filter((lease) => lease.taskId === laneB)
						.map((lease) => ({
							attemptId: lease.attemptId,
							ownerId: lease.ownerId,
							fencingToken: lease.fencingToken,
						})),
					"B's physical lease carries its own admitted attempt's owner and fence",
				).toEqual([
					{
						attemptId: e10AttemptOf(laneB)?.attemptId,
						ownerId: e10BAttemptLease?.ownerId,
						fencingToken: e10BAttemptLease?.fencingToken,
					},
				]);
				await withDeadline(trace, "E10 settled", session.waitForForegroundIdle(), 90_000);
				offE10Tail();
				expect(
					{
						a: e10AttemptOf(laneA)?.status,
						b: e10AttemptOf(laneB)?.status,
						c: e10AttemptOf(laneC)?.status,
						d: e10AttemptOf(laneD)?.status,
					},
					"every writer reaches its native terminal once the held scope is released",
				).toEqual({ a: "completed", b: "completed", c: "completed", d: "blocked" });
				expect(e10Held(), "no lease remains after the overlap settles").toEqual([]);
				// Same-model identities: four workers share one provider model; each exact attempt is its own grant, routed by its own context.
				const grants = [laneA, laneB, laneC, laneD].map((lane) => e10AttemptOf(lane)?.grantId);
				expect(
					grants.every((grant) => typeof grant === "string"),
					"every attempt carries its own grant",
				).toBe(true);
				expect(new Set(grants).size, "the four grants are distinct").toBe(4);
				const e10Runtime = session.backgroundLanes.getTaskRuntimeSnapshot();
				const e10Agents = [e10StartA, e10StartB, e10StartC, e10StartD].map(
					(start) => e10Runtime?.agents[start.agentId],
				);
				expect(
					new Set([laneA, laneB, laneC, laneD].map((lane) => e10AttemptOf(lane)?.attemptId)).size,
					"four distinct attempts",
				).toBe(4);
				expect(
					new Set(e10Agents.map((agent) => agent?.resumeContext.sessionId)).size,
					"four distinct resume identities",
				).toBe(4);
				expect(
					new Set(e10Agents.map((agent) => agent?.resumeContext.modelRef)).size,
					"all four agents run one provider model",
				).toBe(1);
				expect(e10Agents[0]?.resumeContext.modelRef, "the shared model is recorded on each agent").toEqual(
					expect.any(String),
				);
				expect(
					world.provider.reached.filter((entry) => entry.startsWith("e10-")).map((entry) => entry.split(":")[0]),
					"each request routed to its own track by its own context",
				).toEqual(expect.arrayContaining(["e10-a", "e10-b", "e10-c", "e10-d"]));
				expect(String(world.io.readFileSync(`${E10_SHARED}/a.txt`, "utf8")), "A wrote its scope").toBe(
					"A-WRITTEN\n",
				);
				expect(String(world.io.readFileSync(`${E10_NESTED}/b.txt`, "utf8")), "B wrote its scope").toBe(
					"B-WRITTEN\n",
				);
				expect(String(world.io.readFileSync(`${E10_C_SCOPE}/c.txt`, "utf8")), "C wrote its scope").toBe(
					"C-WRITTEN\n",
				);
			} catch (error) {
				// A failed proof must not leave a producer gated: the writers this block holds join, and the failure still propagates.
				e10ReleaseC.release();
				offE10Tail();
				e10ReleaseA.release();
				e10ReleaseD.release();
				throw error;
			}
			// Integration and completion: the late lane's module lands, both delegated workers retire, and the goal completes on the
			// host after a passing run is recorded as evidence. The orchestration journey also checks active-lane refusal.
			const e12PersistGates: Array<{
				readonly cwd: string;
				readonly command: string;
				readonly tip: string | undefined;
			}> = [];
			// E12 gate steps are queued first: the shell queue is FIFO and the gate runs before the integration vitest run.
			const E12_GATE = "npm run check";
			const e12Reached = createBarrier();
			const e12Release = createBarrier();
			let e12LanePath: string | undefined;
			const e12ToolText = (toolCallId: string): string => {
				const entry = created.sessionManager
					.getBranch()
					.find(
						(candidate) =>
							candidate.type === "message" &&
							candidate.message.role === "toolResult" &&
							candidate.message.toolCallId === toolCallId,
					);
				if (entry?.type !== "message" || entry.message.role !== "toolResult") {
					throw new Error(`no durable tool result for ${toolCallId}`);
				}
				return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			};
			const e12LandCall = (id: string) => ({
				id,
				name: "worktree_sync",
				arguments: { action: "land", laneKey: "e12" },
			});
			world.shell.enqueue(
				{ name: "e12-gate-fails", command: E12_GATE, output: "check failed", exitCode: 1 },
				{
					name: "e12-gate-tip-moves",
					command: E12_GATE,
					output: "check passed",
					exitCode: 0,
					check: () => {
						e12Reached.release();
					},
					gate: e12Release.promise,
				},
				{ name: "e12-gate-passes", command: E12_GATE, output: "check passed", exitCode: 0 },
				{
					name: "e12-persist-gate-first",
					command: E12_GATE,
					output: "check passed",
					exitCode: 0,
					check: (request) => {
						e12PersistGates.push({
							cwd: request.cwd,
							command: request.command,
							tip: world.git.refSha("refs/heads/pi/wt/e12"),
						});
					},
				},
				{
					name: "e12-persist-gate-second",
					command: E12_GATE,
					output: "check passed",
					exitCode: 0,
					check: (request) => {
						e12PersistGates.push({
							cwd: request.cwd,
							command: request.command,
							tip: world.git.refSha("refs/heads/pi/wt/e12"),
						});
					},
				},
			);
			const integrateVitest = "vitest run test/limits.test.ts";
			let integrationAdmission:
				| { readonly mainSha: string | undefined; readonly limits: string; readonly late: string }
				| undefined;
			const integrationVitestOutput = ["Test Files  1 passed (1)\n", "Tests  1 passed (1)\n"];
			world.shell.enqueue({
				name: "vitest-pass-integration",
				command: integrateVitest,
				output: integrationVitestOutput,
				exitCode: 0,
				check: () => {
					integrationAdmission = {
						mainSha: world.git.refSha("refs/heads/main"),
						limits: String(world.io.readFileSync(LIMITS_PATH, "utf8")),
						late: String(world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/late.ts`, "utf8")),
					};
					if (world.io.readFileSync(LIMITS_PATH, "utf8") !== "export const MAX_RETRIES = 5;\n") {
						throw new Error("the run saw a limits value other than 5");
					}
					if (
						world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/late.ts`, "utf8") !== "export const LATE = true;\n"
					) {
						throw new Error("the run saw no landed late module");
					}
				},
			});
			const e0Counters: E0Counters = zeroE0Counters();
			world.systemOne.enterPhase(
				"integrate",
				{
					...lateJudgments,
				},
				{
					expect: (request) => {
						ownerWords("Integrate the late lane's module.")(request);
						const controller = session.systemOneController;
						if (controller === undefined)
							throw new Error("the E0 integrate phase has no bound System One controller");
						bindE0Request(request, controller.store.snapshot(), session.messages.length, e0Counters);
					},
				},
			);
			world.provider.enqueue(
				"root",
				calls("integrate-late", [
					{
						id: "add-late-1",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "late", paths: ["src/late.ts"] },
					},
					{
						id: "commit-late-1",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "late", message: "Add the late module" },
					},
				]),
				{
					name: "land-late",
					check: (request) => {
						assertBatchOk(request, "integrate-late");
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "land-late-1",
								name: "worktree_sync",
								arguments: { action: "land", laneKey: "late" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-landed",
					check: (request) => {
						const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
						if (!landed)
							throw new Error(`the late lane did not land: ${JSON.stringify(latestBatchResults(request))}`);
					},
					reply: { content: [{ type: "text", text: "The late module landed." }] },
				},
			);
			await withDeadline(trace, "integration turn", session.prompt("Integrate the late lane's module."));
			if (world.systemOne.enabled) {
				expect(
					e0Counters.preflight,
					"the integrate turn's preflight is bound to its admitted boundary",
				).toBeGreaterThan(0);
				expect(
					e0Counters.postflight,
					"the integrate turn's postflight is bound to its admitted boundary",
				).toBeGreaterThan(0);
				// The integrate turn makes no tool-gate request, so the tool-gate stage is not exercised here. Evidence rows are not
				// asserted in this phase: the preflight may legitimately carry none before verification evidence is admitted.
			} else {
				expect(e0Counters, "off runs no System One and binds nothing").toEqual(zeroE0Counters());
			}
			trace.mark("root", "late.integrated");
			// E12 (executed worktree gate): a lane lands only through the gate command run in its worktree at its exact tip. A refused
			// gate leaves main unchanged; a tip that moves while the gate runs is refused, not merged; a gate that passes at the
			// unchanged tip lands it. The gate command is the owner's trusted setting, run by the shell port.
			world.settingsManager.applyOverrides({ worktreeSync: { gate: "on", gateCommand: E12_GATE } });
			world.provider.enqueue(
				"root",
				calls("e12-create", [
					{
						id: "e12-create-1",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "e12", goalId: "retries-goal" },
					},
				]),
				dynamicCalls("e12-write", (request) => {
					e12LanePath = legendPath(request, "p/e12");
					return [
						{
							id: "e12-write-1",
							name: "write",
							arguments: { path: `${e12LanePath}/src/e12.ts`, content: "export const E12 = 1;\n" },
						},
					];
				}),
				calls("e12-commit", [
					{
						id: "e12-add-1",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12.ts"] },
					},
					{
						id: "e12-commit-1",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "e12", message: "Add the E12 module" },
					},
				]),
				calls("e12-land-refused", [e12LandCall("e12-land-1")]),
				{
					name: "e12-refused-read",
					reply: { content: [{ type: "text", text: "The gate refused the first land." }] },
				},
				calls("e12-land-moved", [e12LandCall("e12-land-2")]),
				{ name: "e12-moved-read", reply: { content: [{ type: "text", text: "The gate refused the moved tip." }] } },
				calls("e12-land-passes", [e12LandCall("e12-land-3")]),
				{ name: "e12-landed-read", reply: { content: [{ type: "text", text: "The unchanged tip landed." }] } },
			);
			world.systemOne.enterPhase(
				"e12",
				{
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "inspect", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				},
				{
					expect: ownerWords(
						"Create the e12 lane, commit its module, and land it through the gate.",
						"Land the e12 lane again while its gate runs.",
						"Land the e12 lane once its gate passes.",
					),
				},
			);
			const e12MainBefore = world.git.refSha("refs/heads/main");
			await withDeadline(
				trace,
				"E12 create, commit and refused land",
				session.prompt("Create the e12 lane, commit its module, and land it through the gate."),
				120_000,
			);
			expect(e12ToolText("e12-land-1"), "the gate command failed at the lane tip").toContain(
				"gate command failed (exit 1)",
			);
			expect(world.git.refSha("refs/heads/main"), "a refused gate leaves main unchanged").toBe(e12MainBefore);
			// The lane tip moves while its gate runs: the external writer commits in the lane, and only then is the gate released.
			const movedLanding = session.prompt("Land the e12 lane again while its gate runs.");
			await withDeadline(trace, "E12 gate reached", e12Reached.promise, 90_000);
			if (e12LanePath === undefined) throw new Error("the e12 lane path was never read from the request legend");
			world.io.writeFileSync(`${e12LanePath}/src/e12-late.ts`, "export const E12_LATE = 1;\n");
			const added = world.git.run(["add", "src/e12-late.ts"], e12LanePath, {});
			const committed = world.git.run(["commit", "-m", "External E12 change during the gate"], e12LanePath, {});
			if (added.code !== 0 || committed.code !== 0) {
				throw new Error(`the external lane commit failed: ${added.stderr}${committed.stderr}`);
			}
			e12Release.release();
			await withDeadline(trace, "E12 moved landing", movedLanding, 120_000);
			expect(e12ToolText("e12-land-2"), "a tip that moved during the gate is refused, not merged").toContain(
				"changed during the gate",
			);
			expect(world.git.refSha("refs/heads/main"), "the moved tip leaves main unchanged").toBe(e12MainBefore);
			// The unchanged tip, gated and passing, lands: main moves to exactly the tip that was tested.
			await withDeadline(
				trace,
				"E12 passing landing",
				session.prompt("Land the e12 lane once its gate passes."),
				120_000,
			);
			expect(e12ToolText("e12-land-3"), "the passing gate lands the unchanged tip").toContain("LANDED");
			expect(world.git.refSha("refs/heads/main"), "main moves to the tested lane tip").toBe(
				world.git.refSha("refs/heads/pi/wt/e12"),
			);
			trace.mark("root", "e12.landed");
			// E12 persistence (post-CAS): the epoch record fails after main has moved, with the gate ON for both landings. The landing
			// transaction is the only durable record. Each reconcile is checked against the raw persisted epoch, transaction and event
			// log: the first on its own, the second against the first's bytes. No session getter stands in for persisted state here.
			const e12Record = (name: string): string | undefined => {
				for (const [path, content] of world.io.fileEntries()) {
					if (path.endsWith(`/${name}`)) return content;
				}
				return undefined;
			};
			const e12EventLog = (): string => e12Record("events.jsonl") ?? "";
			let e12PreSecond:
				| { readonly epoch: string | undefined; readonly transaction: string | undefined; readonly events: string }
				| undefined;
			const e12Snapshot = () => ({
				epoch: e12Record("epoch.json"),
				transaction: e12Record("landing-transaction.json"),
				events: e12EventLog(),
			});
			const e12EpochEvents = (log: string): number =>
				log.split("\n").filter((line) => line.includes('"event":"epoch_reconciled"')).length;
			const e12EpochRecord = (): { readonly epoch?: number; readonly mainSha?: string } | undefined => {
				const text = e12Record("epoch.json");
				return text === undefined
					? undefined
					: (JSON.parse(text) as { readonly epoch?: number; readonly mainSha?: string });
			};
			const e12Transaction = (): { readonly stage?: string; readonly testedTipSha?: string } | undefined => {
				const text = e12Record("landing-transaction.json");
				return text === undefined
					? undefined
					: (JSON.parse(text) as { readonly stage?: string; readonly testedTipSha?: string });
			};
			const e12EpochFault = () =>
				world.io.failNext({
					name: "e12-epoch-rename-fails",
					kind: "rename",
					matches: (operation) => operation.destination?.endsWith("epoch.json") === true,
					code: "EIO",
					times: 1,
				});
			// The gate stays on for both persistence landings: each runs its scripted gate command at the tested tip before the epoch fails.
			world.settingsManager.applyOverrides({ worktreeSync: { gate: "on", gateCommand: E12_GATE } });
			world.systemOne.enterPhase(
				"e12-persist",
				{
					changes_model_pools: { kind: "noul", probability: 0.02 },
					local_commits_only: { kind: "noul", probability: 0.02 },
					lifts_delivery_block: { kind: "noul", probability: 0.02 },
					full_handoff: { kind: "noul", probability: 0.02 },
					optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
					states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
					states_committed: { kind: "noul", probability: 0.02 },
					states_pushed: { kind: "noul", probability: 0.02 },
					states_published: { kind: "noul", probability: 0.02 },
					states_files_changed: { kind: "noul", probability: 0.97 },
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "inspect", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.02 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				},
				{
					expect: ownerWords(
						"Commit the post-gate module and land it while its epoch record cannot be written.",
						"Reconcile the landing record.",
						"Reconcile the landing record again.",
						"Write another module and land it under the same fault.",
						"Reconcile after the ref moved.",
						"Reconcile once the ref is repaired.",
					),
				},
			);
			world.provider.enqueue(
				"root",
				calls("e12p-write", [
					{
						id: "e12p-write-1",
						name: "write",
						arguments: { path: `${e12LanePath}/src/e12-persist.ts`, content: "export const E12_PERSIST = 1;\n" },
					},
				]),
				calls("e12p-commit", [
					{
						id: "e12p-add-1",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12-persist.ts"] },
					},
					{
						id: "e12p-commit-1",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "e12", message: "Add the E12 persistence module" },
					},
				]),
				calls("e12p-land", [e12LandCall("e12p-land-1")]),
				{
					name: "e12p-landed-read",
					reply: { content: [{ type: "text", text: "The epoch record could not be written." }] },
				},
				calls("e12p-reconcile-1", [
					{ id: "e12p-reconcile-1", name: "worktree_sync", arguments: { action: "reconcile" } },
				]),
				{
					name: "e12p-first-read",
					reply: { content: [{ type: "text", text: "The first reconcile rolled the landing forward." }] },
				},
				dynamicCalls(
					"e12p-reconcile-2",
					() => [{ id: "e12p-reconcile-2", name: "worktree_sync", arguments: { action: "reconcile" } }],
					() => {
						e12PreSecond = e12Snapshot();
					},
				),
				{
					name: "e12p-reconciled-read",
					reply: { content: [{ type: "text", text: "The second reconcile found the record settled." }] },
				},
				calls("e12p-write-2", [
					{
						id: "e12p-write-2-1",
						name: "write",
						arguments: { path: `${e12LanePath}/src/e12-ambig.ts`, content: "export const E12_AMBIG = 1;\n" },
					},
				]),
				calls("e12p-commit-2", [
					{
						id: "e12p-add-2",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12-ambig.ts"] },
					},
					{
						id: "e12p-commit-2-1",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "e12", message: "Add the E12 ambiguity module" },
					},
				]),
				calls("e12p-land-2", [e12LandCall("e12p-land-2-1")]),
				{
					name: "e12p-landed-2-read",
					reply: { content: [{ type: "text", text: "The second epoch record could not be written." }] },
				},
				calls("e12p-ambig", [{ id: "e12p-ambig-1", name: "worktree_sync", arguments: { action: "reconcile" } }]),
				{
					name: "e12p-ambig-read",
					reply: { content: [{ type: "text", text: "The ambiguous record is refused." }] },
				},
				calls("e12p-repair", [{ id: "e12p-repair-1", name: "worktree_sync", arguments: { action: "reconcile" } }]),
				{
					name: "e12p-repaired-read",
					reply: { content: [{ type: "text", text: "The repaired record is reconciled." }] },
				},
			);
			// First landing: the gate runs at the tested tip, then the epoch rename fails after main has moved; the transaction stays at main_moved.
			e12EpochFault();
			const epochBeforePersist = e12EpochRecord()?.epoch;
			await withDeadline(
				trace,
				"E12 persistence landing",
				session.prompt("Commit the post-gate module and land it while its epoch record cannot be written."),
				120_000,
			);
			const persistTip = world.git.refSha("refs/heads/pi/wt/e12");
			expect(world.shell.reached, "the first landing ran its scripted gate command").toContain(
				"e12-persist-gate-first",
			);
			expect(e12PersistGates[0], "the first gate ran in the exact lane worktree at the admitted tested tip").toEqual(
				{
					cwd: e12LanePath,
					command: E12_GATE,
					tip: persistTip,
				},
			);
			expect(world.git.refSha("refs/heads/main"), "main moved to the tested tip before the epoch failed").toBe(
				persistTip,
			);
			expect(e12Transaction(), "the landing transaction stays at main_moved").toMatchObject({
				stage: "main_moved",
				testedTipSha: persistTip,
			});
			expect(e12EpochRecord()?.epoch, "the epoch record was not written").toBe(epochBeforePersist);
			const eventsBeforeFirst = e12EventLog();
			// First reconcile, checked on its own against the raw persisted bytes.
			await withDeadline(trace, "E12 first reconcile", session.prompt("Reconcile the landing record."), 120_000);
			const firstCheckpoint = {
				epoch: e12Record("epoch.json"),
				transaction: e12Record("landing-transaction.json"),
				events: e12EventLog(),
			};
			expect(firstCheckpoint.transaction, "the first reconcile clears the landing transaction").toBeUndefined();
			expect(
				JSON.parse(firstCheckpoint.epoch ?? "null"),
				"the first reconcile writes the epoch once, for the tested tip",
			).toMatchObject({
				epoch: (epochBeforePersist ?? 0) + 1,
				mainSha: persistTip,
			});
			expect(
				e12EpochEvents(firstCheckpoint.events) - e12EpochEvents(eventsBeforeFirst),
				"the first reconcile appends exactly one epoch_reconciled audit event",
			).toBe(1);
			// Second reconcile, checked against the first checkpoint's raw bytes: nothing persisted changes.
			await withDeadline(
				trace,
				"E12 second reconcile",
				session.prompt("Reconcile the landing record again."),
				120_000,
			);
			const secondCheckpoint = {
				epoch: e12Record("epoch.json"),
				transaction: e12Record("landing-transaction.json"),
				events: e12EventLog(),
			};
			expect(e12ToolText("e12p-reconcile-2"), "the second reconcile reports a settled record").toContain(
				"reconciled",
			);
			expect(
				secondCheckpoint,
				"the second reconcile leaves the persisted epoch, transaction and audit log unchanged",
			).toEqual(firstCheckpoint);
			expect(e12PreSecond, "the second provider check saw the first reconcile's settled state").toEqual(
				firstCheckpoint,
			);
			expect(
				secondCheckpoint,
				"the post-second state equals the pre-second state captured at the second provider check",
			).toEqual(e12PreSecond);
			const epochAfterReconcile = e12EpochRecord()?.epoch;
			// A second landing under the same fault, then main is moved to a commit that is neither prior nor tested.
			e12EpochFault();
			await withDeadline(
				trace,
				"E12 second persistence landing",
				session.prompt("Write another module and land it under the same fault."),
				120_000,
			);
			const ambiguousTip = world.git.refSha("refs/heads/pi/wt/e12");
			expect(world.shell.reached, "the second landing ran its scripted gate command").toContain(
				"e12-persist-gate-second",
			);
			expect(
				e12PersistGates[1],
				"the second gate ran in the exact lane worktree at the admitted tested tip",
			).toEqual({
				cwd: e12LanePath,
				command: E12_GATE,
				tip: ambiguousTip,
			});
			expect(world.git.refSha("refs/heads/main"), "the second landing moved main").toBe(ambiguousTip);
			expect(e12Transaction()?.stage, "the second transaction stays at main_moved").toBe("main_moved");
			expect(
				world.git.run(["update-ref", "refs/heads/main", e12MainBefore ?? ""], HARNESS_PROJECT_CWD, {}).code,
				"the external ref move succeeds",
			).toBe(0);
			const ambiguousTransactionBefore = e12Record("landing-transaction.json");
			await withDeadline(
				trace,
				"E12 ambiguous reconcile",
				session.prompt("Reconcile after the ref moved."),
				120_000,
			);
			expect(e12ToolText("e12p-ambig-1"), "an ambiguous landing is refused, not rolled forward").toContain(
				"ambiguous",
			);
			expect(e12Transaction()?.stage, "the ambiguous transaction is kept for its owner").toBe("main_moved");
			expect(
				e12Record("landing-transaction.json"),
				"the ambiguous reconcile keeps the transaction bytes exactly",
			).toBe(ambiguousTransactionBefore);
			expect(
				world.git.refSha("refs/heads/main"),
				"the ambiguous reconcile leaves the foreign main sha untouched",
			).toBe(e12MainBefore);
			expect(e12EpochRecord()?.epoch, "the ambiguous reconcile writes no epoch").toBe(epochAfterReconcile);
			// The owner repairs main to the tested tip: reconcile rolls the second landing forward and clears it.
			expect(
				world.git.run(["update-ref", "refs/heads/main", ambiguousTip ?? ""], HARNESS_PROJECT_CWD, {}).code,
				"the repair ref move succeeds",
			).toBe(0);
			await withDeadline(
				trace,
				"E12 repaired reconcile",
				session.prompt("Reconcile once the ref is repaired."),
				120_000,
			);
			expect(e12Transaction(), "the repaired reconcile clears the transaction").toBeUndefined();
			expect(e12EpochRecord(), "the repaired reconcile writes the second epoch").toMatchObject({
				epoch: (epochAfterReconcile ?? 0) + 1,
				mainSha: ambiguousTip,
			});
			world.settingsManager.applyOverrides({ worktreeSync: { gate: "off" } });
			trace.mark("root", "e12.persisted");
			world.systemOne.enterPhase(
				"complete",
				{
					...lateJudgments,
					shows_true_0: { kind: "noul", probability: 0.97 },
					shows_false_0: { kind: "noul", probability: 0.02 },
					shows_true_1: { kind: "noul", probability: 0.97 },
					shows_false_1: { kind: "noul", probability: 0.02 },
					shows_true_2: { kind: "noul", probability: 0.97 },
					shows_false_2: { kind: "noul", probability: 0.02 },
					shows_true_3: { kind: "noul", probability: 0.97 },
					shows_false_3: { kind: "noul", probability: 0.02 },
					shows_true_4: { kind: "noul", probability: 0.97 },
					shows_false_4: { kind: "noul", probability: 0.02 },
					shows_true_5: { kind: "noul", probability: 0.97 },
					shows_false_5: { kind: "noul", probability: 0.02 },
					shows_true_6: { kind: "noul", probability: 0.97 },
					shows_false_6: { kind: "noul", probability: 0.02 },
					shows_true_7: { kind: "noul", probability: 0.97 },
					shows_false_7: { kind: "noul", probability: 0.02 },
					shows_true_8: { kind: "noul", probability: 0.97 },
					shows_false_8: { kind: "noul", probability: 0.02 },
					shows_true_9: { kind: "noul", probability: 0.97 },
					shows_false_9: { kind: "noul", probability: 0.02 },
					shows_true_10: { kind: "noul", probability: 0.97 },
					shows_false_10: { kind: "noul", probability: 0.02 },
					shows_true_11: { kind: "noul", probability: 0.97 },
					shows_false_11: { kind: "noul", probability: 0.02 },
					shows_true_12: { kind: "noul", probability: 0.97 },
					shows_false_12: { kind: "noul", probability: 0.02 },
					shows_true_13: { kind: "noul", probability: 0.97 },
					shows_false_13: { kind: "noul", probability: 0.02 },
					shows_true_14: { kind: "noul", probability: 0.97 },
					shows_false_14: { kind: "noul", probability: 0.02 },
					shows_true_15: { kind: "noul", probability: 0.97 },
					shows_false_15: { kind: "noul", probability: 0.02 },
					shows_true_16: { kind: "noul", probability: 0.97 },
					shows_false_16: { kind: "noul", probability: 0.02 },
					shows_true_17: { kind: "noul", probability: 0.97 },
					shows_false_17: { kind: "noul", probability: 0.02 },
					shows_true_18: { kind: "noul", probability: 0.97 },
					shows_false_18: { kind: "noul", probability: 0.02 },
					shows_true_19: { kind: "noul", probability: 0.97 },
					shows_false_19: { kind: "noul", probability: 0.02 },
					shows_true_20: { kind: "noul", probability: 0.97 },
					shows_false_20: { kind: "noul", probability: 0.02 },
					shows_true_21: { kind: "noul", probability: 0.97 },
					shows_false_21: { kind: "noul", probability: 0.02 },
					shows_true_22: { kind: "noul", probability: 0.97 },
					shows_false_22: { kind: "noul", probability: 0.02 },
					shows_true_23: { kind: "noul", probability: 0.97 },
					shows_false_23: { kind: "noul", probability: 0.02 },
					shows_true_24: { kind: "noul", probability: 0.97 },
					shows_false_24: { kind: "noul", probability: 0.02 },
					shows_true_25: { kind: "noul", probability: 0.97 },
					shows_false_25: { kind: "noul", probability: 0.02 },
					shows_true_26: { kind: "noul", probability: 0.97 },
					shows_false_26: { kind: "noul", probability: 0.02 },
					outcomes_achieved: { kind: "noul", probability: 0.97 },
					required_behavior_unverified: { kind: "noul", probability: 0.02 },
					material_claim_unsupported: { kind: "noul", probability: 0.02 },
					missing_requirement: { kind: "noul", probability: 0.02 },
				},
				{
					expect: (request) => {
						ownerWords(
							"Retire the workers and complete the goal.",
							"Change the stage one line of the notes file.",
							"Re-read the notes file.",
						)(request);
						if (world.systemOne.enabled) {
							const controller = session.systemOneController;
							if (controller === undefined)
								throw new Error("the E0 complete phase has no bound System One controller");
							bindE0Request(request, controller.store.snapshot(), session.messages.length, e0Counters);
							const integration = session
								.getGoalStateSnapshot()
								?.evidence.find((item) => item.uri === "verify-integration-1");
							if (integration !== undefined) {
								const observation = controller.store
									.snapshot()
									.observations.find(
										(o) =>
											o.freshness === "fresh" &&
											o.source.content_hash === integration.id &&
											o.source.locator === integration.uri,
									);
								if (observation !== undefined && isRecordObject(request.state)) {
									const carries = (rows: unknown) =>
										Array.isArray(rows) &&
										rows.some((row) => isRecordObject(row) && row.id === observation.id);
									if (carries(request.state.evidence_view)) e0Counters.integrationPreflightRows += 1;
									if (carries(request.state.new_evidence)) e0Counters.integrationPostflightRows += 1;
								}

								bindE0Completion(
									request,
									controller.store.snapshot(),
									session.getGoalStateSnapshot()?.requirements ?? [],
									integration,
									e0Counters,
								);
							}
						}
						if (world.systemOne.enabled)
							checkCompletionItems(request, {
								requirementText: COMPLETION_REQUIREMENT_TEXT,
								evidenceIds: durableGoalEvidenceIds(created.sessionManager),
							});
					},
				},
			);
			world.provider.enqueue(
				"root",
				dynamicCalls("retire-workers", (request) => [
					{
						id: "retire-a-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-a") },
					},
					{
						id: "retire-b-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-b") },
					},
				]),
				{
					name: "workers-retired",
					check: (request) => {
						const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
						if (
							retirements.length !== 2 ||
							retirements.some((result) => result.isError || !result.text.includes("retired"))
						) {
							throw new Error(`the delegated workers were not both retired: ${JSON.stringify(retirements)}`);
						}
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "goal-req-1",
								name: "goal",
								arguments: {
									action: "add_requirement",
									text: COMPLETION_REQUIREMENT_TEXT,
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				calls("goal-read", [{ id: "goal-read-1", name: "goal", arguments: { action: "get" } }]),
				calls("vitest-integration", [
					{ id: "verify-integration-1", name: "bash", arguments: { command: integrateVitest } },
				]),
				dynamicCalls(
					"add-integration-evidence",
					(request) => [
						{
							id: "evidence-integration-1",
							name: "goal",
							arguments: {
								action: "add_evidence",
								kind: "test",
								uri: "verify-integration-1",
								summary: "vitest passed: MAX_RETRIES is 5 and the late module is landed",
								requirementIds: [requirementIdOf(request)],
							},
						},
					],
					(request) => assertBatchOk(request, "vitest-integration"),
				),
				dynamicCalls("complete-goal", (request) => {
					const ids = evidenceIdsOf(request);
					const requirement = requirementIdOf(request);
					const integrationEvidence = session
						.getGoalStateSnapshot()
						?.evidence.find((item) => item.uri === "verify-integration-1");
					if (integrationEvidence === undefined)
						throw new Error("the native goal state holds no integration evidence for the account");
					return [
						{
							id: "complete-goal-1",
							name: "goal",
							arguments: {
								action: "complete",
								account: {
									changes: [
										{
											path: "src/limits.ts",
											reason: "Raises MAX_RETRIES to 5 for the retries lane.",
											evidenceIds: [integrationEvidence.id],
											serves: [requirement],
										},
										{
											path: "src/late.ts",
											reason: "Exports the LATE flag from the late module.",
											evidenceIds: [integrationEvidence.id],
											serves: [requirement],
										},
										{
											path: "/harness/project:e10/shared/a.txt",
											reason: "Writes the shared file A: the held writer of the overlap proof.",
											serves: [requirement],
										},
										{
											path: "/harness/project:e10/shared/nested/b.txt",
											reason: "Writes the nested file B: the queued writer admitted after A's release.",
											serves: [requirement],
										},
										{
											path: "/harness/project:e10/other/c/c.txt",
											reason: "Writes the disjoint file C: the writer that completed beside the held scope.",
											serves: [requirement],
										},
										{
											path: "e10/shared/a.txt",
											reason: "Writes the shared file A: the held writer of the overlap proof.",
											serves: [requirement],
										},
										{
											path: "e10/shared/nested/b.txt",
											reason: "Writes the nested file B: the queued writer admitted after A's release.",
											serves: [requirement],
										},
										{
											path: "e10/other/c/c.txt",
											reason: "Writes the disjoint file C: the writer that completed beside the held scope.",
											serves: [requirement],
										},
										{
											path: "src/e12.ts",
											reason: "Adds the E12 module, landed through the executed gate at its tested tip.",
											serves: [requirement],
										},
										{
											path: "src/e12-late.ts",
											reason:
												"Adds the module an external writer committed while the gate ran; the moved tip was refused, and this file landed with the unchanged tip.",
											serves: [requirement],
										},
										{
											path: "src/e12-persist.ts",
											reason:
												"Adds the persistence module: its landing's epoch record failed and reconcile rolled it forward once.",
											serves: [requirement],
										},
										{
											path: "src/e12-ambig.ts",
											reason:
												"Adds the ambiguity module: its landing was reconciled only after main was repaired to the tested tip.",
											serves: [requirement],
										},
									],
									assumptions: [{ claim: "the limits test checks the retry count", evidenceIds: [ids[0]] }],
									regressions: [
										{ path: "src/limits.ts", evidenceIds: [ids[0]] },
										{ path: "src/late.ts", evidenceIds: [ids[0]] },
									],
								},
							},
						},
					];
				}),
				{
					name: "goal-completed",
					check: (request) => {
						assertBatchOk(request, "complete-goal");
						if (!latestBatchResults(request).some((result) => result.text.includes("goal complete recorded"))) {
							throw new Error("the host did not record the goal as complete");
						}
					},
					reply: { content: [{ type: "text", text: "The goal is complete." }] },
				},
			);
			await withDeadline(
				trace,
				"retirement and completion turn",
				session.prompt("Retire the workers and complete the goal."),
			);
			trace.mark("root", "goal.completed");
			if (world.systemOne.enabled) {
				const native = {
					requirementText: COMPLETION_REQUIREMENT_TEXT,
					evidenceIds: durableGoalEvidenceIds(created.sessionManager),
				};
				const linkedRequest = world.systemOne.decoded.find(
					(request) => request.phase === "complete" && checkCompletionItems(request, native) > 0,
				);
				if (linkedRequest === undefined) throw new Error("no completion request carried a criterion statement");
				const linkedState = linkedRequest.state as Record<string, unknown>;
				const linkedKey = Object.keys(linkedState).find(
					(key) => /^s\d+$/.test(key) && String(linkedState[key]).startsWith(CRITERION_STATEMENT_PREFIX),
				);
				if (linkedKey === undefined) throw new Error("the linked request names no criterion statement key");
				const index = linkedKey.slice(1);
				expect(
					checkCompletionItems(linkedRequest, native),
					"the criterion statements carry the admitted requirement and evidence",
				).toBeGreaterThan(0);
				// Freshness, verified-flag agreement: each cited evidence line's marker must agree with the native ledger's verified flag, and the admitted
				// integration evidence must be verified with a passing test receipt on its own bash result. This proves the flag agreement only; it does not
				// establish that the evidence postdates any edit.
				const fLedger = session.getGoalStateSnapshot()?.evidence ?? [];
				expect(
					checkEvidenceMarkers(linkedRequest, new Map(fLedger.map((item) => [item.id, item.verified === true]))),
					"each cited evidence marker agrees with the native ledger's verified flag",
				).toBeGreaterThan(0);
				const fIntegration = fLedger.find((item) => item.uri === "verify-integration-1");
				const fCitedInPost = Object.values(linkedState).some(
					(value) => typeof value === "string" && new RegExp(`^${fIntegration?.id}:`, "m").test(value),
				);
				expect(fCitedInPost, "the completion POST cites the admitted integration evidence").toBe(true);
				if (world.systemOne.enabled) {
					expect(
						e0Counters.completionOutcomeRows,
						"a completion outcome row selects the admitted integration observation",
					).toBeGreaterThan(0);
					expect(
						e0Counters.acceptanceMatrixRequests,
						"a completion request transports the acceptance matrix",
					).toBeGreaterThan(0);
					expect(
						e0Counters.verificationMatrixRequests,
						"a completion request transports the verification matrix, empty or not",
					).toBeGreaterThan(0);
					expect(
						session.getVerificationObligations(),
						"the completed goal leaves no open verification obligation",
					).toEqual([]);
				}
				if (world.systemOne.enabled) {
					expect(
						e0Counters.integrationPreflightRows + e0Counters.integrationPostflightRows,
						"the completion phase transports the admitted integration observation in a preflight or postflight row",
					).toBeGreaterThan(0);
				}
				expect(integrationAdmission, "the integration verification captured its admission state").toBeDefined();
				expect(world.git.refSha("refs/heads/main"), "main is unchanged since the integration admission").toBe(
					integrationAdmission?.mainSha,
				);
				expect(
					world.io.readFileSync(LIMITS_PATH, "utf8"),
					"the limits file is unchanged since the integration admission",
				).toBe(integrationAdmission?.limits);
				expect(
					world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/late.ts`, "utf8"),
					"the landed module is unchanged since the integration admission",
				).toBe(integrationAdmission?.late);
				expect(fIntegration?.verified, "the admitted integration evidence is verified by the ledger").toBe(true);
				const fReceipt = created.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "verify-integration-1",
					);
				const fDetails =
					fReceipt?.type === "message" && fReceipt.message.role === "toolResult"
						? fReceipt.message.details
						: undefined;
				expect(
					typeof fDetails === "object" && fDetails !== null && "piVerification" in fDetails
						? fDetails.piVerification
						: undefined,
					"the integration evidence is backed by its own passing test receipt",
				).toMatchObject({ status: "passed", outcome: "executed", evidence: "tests" });
				// Negative controls on the decoded POST: each tampering is rejected by the oracle before any answer.
				expect(() =>
					checkCompletionItems(
						{
							...linkedRequest,
							state: {
								...linkedState,
								[`s${index}`]: `${CRITERION_STATEMENT_PREFIX}A requirement the goal never admitted.`,
							},
						},
						native,
					),
				).toThrow("does not name the native requirement");
				expect(() =>
					checkCompletionItems(
						{
							...linkedRequest,
							state: { ...linkedState, [`e${index}`]: "ev-00000000: an evidence line the goal never admitted" },
						},
						native,
					),
				).toThrow("cites evidence the goal never admitted");
				expect(() =>
					checkCompletionItems(
						{
							...linkedRequest,
							questions: {
								...linkedRequest.questions,
								shows_true_99: {
									type: "noul",
									instructions: "Does `e99` show that `s99` is true?",
									criteria: { true: "a", false: "b" },
								},
							},
						},
						native,
					),
				).toThrow("which the decoded state does not carry");
			}
			// Off retains no transport body: the oracle never ran, and nothing was decoded or recorded.
			expect(
				world.systemOne.enabled ? [] : world.systemOne.decoded,
				"off retains zero decoded transport bodies",
			).toHaveLength(0);

			expect(session.getGoalStateSnapshot()?.status, "the mixed host records completion in either mode").toBe(
				"completed",
			);
			expect(
				getLatestGoalStateSnapshot(created.sessionManager)?.status,
				"the mixed persisted goal agrees with the completed host",
			).toBe("completed");

			world.provider.enqueue(
				"root",
				calls("read-notes", [{ id: "read-notes-1", name: "read", arguments: { path: notesPath } }]),
				{
					name: "stale-edit",
					check: () => {
						heldDescriptor = world.io.openSync(notesPath, "r");
						world.io.writeFileSync(`${notesPath}.tmp`, "stage two\n");
						world.io.renameSync(`${notesPath}.tmp`, notesPath);
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "stale-edit-1",
								name: "edit",
								arguments: { path: notesPath, edits: [{ oldText: "stage one", newText: "stage three" }] },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "stale-edit-refused",
					check: (request) => {
						const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
						if (!edit?.isError || !edit.text.includes("Could not find the exact text")) {
							throw new Error(`the stale edit was not refused: ${edit?.text ?? "no edit result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The stale edit was refused." }] },
				},
			);
			await withDeadline(
				trace,
				"stale replacement turn",
				session.prompt("Change the stage one line of the notes file."),
			);
			if (heldDescriptor === undefined) throw new Error("the held descriptor was never opened");
			expect(world.readDescriptorText(heldDescriptor, 64), "a held descriptor keeps the node it opened").toBe(
				"stage one\n",
			);
			world.closeDescriptor(heldDescriptor);
			expect(world.io.readFileSync(notesPath, "utf8"), "the path shows the replacement").toBe("stage two\n");

			// The refused edit is followed by a successful read before the restart: the refusal is resolved by the next successful call.
			world.provider.enqueue(
				"root",
				calls("reread-notes", [{ id: "reread-notes-1", name: "read", arguments: { path: notesPath } }]),
				text("reread-reported", "The notes file is read again."),
			);
			// The refused edit is still an active recovery record, so the loop asks the model once more after the reply.
			await withDeadline(trace, "notes re-read turn", session.prompt("Re-read the notes file."));
			// Restart. The root session is disposed, then reopened from its persisted file by its owner. The reopened session's
			// first request must carry every legend line the first session showed: alias ids are restored, not re-minted.
			// The first session is disposed once the goal is complete: no admission or work-remaining question is pending.
			// The goal is complete: disposing the first session asks no admission or work-remaining question.
			world.systemOne.enterPhase("restart-disposal", {});
			expect(
				await world.disposeSessionInBody(session),
				"the root session must dispose before the restart",
			).toBeUndefined();
			const rootFile = created.sessionManager.getSessionFile();
			if (rootFile === undefined) throw new Error("the mixed root session has no file");
			const restartedRoot = await world.createRootSession("root", {
				sessionManager: world.openSessionManager(rootFile),
			});
			const restarted = restartedRoot.session;
			expect(restarted.getGoalStateSnapshot()?.status, "restart preserves the completed goal").toBe("completed");
			expect(
				getLatestGoalStateSnapshot(restartedRoot.sessionManager)?.status,
				"the reopened durable goal remains completed",
			).toBe("completed");
			// The restored prompt is a new root turn: its post-flight stage asks the turn-outcome questions, and the answer is a
			// completed step with its conclusions supported.
			// The restored prompt's admission does not ask whether the grounding is sufficient: the disposal above asks it.

			// The restored prompt is a new root turn: its post-flight stage asks the turn-outcome questions; the completed goal leaves no open work.
			const restartOwnerWords = (...userRequests: string[]) =>
				expectOwnerWords({
					sessionManager: () => restartedRoot.sessionManager,
					userRequests,
					optionalToolNames: ["secret_store"],
				});
			world.systemOne.enterPhase(
				"restart",
				{
					step_relevant: { kind: "noul", probability: 0.97 },
					evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
					unsupported_assumption_present: { kind: "noul", probability: 0.02 },
					route: { kind: "choice", choice: "reason", confidence: 0.97 },
					action_accomplished_step: { kind: "noul", probability: 0.97 },
					conclusions_supported: { kind: "noul", probability: 0.97 },
					scope_violation: { kind: "noul", probability: 0.02 },
					unrelated_behavior_change: { kind: "noul", probability: 0.02 },
					replan_required: { kind: "noul", probability: 0.02 },
					next_status: { kind: "choice", choice: "completion_candidate", confidence: 0.97 },
				},
				{ expect: restartOwnerWords("Continue after the restart.") },
			);
			world.provider.enqueue("root", {
				name: "restored-legend",
				check: (request) => {
					const lines = legendLinesOf(request);
					if (legendAtIntegration.length === 0) throw new Error("no legend was shown before the restart");
					const missing = legendAtIntegration.filter((line) => !lines.includes(line));
					if (missing.length > 0)
						throw new Error(`the restored request lost legend lines: ${missing.join(" | ")}`);
				},
				reply: { content: [{ type: "text", text: "Restored and continuing." }] },
			});
			await withDeadline(trace, "restored root turn", restarted.prompt("Continue after the restart."));
			trace.mark("root", "restart.reply");
			await withDeadline(trace, "restored foreground settled", restarted.waitForForegroundIdle(), 60_000);

			expect(world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/limits.ts`, "utf8"), toolOutcomes(session)).toBe(
				"export const MAX_RETRIES = 5;\n",
			);
			expect(world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/owner.md`, "utf8")).toBe(OWNER_DRAFT_DIRTY);
		},
	);
}, 360_000);
