import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { configFile } from "../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	countUniquePaidRows,
	createAgentSessionRuntime,
	DEFAULT_DISCARD_SCAN_LIMITS,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	collectToolCallResultPairs,
	resolvePreserveRecentPairs,
} from "../../../src/core/compaction/evidence-retention-projection.ts";
import { createFileArtifactStore } from "../../../src/core/context/context-artifacts.ts";
import { acquireContextStoreRetention, getContextStoreDir } from "../../../src/core/context/context-store-retention.ts";
import { sessionSemanticUsageOf } from "../../../src/core/cost/semantic-usage-delivery.ts";
import {
	journalSlotOf,
	readJournal,
	SEMANTIC_USAGE_JOURNAL_MAX_RECORDS,
} from "../../../src/core/cost/semantic-usage-journal.ts";
import { createSessionManagerLedgerPort } from "../../../src/core/cost/session-ledger-port.ts";
import { classifyCustomEntryPersisted } from "../../../src/core/cost/spawned-usage-receipt.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf } from "../../../src/core/cost/usage-records.ts";
import type { WorkerWriteReservationLease } from "../../../src/core/delegation/worker-write-reservation.ts";
import type { ExecResult } from "../../../src/core/exec.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { isGoalExecutionActive } from "../../../src/core/goals/goal-state.ts";
import { getResumableHumanInputSnapshot } from "../../../src/core/human-input.ts";
import { type MemoryLifecycleDiagnostic, MemoryManager } from "../../../src/core/memory/memory-manager.ts";
import type { TranscriptSummaryTimeSource } from "../../../src/core/memory/transcript-memory-contracts.ts";
import { resolveTranscriptSummarizer } from "../../../src/core/memory/transcript-summarizer.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import type { OrchestrationProfile } from "../../../src/core/orchestration/contracts.ts";
import { CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE } from "../../../src/core/reflection-controller.ts";
import { getInFlightWorkUnits } from "../../../src/core/reload-blockers.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "../../../src/core/sdk.ts";
import type { Settings } from "../../../src/core/settings/settings-schema.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { TerminalWarnings } from "../../../src/core/terminal-warnings.ts";
import { OPTIONAL_TOOL_INTENT_CUSTOM_TYPE } from "../../../src/core/tool-applicability-gate.ts";
import type { ToolDef } from "../../../src/core/tools/index.ts";
import { routeShellContract } from "../../../src/core/tools/shell-contract-router.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../../src/kernel/session/session-manager.ts";
import { SignalLifecycle } from "../../../src/modes/interactive/signal-lifecycle.ts";
import { type RpcModeIo, runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import type { TerminationSignalHandler } from "../../../src/modes/termination-signals.ts";
import {
	acquireWorkRun,
	getWorkRunDir,
	hasActiveWorkRunLease,
	pruneWorkTenant,
	removeWorkRun,
	WORK_RUN_MANIFEST_FILE,
	type WorkRetentionOptions,
	type WorkRunLease,
} from "../../../src/utils/work-directory.ts";
import { ScriptedHumanInput } from "./scripted-human-input.ts";
import {
	type Barrier,
	createBarrier,
	HARNESS_API,
	HARNESS_PROVIDER,
	ScriptedProvider,
	type ScriptedRequest,
} from "./scripted-provider.ts";
import { ScriptedWindowsShellProcesses } from "./scripted-windows-shell.ts";
import { EffectGuard, VirtualFileSystem } from "./virtual-io.ts";
import { type VirtualProcessState, VirtualProcessTable } from "./virtual-process-table.ts";
import { VirtualShell } from "./virtual-shell.ts";

/** Script tracks: the root session, each delegated worker, and the compaction summarizer share the root's track. */
/** The worker claims a disposed owner may keep by design, typed from the owner's own resource snapshot. */
export type WorkerProjectClaims = NonNullable<
	ReturnType<AgentSession["getResourceSnapshot"]>["workers"]
>["ownedProjectClaims"];

export const SCRIPTED_TRACKS = ["root", "worker-a", "worker-b", "worker-c"] as const;
const HARNESS_ROOT = resolve("/harness");

/**
 * The one composition owner for fixture and test paths: a native path under the fixture root. Every path the fixture
 * registers, compares or hands to production is built here, so the host's separator and drive are the same everywhere.
 */
export function harnessPath(...segments: string[]): string {
	return resolve(HARNESS_ROOT, ...segments);
}

export const HARNESS_PROJECT_CWD = harnessPath("project");

/** A native path under the project root: the composition owner for project-relative fixture and test paths. */
export function projectPath(...segments: string[]): string {
	return resolve(HARNESS_PROJECT_CWD, ...segments);
}

const TYPESAFE_FIXTURE_KEY = "apikey_harness_fixture_0001";
const HARNESS_PROVIDER_FIXTURE_KEY = "harness-fixture-credential";

/** Ordered record of what each lane reached. Failures print the last reached phase and what is still open. */
export class HarnessTrace {
	private readonly reachedPhases: string[] = [];
	private readonly openPhases = new Set<string>();
	private readonly liveWork = new Set<Promise<void>>();
	private readonly rejectedWork: unknown[] = [];

	/** Records work the body started, so the world joins it before the sessions it drives are torn down. */
	track<T>(work: Promise<T>): Promise<T> {
		const settled: Promise<void> = work.then(
			() => {
				this.liveWork.delete(settled);
			},
			(error: unknown) => {
				this.liveWork.delete(settled);
				this.rejectedWork.push(error);
			},
		);
		this.liveWork.add(settled);
		return work;
	}

	/**
	 * Joins a native promise's physical settlement only. It records no outcome: a rejection is handled on the original promise and
	 * its cause is discarded here, so the owner that started the work judges the result through its own receipts and warnings.
	 */
	observe<T>(work: Promise<T>): Promise<T> {
		const settled: Promise<void> = work.then(
			() => {
				this.liveWork.delete(settled);
			},
			() => {
				this.liveWork.delete(settled);
			},
		);
		this.liveWork.add(settled);
		return work;
	}

	/**
	 * The body states that it received this exact rejection and judged it itself: it is no longer reported by {@link join}. Claimed by
	 * identity, never by awaiting (a deadline race also awaits, and a rejection arriving after it fired must still be reported), and a
	 * rejection that was never recorded is an error, so a claim cannot silently cover work this trace did not see. The judgment names
	 * the failure it covers: a recorded rejection whose message is not `expected` (exact text, or a RegExp) throws and stays unclaimed.
	 */
	claimRejection(error: unknown, expected: string | RegExp): void {
		const index = this.rejectedWork.indexOf(error);
		if (index < 0) throw new Error("claimRejection: the trace recorded no such rejection");
		const message = error instanceof Error ? error.message : String(error);
		const matches = typeof expected === "string" ? message === expected : expected.test(message);
		if (!matches) throw new Error(`claimRejection: the recorded rejection is not the judged failure: ${message}`);
		this.rejectedWork.splice(index, 1);
	}

	/** Waits until every tracked item settled; returns the rejections the body did not claim. */
	async join(): Promise<unknown[]> {
		while (this.liveWork.size > 0) await Promise.all([...this.liveWork]);
		return this.rejectedWork.splice(0);
	}

	mark(lane: string, phase: string): void {
		this.reachedPhases.push(`${lane}:${phase}`);
	}

	open(lane: string, phase: string): void {
		this.openPhases.add(`${lane}:${phase}`);
	}

	close(lane: string, phase: string): void {
		this.openPhases.delete(`${lane}:${phase}`);
	}

	reached(phase: string): boolean {
		return this.reachedPhases.some((entry) => entry.endsWith(`:${phase}`));
	}

	require(phase: string): void {
		if (!this.reached(phase)) throw new Error(`Required phase was not reached: ${phase}; ${this.describe()}`);
	}

	describe(): string {
		const last = this.reachedPhases.at(-1) ?? "none";
		return `last=${last}; open=[${[...this.openPhases].join(", ")}]; reached=${this.reachedPhases.length}`;
	}
}

/** Bounded wait for a completion the scenario expects. A stall names the trace position, not a sleep. */
export async function withDeadline<T>(trace: HarnessTrace, label: string, work: Promise<T>, ms = 20_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Deadline ${ms}ms exceeded waiting for ${label}; ${trace.describe()}`)),
			ms,
		);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

export interface JudgeQuestion {
	type: "choice" | "noul" | "score";
	instructions?: string;
	criteria?: Record<string, unknown> | unknown[];
}

/** One System One request as the production sent it: the projected state and the questions asked over it. */
export interface SystemOneDecodedRequest {
	readonly phase: string;
	readonly state: unknown;
	readonly questions: Readonly<Record<string, JudgeQuestion>>;
}

interface JudgeRequestBody {
	model: string;
	state: unknown;
	questions: Record<string, JudgeQuestion>;
}

/**
 * Request-local controls of one phase: `expect` checks the decoded request before any answer, `gate` holds the answers.
 * `families` answers a dynamic question family (ids that are built per tool call, such as `keep_call::<callId>`): every
 * id that starts with a key takes that key's judgment, and the family is declared and consumed as one unit.
 */
export interface ScriptedPhaseOptions {
	readonly expect?: (request: SystemOneDecodedRequest) => void;
	readonly gate?: Promise<unknown>;
	readonly families?: Readonly<Record<string, ScriptedJudgment>>;
	/**
	 * The evaluator is unavailable for every request of the phase: each one answers HTTP 503 after its gate. The declared
	 * judgments it carries count as consumed by that intended outage, which is recorded apart from unscripted requests.
	 */
	readonly outage?: boolean;
	/**
	 * The evaluator answers every request of the phase with a PAID response that breaks its contract (no answer for any
	 * asked question), after its gate. The declared judgments count as consumed by that intended invalid answer, which is
	 * recorded apart from unscripted requests.
	 */
	readonly invalidAnswer?: boolean;
	/** Called when a request is admitted: its questions are validated and answered, and it then waits at its gate (a `paidOutageFirst` request answers at once instead). */
	readonly onAdmit?: () => void;
	/**
	 * The request ignores its caller's abort and answers after its gate, as an evaluator that is not cancelled does. The
	 * owner may settle on the abort while the physical request stays in flight until it answers. Requires a gate.
	 */
	readonly ignoresAbort?: boolean;
	/**
	 * The first request of the phase is answered HTTP 503 with a PAID body (usage included, as a provider that charged for a
	 * failed response), before any gate; later requests wait at the gate (abortable unless `ignoresAbort`). The paid outage is
	 * recorded as an intended outage. Requires a gate.
	 */
	readonly paidOutageFirst?: boolean;
}

/** The owner-visible state a System One question reads by name: `owner_messages[N]` and `optional_tools[N]`. */
function stateIndexedBy(state: unknown, field: string, index: number): boolean {
	if (typeof state !== "object" || state === null) return false;
	const list = (state as Record<string, unknown>)[field];
	return Array.isArray(list) && index < list.length;
}

/**
 * Bounded instruction-reference check: a question that names `owner_messages[N]` or `optional_tools[N]` must find that
 * element in the decoded state. A question pointing past the state it was built from is a wrong input, not an answer.
 */
function checkInstructionReferences(request: SystemOneDecodedRequest): void {
	for (const [id, question] of Object.entries(request.questions)) {
		const instructions = question.instructions ?? "";
		const indexed = /^(carries|optional_tool)_(\d+)$/.exec(id);
		if (indexed === null) continue;
		const index = Number(indexed[2]);
		const field = indexed[1] === "carries" ? "owner_messages" : "optional_tools";
		if (!instructions.includes(`${field}[${index}]`)) {
			throw new Error(`question ${id} does not name ${field}[${index}] in its instructions`);
		}
		if (!stateIndexedBy(request.state, field, index)) {
			throw new Error(`question ${id} names ${field}[${index}] which the decoded state does not carry`);
		}
	}
}

/**
 * An explicit judgment for one System One question: `noul` carries the probability that the question's
 * `true` criterion holds; `choice` names one criterion the question offers, with the confidence behind it.
 */
export type ScriptedJudgment =
	| { readonly kind: "noul"; readonly probability: number }
	| { readonly kind: "choice"; readonly choice: string; readonly confidence: number }
	/** A score question: the level the judgment puts its probability on, and the probability of that level. */
	| { readonly kind: "score"; readonly level: number; readonly confidence: number };

function judgmentAnswer(judgment: ScriptedJudgment, question: JudgeQuestion): Record<string, unknown> {
	if (judgment.kind === "noul") {
		if (question.type !== "noul") throw new Error(`scripted noul judgment does not fit a ${question.type} question`);
		return { type: "noul", noul: judgment.probability };
	}
	if (judgment.kind === "score") {
		if (question.type !== "score" || !Array.isArray(question.criteria)) {
			throw new Error(`scripted score judgment does not fit a ${question.type} question`);
		}
		const levels = question.criteria.map((_, index) => String(index));
		if (!levels.includes(String(judgment.level))) {
			throw new Error(`scripted score level ${judgment.level} is not offered (levels: ${levels.join(", ")})`);
		}
		const others = levels.filter((level) => level !== String(judgment.level));
		const probabilities: Record<string, number> = { [String(judgment.level)]: judgment.confidence };
		for (const other of others) probabilities[other] = (1 - judgment.confidence) / others.length;
		const score = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
		const legend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
		return { type: "score", score, confidence: judgment.confidence, probabilities, legend };
	}
	if (question.type !== "choice") throw new Error(`scripted choice judgment does not fit a ${question.type} question`);
	const offered = Object.keys(question.criteria ?? {});
	if (!offered.includes(judgment.choice)) {
		throw new Error(
			`scripted choice '${judgment.choice}' is not offered by the question (offered: ${offered.join(", ")})`,
		);
	}
	const others = offered.filter((choice) => choice !== judgment.choice);
	const probabilities: Record<string, number> = { [judgment.choice]: judgment.confidence };
	for (const other of others) probabilities[other] = (1 - judgment.confidence) / others.length;
	return { type: "choice", choice: judgment.choice, confidence: judgment.confidence, probabilities };
}

/**
 * Transport-boundary script for System One. A phase names exactly the questions it expects and their
 * judgments. A question outside the phase, or a judgment the question cannot take, fails the request and is
 * recorded, so the journey fails at settlement instead of answering on a guess.
 */
/** The typesafe driver's endpoints: the only System One URLs a scripted judgment may answer. */
const SYSTEM_ONE_MODELS_URL = "https://api.typesafe.ai/v1/models";
const SYSTEM_ONE_DECISIONS_URL = "https://api.typesafe.ai/v1/systemone";

/** Serialized optional-intent entries by id: the exact bytes a restored session keeps, and the ids an off window may not add to. */
function optionalIntentSnapshot(manager: SessionManager): Map<string, string> {
	return new Map(
		manager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)
			.map((entry): [string, string] => [entry.id, JSON.stringify(entry)]),
	);
}

function transportAbortError(): Error {
	return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

export class ScriptedSystemOneTransport {
	readonly enabled: boolean;
	readonly requests: Array<{ readonly method: string; readonly url: string }> = [];

	constructor(enabled: boolean) {
		this.enabled = enabled;
	}
	readonly unscripted: string[] = [];
	/** Every decoded request of the enabled transport, in arrival order, for scenario oracles and negative controls. */
	readonly decoded: SystemOneDecodedRequest[] = [];
	private phase = "unentered";
	private expected = new Map<string, ScriptedJudgment>();
	private families = new Map<string, ScriptedJudgment>();
	private expectRequest: ((request: SystemOneDecodedRequest) => void) | undefined;
	private gate: Promise<unknown> | undefined;
	private outage = false;
	private invalidAnswer = false;
	private onAdmit: (() => void) | undefined;
	private ignoresAbort = false;
	private paidOutageFirst = false;
	/** Transport requests still in flight, settled or not: an owner's abort does not end a physical request. */
	private readonly inFlight = new Set<Promise<void>>();
	/** Requests a phase answered as an unavailable evaluator: intended by the scenario, never unscripted. */
	readonly intendedOutages: string[] = [];
	/** Requests a phase answered with an intentionally invalid paid response: intended by the scenario, never unscripted. */
	readonly intendedInvalidAnswers: string[] = [];
	/** "phase:id" pairs a production request answered. */
	private readonly consumed = new Set<string>();
	/** "phase:id" pairs a phase declared, in order. */
	private readonly declared: string[] = [];
	/** Declared pairs whose phase ended before any production request asked them. */
	private readonly unconsumed: string[] = [];

	enterPhase(
		name: string,
		judgments: Readonly<Record<string, ScriptedJudgment>>,
		options: ScriptedPhaseOptions = {},
	): void {
		this.closePhase();
		this.phase = name;
		// These are semantic-plane inputs only. Off runs supply no answers and reject every attempted transport call.
		this.expected = new Map(this.enabled ? Object.entries(judgments) : []);
		this.families = new Map(this.enabled ? Object.entries(options.families ?? {}) : []);
		this.expectRequest = options.expect;
		this.gate = options.gate;
		this.outage = this.enabled && options.outage === true;
		this.invalidAnswer = this.enabled && options.invalidAnswer === true;
		if (options.ignoresAbort === true && options.gate === undefined) {
			throw new Error("A transport request that ignores abort requires an explicit gate");
		}
		if (options.paidOutageFirst === true && options.gate === undefined) {
			throw new Error("A paid first outage requires an explicit gate for the requests after it");
		}
		this.onAdmit = options.onAdmit;
		this.ignoresAbort = options.ignoresAbort === true;
		this.paidOutageFirst = this.enabled && options.paidOutageFirst === true;
		for (const id of this.expected.keys()) this.declared.push(`${name}:${id}`);
		for (const prefix of this.families.keys()) this.declared.push(`${name}:${prefix}*`);
	}

	/** Adds explicitly required families for one operation without replacing the current phase's owner judgments or transport controls. */
	async withQuestionFamilies<T>(
		families: Readonly<Record<string, ScriptedJudgment>>,
		operation: () => Promise<T>,
	): Promise<T> {
		if (!this.enabled) return operation();
		const phase = this.phase;
		const previous = this.families;
		const prefixes = Object.keys(families);
		for (const prefix of prefixes) {
			if (previous.has(prefix) || this.consumed.has(`${phase}:${prefix}*`)) {
				throw new Error(`Question family ${phase}:${prefix} is already owned or was already consumed`);
			}
		}
		this.families = new Map([...previous, ...Object.entries(families)]);
		for (const prefix of prefixes) this.declared.push(`${phase}:${prefix}*`);
		try {
			return await operation();
		} finally {
			for (const prefix of prefixes) {
				if (!this.consumed.has(`${phase}:${prefix}*`)) this.unconsumed.push(`${phase}:${prefix}*`);
			}
			if (this.phase === phase) this.families = previous;
			else this.unscripted.push(`Question-family scope for ${phase} crossed into phase ${this.phase}`);
		}
	}

	private closePhase(): void {
		for (const id of this.expected.keys()) {
			const key = `${this.phase}:${id}`;
			if (!this.consumed.has(key)) this.unconsumed.push(key);
		}
		for (const prefix of this.families.keys()) {
			const key = `${this.phase}:${prefix}*`;
			if (!this.consumed.has(key)) this.unconsumed.push(key);
		}
		this.expected = new Map();
		this.families = new Map();
		this.expectRequest = undefined;
		this.gate = undefined;
		this.outage = false;
		this.invalidAnswer = false;
		this.onAdmit = undefined;
		this.ignoresAbort = false;
		this.paidOutageFirst = false;
	}

	/** Ends the last phase, then fails on any declared judgment no production request consumed. */
	assertConsumed(): void {
		this.closePhase();
		if (this.enabled ? this.consumed.size === 0 : this.requests.length !== 0) {
			throw new Error(`System One ${this.enabled ? "on consumed no judgments" : "off made transport requests"}`);
		}
		if (this.unconsumed.length > 0) {
			throw new Error(`Declared System One judgments never consumed: ${this.unconsumed.join(", ")}`);
		}
	}

	readonly fetch: typeof fetch = (input, init) => {
		const work = this.answer(input, init);
		const settled = work.then(
			() => undefined,
			() => undefined,
		);
		this.inFlight.add(settled);
		void settled.then(() => this.inFlight.delete(settled));
		return work;
	};

	/** Joins every transport request still in flight: a request whose owner aborted is physical until it answers. */
	async joinInFlight(): Promise<void> {
		while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
	}

	assertInFlightSettled(): void {
		if (this.inFlight.size > 0)
			throw new Error(`System One transport requests still in flight: ${this.inFlight.size}`);
	}

	/** Holds a request at its gate. A request that does not ignore abort rejects when its caller aborts while it waits. */
	private async holdAtGate(gate: Promise<unknown>, signal: AbortSignal | null | undefined): Promise<void> {
		if (signal === undefined || signal === null) {
			await gate;
			return;
		}
		if (signal.aborted) throw transportAbortError();
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => reject(transportAbortError());
			signal.addEventListener("abort", onAbort, { once: true });
			gate.then(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, reject);
		});
	}

	private readonly answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		this.requests.push({ method, url });
		if (!this.enabled) {
			this.unscripted.push(`${this.phase}: System One off attempted ${method} ${url}`);
			throw new Error(`System One is disabled: ${method} ${url}`);
		}
		if (method === "GET" && url === SYSTEM_ONE_MODELS_URL) return Response.json({ data: [] });
		if (method !== "POST" || url !== SYSTEM_ONE_DECISIONS_URL || typeof init?.body !== "string") {
			this.unscripted.push(`${this.phase}: ${method} ${url}`);
			throw new Error(`Unscripted System One request: ${method} ${url}`);
		}
		const body = JSON.parse(init.body) as JudgeRequestBody;
		// The request answers from the phase that received it, even when a gate holds it past a phase change.
		const phase = this.phase;
		const expected = this.expected;
		const families = this.families;
		const gate = this.gate;
		const outage = this.outage;
		const invalidAnswer = this.invalidAnswer;
		const onAdmit = this.onAdmit;
		const ignoresAbort = this.ignoresAbort;
		const decoded: SystemOneDecodedRequest = { phase, state: body.state, questions: body.questions };
		this.decoded.push(decoded);
		try {
			checkInstructionReferences(decoded);
			this.expectRequest?.(decoded);
		} catch (error) {
			const detail = `${phase}: state mismatch: ${error instanceof Error ? error.message : String(error)}`;
			this.unscripted.push(detail);
			throw new Error(detail);
		}
		// Admission snapshot: every question is validated and answered now, before the gate, so a held request answers what it
		// was admitted with. An outage is the only exemption, and it still requires each question to have a fitting judgment.
		const answers: Record<string, unknown> = {};
		const rejected: string[] = [];
		for (const [id, question] of Object.entries(body.questions)) {
			const direct = expected.get(id);
			const family = direct === undefined ? [...families].find(([prefix]) => id.startsWith(prefix)) : undefined;
			const judgment = direct ?? family?.[1];
			if (judgment === undefined) {
				const offered = Object.keys(question.criteria ?? {}).join("|");
				rejected.push(`${id}:${question.type}[${offered}]`);
				continue;
			}
			try {
				answers[id] = judgmentAnswer(judgment, question);
				this.consumed.add(family === undefined ? `${phase}:${id}` : `${phase}:${family[0]}*`);
			} catch (error) {
				rejected.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (rejected.length > 0) {
			// A bounded excerpt of the decoded state names which production request asked, so the close is diagnosable.
			const detail = `${phase}: System One questions without an explicit judgment: ${rejected.join(", ")} (state: ${JSON.stringify(body.state).slice(0, 600)})`;
			this.unscripted.push(detail);
			throw new Error(detail);
		}
		onAdmit?.();
		if (this.paidOutageFirst) {
			// Once per phase: the first request is a paid failure; the retry that follows reaches the gate below.
			this.paidOutageFirst = false;
			this.intendedOutages.push(`${phase}: ${method} ${url}`);
			return Response.json(
				{ model: body.model, answers: {}, usage: { input_tokens: 10, output_tokens: 5 } },
				{ status: 503 },
			);
		}
		if (gate !== undefined) await this.holdAtGate(gate, ignoresAbort ? undefined : init?.signal);
		if (outage) {
			// The configured outage cause: the validated questions are answered by a 503, recorded apart from unscripted requests.
			this.intendedOutages.push(`${phase}: ${method} ${url}`);
			return Response.json({ error: "evaluator unavailable" }, { status: 503 });
		}
		if (invalidAnswer) {
			// The configured invalid answer: a paid response (usage included) that answers none of the asked questions.
			this.intendedInvalidAnswers.push(`${phase}: ${method} ${url}`);
			return Response.json({ model: body.model, answers: {}, usage: { input_tokens: 10, output_tokens: 5 } });
		}
		return Response.json({ model: body.model, answers, usage: { input_tokens: 10, output_tokens: 5 } });
	};
}

/** One commit of the virtual repository: the full tree it records and its subject line. */
interface GitCommit {
	readonly sha: string;
	readonly parent: string | undefined;
	readonly tree: ReadonlyMap<string, string>;
	readonly subject: string;
}

type GitHead = { readonly kind: "branch"; readonly ref: string } | { readonly kind: "detached"; readonly sha: string };

/** One conflicted path as git records it in the index: stage 1 (base), 2 (ours), 3 (theirs). */
interface GitConflict {
	readonly base: string | undefined;
	readonly ours: string | undefined;
	readonly theirs: string | undefined;
}

/** A rebase in progress: commits still to replay, the replayed head, and where it stopped. */
interface GitRebase {
	readonly headName: string;
	readonly origHead: string;
	readonly total: number;
	todo: string[];
	done: number;
	replayHead: string;
	stoppedAt: string | undefined;
}

/** A checkout: its path, its git dir, what HEAD points at, the staged snapshot, and conflicts. */
interface GitWorktree {
	readonly path: string;
	readonly gitDir: string;
	head: GitHead;
	index: Map<string, string>;
	unmerged: Map<string, GitConflict>;
	rebase: GitRebase | undefined;
}

/** One index entry: the file mode and the blob that holds its content. */
interface GitIndexEntry {
	readonly mode: string;
	readonly blob: string;
}

interface GitOutcome {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const NOT_A_REPOSITORY = "fatal: not a git repository (or any of the parent directories): .git\n";

/** Whether `target` is `directory` or lies beneath it, judged by native relative paths rather than a textual prefix. */
function isWithin(directory: string, target: string): boolean {
	const path = relative(directory, target);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** A repository-relative file name in Git's wire form: forward slashes whatever the host separator. */
function gitRelative(from: string, to: string): string {
	return relative(from, to).split(sep).join("/");
}

/**
 * Stateful git for the worktree-sync engine and the SDK's own git reads. Commits, branches, worktrees, the
 * staged snapshot, merges and rebases are real state transitions; the working files and the git dirs live in
 * the world's virtual filesystem. Only the subcommands the production code issues are implemented; any other
 * command is recorded as unscripted and rejected.
 */
export class VirtualGit {
	readonly unscripted: string[] = [];
	private readonly io: VirtualFileSystem;
	private readonly root: string;
	private readonly commonDir: string;
	private readonly commits = new Map<string, GitCommit>();
	private readonly refs = new Map<string, string>();
	private readonly worktrees = new Map<string, GitWorktree>();
	private counter = 0;
	/** Blob contents by object id; tree contents by tree id; scratch index files by GIT_INDEX_FILE path. */
	private readonly blobs = new Map<string, string>();
	private readonly trees = new Map<string, ReadonlyMap<string, string>>();
	private readonly indexFiles = new Map<string, Map<string, GitIndexEntry>>();

	constructor(io: VirtualFileSystem, root: string) {
		this.io = io;
		this.root = resolve(root);
		this.commonDir = join(this.root, ".git");
	}

	/** Creates the repository with one commit of `committed` on `branch`, checked out at the root. */
	initialize(branch: string, committed: Readonly<Record<string, string>>): void {
		this.io.mkdirSync(this.commonDir, { recursive: true });
		const tree = new Map(Object.entries(committed));
		const sha = this.commit(tree, undefined, "Initial commit");
		this.refs.set(`refs/heads/${branch}`, sha);
		this.worktrees.set(this.root, {
			path: this.root,
			gitDir: this.commonDir,
			head: { kind: "branch", ref: `refs/heads/${branch}` },
			index: new Map(tree),
			unmerged: new Map(),
			rebase: undefined,
		});
	}

	/** The commit a ref names in the virtual repository, or undefined when the ref does not exist. */
	refSha(ref: string): string | undefined {
		return this.refs.get(ref);
	}

	/** Process exec port for the worktree-sync engine: asynchronous, results from the same state. */
	async exec(
		command: string,
		args: readonly string[],
		options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
	): Promise<ExecResult> {
		if (command !== "git") {
			this.unscripted.push(`${command} ${args.join(" ")} @ ${options.cwd}`);
			throw new Error(`Unscripted command: ${command}`);
		}
		const outcome = this.run(args, options.cwd, options.env ?? {});
		return {
			stdout: outcome.stdout,
			stderr: outcome.stderr,
			code: outcome.code,
			killed: false,
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	}

	run(
		argv: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>> = {},
		input?: string,
	): GitOutcome {
		const args = [...argv];
		// Engine-injected `-c key=value` configuration does not change the state transitions modelled here.
		while (args[0] === "-c") args.splice(0, 2);
		// Outside any repository every git command fails the way real git fails.
		if (this.worktreeFor(cwd) === undefined) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		try {
			return this.dispatch(args, cwd, env, input);
		} catch (error) {
			// Every throw is an unscripted command: it is recorded here so the close check cannot miss it.
			this.unscripted.push(
				`git ${args.join(" ")} @ ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	private dispatch(
		args: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
		input: string | undefined,
	): GitOutcome {
		const [command = "", ...rest] = args;
		switch (command) {
			case "hash-object":
				return this.hashObject(rest, cwd, input);
			case "read-tree":
				return this.readTree(rest, cwd, env);
			case "update-index":
				return this.updateIndex(rest, env, input);
			case "write-tree":
				return this.writeTree(env);
			case "config":
				// git init writes core.filemode; any other unset key is exit status 1.
				if (rest[0] === "--get" && rest[1] === "core.filemode") return { code: 0, stdout: "true\n", stderr: "" };
				if (rest[0] === "--get" && rest[1] !== undefined) return { code: 1, stdout: "", stderr: "" };
				throw new Error(`Unscripted config: ${rest.join(" ")}`);
			case "rev-parse":
				return this.revParse(rest, cwd);
			case "symbolic-ref":
				return this.symbolicRef(rest, cwd);
			case "worktree":
				return this.worktreeCommand(rest, cwd);
			case "branch":
				return this.branchCommand(rest, cwd);
			case "status":
				return rest.includes("--porcelain=v2") ? this.statusHeader(cwd) : this.statusCommand(cwd);
			case "add":
				return this.addCommand(rest, cwd);
			case "commit":
				return this.commitCommand(rest, cwd);
			case "diff":
				return this.diffCommand(rest, cwd);
			case "ls-files":
				return this.lsFilesCommand(rest, cwd);
			case "merge-base":
				return this.mergeBaseCommand(rest, cwd);
			case "rev-list":
				return this.revListCommand(rest, cwd);
			case "log":
				return this.logCommand(rest, cwd);
			case "update-ref":
				return this.updateRef(rest);
			case "reset":
				return this.resetCommand(rest, cwd);
			case "rebase":
				return this.rebaseCommand(rest, cwd);
			case "remote":
				// The fixture repository has no remote: real git refuses the lookup with exit status 2.
				if (rest[0] === "get-url" && rest[1] === "origin")
					return { code: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
				throw new Error(`Unscripted remote: ${rest.join(" ")}`);
			default:
				this.unscripted.push(`git ${args.join(" ")} @ ${cwd}`);
				throw new Error(`Unscripted git command: ${command}`);
		}
	}

	private commit(tree: ReadonlyMap<string, string>, parent: string | undefined, subject: string): string {
		const sha = createHash("sha1")
			.update(JSON.stringify([parent ?? "", subject, [...tree].sort(), this.counter++]))
			.digest("hex");
		this.commits.set(sha, { sha, parent, tree: new Map(tree), subject });
		return sha;
	}

	private worktreeFor(cwd: string): GitWorktree | undefined {
		const target = resolve(cwd);
		let best: GitWorktree | undefined;
		for (const worktree of this.worktrees.values()) {
			const inside = isWithin(worktree.path, target);
			if (inside && (best === undefined || worktree.path.length > best.path.length)) best = worktree;
		}
		return best;
	}

	private headSha(worktree: GitWorktree): string | undefined {
		if (worktree.rebase) return worktree.rebase.replayHead;
		return worktree.head.kind === "branch" ? this.refs.get(worktree.head.ref) : worktree.head.sha;
	}

	private treeOf(sha: string | undefined): ReadonlyMap<string, string> {
		return (
			(sha === undefined ? undefined : (this.commits.get(sha)?.tree ?? this.trees.get(sha))) ??
			new Map<string, string>()
		);
	}

	private resolveCommit(ref: string, cwd: string): string | undefined {
		if (this.commits.has(ref)) return ref;
		const branch = this.refs.get(`refs/heads/${ref}`);
		if (branch) return branch;
		if (ref === "HEAD") {
			const worktree = this.worktreeFor(cwd);
			return worktree ? this.headSha(worktree) : undefined;
		}
		return undefined;
	}

	private ancestorsOf(sha: string): Set<string> {
		const seen = new Set<string>();
		const queue = [sha];
		while (queue.length > 0) {
			const next = queue.shift();
			if (next === undefined || seen.has(next)) continue;
			seen.add(next);
			const parent = this.commits.get(next)?.parent;
			if (parent !== undefined) queue.push(parent);
		}
		return seen;
	}

	private isAncestor(ancestor: string, descendant: string): boolean {
		return this.ancestorsOf(descendant).has(ancestor);
	}

	private mergeBase(left: string, right: string): string | undefined {
		const fromLeft = this.ancestorsOf(left);
		let current: string | undefined = right;
		while (current !== undefined) {
			if (fromLeft.has(current)) return current;
			current = this.commits.get(current)?.parent;
		}
		return undefined;
	}

	/** Commits reachable from `tip` and not from `base`, oldest first (the rebase replay order). */
	private commitsBetween(base: string | undefined, tip: string): string[] {
		const excluded = base === undefined ? new Set<string>() : this.ancestorsOf(base);
		const collected: string[] = [];
		let current: string | undefined = tip;
		while (current !== undefined && !excluded.has(current)) {
			collected.push(current);
			current = this.commits.get(current)?.parent;
		}
		return collected.reverse();
	}

	private readWorking(worktree: GitWorktree, relative: string): string | undefined {
		const absolute = join(worktree.path, relative);
		if (!this.io.existsSync(absolute)) return undefined;
		return String(this.io.readFileSync(absolute, "utf8"));
	}

	private writeWorking(worktree: GitWorktree, relative: string, content: string | undefined): void {
		const absolute = join(worktree.path, relative);
		if (content === undefined) {
			if (this.io.existsSync(absolute)) this.io.unlinkSync(absolute);
			return;
		}
		this.io.mkdirSync(dirname(absolute), { recursive: true });
		this.io.writeFileSync(absolute, content);
	}

	/** Every regular file under the checkout except the git dir, as paths relative to the checkout. */
	private workingFiles(worktree: GitWorktree): string[] {
		const found: string[] = [];
		const visit = (directory: string): void => {
			const entries = this.io.readdirSync(directory, { withFileTypes: true }) as Array<{
				name: string;
				isDirectory(): boolean;
				isFile(): boolean;
			}>;
			for (const entry of entries) {
				if (entry.name === ".git") continue;
				const absolute = join(directory, entry.name);
				if (entry.isDirectory()) visit(absolute);
				else if (entry.isFile()) found.push(gitRelative(worktree.path, absolute));
			}
		};
		visit(worktree.path);
		return found.sort();
	}

	/** `status --porcelain` lines: staged column, worktree column, then the path. */
	private statusLines(worktree: GitWorktree): string[] {
		const headTree = this.treeOf(this.headSha(worktree));
		const paths = new Set<string>([
			...headTree.keys(),
			...worktree.index.keys(),
			...worktree.unmerged.keys(),
			...this.workingFiles(worktree),
		]);
		const lines: string[] = [];
		for (const relative of [...paths].sort()) {
			if (worktree.unmerged.has(relative)) {
				lines.push(`UU ${relative}`);
				continue;
			}
			const indexed = worktree.index.get(relative);
			const headed = headTree.get(relative);
			const working = this.readWorking(worktree, relative);
			if (indexed === undefined && headed === undefined) {
				if (working !== undefined) lines.push(`?? ${relative}`);
				continue;
			}
			const staged = indexed === headed ? " " : indexed === undefined ? "D" : headed === undefined ? "A" : "M";
			const unstaged = working === indexed ? " " : working === undefined ? "D" : "M";
			if (staged === " " && unstaged === " ") continue;
			lines.push(`${staged}${unstaged} ${relative}`);
		}
		return lines;
	}

	private revParse(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		const out: string[] = [];
		let verify = false;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index] ?? "";
			if (arg === "--verify" || arg === "--quiet" || arg === "--path-format=absolute") {
				if (arg === "--verify") verify = true;
				continue;
			}
			if (
				arg === "--show-toplevel" ||
				arg === "--git-common-dir" ||
				arg === "--git-path" ||
				arg === "--absolute-git-dir"
			) {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				if (arg === "--show-toplevel") out.push(worktree.path);
				else if (arg === "--git-common-dir") out.push(this.commonDir);
				else if (arg === "--absolute-git-dir") out.push(worktree.gitDir);
				else out.push(join(worktree.gitDir, args[++index] ?? ""));
				continue;
			}
			if (arg === "--abbrev-ref") {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				if (args[++index] !== "HEAD") throw new Error(`Unscripted rev-parse --abbrev-ref: ${args.join(" ")}`);
				if (worktree.head.kind !== "branch")
					return { code: 128, stdout: "", stderr: "fatal: HEAD is not a branch\n" };
				out.push(worktree.head.ref.replace("refs/heads/", ""));
				continue;
			}
			if (arg === "HEAD") {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				const sha = this.headSha(worktree);
				if (sha === undefined) return { code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n" };
				out.push(sha);
				continue;
			}
			if (arg === "HEAD^") {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				const parent = this.commits.get(this.headSha(worktree) ?? "")?.parent;
				if (parent === undefined) {
					return { code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD^': unknown revision\n" };
				}
				out.push(parent);
				continue;
			}
			if (arg.startsWith("refs/heads/")) {
				const sha = this.refs.get(arg);
				if (sha === undefined) {
					return verify
						? { code: 1, stdout: "", stderr: "" }
						: { code: 128, stdout: "", stderr: `fatal: ${arg}\n` };
				}
				out.push(sha);
				continue;
			}
			this.unscripted.push(`git rev-parse ${arg} @ ${cwd}`);
			throw new Error(`Unscripted rev-parse argument: ${arg}`);
		}
		return { code: 0, stdout: out.map((line) => `${line}\n`).join(""), stderr: "" };
	}

	private symbolicRef(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		if (args[0] !== "--short" || args[1] !== "HEAD") throw new Error(`Unscripted symbolic-ref: ${args.join(" ")}`);
		if (worktree.head.kind !== "branch")
			return { code: 128, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref\n" };
		return { code: 0, stdout: `${worktree.head.ref.replace("refs/heads/", "")}\n`, stderr: "" };
	}

	private worktreeCommand(args: readonly string[], cwd: string): GitOutcome {
		const [subcommand, ...rest] = args;
		if (subcommand === "list") {
			const lines: string[] = [];
			for (const worktree of this.worktrees.values()) {
				lines.push(`worktree ${worktree.path}`);
				lines.push(`HEAD ${this.headSha(worktree) ?? "0".repeat(40)}`);
				lines.push(worktree.head.kind === "branch" ? `branch ${worktree.head.ref}` : "detached");
				lines.push("");
			}
			return { code: 0, stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
		}
		if (subcommand === "prune") return { code: 0, stdout: "", stderr: "" };
		if (subcommand === "add") {
			const positional: string[] = [];
			let branch: string | undefined;
			for (let index = 0; index < rest.length; index++) {
				if (rest[index] === "-b") branch = rest[++index];
				else positional.push(rest[index] ?? "");
			}
			const [path, base] = positional;
			if (branch === undefined || path === undefined || base === undefined) {
				throw new Error(`Unscripted worktree add: ${args.join(" ")}`);
			}
			const absolute = resolve(cwd, path);
			if (this.worktrees.has(absolute) || this.io.existsSync(absolute)) {
				return { code: 128, stdout: "", stderr: `fatal: '${absolute}' already exists\n` };
			}
			if (this.refs.has(`refs/heads/${branch}`)) {
				return { code: 128, stdout: "", stderr: `fatal: a branch named '${branch}' already exists\n` };
			}
			const sha = this.resolveCommit(base, cwd);
			if (sha === undefined) return { code: 128, stdout: "", stderr: `fatal: invalid reference: ${base}\n` };
			this.refs.set(`refs/heads/${branch}`, sha);
			const gitDir = join(this.commonDir, "worktrees", basename(absolute));
			this.io.mkdirSync(gitDir, { recursive: true });
			const tree = this.treeOf(sha);
			const worktree: GitWorktree = {
				path: absolute,
				gitDir,
				head: { kind: "branch", ref: `refs/heads/${branch}` },
				index: new Map(tree),
				unmerged: new Map(),
				rebase: undefined,
			};
			this.io.mkdirSync(absolute, { recursive: true });
			for (const [relative, content] of tree) this.writeWorking(worktree, relative, content);
			this.worktrees.set(absolute, worktree);
			return { code: 0, stdout: "", stderr: `Preparing worktree (new branch '${branch}')\n` };
		}
		if (subcommand === "remove") {
			const force = rest.includes("--force");
			const target = resolve(cwd, rest.filter((arg) => arg !== "--force").at(-1) ?? "");
			const worktree = this.worktrees.get(target);
			if (!worktree) return { code: 128, stdout: "", stderr: `fatal: '${target}' is not a working tree\n` };
			if (worktree.path === this.root)
				return { code: 128, stdout: "", stderr: "fatal: cannot remove the main working tree\n" };
			if (!force && this.statusLines(worktree).length > 0) {
				return {
					code: 128,
					stdout: "",
					stderr: `fatal: '${target}' contains modified or untracked files, use --force to delete it\n`,
				};
			}
			this.worktrees.delete(target);
			this.io.rmSync(target, { recursive: true, force: true });
			this.io.rmSync(worktree.gitDir, { recursive: true, force: true });
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`Unscripted worktree subcommand: ${subcommand ?? ""}`);
	}

	private branchCommand(args: readonly string[], cwd: string): GitOutcome {
		const [mode, name] = args;
		if ((mode !== "-d" && mode !== "-D") || name === undefined)
			throw new Error(`Unscripted branch: ${args.join(" ")}`);
		const ref = `refs/heads/${name}`;
		const sha = this.refs.get(ref);
		if (sha === undefined) return { code: 1, stdout: "", stderr: `error: branch '${name}' not found.\n` };
		for (const worktree of this.worktrees.values()) {
			if (worktree.head.kind === "branch" && worktree.head.ref === ref) {
				return {
					code: 128,
					stdout: "",
					stderr: `error: Cannot delete branch '${name}' checked out at '${worktree.path}'\n`,
				};
			}
		}
		if (mode === "-d") {
			const current = this.worktreeFor(cwd);
			const head = current ? this.headSha(current) : undefined;
			if (head === undefined || !this.isAncestor(sha, head)) {
				return { code: 1, stdout: "", stderr: `error: The branch '${name}' is not fully merged.\n` };
			}
		}
		this.refs.delete(ref);
		return { code: 0, stdout: `Deleted branch ${name} (was ${sha.slice(0, 7)}).\n`, stderr: "" };
	}

	/** The branch identity records `status --porcelain=v2 --branch` leads with; the capture reads only the head. */
	private statusHeader(cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const head = this.headSha(worktree);
		const name = worktree.head.kind === "branch" ? worktree.head.ref.replace("refs/heads/", "") : "(detached)";
		return { code: 0, stdout: `# branch.oid ${head ?? "(initial)"}\0# branch.head ${name}\0`, stderr: "" };
	}

	private blobOf(content: string): string {
		const sha = createHash("sha1")
			.update(`blob ${Buffer.byteLength(content)}\0`)
			.update(content)
			.digest("hex");
		this.blobs.set(sha, content);
		return sha;
	}

	/** The staged snapshot as index entries; each staged blob is registered so object reads resolve. */
	private defaultIndexEntries(worktree: GitWorktree): Map<string, GitIndexEntry> {
		return new Map<string, GitIndexEntry>(
			[...worktree.index].map(([path, content]): [string, GitIndexEntry] => [
				path,
				{ mode: "100644", blob: this.blobOf(content) },
			]),
		);
	}

	private hashObject(args: readonly string[], cwd: string, input: string | undefined): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		if (!args.includes("-w")) throw new Error(`Unscripted hash-object: ${args.join(" ")}`);
		if (args.includes("--stdin")) {
			if (input === undefined) throw new Error("hash-object --stdin without input");
			return { code: 0, stdout: `${this.blobOf(input)}\n`, stderr: "" };
		}
		const separator = args.indexOf("--");
		const paths = separator >= 0 ? args.slice(separator + 1) : [];
		if (paths.length === 0) throw new Error(`Unscripted hash-object: ${args.join(" ")}`);
		const hashes: string[] = [];
		for (const path of paths) {
			const content = this.readWorking(worktree, relative(worktree.path, resolve(cwd, path)));
			if (content === undefined) return { code: 128, stdout: "", stderr: `fatal: could not open '${path}'\n` };
			hashes.push(this.blobOf(content));
		}
		return { code: 0, stdout: hashes.map((hash) => `${hash}\n`).join(""), stderr: "" };
	}

	/** `read-tree --empty` or `read-tree <commit>` into the scratch index named by GIT_INDEX_FILE. */
	private readTree(
		args: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
	): GitOutcome {
		const indexFile = env.GIT_INDEX_FILE;
		if (indexFile === undefined) throw new Error(`Unscripted read-tree without a scratch index: ${args.join(" ")}`);
		if (args.includes("--empty")) {
			this.indexFiles.set(indexFile, new Map());
			return { code: 0, stdout: "", stderr: "" };
		}
		const revision = args.find((arg) => !arg.startsWith("-")) ?? "";
		const sha = this.resolveCommit(revision, cwd);
		const tree = sha === undefined ? undefined : this.commits.get(sha)?.tree;
		if (tree === undefined) return { code: 128, stdout: "", stderr: `fatal: not a valid object name: ${revision}\n` };
		this.indexFiles.set(
			indexFile,
			new Map(
				[...tree].map(([path, content]): [string, GitIndexEntry] => [
					path,
					{ mode: "100644", blob: this.blobOf(content) },
				]),
			),
		);
		return { code: 0, stdout: "", stderr: "" };
	}

	/** `update-index -z --index-info`: a `0` mode removes the path, any other mode sets its entry. */
	private updateIndex(
		args: readonly string[],
		env: Readonly<Record<string, string | undefined>>,
		input: string | undefined,
	): GitOutcome {
		const indexFile = env.GIT_INDEX_FILE;
		const entries = indexFile === undefined ? undefined : this.indexFiles.get(indexFile);
		if (entries === undefined || !args.includes("--index-info") || !args.includes("-z")) {
			throw new Error(`Unscripted update-index: ${args.join(" ")}`);
		}
		for (const record of (input ?? "").split("\0")) {
			if (record === "") continue;
			const tab = record.indexOf("\t");
			const [mode = "", blob = ""] = record.slice(0, tab).split(" ");
			const path = record.slice(tab + 1);
			if (mode === "0") entries.delete(path);
			else entries.set(path, { mode, blob });
		}
		return { code: 0, stdout: "", stderr: "" };
	}

	private writeTree(env: Readonly<Record<string, string | undefined>>): GitOutcome {
		const indexFile = env.GIT_INDEX_FILE;
		const entries = indexFile === undefined ? undefined : this.indexFiles.get(indexFile);
		if (entries === undefined) throw new Error("write-tree without a scratch index file");
		const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		const sha = createHash("sha1")
			.update(sorted.map(([path, entry]) => `${entry.mode} ${entry.blob} ${path}`).join("\n"))
			.digest("hex");
		const contents = new Map<string, string>();
		for (const [path, entry] of sorted) {
			const content = this.blobs.get(entry.blob);
			if (content === undefined) throw new Error(`write-tree: unknown blob ${entry.blob} for ${path}`);
			contents.set(path, content);
		}
		this.trees.set(sha, contents);
		return { code: 0, stdout: `${sha}\n`, stderr: "" };
	}

	/** The tree a diff operand names: a commit or revision names its tree, a written tree id names itself. */
	private treeFor(ref: string, cwd: string): ReadonlyMap<string, string> | undefined {
		const sha = this.resolveCommit(ref, cwd);
		return sha === undefined ? this.trees.get(ref) : this.commits.get(sha)?.tree;
	}

	private statusCommand(cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const lines = this.statusLines(worktree);
		return { code: 0, stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
	}

	private addCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		for (const path of args.filter((arg) => arg !== "--")) {
			const rel = gitRelative(worktree.path, resolve(cwd, path));
			const working = this.readWorking(worktree, rel);
			if (working === undefined) worktree.index.delete(rel);
			else worktree.index.set(rel, working);
			worktree.unmerged.delete(rel);
		}
		return { code: 0, stdout: "", stderr: "" };
	}

	private commitCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const messageIndex = args.indexOf("-m");
		const subject = messageIndex >= 0 ? (args[messageIndex + 1] ?? "") : undefined;
		if (subject === undefined || worktree.rebase) throw new Error(`Unscripted commit: ${args.join(" ")}`);
		const parent = this.headSha(worktree);
		const next = this.commit(worktree.index, parent, subject);
		if (worktree.head.kind === "branch") this.refs.set(worktree.head.ref, next);
		else worktree.head = { kind: "detached", sha: next };
		return { code: 0, stdout: "", stderr: "" };
	}

	private diffCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		if (args.includes("--quiet")) {
			const cached = args.includes("--cached");
			const dirty = this.statusLines(worktree).some((line) => {
				if (line.startsWith("UU")) return true;
				if (line.startsWith("??")) return false;
				return cached ? line[0] !== " " : line[1] !== " ";
			});
			return { code: dirty ? 1 : 0, stdout: "", stderr: "" };
		}
		if (args.includes("--diff-filter=U")) {
			const paths = [...worktree.unmerged.keys()].sort();
			return { code: 0, stdout: paths.map((path) => `${path}\n`).join(""), stderr: "" };
		}
		const dashes = args.indexOf("--");
		const operands = args.slice(0, dashes < 0 ? args.length : dashes).filter((arg) => !arg.startsWith("-"));
		const pathspecs = dashes < 0 ? [] : args.slice(dashes + 1).map((spec) => spec.replace(":(literal)", ""));
		const range = operands.find((arg) => arg.includes(".."));
		const ambiguous = (ref: string): GitOutcome => ({
			code: 128,
			stdout: "",
			stderr: `fatal: ambiguous argument '${ref}'\n`,
		});
		// `before` and `after` map path to content; without `after` the working checkout is the right side.
		let before: ReadonlyMap<string, string>;
		let after: ReadonlyMap<string, string> | undefined;
		if (range !== undefined) {
			const separator = range.includes("...") ? "..." : "..";
			const [leftRef = "", rightRef = ""] = range.split(separator);
			const right = this.resolveCommit(rightRef, cwd);
			const leftResolved = this.resolveCommit(leftRef, cwd);
			if (right === undefined || leftResolved === undefined) return ambiguous(range);
			const left = separator === "..." ? (this.mergeBase(leftResolved, right) ?? leftResolved) : leftResolved;
			before = this.treeOf(left);
			after = this.treeOf(right);
		} else if (operands.length === 2) {
			const left = this.treeFor(operands[0] ?? "", cwd);
			const right = this.treeFor(operands[1] ?? "", cwd);
			if (left === undefined || right === undefined) return ambiguous(operands.join(" "));
			before = left;
			after = right;
		} else if (operands.length === 1) {
			const left = this.treeFor(operands[0] ?? "", cwd);
			if (left === undefined) return ambiguous(operands[0] ?? "");
			before = left;
		} else {
			throw new Error(`Unscripted diff: ${args.join(" ")}`);
		}
		const readAfter = (path: string): string | undefined =>
			after ? after.get(path) : this.readWorking(worktree, path);
		const candidates = new Set([...before.keys(), ...(after ? after.keys() : worktree.index.keys())]);
		const added = args.includes("--diff-filter=A");
		const changed = [...candidates]
			.filter((path) => pathspecs.length === 0 || pathspecs.includes(path))
			.sort()
			.map((path) => ({ path, old: before.get(path), next: readAfter(path) }))
			.filter(({ old, next }) => old !== next)
			.filter(({ old, next }) => !added || (old === undefined && next !== undefined));
		if (args.includes("--name-only")) {
			const terminator = args.includes("-z") ? "\0" : "\n";
			return { code: 0, stdout: changed.map(({ path }) => `${path}${terminator}`).join(""), stderr: "" };
		}
		const patch = changed.map(({ path, old, next }) => {
			const lines = [
				`diff --git a/${path} b/${path}`,
				old === undefined ? "--- /dev/null" : `--- a/${path}`,
				next === undefined ? "+++ /dev/null" : `+++ b/${path}`,
			];
			if (old !== undefined) lines.push(...old.split("\n").map((line) => `-${line}`));
			if (next !== undefined) lines.push(...next.split("\n").map((line) => `+${line}`));
			return `${lines.join("\n")}\n`;
		});
		return { code: 0, stdout: patch.join(""), stderr: "" };
	}

	private lsFilesCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const nul = args.includes("-z") ? "\0" : "\n";
		if (args.includes("--others")) {
			const tracked = new Set([...this.treeOf(this.headSha(worktree)).keys(), ...worktree.index.keys()]);
			const untracked = this.workingFiles(worktree).filter((path) => !tracked.has(path));
			return { code: 0, stdout: untracked.map((path) => `${path}${nul}`).join(""), stderr: "" };
		}
		if (args.includes("--stage")) {
			const entries = this.defaultIndexEntries(worktree);
			return {
				code: 0,
				stdout: [...entries].map(([path, entry]) => `${entry.mode} ${entry.blob} 0\t${path}${nul}`).join(""),
				stderr: "",
			};
		}
		if (args.includes("--cached")) {
			return {
				code: 0,
				stdout: [...worktree.index.keys()]
					.sort()
					.map((path) => `${path}${nul}`)
					.join(""),
				stderr: "",
			};
		}
		if (args[0] !== "-u") throw new Error(`Unscripted ls-files: ${args.join(" ")}`);
		const blob = (content: string): string => this.blobOf(content);
		const lines: string[] = [];
		for (const [path, conflict] of [...worktree.unmerged].sort(([left], [right]) => left.localeCompare(right))) {
			if (conflict.base !== undefined) lines.push(`100644 ${blob(conflict.base)} 1\t${path}`);
			if (conflict.ours !== undefined) lines.push(`100644 ${blob(conflict.ours)} 2\t${path}`);
			if (conflict.theirs !== undefined) lines.push(`100644 ${blob(conflict.theirs)} 3\t${path}`);
		}
		return { code: 0, stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
	}

	private mergeBaseCommand(args: readonly string[], cwd: string): GitOutcome {
		if (args[0] === "--is-ancestor") {
			const ancestor = this.resolveCommit(args[1] ?? "", cwd);
			const descendant = this.resolveCommit(args[2] ?? "", cwd);
			if (ancestor === undefined || descendant === undefined) {
				return { code: 128, stdout: "", stderr: `fatal: Not a valid object name\n` };
			}
			return { code: this.isAncestor(ancestor, descendant) ? 0 : 1, stdout: "", stderr: "" };
		}
		const left = this.resolveCommit(args[0] ?? "", cwd);
		const right = this.resolveCommit(args[1] ?? "", cwd);
		if (left === undefined || right === undefined)
			return { code: 128, stdout: "", stderr: "fatal: Not a valid object name\n" };
		const base = this.mergeBase(left, right);
		return base === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `${base}\n`, stderr: "" };
	}

	private revListCommand(args: readonly string[], cwd: string): GitOutcome {
		const range = args.find((arg) => arg.includes("..."));
		if (range === undefined || !args.includes("--left-right") || !args.includes("--count")) {
			throw new Error(`Unscripted rev-list: ${args.join(" ")}`);
		}
		const [leftRef = "", rightRef = ""] = range.split("...");
		const left = this.resolveCommit(leftRef, cwd);
		const right = this.resolveCommit(rightRef, cwd);
		if (left === undefined || right === undefined) return { code: 128, stdout: "", stderr: "fatal: bad revision\n" };
		const fromLeft = this.ancestorsOf(left);
		const fromRight = this.ancestorsOf(right);
		const behind = [...fromLeft].filter((sha) => !fromRight.has(sha)).length;
		const ahead = [...fromRight].filter((sha) => !fromLeft.has(sha)).length;
		return { code: 0, stdout: `${behind}\t${ahead}\n`, stderr: "" };
	}

	private logCommand(args: readonly string[], cwd: string): GitOutcome {
		const sha = args.at(-1) ?? "";
		const commit = this.commits.get(this.resolveCommit(sha, cwd) ?? "");
		if (args[0] !== "-1" || args[1] !== "--format=%s" || commit === undefined) {
			throw new Error(`Unscripted log: ${args.join(" ")}`);
		}
		return { code: 0, stdout: `${commit.subject}\n`, stderr: "" };
	}

	private updateRef(args: readonly string[]): GitOutcome {
		const [ref = "", next = "", expected] = args;
		const current = this.refs.get(ref);
		if (expected !== undefined && current !== expected) {
			return {
				code: 1,
				stdout: "",
				stderr: `error: cannot lock ref '${ref}': is at ${current ?? "nothing"} but expected ${expected}\n`,
			};
		}
		// Branches hold commits only; other refs (the work-baseline refs) may name any stored object, trees included.
		const storable = this.commits.has(next) || (!ref.startsWith("refs/heads/") && this.trees.has(next));
		if (!storable) return { code: 128, stdout: "", stderr: `fatal: invalid new value for ${ref}\n` };
		this.refs.set(ref, next);
		return { code: 0, stdout: "", stderr: "" };
	}

	private resetCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const target = args.find((arg) => arg !== "--merge");
		const sha = target === undefined ? undefined : this.resolveCommit(target, cwd);
		if (args[0] !== "--merge" || sha === undefined) throw new Error(`Unscripted reset: ${args.join(" ")}`);
		const next = this.treeOf(sha);
		const paths = new Set([...worktree.index.keys(), ...next.keys()]);
		for (const path of paths) {
			if (worktree.index.get(path) === next.get(path)) continue;
			if (this.readWorking(worktree, path) !== worktree.index.get(path)) {
				return {
					code: 128,
					stdout: "",
					stderr: `error: Entry '${path}' would be overwritten by merge. Cannot merge.\n`,
				};
			}
		}
		for (const path of paths) {
			if (worktree.index.get(path) !== next.get(path)) this.writeWorking(worktree, path, next.get(path));
		}
		worktree.index = new Map(next);
		worktree.unmerged.clear();
		if (worktree.head.kind === "branch") this.refs.set(worktree.head.ref, sha);
		return { code: 0, stdout: "", stderr: "" };
	}

	private rebaseCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const [first = ""] = args;
		if (first === "--continue") return this.rebaseContinue(worktree);
		if (first === "--skip") return this.rebaseSkip(worktree);
		if (first === "--abort") return this.rebaseAbort(worktree);
		if (args.length !== 1 || worktree.rebase) throw new Error(`Unscripted rebase: ${args.join(" ")}`);
		return this.rebaseStart(worktree, first, cwd);
	}

	private rebaseStart(worktree: GitWorktree, onto: string, cwd: string): GitOutcome {
		if (worktree.head.kind !== "branch")
			return { code: 128, stdout: "", stderr: "fatal: rebase requires a branch\n" };
		if (this.statusLines(worktree).some((line) => !line.startsWith("??"))) {
			return { code: 1, stdout: "", stderr: "error: cannot rebase: You have unstaged changes.\n" };
		}
		const branchSha = this.refs.get(worktree.head.ref);
		const ontoSha = this.resolveCommit(onto, cwd);
		if (branchSha === undefined || ontoSha === undefined)
			return { code: 128, stdout: "", stderr: `fatal: invalid upstream '${onto}'\n` };
		if (this.isAncestor(ontoSha, branchSha))
			return { code: 0, stdout: "Current branch is up to date.\n", stderr: "" };
		if (this.isAncestor(branchSha, ontoSha)) {
			this.refs.set(worktree.head.ref, ontoSha);
			this.adoptTree(worktree, this.treeOf(ontoSha));
			return { code: 0, stdout: "Fast-forwarded.\n", stderr: "" };
		}
		const todo = this.commitsBetween(this.mergeBase(branchSha, ontoSha), branchSha);
		this.adoptTree(worktree, this.treeOf(ontoSha));
		worktree.rebase = {
			headName: worktree.head.ref,
			origHead: branchSha,
			total: todo.length,
			todo,
			done: 0,
			replayHead: ontoSha,
			stoppedAt: undefined,
		};
		return this.drive(worktree);
	}

	/** Moves the staged snapshot and the working files of the changed paths to `tree`. */
	private adoptTree(worktree: GitWorktree, tree: ReadonlyMap<string, string>): void {
		const paths = new Set([...worktree.index.keys(), ...tree.keys()]);
		for (const path of paths) {
			if (worktree.index.get(path) !== tree.get(path)) this.writeWorking(worktree, path, tree.get(path));
		}
		worktree.index = new Map(tree);
		worktree.unmerged.clear();
	}

	/** Replays commits in order; stops at the first conflicting commit with rebase state on disk. */
	private drive(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined) return { code: 0, stdout: "", stderr: "" };
		while (rebase.todo.length > 0) {
			const sha = rebase.todo[0] ?? "";
			const commit = this.commits.get(sha);
			if (commit === undefined) throw new Error(`Rebase references a missing commit: ${sha}`);
			const base = this.treeOf(commit.parent);
			const ours = worktree.index;
			const theirs = commit.tree;
			const merged = new Map<string, string>();
			const conflicts = new Map<string, GitConflict>();
			for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
				const b = base.get(path);
				const o = ours.get(path);
				const t = theirs.get(path);
				if (o === t) {
					if (o !== undefined) merged.set(path, o);
				} else if (o === b) {
					if (t !== undefined) merged.set(path, t);
				} else if (t === b) {
					if (o !== undefined) merged.set(path, o);
				} else {
					conflicts.set(path, { base: b, ours: o, theirs: t });
					if (o !== undefined) merged.set(path, o);
				}
			}
			const previous = worktree.index;
			worktree.index = merged;
			for (const path of new Set([...previous.keys(), ...merged.keys()])) {
				if (previous.get(path) !== merged.get(path)) this.writeWorking(worktree, path, merged.get(path));
			}
			if (conflicts.size > 0) {
				for (const [path, conflict] of conflicts) {
					worktree.unmerged.set(path, conflict);
					this.writeWorking(worktree, path, this.conflictText(conflict, commit.subject));
				}
				rebase.stoppedAt = sha;
				this.writeRebaseState(worktree);
				const detail = [...conflicts.keys()].map((path) => `CONFLICT (content): Merge conflict in ${path}`);
				return {
					code: 1,
					stdout: "",
					stderr: `${detail.join("\n")}\nerror: could not apply ${sha.slice(0, 7)}... ${commit.subject}\n`,
				};
			}
			rebase.replayHead = this.commit(worktree.index, rebase.replayHead, commit.subject);
			rebase.todo.shift();
			rebase.done++;
		}
		this.refs.set(rebase.headName, rebase.replayHead);
		worktree.rebase = undefined;
		this.io.rmSync(join(worktree.gitDir, "rebase-merge"), { recursive: true, force: true });
		return { code: 0, stdout: `Successfully rebased and updated ${rebase.headName}.\n`, stderr: "" };
	}

	private conflictText(conflict: GitConflict, subject: string): string {
		const body = (content: string | undefined): string[] => (content ?? "").replace(/\n$/, "").split("\n");
		return `${[
			"<<<<<<< HEAD",
			...body(conflict.ours),
			"||||||| parent",
			...body(conflict.base),
			"=======",
			...body(conflict.theirs),
			`>>>>>>> ${subject}`,
		].join("\n")}\n`;
	}

	private writeRebaseState(worktree: GitWorktree): void {
		const rebase = worktree.rebase;
		if (rebase === undefined) return;
		const directory = join(worktree.gitDir, "rebase-merge");
		this.io.mkdirSync(directory, { recursive: true });
		this.io.writeFileSync(join(directory, "msgnum"), `${rebase.done + 1}\n`);
		this.io.writeFileSync(join(directory, "end"), `${rebase.total}\n`);
		this.io.writeFileSync(join(directory, "head-name"), `${rebase.headName}\n`);
		this.io.writeFileSync(join(directory, "orig-head"), `${rebase.origHead}\n`);
		if (rebase.stoppedAt !== undefined)
			this.io.writeFileSync(join(directory, "stopped-sha"), `${rebase.stoppedAt}\n`);
	}

	private rebaseContinue(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined || rebase.stoppedAt === undefined) {
			return { code: 128, stdout: "", stderr: "fatal: No rebase in progress?\n" };
		}
		for (const path of worktree.unmerged.keys()) {
			const working = this.readWorking(worktree, path) ?? "";
			if (working.includes("<<<<<<<")) {
				return { code: 1, stdout: "", stderr: `error: you must resolve conflicts in ${path} before continuing\n` };
			}
			worktree.index.set(path, working);
		}
		worktree.unmerged.clear();
		const subject = this.commits.get(rebase.stoppedAt)?.subject ?? "";
		rebase.replayHead = this.commit(worktree.index, rebase.replayHead, subject);
		rebase.todo.shift();
		rebase.done++;
		rebase.stoppedAt = undefined;
		return this.drive(worktree);
	}

	private rebaseSkip(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined || rebase.stoppedAt === undefined) {
			return { code: 128, stdout: "", stderr: "fatal: No rebase in progress?\n" };
		}
		this.adoptTree(worktree, this.treeOf(rebase.replayHead));
		rebase.todo.shift();
		rebase.done++;
		rebase.stoppedAt = undefined;
		return this.drive(worktree);
	}

	private rebaseAbort(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined) return { code: 128, stdout: "", stderr: "fatal: no rebase in progress\n" };
		this.adoptTree(worktree, this.treeOf(rebase.origHead));
		worktree.rebase = undefined;
		this.io.rmSync(join(worktree.gitDir, "rebase-merge"), { recursive: true, force: true });
		return { code: 0, stdout: "", stderr: "" };
	}
}

/**
 * Child-process boundary. `git` answers come from the stateful repository; any other command is rejected.
 * Sync results mirror the real child_process contract: a non-zero status throws with its stderr.
 */
/**
 * A git child process for `spawn`: its output and exit are the virtual repository's answer, emitted once the
 * caller has attached its listeners. Stream and event shape match what the production settlement waits on.
 */
class VirtualGitChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid: number | undefined = undefined;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	finish(outcome: GitOutcome): void {
		this.stdout.end(outcome.stdout);
		this.stderr.end(outcome.stderr);
		this.exitCode = outcome.code;
		this.emit("exit", outcome.code, null);
	}

	kill(): boolean {
		return false;
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}
}

/** JSON with object keys sorted, so two equal values compare equal whatever order their keys were written in. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item !== null && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
			: item,
	);
}

/**
 * The worker controller's resources, reduced to what must be zero or false once every worker is settled. An unloaded controller
 * (undefined) owns nothing, so it is null here and matches an expected null.
 */
function settledWorkers(workers: ReturnType<AgentSession["getResourceSnapshot"]>["workers"]): unknown {
	if (workers === undefined) return null;
	// Every loaded control mailbox, including mailboxes whose claims were released, is read: listeners, open obligations and pending messages.
	// Reply acknowledgements are a bounded cache, not work, so they are not required to be empty.
	const loadedMailboxes = workers.control.loadedMailboxes;
	const agents = workers.ownedProjectClaims.flatMap((claim) => claim.agents);
	// A loaded mailbox with no snapshot on its claim agent is unobserved, never quiescent: it is reported, not dropped.
	const loadedMailboxesUnobserved = agents
		.filter((agent) => agent.mailboxLoaded && agent.mailbox === undefined)
		.map((agent) => agent.agentId);
	const activeAttempts = agents
		.filter(
			(agent) =>
				agent.attemptStatus === "queued" || agent.attemptStatus === "leased" || agent.attemptStatus === "running",
		)
		.map((agent) => agent.agentId);
	// Owned claims are classified, never omitted: each is its agents' statuses, and a settled journey retains none.
	const ownedClaims = workers.ownedProjectClaims.map((claim) =>
		claim.agents.map(
			(agent) =>
				`${agent.agentId}:${agent.agentStatus}:${agent.attemptStatus ?? "none"}:holds${agent.executingHoldCount}`,
		),
	);
	return {
		ingressPromiseCount: workers.ingressPromiseCount,
		executionPromiseCount: workers.executionPromiseCount,
		executingHolds: workers.executingHolds.length,
		inFlightLedgerCount: workers.inFlightLedgerCount,
		laneAbortControllerCount: workers.laneAbortControllerCount,
		shellSessionCount: workers.shellSessionCount,
		pendingTerminalHandoffCount: workers.pendingTerminalHandoffCount,
		scheduler: {
			admissionClosed: workers.scheduler.admissionClosed,
			queuedCount: workers.scheduler.queuedCount,
			deferredCount: workers.scheduler.deferredCount,
			preflightPromiseCount: workers.scheduler.preflightPromiseCount,
			preflightTokenCount: workers.scheduler.preflightTokenCount,
			runningPromiseCount: workers.scheduler.runningPromiseCount,
			pendingCancellationCount: workers.scheduler.pendingCancellationCount,
			laneObserverCount: workers.scheduler.laneObserverCount,
			queueCapacityListenerCount: workers.scheduler.queueCapacityListenerCount,
			queueCapacityNotificationPending: workers.scheduler.queueCapacityNotificationPending,
		},
		reservations: {
			heldLeases: workers.reservations.heldLeases.length,
			watchCount: workers.reservations.watchCount,
			availabilityListenerCount: workers.reservations.availabilityListenerCount,
			availabilityDeliveryDepth: workers.reservations.availabilityDeliveryDepth,
		},
		control: {
			stateListenerCount: workers.control.stateListenerCount,
			reconcilingTaskBearingCount: workers.control.reconcilingTaskBearingCount,
			scheduledReconciliationCount: workers.control.scheduledReconciliationCount,
		},
		activeAttempts,
		mailboxListeners: loadedMailboxes.reduce((sum, mailbox) => sum + mailbox.listenerCount, 0),
		openObligations: loadedMailboxes.filter((mailbox) => mailbox.hasOpenObligation).map((mailbox) => mailbox.agentId),
		pendingMessages: loadedMailboxes
			.filter((mailbox) => mailbox.pendingMessageIds.length > 0)
			.map((mailbox) => `${mailbox.agentId}:${mailbox.pendingMessageIds.length}`),
		ownedClaims,
		loadedMailboxesUnobserved,
	};
}

/**
 * Settlement of one session's owned resources, read from the owners' fields after its disposal: nothing is active, pending, watched
 * or listening, and the background tool tasks are disposed. A value that is not settled fails with the whole snapshot.
 */
/** The exact retention a disposed owner keeps by design, predeclared before its disposal. Nothing else may be retained. */
/**
 * The settlement of a native promise after one event-loop turn: "pending" until it settles. The observed promise is read, never
 * replaced, and its rejection is handled here so the observer adds no unhandled rejection.
 */
export async function settlementState(work: Promise<unknown>): Promise<"pending" | "settled"> {
	let state: "pending" | "settled" = "pending";
	void work.then(
		() => {
			state = "settled";
		},
		() => {
			state = "settled";
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return state;
}

interface CertifiedOwnerRetention {
	readonly claims: WorkerProjectClaims;
	readonly leases: readonly WorkerWriteReservationLease[];
	readonly executingHolds: readonly { readonly agentId: string; readonly count: number }[];
	readonly watchCount: number;
	readonly laneAbortControllers: number;
}

/** The one oracle for a disposed owner's receipt: exact predeclared retention, every other resource settled. Certification and close both use it. */
function assertCertifiedOwnerRetention(
	snapshot: ReturnType<AgentSession["getResourceSnapshot"]>,
	expected: CertifiedOwnerRetention,
	label: string,
): void {
	const workers = snapshot.workers;
	if (workers === undefined) throw new Error(`${label} carries no worker snapshot`);
	if (!isDeepStrictEqual(workers.ownedProjectClaims, expected.claims)) {
		throw new Error(`${label} retains claims other than the predeclared ones`);
	}
	if (!isDeepStrictEqual(workers.reservations.heldLeases, expected.leases)) {
		throw new Error(`${label} retains write leases other than the predeclared ones`);
	}
	if (!isDeepStrictEqual(workers.executingHolds, expected.executingHolds)) {
		throw new Error(`${label} retains execution holds other than the predeclared ones`);
	}
	if (workers.laneAbortControllerCount !== expected.laneAbortControllers) {
		throw new Error(`${label} retains lane abort controllers other than the predeclared count`);
	}
	if (workers.reservations.watchCount !== expected.watchCount) {
		throw new Error(`${label} retains reservation observers other than the predeclared count`);
	}
	assertResourcesSettled(
		{
			...snapshot,
			workers: {
				...workers,
				ownedProjectClaims: [],
				executingHolds: [],
				laneAbortControllerCount: 0,
				reservations: { ...workers.reservations, heldLeases: [], watchCount: 0 },
			},
		},
		label,
	);
}

function assertResourcesSettled(snapshot: ReturnType<AgentSession["getResourceSnapshot"]>, label: string): void {
	const settled = {
		foregroundRecovery: {
			shutdown: snapshot.foregroundRecovery.shutdown,
			activeRuns: snapshot.foregroundRecovery.activeRuns,
			idleWaiters: snapshot.foregroundRecovery.idleWaiters,
			activityListeners: snapshot.foregroundRecovery.activityListeners,
			retrying: snapshot.foregroundRecovery.retrying,
			hasSubmissionLease: snapshot.foregroundRecovery.submissionEpoch !== undefined,
		},
		terminalHandoffs: {
			pendingDeliveries: snapshot.terminalHandoffs.pendingDeliveries,
			activeDeliveryIdentities: snapshot.terminalHandoffs.activeDeliveryIdentities,
		},
		backgroundToolTasks: {
			disposed: snapshot.backgroundToolTasks.disposed,
			physicalExecutions: snapshot.backgroundToolTasks.physicalExecutions,
			runningTaskIds: snapshot.backgroundToolTasks.runningTaskIds.length,
			handoffRequests: snapshot.backgroundToolTasks.handoffRequests,
			waitingConsumers: snapshot.backgroundToolTasks.waitingConsumers,
			taskWatchdogs: snapshot.backgroundToolTasks.taskWatchdogs,
			queuedNotifications: snapshot.backgroundToolTasks.queuedNotifications,
			activeNotificationRecords: snapshot.backgroundToolTasks.activeNotificationRecords,
			notificationDrainActive: snapshot.backgroundToolTasks.notificationDrainActive,
			notificationRetryActive: snapshot.backgroundToolTasks.notificationRetryActive,
		},
		eventListeners: snapshot.eventListeners,
		workers: settledWorkers(snapshot.workers),
	};
	const expectedWorkers = {
		ingressPromiseCount: 0,
		executionPromiseCount: 0,
		executingHolds: 0,
		inFlightLedgerCount: 0,
		laneAbortControllerCount: 0,
		pendingTerminalHandoffCount: 0,
		scheduler: {
			admissionClosed: true,
			queuedCount: 0,
			deferredCount: 0,
			preflightPromiseCount: 0,
			preflightTokenCount: 0,
			runningPromiseCount: 0,
			pendingCancellationCount: 0,
			laneObserverCount: 0,
			queueCapacityListenerCount: 0,
			queueCapacityNotificationPending: false,
		},
		reservations: { heldLeases: 0, watchCount: 0, availabilityListenerCount: 0, availabilityDeliveryDepth: 0 },
		control: { stateListenerCount: 0, reconcilingTaskBearingCount: 0, scheduledReconciliationCount: 0 },
		shellSessionCount: 0,
		activeAttempts: [],
		mailboxListeners: 0,
		openObligations: [],
		pendingMessages: [],
		ownedClaims: [],
		loadedMailboxesUnobserved: [],
	};
	const expected = {
		foregroundRecovery: {
			shutdown: true,
			activeRuns: 0,
			idleWaiters: 0,
			activityListeners: 0,
			retrying: false,
			hasSubmissionLease: false,
		},
		terminalHandoffs: { pendingDeliveries: 0, activeDeliveryIdentities: 0 },
		backgroundToolTasks: {
			disposed: true,
			physicalExecutions: 0,
			runningTaskIds: 0,
			handoffRequests: 0,
			waitingConsumers: 0,
			taskWatchdogs: 0,
			queuedNotifications: 0,
			activeNotificationRecords: 0,
			notificationDrainActive: false,
			notificationRetryActive: false,
		},
		eventListeners: 0,
		workers: snapshot.workers === undefined ? null : expectedWorkers,
	};
	if (canonicalJson(settled) !== canonicalJson(expected)) {
		throw new Error(`${label} resources are not settled after disposal: ${JSON.stringify(snapshot)}`);
	}
}

export class HarnessProcesses {
	readonly unscripted: string[] = [];
	private readonly settling = new Set<Promise<void>>();
	/** Child causes retained after their spawn leaves `settling`, so every later drain still reports them. */
	private readonly causes: unknown[] = [];
	private readonly git: VirtualGit;
	private readonly windows: ScriptedWindowsShellProcesses;

	constructor(git: VirtualGit, windows: ScriptedWindowsShellProcesses) {
		this.git = git;
		this.windows = windows;
	}

	/** Joins every spawned child: its stdio has closed and its close has fired. Failures are aggregated, never dropped. */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.settling]);
		if (this.causes.length > 0)
			throw new AggregateError([...this.causes], "Virtual process children failed to settle");
	}

	run(operation: string, args: readonly unknown[]): unknown {
		// The Windows runtime answers only its own provisioned executables; every other operation keeps its existing dispatch.
		const windowsResult = this.windows.tryRun(operation, args);
		if (windowsResult?.handled) return windowsResult.value;
		const [file, argv, options] = args;
		const isGit = file === "git" || file === "git.exe";
		if (operation === "spawn" && isGit && Array.isArray(argv)) {
			// The state is read at spawn time, as git reads its repository when it starts.
			const spawnOptions = (options ?? {}) as { cwd?: string; env?: Record<string, string | undefined> };
			const outcome = this.git.run(argv as string[], spawnOptions.cwd ?? "", spawnOptions.env ?? {});
			const child = new VirtualGitChild();
			// The stdio is consumed so both streams close; the child's close fires once both have closed, and the spawn is tracked until then.
			child.stdout.on("data", () => undefined);
			child.stderr.on("data", () => undefined);
			const streamsClosed = Promise.all([
				new Promise<void>((resolve) => child.stdout.once("close", () => resolve())),
				new Promise<void>((resolve) => child.stderr.once("close", () => resolve())),
			]).then(() => {
				child.emit("close", outcome.code, null);
			});
			const finished = new Promise<void>((resolve, reject) => {
				setImmediate(() => {
					try {
						child.finish(outcome);
						resolve();
					} catch (error) {
						// A failing finish still closes both streams, so the stdio joins and the child close are not skipped.
						child.stdout.destroy();
						child.stderr.destroy();
						reject(error);
					}
				});
			});
			// Both joins run independently: neither a rejected finish nor a throwing close listener skips the other.
			const settled = Promise.allSettled([finished, streamsClosed]).then((results) => {
				for (const result of results) if (result.status === "rejected") this.causes.push(result.reason);
			});
			this.settling.add(settled);
			void settled.then(() => this.settling.delete(settled));
			return child;
		}
		if (isGit && Array.isArray(argv)) {
			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? "";
			const env = (options as { env?: Record<string, string | undefined> } | undefined)?.env ?? {};
			const stdin: unknown = (options as { input?: unknown } | undefined)?.input;
			const input = Buffer.isBuffer(stdin) ? stdin.toString("utf8") : typeof stdin === "string" ? stdin : undefined;
			const outcome = this.git.run(argv as string[], cwd, env, input);
			if (operation === "spawnSync") {
				return {
					status: outcome.code,
					signal: null,
					stdout: outcome.stdout,
					stderr: outcome.stderr,
					output: [null, outcome.stdout, outcome.stderr],
					pid: 0,
				};
			}
			if (outcome.code !== 0) {
				throw Object.assign(new Error(`Command failed: git ${argv.join(" ")}\n${outcome.stderr}`), {
					status: outcome.code,
					signal: null,
					stdout: outcome.stdout,
					stderr: outcome.stderr,
				});
			}
			const encoding = (options as { encoding?: string } | undefined)?.encoding;
			return encoding ? outcome.stdout : Buffer.from(outcome.stdout);
		}
		this.unscripted.push(`${operation} ${String(file)} ${JSON.stringify(argv)}`);
		throw new Error(`Unscripted process ${operation}: ${String(file)}`);
	}
}

export interface HarnessWorldOptions {
	readonly name: string;
	readonly systemOneEnabled: boolean;
	/**
	 * Priced or window-configured scripted tracks. Applied to the provider before the registry is built, so the catalog,
	 * the router pool and every session read the same configured descriptor the scripted requests report.
	 */
	readonly modelOptions?: Readonly<Record<string, Parameters<ScriptedProvider["configureModel"]>[1]>>;
	/** Exact warning allowances of this journey: every other captured warning fails the close, after cleanup. */
	readonly warningAllowances?: readonly RegExp[];
	readonly files?: Readonly<Record<string, string>>;
	readonly settings?: Partial<Settings>;
	/** A git repository at the project root (project-relative paths): `committed` is the initial commit; `dirty` are owner edits left unstaged. */
	readonly repository?: {
		readonly committed: Readonly<Record<string, string>>;
		readonly dirty?: Readonly<Record<string, string>>;
	};
}

/** Runs one scenario body in a fresh world and always settles it afterwards, in the order `close` defines. */
export async function runHarnessWorld(
	options: HarnessWorldOptions,
	body: (world: HarnessWorld) => Promise<void>,
): Promise<void> {
	const world = new HarnessWorld(options);
	let bodyFailure: { readonly error: unknown } | undefined;
	try {
		await body(world);
	} catch (error) {
		bodyFailure = { error };
	}
	await world.close(bodyFailure);
}

/**
 * One composed world: virtual IO, effect guard, scripted provider and System One transport, and the
 * production SDK session built on top of them. Disposal settles every resource it opened.
 */
/**
 * The summary hierarchy's time source in a journey: the wall clock plus an offset the scenario advances, with real
 * timers. Until `advance` is called it behaves exactly like the system clock, so a journey that never advances it is
 * unchanged. `advance` moves domain time forward and fires, once and in due order, every timer that is then due, so a
 * long wait (an orphan age, a retry backoff) is reached by an event instead of by waiting. I/O deadlines stay real.
 */
export class HarnessHistoryClock implements TranscriptSummaryTimeSource {
	private offsetMs = 0;
	private nextHandle = 1;
	private readonly pending = new Map<
		number,
		{ readonly callback: () => void; readonly dueAt: number; readonly timer: ReturnType<typeof setTimeout> }
	>();

	now(): number {
		return Date.now() + this.offsetMs;
	}

	setTimer(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		const timer = setTimeout(() => {
			this.pending.delete(handle);
			callback();
		}, delayMs);
		timer.unref();
		this.pending.set(handle, { callback, dueAt: this.now() + delayMs, timer });
		return handle;
	}

	clearTimer(handle: unknown): void {
		if (typeof handle !== "number") return;
		const entry = this.pending.get(handle);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(handle);
	}

	/** Timers armed and not yet fired or cleared. */
	get armedTimers(): number {
		return this.pending.size;
	}

	/** Moves domain time forward by `ms` and fires every timer that is then due; returns how many fired. */
	advance(ms: number): number {
		this.offsetMs += ms;
		const due = [...this.pending.entries()]
			.filter(([, entry]) => entry.dueAt <= this.now())
			.sort((left, right) => left[1].dueAt - right[1].dueAt);
		for (const [handle, entry] of due) {
			clearTimeout(entry.timer);
			this.pending.delete(handle);
			entry.callback();
		}
		return due.length;
	}
}

export class HarnessWorld {
	readonly trace = new HarnessTrace();
	readonly io = new VirtualFileSystem(HARNESS_PROJECT_CWD);
	readonly systemOne: ScriptedSystemOneTransport;
	/** The history hierarchy's time source for every root session of this world (see {@link HarnessHistoryClock}). */
	readonly historyClock = new HarnessHistoryClock();
	readonly git: VirtualGit;
	readonly processTable = new VirtualProcessTable();
	readonly processes: HarnessProcesses;
	readonly windowsShell: ScriptedWindowsShellProcesses;
	readonly guard: EffectGuard;
	/** A witness-scoped answer to one fetch the guard receives; undefined passes it to System One's transport, as before. */
	fetchResponder: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | undefined) | undefined =
		undefined;
	readonly provider: ScriptedProvider;
	/** The scripted shell transport: bash runs through it for root and every worker lane. */
	readonly shell = new VirtualShell();
	/** The external human-input presentation: only native askQuestions is scripted; the close path cuts it off and asserts it settled. */
	readonly humanInput = new ScriptedHumanInput();
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settingsManager: SettingsManager;
	/** The settings the world's manager was built from: a per-session override clones it and changes only the System One flag. */
	private readonly baseSettings: Parameters<typeof SettingsManager.inMemory>[0];
	readonly sessions: AgentSession[] = [];
	/** Every warning any session of this world emitted, in order: journeys classify them before they close. */
	readonly warnings: string[] = [];
	private readonly warningAllowances: readonly RegExp[];
	private readonly everySession: AgentSession[] = [];
	/** Immutable disposal certificates: a disposed owner's snapshot taken at disposal, and the exact claims it keeps by design. */
	private readonly retainedDisposals = new Map<
		AgentSession,
		{
			readonly snapshot: ReturnType<AgentSession["getResourceSnapshot"]>;
			readonly expectation: CertifiedOwnerRetention;
		}
	>();
	private readonly everySessionManager: SessionManager[] = [];
	/** Each manager's open System One window: the mode its latest session binding runs in, and the intent entries it began with. */
	private readonly systemOneWindows = new Map<
		SessionManager,
		{ readonly enabled: boolean; readonly before: ReadonlyMap<string, string> }
	>();
	/** Violations recorded as each window closes; close reports them. */
	private readonly systemOneWindowFailures: string[] = [];
	/** The external approval port's own callbacks (setEdgeConfirmation): asked, in flight and settled. Native human input is separate. */
	readonly externalConfirmations = { asked: 0, inFlight: 0, settled: 0 };
	private readonly warningSubscriptions: Array<() => void> = [];
	/** The public isolated completions the owners started, in start order: the original promises the owners hold. */
	readonly isolatedCompletions: Promise<unknown>[] = [];
	/** Per-world agent directory: stores cached by path (SQLite, host stores) never leak between journeys. */
	readonly agentDir: string;
	private disposed = false;

	constructor(options: HarnessWorldOptions) {
		this.systemOne = new ScriptedSystemOneTransport(options.systemOneEnabled);
		this.agentDir = harnessPath(`agent-${options.name}`);
		this.warningAllowances = options.warningAllowances ?? [];
		this.git = new VirtualGit(this.io, HARNESS_PROJECT_CWD);
		this.windowsShell = new ScriptedWindowsShellProcesses(this.io, this.shell, this.processTable);
		this.processes = new HarnessProcesses(this.git, this.windowsShell);
		this.guard = new EffectGuard(this.io, {
			sqlite: "memory",
			process: (operation, args) => this.processes.run(operation, args),
			signal: (pid, signal) => this.processTable.signal(pid, signal),
			pid: () => this.processTable.self,
			fetch: (input, init) => this.fetchResponder?.(input, init) ?? this.systemOne.fetch(input, init),
		});
		this.guard.install();
		// The installed managed uv and interpreter are provisioned once per world, after the guard, at their actual canonical paths.
		this.windowsShell.provisionInstalledRuntime(HARNESS_PROJECT_CWD);
		let provider: ScriptedProvider | undefined;
		// A failure while building the world must not leave the process-wide guard or the provider registration installed.
		try {
			// Process table of the fixture: an explicit empty /proc. Worker run environments list it to reap marked
			// processes during disposal; the fixture starts no processes, so the listing is genuinely empty.
			this.io.mkdirSync("/proc", { recursive: true });
			for (const [path, text] of Object.entries(options.files ?? {})) this.io.seed(path, text);
			if (options.repository) {
				this.git.initialize("main", options.repository.committed);
				for (const [path, text] of Object.entries(options.repository.dirty ?? {})) {
					this.io.seed(join(HARNESS_PROJECT_CWD, path), text);
				}
			}
			provider = new ScriptedProvider(`harness-${options.name}`);
			this.provider = provider;
			for (const [modelId, modelOptions] of Object.entries(options.modelOptions ?? {})) {
				provider.configureModel(modelId, modelOptions);
			}
			provider.register();
			this.authStorage = AuthStorage.inMemory({
				typesafe: { type: "api_key", key: TYPESAFE_FIXTURE_KEY },
				[HARNESS_PROVIDER]: { type: "api_key", key: HARNESS_PROVIDER_FIXTURE_KEY },
			});
			this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
			// Every scripted track is a registered, authenticated model, so workers select among them through the
			// production account catalog exactly as they would select real models.
			this.syncRegisteredModels();
			// The owner's model favorites: the router pool that delegation admits workers from is built from them.
			this.baseSettings = {
				modelFavorites: SCRIPTED_TRACKS.map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
				// These journeys exercise legacy memory and reflection; production defaults to ICM.
				memorySystem: "okf",
				...options.settings,
				systemOne: { ...options.settings?.systemOne, enabled: options.systemOneEnabled },
			};
			this.settingsManager = SettingsManager.inMemory(this.baseSettings);
		} catch (error) {
			const failures: unknown[] = [error];
			// Registration rolls back first: the guard restore must not run while a scripted track stays registered.
			try {
				provider?.rollbackRegistration();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			try {
				this.guard.dispose();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (failures.length === 1) throw error;
			throw new AggregateError(failures, "Harness world construction failed and rollback reported evidence");
		}
	}

	private syncRegisteredModels(): void {
		this.modelRegistry.registerProvider(HARNESS_PROVIDER, {
			api: HARNESS_API,
			baseUrl: "https://harness.invalid",
			apiKey: HARNESS_PROVIDER_FIXTURE_KEY,
			// Registry descriptors come from the same provider.model() the scripted requests report, so a priced or
			// window-configured track is priced identically in the catalog and on the wire.
			models: SCRIPTED_TRACKS.map((id) => {
				const { name, reasoning, defaultThinkingLevel, thinkingLevelMap, input, cost, contextWindow, maxTokens } =
					this.provider.model(id);
				return {
					id,
					name,
					reasoning,
					...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
					...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
					input,
					cost,
					contextWindow,
					maxTokens,
				};
			}),
		});
	}

	setModelReasoning(
		id: string,
		reasoning: boolean,
		thinkingLevelMap?: ReturnType<ScriptedProvider["model"]>["thinkingLevelMap"],
	): void {
		this.provider.setModelReasoning(id, reasoning, thinkingLevelMap);
		this.syncRegisteredModels();
	}

	/** Root session in normal user-facing mode, bound to the scripted root track `modelId`. */
	async createRootSession(
		modelId = "root",
		options: {
			readonly sessionManager?: SessionManager;
			readonly agentDir?: string;
			/** This session's System One mode: the world's transport and settings stay as they are; only this session's binding changes. */
			readonly systemOneEnabled?: boolean;
			/** An owner-authored host profile owns the root's model and tools; the SDK forbids a model option alongside it. */
			readonly orchestrationProfile?: OrchestrationProfile;
			/** Caller-owned tools (for example a platform bash definition) offered to this session in addition to the native set. */
			readonly customTools?: ToolDef[];
			/**
			 * Omits the world's POSIX shell operations, so the session's native platform engine runs the platform it selects. Defaults to
			 * omitted on win32 (the world's POSIX shell is not the platform shell there) and kept on POSIX hosts.
			 */
			readonly omitShellOperations?: boolean;
			/** The loop the owner selects; undefined keeps the SDK's default for this session's System One mode. */
			readonly executionLoopMode?: CreateAgentSessionOptions["executionLoopMode"];
			/**
			 * Settings of this session only, layered over the world's: the session gets its own manager, so a change it makes
			 * (a memory-system switch, a policy override) never reaches another session. A key set to `undefined` is absent
			 * in the stored settings (the in-memory store serializes through JSON), so it exercises the production default.
			 */
			readonly settings?: Partial<Settings>;
			/**
			 * Extension factories loaded into this session only: the fixture builds a DefaultResourceLoader with these factories and reloads it
			 * (a supplied loader is not reloaded by createAgentSession). Factories register their behavior on the session's own events, which
			 * fire only once the scenario binds the session (`bindExtensions`), as production modes do.
			 */
			readonly extensionFactories?: readonly ExtensionFactory[];
			/**
			 * This creation's closing sink in place of the world's warnings. `null` passes none, so a creation that fails after construction carries
			 * its held closing warnings on the failure.
			 */
			readonly closingSink?: ((warnings: readonly string[]) => void) | null;
			/**
			 * Makes this creation's extension read (`resourceLoader.getExtensions()`, the SDK's last step before it returns) throw once the IO fault
			 * named `afterFault` has fired, and counts the loader's disposal into `probe`. The fixture builds the loader the SDK would build itself.
			 */
			readonly extensionReadFailure?: {
				readonly afterFault: string;
				readonly message: string;
				readonly probe: { loaderDisposals: number };
			};
		} = {},
	): Promise<{
		session: AgentSession;
		sessionManager: SessionManager;
		settingsManager: SettingsManager;
		getExtensionRunner: CreateAgentSessionResult["getExtensionRunner"];
		extensionsResult: CreateAgentSessionResult["extensionsResult"];
	}> {
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(HARNESS_PROJECT_CWD);
		const systemOneEnabled = options.systemOneEnabled ?? this.systemOne.enabled;
		const omitShellOperations = options.omitShellOperations ?? process.platform === "win32";
		// A session that selects the other mode or its own settings gets its own settings clone; every other setting is the world's.
		const settingsManager =
			systemOneEnabled === this.systemOne.enabled && options.settings === undefined
				? this.settingsManager
				: SettingsManager.inMemory({
						...this.baseSettings,
						...options.settings,
						systemOne: {
							...this.baseSettings?.systemOne,
							...options.settings?.systemOne,
							enabled: systemOneEnabled,
						},
					});
		// The manager's previous window ends here; this binding's window begins with the intent entries the manager holds before it runs.
		const intentBefore = optionalIntentSnapshot(sessionManager);
		this.closeSystemOneWindow(sessionManager, intentBefore);
		this.systemOneWindows.set(sessionManager, { enabled: systemOneEnabled, before: intentBefore });
		const agentDir = options.agentDir ?? this.agentDir;
		// A supplied loader is not reloaded by createAgentSession, and only reload() runs the extension factories: load them here,
		// as the SDK does for the loader it builds itself. The session still has to be bound (bindExtensions) to emit session_start.
		let extensionLoader: DefaultResourceLoader | undefined;
		if (options.extensionFactories !== undefined || options.extensionReadFailure !== undefined) {
			extensionLoader = new DefaultResourceLoader({
				cwd: HARNESS_PROJECT_CWD,
				agentDir,
				settingsManager,
				extensionFactories: [...(options.extensionFactories ?? [])],
			});
			await extensionLoader.reload();
		}
		if (extensionLoader !== undefined && options.extensionReadFailure !== undefined) {
			const failure = options.extensionReadFailure;
			const readExtensions = extensionLoader.getExtensions.bind(extensionLoader);
			extensionLoader.getExtensions = () => {
				if (this.io.consumedFaults.includes(failure.afterFault)) throw new Error(failure.message);
				return readExtensions();
			};
			const disposeLoader = extensionLoader.dispose.bind(extensionLoader);
			extensionLoader.dispose = () => {
				failure.probe.loaderDisposals++;
				return disposeLoader();
			};
		}
		const { session, getExtensionRunner, extensionsResult } = await createAgentSession({
			cwd: HARNESS_PROJECT_CWD,
			agentDir,
			// Closing warnings (a session's terminal disclosures) reach the world's warnings, not the process's stderr, unless the creation
			// supplies its own sink (`null`: none).
			onClosingWarnings:
				options.closingSink === undefined
					? (warnings) => this.warnings.push(...warnings)
					: (options.closingSink ?? undefined),
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			settingsManager,
			sessionManager,
			...(extensionLoader === undefined ? {} : { resourceLoader: extensionLoader }),
			...(options.executionLoopMode === undefined ? {} : { executionLoopMode: options.executionLoopMode }),
			...(options.orchestrationProfile === undefined
				? { model: this.provider.model(modelId) }
				: { orchestrationProfile: options.orchestrationProfile }),
			// Worker tracks are admitted through the router pool: with routing on, delegation accepts only pool members.
			routerPool: {
				source: "sdk_models",
				models: SCRIPTED_TRACKS.map((id) => ({ model: this.provider.model(id) })),
			},
			systemOneFetch: this.systemOne.fetch,
			historyTimeSource: this.historyClock,
			systemOneEnabled,
			...(omitShellOperations ? {} : { shellOperations: this.shell }),
			customTools: options.customTools,
			// Worktree-sync git runs against the same stateful repository the SDK's own git reads see.
			worktreeSyncEnginePorts: {
				// Git runs against the virtual repository; the engine's sh/cmd gate commands run through the scripted shell port.
				exec: (command, args, options) =>
					command === "git"
						? this.git.exec(command, args, options)
						: this.shell.execEngine(command, args, options),
				isPidAlive: (pid) => this.processTable.isAlive(pid),
				pid: this.processTable.self,
			},
		});
		// Caller observation of production operations only: each native method runs unchanged, and its promise (preflight and tail
		// included) is what close joins. Test synchronization gates are never tracked.
		const trace = this.trace;
		// Internal turns (reflection) are returned untouched: their lifecycle owns cancellation and catches it. Only owner work is tracked.
		const prompt = session.prompt.bind(session);
		session.prompt = (...args: Parameters<AgentSession["prompt"]>) => {
			const work = prompt(...args);
			return args[1]?.internalContextType === undefined ? trace.track(work) : work;
		};
		const compact = session.compact.bind(session);
		session.compact = (...args: Parameters<AgentSession["compact"]>) => trace.track(compact(...args));
		const executeBash = session.executeBash.bind(session);
		session.executeBash = (...args: Parameters<AgentSession["executeBash"]>) => trace.track(executeBash(...args));
		const continueGoalLoop = session.continueGoalLoop.bind(session);
		session.continueGoalLoop = (...args: Parameters<AgentSession["continueGoalLoop"]>) =>
			trace.track(continueGoalLoop(...args));
		// Navigation stays tracked: its own exact abort resolves as a cancelled result, so a rejection is unexpected and must reach close.
		const navigateTree = session.navigateTree.bind(session);
		session.navigateTree = (...args: Parameters<AgentSession["navigateTree"]>) => trace.track(navigateTree(...args));
		const runIsolatedCompletion = session.runIsolatedCompletion.bind(session);
		session.runIsolatedCompletion = (...args: Parameters<AgentSession["runIsolatedCompletion"]>) =>
			this.recordIsolatedCompletion(trace.observe(runIsolatedCompletion(...args)));
		this.warningSubscriptions.push(
			session.subscribe((event) => {
				if (event.type === "warning") this.warnings.push(event.message);
			}),
		);
		this.everySession.push(session);
		this.everySessionManager.push(sessionManager);
		this.sessions.push(session);
		if ((session.systemOneController !== undefined) !== systemOneEnabled) {
			throw new Error(`System One ${systemOneEnabled ? "on" : "off"} session binding mismatch`);
		}
		return { session, sessionManager, settingsManager, getExtensionRunner, extensionsResult };
	}

	/** A file-backed session manager; its session file is written to the virtual tree on the first reply. */
	createSessionManager(agentDir = this.agentDir): SessionManager {
		return SessionManager.create(HARNESS_PROJECT_CWD, agentDir);
	}

	/** Reopens a session file written earlier in this world, as its owner would after a restart. */
	openSessionManager(file: string, agentDir = this.agentDir): SessionManager {
		return SessionManager.open(file, agentDir);
	}

	/** Reads a descriptor the scenario opened earlier: a positional read sees the node the descriptor was opened on. */
	readDescriptorText(descriptor: number, length: number): string {
		const filesystem = this.io.nodeFsExports() as {
			readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
		};
		const buffer = Buffer.alloc(length);
		return buffer.subarray(0, filesystem.readSync(descriptor, buffer, 0, length, 0)).toString("utf8");
	}

	/** Closes a descriptor the scenario opened. */
	closeDescriptor(descriptor: number): void {
		const filesystem = this.io.nodeFsExports() as { closeSync(fd: number): void };
		filesystem.closeSync(descriptor);
	}

	/**
	 * Disposes one session inside the scenario body and takes its settlement out of the close list, so the body
	 * asserts exactly what this disposal rejected with. Resolves to the rejection, or undefined when it completed.
	 */
	private recordIsolatedCompletion<T>(completion: Promise<T>): Promise<T> {
		this.isolatedCompletions.push(completion);
		return completion;
	}

	async disposeSessionInBody(session: AgentSession): Promise<{ readonly error: unknown } | undefined> {
		if (!this.sessions.includes(session)) throw new Error("Session is not owned by this world");
		// Each disposal step is its own attempt: a failed abort or wait never skips the disposal. Ownership leaves the world only
		// after every step has been attempted, so a failure can never drop a session that is still running.
		const failures: unknown[] = [];
		const attempt = async (step: () => unknown): Promise<void> => {
			try {
				await step();
			} catch (error) {
				failures.push(error);
			}
		};
		try {
			await attempt(() => session.abort("session disposed in the scenario body"));
			await attempt(() => session.waitForForegroundIdle());
			await attempt(() => session.disposeAndWait());
		} finally {
			const index = this.sessions.indexOf(session);
			if (index >= 0) this.sessions.splice(index, 1);
		}
		if (failures.length === 0) return undefined;
		return {
			error:
				failures.length === 1 ? failures[0] : new AggregateError(failures, "Session disposal in the body failed"),
		};
	}

	/**
	 * Certify an owner this world disposed, at the boundary before any cutback. The receipt is read here from the owner itself: it
	 * must already have left the active list, carry a worker snapshot, keep exactly the predeclared claims, and leave every other
	 * resource settled. Close checks the stored receipt and never reads the disposed owner again.
	 */
	certifyDisposedOwner(
		session: AgentSession,
		expectedClaims: WorkerProjectClaims,
		expectedRetention: {
			readonly leases?: readonly WorkerWriteReservationLease[];
			readonly executingHolds?: readonly { readonly agentId: string; readonly count: number }[];
			readonly watchCount?: number;
			readonly laneAbortControllers?: number;
		} = {},
	): void {
		if (!this.everySession.includes(session)) throw new Error("the certified owner was not created by this world");
		if (this.sessions.includes(session)) throw new Error("the certified owner is still active; dispose it first");
		if (this.retainedDisposals.has(session)) throw new Error("the certified owner already has a disposal receipt");
		const snapshot = session.getResourceSnapshot();
		const expectation: CertifiedOwnerRetention = {
			claims: expectedClaims,
			leases: expectedRetention.leases ?? [],
			executingHolds: expectedRetention.executingHolds ?? [],
			watchCount: expectedRetention.watchCount ?? 0,
			laneAbortControllers: expectedRetention.laneAbortControllers ?? 0,
		};
		assertCertifiedOwnerRetention(snapshot, expectation, "disposed owner receipt");
		this.retainedDisposals.set(session, {
			snapshot: structuredClone(snapshot),
			expectation: structuredClone(expectation),
		});
	}

	/** Ends a manager's open System One window. An off window keeps the intent entries it began with, byte for byte, and adds none. */
	private closeSystemOneWindow(manager: SessionManager, now: ReadonlyMap<string, string>): void {
		const window = this.systemOneWindows.get(manager);
		if (window === undefined || window.enabled) return;
		for (const [id, bytes] of window.before) {
			if (now.get(id) !== bytes)
				this.systemOneWindowFailures.push(`optional intent ${id} changed while System One was off`);
		}
		for (const id of now.keys()) {
			if (!window.before.has(id))
				this.systemOneWindowFailures.push(`optional intent ${id} was created while System One was off`);
		}
	}

	/**
	 * Ordered settlement, run after the scenario body: every session is disposed and awaited, the scripted
	 * provider is closed, resources and escapes are asserted, and only then is the effect guard restored, so
	 * asynchronous production cleanup never runs outside the mock boundary. Cleanup failures are never
	 * swallowed: a body failure is rethrown with cleanup evidence attached when both failed.
	 */
	async close(body: { readonly error: unknown } | undefined): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		// Every failure is kept, and every cleanup step is attempted: a failed step never skips the step after it.
		const failures: unknown[] = body === undefined ? [] : [body.error];
		const attempt = (step: () => unknown): void => {
			try {
				step();
			} catch (error) {
				failures.push(error);
			}
		};
		const attemptAsync = async (step: () => Promise<unknown>): Promise<void> => {
			try {
				await step();
			} catch (error) {
				failures.push(error);
			}
		};
		try {
			// A scenario hold still pending is released first, so no owner's disposal waits on a gate; each one is reported at the checks.
			attempt(() => this.io.cutoffHolds());
			attempt(() => this.guard.threads.cutoffHolds());
			// Cutoff: every session's root, compaction, summary and bash work is aborted without awaiting the abort; the provider then cancels
			// its uncooperative producers; only then are the cutoffs awaited and the tracked owner work joined.
			const cutoffs: Array<Promise<void>> = [];
			for (const session of this.sessions) {
				attempt(() => cutoffs.push(session.abort("harness world closed")));
				attempt(() => session.abortCompaction());
				attempt(() => session.abortBranchSummary());
				attempt(() => session.abortBash());
			}
			attempt(() => this.provider.cancelPending());
			for (const cutoff of cutoffs) await attemptAsync(() => cutoff);
			await attemptAsync(async () => {
				for (const error of await this.trace.join()) {
					if (error !== body?.error) failures.push(error);
				}
			});
			// Each session's foreground settlement and disposal are separate attempts: a failed wait never skips the disposal.
			for (const session of this.sessions) {
				await attemptAsync(() => session.waitForForegroundIdle());
				await attemptAsync(() => session.disposeAndWait());
			}
			await attemptAsync(() => this.guard.retireHttpDispatchers());
			for (const unsubscribe of this.warningSubscriptions) attempt(unsubscribe);
			await attemptAsync(() => this.provider.dispose());
			await attemptAsync(() => this.humanInput.dispose());
			await attemptAsync(() => this.shell.dispose());
			await attemptAsync(() => this.processes.drain());
			attempt(() => this.windowsShell.assertDrained());
			await attemptAsync(() => this.windowsShell.disposeAndWait());
			const checks: Array<() => void> = [
				() => this.provider.assertDrained(),
				() => this.shell.assertDrained(),
				() => this.humanInput.assertDrained(),
				() => this.io.assertNoOpenResources(),
				// Application connections must be released by their owners after the sessions above are disposed.
				() => this.guard.assertNoOpenSqliteHandles(),
				// Every started worker thread must have been terminated or closed by its owner, and every scripted intercept reached.
				() => this.guard.assertWorkersSettled(),
				() => this.processTable.assertClean(),
				() => this.io.assertFaultsConsumed(),
				() => this.guard.assertSqliteFaultsConsumed(),
				() => this.guard.assertNoEscapes(),
				() => {
					if (this.processes.unscripted.length)
						throw new Error(`Unscripted processes: ${this.processes.unscripted.join("; ")}`);
				},
				() => {
					if (this.systemOne.unscripted.length)
						throw new Error(`Unscripted judgment requests: ${this.systemOne.unscripted.join("; ")}`);
				},
				() => this.systemOne.assertConsumed(),
				() => this.systemOne.assertInFlightSettled(),
				() => {
					if (this.git.unscripted.length)
						throw new Error(`Unscripted git commands: ${this.git.unscripted.join("; ")}`);
				},
				() => {
					const unclassified = this.warnings.filter(
						(message) => !this.warningAllowances.some((pattern) => pattern.test(message)),
					);
					if (unclassified.length > 0) throw new Error(`Unclassified warnings: ${JSON.stringify(unclassified)}`);
				},
			];
			// Each manager's last window ends at close; no binding after it can extend it. Off windows report through the failure list.
			for (const manager of this.systemOneWindows.keys()) {
				this.closeSystemOneWindow(manager, optionalIntentSnapshot(manager));
			}
			attempt(() => {
				// An off window keeps the intent entries of its baseline byte for byte, and no native turn inside it may add an intent entry.
				if (this.systemOneWindowFailures.length > 0) throw new Error(this.systemOneWindowFailures.join("; "));
			});
			this.everySession.forEach((session, index) => {
				const retained = this.retainedDisposals.get(session);
				if (retained === undefined)
					attempt(() => assertResourcesSettled(session.getResourceSnapshot(), `session ${index}`));
				else
					attempt(() => {
						assertCertifiedOwnerRetention(
							retained.snapshot,
							retained.expectation,
							`session ${index} disposal certificate`,
						);
					});
			});
			this.everySessionManager.forEach((manager, index) => {
				attempt(() => {
					const pending = getResumableHumanInputSnapshot(manager);
					if (pending !== undefined) {
						throw new Error(`session ${index} still has a pending native human input: ${pending.status}`);
					}
				});
			});
			attempt(() => {
				const { asked, inFlight, settled } = this.externalConfirmations;
				if (inFlight !== 0 || settled !== asked) {
					throw new Error(
						`external approval callbacks not settled: asked ${asked}, settled ${settled}, in flight ${inFlight}`,
					);
				}
			});
			for (const check of checks) attempt(check);
		} finally {
			// Guard restore runs after every cleanup step and classification; its own failure joins the evidence.
			try {
				this.guard.dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Harness journey failed and cleanup reported evidence");
	}
}

/**
 * An extension that holds the summary it returns from `session_before_compact` until `hold` is released. `reached` is released when the
 * compaction reaches the handler, so the scenario can quit while the compaction is still in its handler.
 */
export function holdCompactionSummary(hold: Barrier, reached: Barrier): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event) => {
			reached.release();
			await hold.promise;
			return {
				compaction: {
					summary: "The held summary.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};
}

/**
 * An extension that holds the run at the assistant's message end until `hold` is released. `reached` is released when the assistant's
 * message reaches the handler; the user's own message end passes straight through. With `replyText`, only the reply carrying that text
 * is held, so an earlier seed turn in the same session passes through.
 */
export function holdAssistantMessageEnd(hold: Barrier, reached: Barrier, replyText?: string): ExtensionFactory {
	return (pi) => {
		pi.on("message_end", async (event) => {
			if (event.message.role !== "assistant") return;
			if (
				replyText !== undefined &&
				!event.message.content.some((block) => block.type === "text" && block.text === replyText)
			)
				return;
			reached.release();
			await hold.promise;
		});
	};
}

/** The closing verification notice System One's own closing work emits; the compaction witnesses do not judge it. */
const CLOSING_VERIFICATION_NOTICE =
	"System One verification was not run because the session was closing; no judgment was recorded.";

interface SessionFileEntry {
	readonly type?: string;
	readonly outcome?: string;
}

function sessionFileEntries(text: string): SessionFileEntry[] {
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as SessionFileEntry);
}

/** The compaction lifecycle records of a session file, in file order. */
function compactionLifecycle(text: string): Array<{ readonly type: string; readonly outcome: string | undefined }> {
	const records: Array<{ readonly type: string; readonly outcome: string | undefined }> = [];
	for (const entry of sessionFileEntries(text)) {
		if (entry.type === "compaction_start" || entry.type === "compaction_end")
			records.push({ type: entry.type, outcome: entry.outcome });
	}
	return records;
}

/**
 * What a compaction behind a held run leaves in the session file, and what the quit and the release each report. `quitWarnings` excludes
 * the closing verification notice; `control` is the normal order, where the run completes before the compaction commits.
 */
export interface CompactionBehindHeldRunWitness {
	readonly subscriptionsAfterQuit: number;
	readonly retentionEligiblePairs: number;
	readonly planningRequestsAfterQuit: number;
	readonly inFlightAtStart: boolean;
	readonly quitWarnings: readonly string[];
	readonly warningsAfterRelease: readonly string[];
	readonly heldOutcome: unknown;
	readonly heldRunOutcome: unknown;
	readonly fileAtQuit: string;
	readonly fileAfterRelease: string;
	readonly lifecycleAfterRelease: ReturnType<typeof compactionLifecycle>;
	readonly requestsAtQuit: number;
	readonly requestsAfterRelease: number;
	readonly control: {
		readonly reconnectSubscriptions: number;
		readonly retentionPlanningReached: boolean;
		readonly disposal: unknown;
		readonly summary: string;
		readonly lifecycle: ReturnType<typeof compactionLifecycle>;
		readonly compactionEntries: number;
		readonly quitWarnings: readonly string[];
	};
}

/**
 * Quit while a compaction waits behind a run held at the assistant's message end. `compact()` awaits `abortForeground` (the run going
 * idle), so it never reaches its durable lifecycle start: the quit settles the run and the compaction at their bounds, and the release
 * resumes the compaction into the closed owner, which rejects it. The control releases nothing and commits once.
 */
export async function runCompactionBehindHeldRun(world: HarnessWorld): Promise<CompactionBehindHeldRunWitness> {
	const { trace } = world;
	const replyText = "The late reply";
	const hold = createBarrier();
	const reached = createBarrier();
	const held = await world.createRootSession("root", {
		sessionManager: seedCompactionRetentionHistory(world, "held"),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdAssistantMessageEnd(hold, reached, replyText)],
	});
	const heldSession = held.session;
	let quitSettled = false;
	let subscriptionsAfterQuit = 0;
	const subscribeHeld = heldSession.agent.subscribe.bind(heldSession.agent);
	heldSession.agent.subscribe = (...args: Parameters<typeof heldSession.agent.subscribe>) => {
		if (quitSettled) subscriptionsAfterQuit++;
		return subscribeHeld(...args);
	};
	await heldSession.bindExtensions({ uiContext: world.humanInput.ui });
	const heldFile = held.sessionManager.getSessionFile();
	if (heldFile === undefined) throw new Error("the held compaction owner has no file");
	const retentionEligiblePairs =
		collectToolCallResultPairs(held.sessionManager.getBranch()).length - resolvePreserveRecentPairs();
	if (retentionEligiblePairs !== 1)
		throw new Error("held compaction history did not reach one unpinned retention candidate");
	// Compaction needs history, so the owner first completes one plain turn; only the second reply is held.
	world.provider.enqueue(
		"root",
		{ name: "pre-start-seed", reply: { content: [{ type: "text", text: "Seeded before the held run." }] } },
		{ name: "pre-start-held", reply: { content: [{ type: "text", text: replyText }] } },
	);
	await withDeadline(
		trace,
		"pre-start: the seed turn completes",
		heldSession.prompt("Seed the pre-start compaction."),
	);
	// The second submission settles the owner words the seed turn left (a turn that used no tool): the carries_0 screen and the full owner-policy classification that follows it, scripted here.
	if (world.systemOne.enabled) {
		world.systemOne.enterPhase("pre-start-backlog", {
			carries_0: { kind: "noul", probability: 0.02 },
			changes_model_pools: { kind: "noul", probability: 0.02 },
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		});
	}
	const heldRun = heldSession
		.prompt("Start a reply that its extension holds at message end.")
		.catch((error: unknown) => error);
	await withDeadline(trace, "pre-start: the extension holds the reply", reached.promise);
	const compaction = heldSession.compact("Compact the held history.").catch((error: unknown) => error);
	const inFlightAtStart = heldSession.isCompacting;
	const mark = world.warnings.length;
	let fileAtQuit = "";
	let requestsAtQuit = 0;
	let quitWarnings: string[] = [];
	let planningMarkAtQuit = 0;
	let heldOutcome: unknown = "unsettled";
	let heldRunOutcome: unknown = "unsettled";
	try {
		await withDeadline(
			trace,
			"pre-start: the owner disposes while the reply is held",
			heldSession.disposeAndWait(),
			60_000,
		);
		fileAtQuit = world.io.peekFile(heldFile) ?? "";
		quitSettled = true;
		planningMarkAtQuit = world.systemOne.decoded.length;
		requestsAtQuit = world.provider.requests.length;
		quitWarnings = world.warnings.slice(mark).filter((message) => message !== CLOSING_VERIFICATION_NOTICE);
	} finally {
		hold.release();
		heldOutcome = await withDeadline(trace, "pre-start: the held compaction resumes", compaction, 60_000);
		heldRunOutcome = await withDeadline(trace, "pre-start: the held run ends", heldRun, 60_000);
	}
	const fileAfterRelease = world.io.peekFile(heldFile) ?? "";
	const requestsAfterRelease = world.provider.requests.length;
	const warningsAfterRelease = world.warnings.slice(mark).filter((message) => message !== CLOSING_VERIFICATION_NOTICE);
	const planningRequestsAfterQuit = world.systemOne.decoded
		.slice(planningMarkAtQuit)
		.filter((request) =>
			Object.keys(request.questions).some((id) => id.startsWith("keep_call::") || id.startsWith("keep_result::")),
		).length;
	if (planningRequestsAfterQuit !== 0) throw new Error("closed compaction started paid evidence retention planning");

	// Normal order: the run completes, then the compaction commits through the same handler and the owner disposes with nothing in flight.
	const released = createBarrier();
	released.release();
	const control = await world.createRootSession("root", {
		sessionManager: seedCompactionRetentionHistory(world, "control"),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdCompactionSummary(released, createBarrier())],
	});
	const controlSession = control.session;
	await controlSession.bindExtensions({ uiContext: world.humanInput.ui });
	const controlFile = control.sessionManager.getSessionFile();
	if (controlFile === undefined) throw new Error("the normal-order control owner has no file");
	world.provider.enqueue("root", {
		name: "pre-start-control-seed",
		reply: { content: [{ type: "text", text: "Seeded before the control compaction." }] },
	});
	await withDeadline(
		trace,
		"pre-start control: the run completes first",
		controlSession.prompt("Seed the control compaction."),
	);
	const controlMark = world.warnings.length;
	const controlPlanningMark = world.systemOne.decoded.length;
	let reconnectSubscriptions = 0;
	const subscribeControl = controlSession.agent.subscribe.bind(controlSession.agent);
	controlSession.agent.subscribe = (...args: Parameters<typeof controlSession.agent.subscribe>) => {
		reconnectSubscriptions++;
		return subscribeControl(...args);
	};
	const committed = await world.systemOne.withQuestionFamilies(
		{ "keep_call::": { kind: "noul", probability: 0.97 }, "keep_result::": { kind: "noul", probability: 0.97 } },
		() =>
			withDeadline(
				trace,
				"pre-start control: the compaction commits",
				controlSession.compact("Compact the control history."),
			),
	);
	const retentionPlanningReached = world.systemOne.decoded
		.slice(controlPlanningMark)
		.some(
			(request) =>
				"keep_call::pre-start-control-0" in request.questions &&
				"keep_result::pre-start-control-0" in request.questions,
		);
	if (world.systemOne.enabled && !retentionPlanningReached)
		throw new Error("live compaction control never reached eligible retention planning");
	if (subscriptionsAfterQuit !== 0 || reconnectSubscriptions !== 1) {
		throw new Error(
			`compaction consumer subscription boundary disagrees: after quit ${subscriptionsAfterQuit}, live control ${reconnectSubscriptions}`,
		);
	}
	heldSession.agent.subscribe = subscribeHeld;
	controlSession.agent.subscribe = subscribeControl;
	const disposal = await world.disposeSessionInBody(controlSession);
	const controlText = world.io.peekFile(controlFile) ?? "";
	return {
		subscriptionsAfterQuit,
		retentionEligiblePairs,
		planningRequestsAfterQuit,
		inFlightAtStart,
		quitWarnings,
		warningsAfterRelease,
		heldOutcome,
		heldRunOutcome,
		fileAtQuit,
		fileAfterRelease,
		lifecycleAfterRelease: compactionLifecycle(fileAfterRelease),
		requestsAtQuit,
		requestsAfterRelease,
		control: {
			reconnectSubscriptions,
			retentionPlanningReached,
			disposal,
			summary: committed.summary,
			lifecycle: compactionLifecycle(controlText),
			compactionEntries: sessionFileEntries(controlText).filter((entry) => entry.type === "compaction").length,
			quitWarnings: world.warnings.slice(controlMark).filter((message) => message !== CLOSING_VERIFICATION_NOTICE),
		},
	};
}

/** Canonical archived tool history: thirteen successful unpinned pairs exceed the unchanged twelve-pair recency floor. */
function seedCompactionRetentionHistory(world: HarnessWorld, lane: "held" | "control"): SessionManager {
	const manager = world.createSessionManager();
	const model = world.provider.model("root");
	const calls = Array.from({ length: 13 }, (_, index) => ({
		type: "toolCall" as const,
		id: `pre-start-${lane}-${index}`,
		name: "read",
		arguments: { path: projectPath(`archived-${index}.txt`) },
	}));
	manager.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: calls,
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	for (const call of calls)
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: `Archived read result ${call.id}.` }],
			isError: false,
			timestamp: Date.now(),
		});
	const pairs = collectToolCallResultPairs(manager.getBranch());
	if (pairs.length !== 13 || pairs.some((pair) => pair.hasError || pair.isProofObligation))
		throw new Error("archived retention history is not thirteen complete eligible tool pairs");
	return manager;
}

/**
 * What a refused `compaction_end` append leaves in the session file at the quit, and what the quit and the release each report. `quitWarnings`
 * excludes the closing verification notice; `outcome` is the compaction's settled result after the release.
 */
export interface CompactionCloseRefusalWitness {
	/** The session file's resolved path, the path the scripted IO fault names. */
	readonly file: string;
	readonly quitWarnings: readonly string[];
	/** The compaction's rejection, claimed by the journey (its message is the check). */
	readonly outcome: unknown;
	readonly lifecycleAtQuit: ReturnType<typeof compactionLifecycle>;
	/** The release appended no byte, disclosed nothing and made no provider request. */
	readonly fileUnchanged: boolean;
	readonly warningsUnchanged: boolean;
	readonly requestsUnchanged: boolean;
}

/**
 * Quit while a manual compaction waits in its held `session_before_compact` handler, with the durable `compaction_end` append refused. The
 * close's terminal write fails before anything reaches the file: the dispose holds that failure as a closing disclosure, ahead of the bounded
 * settle of the held compaction, and still resolves. The release resumes the compaction into the closed owner, which rejects it with no write.
 */
export async function runCompactionCloseAppendRefused(world: HarnessWorld): Promise<CompactionCloseRefusalWitness> {
	const { trace } = world;
	const hold = createBarrier();
	const reached = createBarrier();
	const owner = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdCompactionSummary(hold, reached)],
	});
	const session = owner.session;
	await session.bindExtensions({ uiContext: world.humanInput.ui });
	const sessionFile = owner.sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("the refused compaction owner has no file");
	const file = resolve(sessionFile);
	// Compaction needs history, so the owner first completes one plain turn.
	world.provider.enqueue("root", {
		name: "compaction-refusal-seed",
		reply: { content: [{ type: "text", text: "Seeded before the refused compaction." }] },
	});
	await withDeadline(
		trace,
		"compaction refusal: the seed turn completes",
		session.prompt("Seed the refused compaction."),
	);
	const compaction = session.compact("Compact the seeded history.").catch((error: unknown) => error);
	await withDeadline(trace, "compaction refusal: the extension holds the summary", reached.promise);
	// Only the terminal record is refused: the start record was appended before the handler, and the write is refused before any byte lands.
	world.io.failNext({
		name: "compaction-end-refused",
		kind: "append",
		code: "EIO",
		matches: (operation, data) => operation.path === file && data?.includes('"type":"compaction_end"') === true,
	});
	const mark = world.warnings.length;
	let fileAtQuit = "";
	let requestsAtQuit = 0;
	let quitWarnings: string[] = [];
	let outcome: unknown = "unsettled";
	try {
		await withDeadline(
			trace,
			"compaction refusal: the owner disposes while the summary is held",
			session.disposeAndWait(),
			60_000,
		);
		fileAtQuit = world.io.peekFile(sessionFile) ?? "";
		requestsAtQuit = world.provider.requests.length;
		quitWarnings = warningsSince(world, mark);
	} finally {
		hold.release();
		outcome = await withDeadline(trace, "compaction refusal: the held summary resumes", compaction, 60_000);
	}
	const fileAfterRelease = world.io.peekFile(sessionFile) ?? "";
	return {
		file,
		quitWarnings,
		outcome,
		lifecycleAtQuit: compactionLifecycle(fileAtQuit),
		fileUnchanged: fileAfterRelease === fileAtQuit,
		warningsUnchanged: isDeepStrictEqual(warningsSince(world, mark), quitWarnings),
		requestsUnchanged: world.provider.requests.length === requestsAtQuit,
	};
}

/**
 * The bounded paid-row count of a discarded replacement's file, on a real session file. Each bound alone refuses the count with its cause;
 * the defaults count every paid row the file holds. Throws unless the appended rows are on disk.
 */
export interface DiscardScanBoundsWitness {
	readonly entriesBound: unknown;
	readonly paidRowsBound: unknown;
	readonly scanBytesBound: unknown;
	readonly defaults: unknown;
	readonly disposal: unknown;
}

/**
 * A session file of this world with three paid usage rows, read by the discard count as a replacement's file whose copied rows end at byte 0.
 * The seed turn gives the file its first reply, so the rows that follow are written to disk rather than buffered.
 */
export async function runDiscardScanBounds(world: HarnessWorld): Promise<DiscardScanBoundsWitness> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-discard-scan`;
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: { memorySystem: "okf" },
	});
	world.provider.enqueue("root", {
		name: "discard-scan-seed",
		reply: { content: [{ type: "text", text: "Seeded for the discard scan." }] },
	});
	await withDeadline(trace, "discard scan: the seed turn completes", owner.session.prompt("Seed the discard scan."));
	const reports = [1, 2, 3].map((index) => ({ reportId: `discard-scan-row-${index}` }));
	const ids = reports.map((report) => owner.sessionManager.appendCustomEntry(SEMANTIC_USAGE_CUSTOM_TYPE, report));
	const persisted = ids.map((id, index) =>
		classifyCustomEntryPersisted(owner.sessionManager, id, SEMANTIC_USAGE_CUSTOM_TYPE, (data) =>
			isDeepStrictEqual(data, reports[index]),
		),
	);
	if (persisted.some((state) => state !== "persisted"))
		throw new Error(`the discard scan rows are not on disk: ${persisted.join(", ")}`);
	const disposal = await world.disposeSessionInBody(owner.session);
	// The count runs after the owner shuts down, as a discard's does; the copied rows end at byte 0, so every paid row is the candidate's.
	const created = { sessionManager: owner.sessionManager, copyBaseline: { bytes: 0 } };
	const bounded = (limits: Partial<typeof DEFAULT_DISCARD_SCAN_LIMITS>) =>
		countUniquePaidRows(created, { ...DEFAULT_DISCARD_SCAN_LIMITS, ...limits });
	return {
		entriesBound: bounded({ entries: 1 }),
		paidRowsBound: bounded({ paidRows: 1 }),
		scanBytesBound: bounded({ scanBytes: 1 }),
		defaults: countUniquePaidRows(created),
		disposal,
	};
}

/** The exhaustion causes of a discard's count, each bound alone, and the defaults' count of the same three rows. */
export const DISCARD_SCAN_BOUNDS_EXPECTED = {
	entriesBound: { unknown: "more than 1 entries" },
	paidRowsBound: { unknown: "more than 1 paid usage rows" },
	scanBytesBound: { unknown: "more than 1 bytes appended after the copy" },
	defaults: { rows: 3 },
	disposal: undefined,
};

/** A replacement the runtime rejected at activation, and what its rollback kept and disclosed. */
export interface DiscardThroughRuntimeWitness {
	/** The rejection as the host reads it: the activation failure, and that the previous session was restored. */
	readonly rejection: string;
	readonly candidateFile: string | undefined;
	/** The candidate's file after the rollback: kept, because its paid rows could not be counted. */
	readonly candidateKept: boolean;
	/** The rollback's disclosure, delivered on the restored session once it is live. */
	readonly restoredWarnings: readonly string[];
	/** Warnings the runtime routed to its terminal; a restored rollback routes none. */
	readonly routed: readonly string[];
}

/**
 * A fork of a session's paid rows, rejected at activation. The rollback shuts the candidate down, counts its paid rows with the real offset
 * scan, and that scan's read of the candidate's file is refused: the file is kept, and the disclosure travels with the restored session.
 */
export async function runDiscardThroughRuntime(world: HarnessWorld): Promise<DiscardThroughRuntimeWitness> {
	const { trace } = world;
	const routed: string[] = [];
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager }) => {
			const root = await world.createRootSession("root", {
				agentDir,
				sessionManager,
				settings: { memorySystem: "okf" },
			});
			return {
				session: root.session,
				sessionManager: root.sessionManager,
				getExtensionRunner: root.getExtensionRunner,
				extensionsResult: root.extensionsResult,
				services: {
					cwd,
					agentDir,
					authStorage: world.authStorage,
					settingsManager: root.settingsManager,
					modelRegistry: world.modelRegistry,
					resourceLoader: root.session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		},
		{
			cwd: HARNESS_PROJECT_CWD,
			agentDir: world.agentDir,
			sessionManager: world.createSessionManager(),
			onTerminalWarnings: (warnings) => {
				routed.push(...warnings);
			},
		},
	);
	world.provider.enqueue("root", {
		name: "runtime-discard-seed",
		reply: { content: [{ type: "text", text: "Seeded for the runtime discard." }] },
	});
	await withDeadline(
		trace,
		"runtime discard: the seed turn completes",
		runtime.session.prompt("Seed the runtime discard."),
	);
	const manager = runtime.sessionManager;
	const originalFile = manager.getSessionFile();
	if (originalFile === undefined) throw new Error("the runtime discard owner has no file");
	const rows = [1, 2].map((index) =>
		manager.appendCustomEntry(SEMANTIC_USAGE_CUSTOM_TYPE, { reportId: `runtime-discard-row-${index}` }),
	);
	const forkAt = rows.at(-1);
	if (forkAt === undefined) throw new Error("the runtime discard has no paid row to fork at");
	// Only the candidate's activation is refused; the restored session (the original file) activates normally.
	const candidate: { file?: string } = {};
	runtime.setRebindSession(async (session) => {
		const file = session.sessionFile;
		if (file === undefined || file === originalFile) return;
		candidate.file = file;
		// The rollback's offset scan reads the candidate's file after the candidate is shut down: that read is the one refused.
		world.io.failNext({
			name: "runtime-discard-scan-read",
			kind: "read",
			code: "EIO",
			matches: (operation) => operation.path === resolve(file),
		});
		throw new Error("the candidate's activation is refused");
	});
	const warningMark = world.warnings.length;
	const outcome = await withDeadline(
		trace,
		"runtime discard: the fork is rejected",
		runtime.fork(forkAt, { position: "at" }),
		60_000,
	).then(
		() => "resolved",
		(error: unknown) => error,
	);
	// The rollback's disclosure is emitted on the live restored session, so the world's session listener already received it: the witness
	// claims exactly that window (and anything the session still holds), leaving none of it for the unclassified-warning check.
	const restoredWarnings = [...world.warnings.splice(warningMark), ...runtime.session.takeUndeliveredWarnings()];
	const candidateKept = candidate.file !== undefined && world.io.peekFile(candidate.file) !== undefined;
	await runtime.dispose();
	return {
		rejection: outcome instanceof Error ? outcome.message : String(outcome),
		candidateFile: candidate.file,
		candidateKept,
		restoredWarnings,
		routed,
	};
}

/** A creation's failure as the caller receives it: the message, and the cause the SDK chained onto it when there is one. */
export interface SdkFailureDescription {
	readonly message: string;
	readonly cause?: {
		readonly name: string;
		readonly message: string;
		readonly errors?: readonly SdkErrorDescription[];
	};
}

/** One error of a cause: its text, or the aggregate it wraps (the context-storage cleanup wraps the scripted IO fault). */
export type SdkErrorDescription =
	| string
	| { readonly name: string; readonly message: string; readonly errors: readonly SdkErrorDescription[] };

/** One creation the SDK constructs and then fails in its extension read, with a memory warning held on the constructed session. */
export interface SdkConstructionFailureOutcome {
	readonly failure: SdkFailureDescription;
	/** Every closing sink call the SDK made, in order. */
	readonly sinkCalls: readonly (readonly string[])[];
	/** Disposals of the creation's resource loader: the failed session's disposal reached its resource release. */
	readonly loaderDisposals: number;
	/** The memory read that holds the warning fired, so the warning comes from this creation's own memory initialization. */
	readonly memoryFaultFired: boolean;
	/** Warnings that reached the world's own list: none, since every warning goes to the sink or rides the failure. */
	readonly worldWarnings: readonly string[];
}

/** One creation whose disposal also fails on the tool-artifact store cleanup, with the seeded artifact's files before and after the disposal. */
export interface SdkDisposalFailureOutcome {
	readonly failure: SdkFailureDescription;
	/** Disposals of the creation's resource loader: the disposal still reaches the loader after the cleanup failed. */
	readonly loaderDisposals: number;
	/** The memory read that holds the warning fired, so the warning comes from this creation's own memory initialization. */
	readonly memoryFaultFired: boolean;
	/** Warnings that reached the world's own list: none, since the warning rides the failure (no sink). */
	readonly worldWarnings: readonly string[];
	/** Files under the session's artifact store: the seeded artifact, then what the disposal left there. */
	readonly artifactFiles: { readonly seeded: number; readonly afterDisposal: number };
	/** The scripted lease write fired: the cleanup failed before its scan. */
	readonly cleanupFaultFired: boolean;
}

/**
 * The SDK's closing-warning routing on a failed construction, beside the objective-loop binding error and its normal-order control. The
 * work-directory witnesses that follow the disposal branches share this chain so the journey's one assertion covers them.
 */
export interface SdkConstructionFailureWitness {
	/** The objective-loop creation: the binding error, and no held warning (the rejection precedes memory initialization). */
	readonly objective: { readonly failure: string; readonly warnings: readonly string[] };
	/** The held warning reaches a sink that accepts it: the failure is the extension read's own error. */
	readonly drained: SdkConstructionFailureOutcome;
	/** The sink refuses the warning: it rides the failure, and the sink's error joins the cleanup errors. */
	readonly sinkRefused: SdkConstructionFailureOutcome;
	/** No sink: the warning rides the failure, which keeps the extension read's error as its cause. */
	readonly noSink: SdkConstructionFailureOutcome;
	/** Normal order, same memory fault, no extension failure: created, the first subscriber takes the warning, the sink is never called. */
	readonly control: {
		readonly disposed: boolean;
		readonly subscriberWarnings: readonly string[];
		readonly sinkCalls: readonly (readonly string[])[];
		readonly memoryFaultFired: boolean;
	};
	/** A disposal whose tool-artifact cleanup is refused before its scan: the cause keeps the extension read, the cleanup and the held warning. */
	readonly disposalFailed: SdkDisposalFailureOutcome;
	/** Normal order, same seeded artifact and held warning, no cleanup fault: the cleanup scans and removes the artifact. */
	readonly disposalControl: SdkDisposalFailureOutcome;
	/** Provider errors at memory initialization, as the memory manager retains and writes them (see {@link providerErrorsWitness}). */
	readonly providerErrors: ProviderErrorWitness;
	/** Work-directory retention, lease liveness and adoption through the production owners (see {@link workDirectoryWitness}). */
	readonly workDirectory: WorkDirectoryWitness;
	/** Optional memory reporting, ambiguous lifecycle reload and held warning overflow through real session owners. */
	readonly sessionWarningRoutes: SessionWarningRoutesWitness;
	readonly runLifecycle: {
		readonly refusedEnd: {
			readonly failure: SdkErrorDescription;
			readonly firstEnds: number;
			readonly secondEnds: number;
			readonly fabricatedFailures: number;
			readonly idle: boolean;
		};
		readonly failedRun: {
			readonly failure: SdkErrorDescription;
			readonly firstEnds: number;
			readonly secondEnds: number;
			readonly originalFailureMessages: number;
			readonly idle: boolean;
			readonly bashCleanup: {
				readonly faultFired: boolean;
				readonly published: readonly string[];
				readonly persisted: readonly string[];
				readonly pendingSuffix: boolean;
				readonly retryRefused: boolean;
				readonly retryDidNotDuplicate: boolean;
				readonly canonicalPrefixConfirmed: boolean;
				readonly repairedPublished: readonly string[];
				readonly repairedPersisted: readonly string[];
				readonly repairedPendingEmpty: boolean;
			};
		};
		readonly control: {
			readonly firstEnds: number;
			readonly secondEnds: number;
			readonly fabricatedFailures: number;
			readonly idle: boolean;
			readonly publishedBash: readonly string[];
			readonly persistedBash: readonly string[];
		};
	};
	readonly unwrittenFork: {
		readonly absentAtRuntimeConstruction: boolean;
		readonly copiedPaidRowsAtConstruction: number;
		readonly firstReplyReached: boolean;
		readonly candidateKept: boolean;
		readonly paidCopyDisclosed: boolean;
		readonly previousRestored: boolean;
	};
	readonly historyUsageBounds: {
		readonly seededRecords: number;
		readonly liveOverflowTokens: number;
		readonly overflowReports: number;
		readonly liveDelta: number;
		readonly overflowWarning: boolean;
		readonly lateProviderReached: boolean;
		readonly disposedOwnerUncharged: boolean;
		readonly lateJournalTokens: number;
		readonly reopenedDelta: number;
		readonly overflowAbsentOnReopen: boolean;
		readonly lateWarning: boolean;
		readonly allWarningsClassified: boolean;
	};
}

export interface SessionWarningRoutesWitness {
	readonly reloadScope: {
		readonly sharedRetainedLanePresent: boolean;
		readonly dedicatedScopeQuiescent: boolean;
		readonly sharedRegistrationsUnchanged: boolean;
	};
	readonly optionalProvider: {
		readonly initializeCalls: number;
		readonly failureWarnings: readonly string[];
		readonly liveListenerWarnings: readonly string[];
		readonly consoleLines: readonly string[];
		readonly controlWarnings: readonly string[];
		readonly disposal: unknown;
	};
	readonly lifecycle: {
		readonly refusalReasons: readonly string[];
		readonly heldWarnings: readonly string[];
		readonly liveReloadWarnings: readonly string[];
		readonly ambiguousEntryUnchanged: boolean;
		readonly controlWarnings: readonly string[];
		readonly disposal: unknown;
	};
	readonly overflow: {
		readonly closingCalls: number;
		readonly retainedCount: number;
		readonly boundedEntriesExact: boolean;
		readonly astralBoundaryExact: boolean;
		readonly disclosure: string | undefined;
		readonly emptyRepeatedDrain: boolean;
		readonly cleanReentry: boolean;
	};
}

const SESSION_LIFECYCLE_REFUSAL_WARNING =
	"Session lifecycle repair refused: duplicate, mismatched, or out-of-order records require manual review.";
const OPTIONAL_MEMORY_WARNING =
	"Memory provider witness-session-optional initialize error: Error: optional init failed [REDACTED]";

/** One prune of a witness tenant: the basenames it removed (in return order), the runs still on disk after it, and the scan refusals it met. */
export interface WorkRetentionWitness {
	readonly removed: readonly string[];
	readonly remaining: readonly string[];
	/** Operation-specific readdir EIO faults armed for the prune, and how many the prune met: the listing it reached for the refused run. */
	readonly refusedScans: number;
	/** For a tenant with a leased run: that run's tree is byte-identical after the prune, so the prune left no marker in it. */
	readonly leasedTreeUnchanged?: boolean;
}

/** A removal the filesystem refuses for one run, then the identical prune with the refusal cleared (see {@link removalRefusalWitness}). */
export interface WorkRemovalRefusalWitness {
	/** The prune while the removal is refused: the refused run is not reported removed, and its neighbour is removed as its age requires. */
	readonly refusedPrune: WorkRetentionWitness;
	/** The removal attempts the refusal met: the refused run's non-recursive root removal, once. */
	readonly refusedRemovals: number;
	/** Actual content deletion and ownership-metadata loss at the refused root removal boundary. */
	readonly partialDeletionReached: boolean;
	/**
	 * The owner withdraws metadata after content deletion, then root removal is refused. Recovery restores the exact manifest and releases its fence.
	 */
	readonly ownedAfterRefusal: boolean;
	/** The refused run is not blocked by a leftover cleanup marker after the refusal. */
	readonly blockedAfterRefusal: boolean;
	/** The identical prune with the refusal cleared: the refused run is removed. */
	readonly retriedPrune: WorkRetentionWitness;
	readonly recoveryRefusal: {
		readonly failure: SdkErrorDescription;
		readonly partialDeletionReached: boolean;
		readonly fenceBlocksAdoption: boolean;
		readonly manifestMissing: boolean;
		readonly acquisitionLeaseRolledBack: boolean;
		readonly retryRemoved: boolean;
	};
	readonly unreadableSnapshot: {
		readonly faultFired: boolean;
		readonly contentUnchanged: boolean;
		readonly refused: boolean;
		readonly oversizedRefused: boolean;
		readonly retryRemoved: boolean;
	};
	readonly acquisitionRace: {
		readonly metadataBoundaryReached: boolean;
		readonly concurrentAcquisitionRefused: boolean;
		readonly lateEntryPreserved: boolean;
		readonly exactManifestRestored: boolean;
		readonly normalLeaseActive: boolean;
		readonly postLeaseOwnershipLossRefused: boolean;
		readonly postLeaseRolledBack: boolean;
		readonly staleLeaseSnapshotReached: boolean;
		readonly newMarkerDeletedByCleanup: boolean;
		readonly recoveredManifestMatches: boolean;
		readonly deletedLeaseRefused: boolean;
		readonly survivingMarkerControl: boolean;
		readonly normalRetryRemoved: boolean;
	};
}

/** One lease probe through the public owner: whether the run stays active, and how many marker files its lease directory keeps. */
export interface WorkLeaseProbeWitness {
	readonly active: boolean;
	readonly markers: number;
	/** The guard route was reached: the process table recorded a signal-0 probe of this marker's pid. */
	readonly probed: boolean;
}

/** Adoption of an existing run directory through the production owner. */
export interface WorkAdoptionWitness {
	/** The manifest read fails with a scripted EIO: the refusal keeps the read's cause, and the fault fired. */
	readonly unreadable: { readonly failure: SdkFailureDescription; readonly faultFired: boolean };
	/** Normal order, the same run with its manifest readable: the directory is adopted at its own path. */
	readonly readable: { readonly adoptedPath: string };
	/** A run directory with no manifest is unowned: refused, with no cause. */
	readonly unowned: { readonly failure: SdkFailureDescription };
}

/** Work-directory retention, lease liveness and adoption through the production owners. */
export interface WorkDirectoryWitness {
	/** An expired leased run whose measurement exhausts the shared scan budget: its lease keeps it, and the unmeasured neighbours are kept. */
	readonly leasedExhausted: WorkRetentionWitness;
	/** An expired leased run whose artifact listing is refused (operation-specific readdir EIO): its lease keeps it, and its counted bytes leave the neighbours inside the budget. */
	readonly leasedUnmeasured: WorkRetentionWitness;
	/** Normal order: the same tenant with the listing allowed. */
	readonly leasedControl: WorkRetentionWitness;
	/** An unleased run whose artifact listing is refused, inside every bound: its counted bytes are within the budget, so it stays. */
	readonly unleasedUnmeasured: WorkRetentionWitness;
	/** Normal order: the same tenant with the listing allowed. Every run is inside the budget, so none is removed. */
	readonly unleasedControl: WorkRetentionWitness;
	/**
	 * The same refused run over the count bound: it is evicted by count like any other run, and its neighbours stay. The removal is not refused, so
	 * this proves selection despite a failed measurement, not a removal under refusal (see {@link WorkDirectoryWitness.removalRefusal}).
	 */
	readonly countEviction: WorkRetentionWitness;
	/** Normal order: the same count bound with the listing allowed. */
	readonly countControl: WorkRetentionWitness;
	/** A measured run over the byte budget is evicted first, oldest first, and the within-budget neighbours survive. */
	readonly overBudgetEviction: WorkRetentionWitness;
	/**
	 * A run whose scan is incomplete: its large payload is counted, then one sub-directory's listing is refused. Its counted bytes alone are over
	 * the byte budget, so it is evicted for bytes, oldest first, and the counted neighbours stay within the budget.
	 */
	readonly partialByteEviction: WorkRetentionWitness;
	/** Normal order: the same incomplete shape with the counted bytes under the budget, so nothing is evicted for bytes. */
	readonly partialByteControl: WorkRetentionWitness;
	/** An unleased run whose artifact listing is refused is evicted by age once it has expired; the removal itself is not refused. */
	readonly ageEviction: WorkRetentionWitness;
	/** Normal order: the same expired run with the scan allowed. */
	readonly ageControl: WorkRetentionWitness;
	/** A removal the filesystem refuses for one run, and the identical prune once the refusal is cleared (see {@link WorkRemovalRefusalWitness}). */
	readonly removalRefusal: WorkRemovalRefusalWitness;
	/** Lease probes by process state: alive, denied and unknown keep their run active (unknown fails closed); dead releases its run. */
	readonly leaseProbes: {
		readonly alive: WorkLeaseProbeWitness;
		readonly dead: WorkLeaseProbeWitness;
		readonly unknown: WorkLeaseProbeWitness;
		readonly denied: WorkLeaseProbeWitness;
		readonly unmarked: WorkLeaseProbeWitness;
	};
	/** A count-over prune whose oldest run probes unknown: that run is kept, and the next run, probed dead, is removed. */
	readonly unknownProbePrune: WorkRetentionWitness;
	/** Normal order: the same prune with the oldest run probed dead: that run is removed. */
	readonly deadProbePrune: WorkRetentionWitness;
	readonly adoption: WorkAdoptionWitness;
}

/** A provider's initialization failure as the memory manager retains it: the diagnostics, the console lines it wrote, and the world's warnings. */
export interface MemoryFailureWitness {
	readonly diagnostics: readonly MemoryLifecycleDiagnostic[];
	readonly console: readonly string[];
	readonly worldWarnings: readonly string[];
}

/** Provider errors at memory initialization: a token behind a tab, three hostile errors, and a plain cause. */
export interface ProviderErrorWitness {
	readonly bearerTab: MemoryFailureWitness;
	readonly nonStringName: MemoryFailureWitness;
	readonly throwingName: MemoryFailureWitness;
	readonly tokenName: MemoryFailureWitness;
	readonly plainCause: MemoryFailureWitness;
	/** The callback routes after initialization and the registration refusal (see {@link memoryCallbackWitness}). */
	readonly callbacks: MemoryCallbackWitness;
}

/** What the memory manager writes when a provider's later callbacks fail, how it refuses a registration, and the normal-order control. */
export interface MemoryCallbackWitness {
	/** The console lines of the failing callbacks, in call order: block key, block, block key, frozen observer, tool definitions, context markers. */
	readonly failingLines: readonly string[];
	/** The callbacks' own results: they stay isolated, so a failing provider yields empty results. */
	readonly failingBlock: string;
	readonly failingToolCount: number;
	readonly failingMarkers: readonly string[];
	/** The refusal text of a registration whose tool definitions throw a token-bearing Error, and one that throws a value no conversion can read. */
	readonly registrationRefusal: string;
	readonly hostileRefusal: string;
	/** The same callbacks succeeding: no console line, the provider's block and markers delivered. */
	readonly controlLines: readonly string[];
	readonly controlBlockHasText: boolean;
	readonly controlMarkers: readonly string[];
}

/** The extension read that the failed creations hit once memory has initialized. */
const SDK_EXTENSION_READ_FAILURE = "SDK construction witness: the extension read fails after memory initialized.";
/** The closing sink's own refusal in the sink-refused case. */
const SDK_SINK_FAILURE = "SDK construction witness: the closing sink refuses the warnings.";
/** The aggregate the context pipeline throws when its tool-artifact cleanup fails (context-pipeline.ts, cleanupToolArtifactStoreOnDispose). */
const SDK_CONTEXT_CLEANUP_FAILURE = "Context storage cleanup failed";

/**
 * The held warning the failing memory read produces: the provider diagnostic carries the error's name and own text (memory-manager.ts
 * describeProviderError). The fault's per-creation name and the platform's MEMORY.md path are replaced by tokens (see
 * {@link tokenizeMemoryFault}) so one expected value serves every creation on every platform.
 */
const SDK_MEMORY_WARNING = "Memory subsystem init failed: Error: Scripted IO fault <memory-fault>: read '<MEMORY.md>'";

/** Each held-warning routing with the cause the SDK chained onto its failure, and the normal-order control (see {@link runSdkConstructionFailure}). */
export const SDK_CONSTRUCTION_FAILURE_EXPECTED: SdkConstructionFailureWitness = {
	historyUsageBounds: {
		seededRecords: 512,
		liveOverflowTokens: 18,
		overflowReports: 1,
		liveDelta: 18,
		overflowWarning: true,
		lateProviderReached: true,
		disposedOwnerUncharged: true,
		lateJournalTokens: 23,
		reopenedDelta: 23,
		overflowAbsentOnReopen: true,
		lateWarning: true,
		allWarningsClassified: true,
	},
	unwrittenFork: {
		absentAtRuntimeConstruction: true,
		copiedPaidRowsAtConstruction: 1,
		firstReplyReached: true,
		candidateKept: true,
		paidCopyDisclosed: true,
		previousRestored: true,
	},
	runLifecycle: {
		refusedEnd: { failure: "run-end refusal", firstEnds: 1, secondEnds: 1, fabricatedFailures: 0, idle: true },
		failedRun: {
			failure: {
				name: "AggregateError",
				message: "failure-record refusal",
				errors: [
					{
						name: "AggregateError",
						message: "failure-record refusal",
						errors: ["original run failure", "failure-record refusal", "failed-end refusal"],
					},
					"scripted IO fault bash-second-append-refused (EIO)",
				],
			},
			firstEnds: 1,
			secondEnds: 1,
			originalFailureMessages: 1,
			idle: true,
			bashCleanup: {
				faultFired: true,
				published: ["echo -n first"],
				persisted: ["echo -n first"],
				pendingSuffix: true,
				retryRefused: true,
				retryDidNotDuplicate: true,
				canonicalPrefixConfirmed: true,
				repairedPublished: ["echo -n first", "echo -n second"],
				repairedPersisted: ["echo -n first", "echo -n second"],
				repairedPendingEmpty: true,
			},
		},
		control: {
			firstEnds: 1,
			secondEnds: 1,
			fabricatedFailures: 0,
			idle: true,
			publishedBash: ["echo -n first", "echo -n second"],
			persistedBash: ["echo -n first", "echo -n second"],
		},
	},
	sessionWarningRoutes: {
		reloadScope: {
			sharedRetainedLanePresent: true,
			dedicatedScopeQuiescent: true,
			sharedRegistrationsUnchanged: true,
		},
		optionalProvider: {
			initializeCalls: 2,
			failureWarnings: [OPTIONAL_MEMORY_WARNING],
			liveListenerWarnings: [OPTIONAL_MEMORY_WARNING],
			consoleLines: [],
			controlWarnings: [],
			disposal: undefined,
		},
		lifecycle: {
			refusalReasons: ["unmatched compaction ends"],
			heldWarnings: [SESSION_LIFECYCLE_REFUSAL_WARNING],
			liveReloadWarnings: [SESSION_LIFECYCLE_REFUSAL_WARNING],
			ambiguousEntryUnchanged: true,
			controlWarnings: [],
			disposal: undefined,
		},
		overflow: {
			closingCalls: 1,
			retainedCount: 100,
			boundedEntriesExact: true,
			astralBoundaryExact: true,
			disclosure: "1 warning(s) raised while no listener was attached were not held.",
			emptyRepeatedDrain: true,
			cleanReentry: true,
		},
	},
	objective: {
		failure: "objective_primary cannot start: missing required binding 'ObjectiveExecutionController'",
		warnings: [],
	},
	drained: {
		failure: { message: SDK_EXTENSION_READ_FAILURE },
		sinkCalls: [[SDK_MEMORY_WARNING]],
		loaderDisposals: 1,
		memoryFaultFired: true,
		worldWarnings: [],
	},
	sinkRefused: {
		failure: {
			message: `${SDK_EXTENSION_READ_FAILURE} ${SDK_MEMORY_WARNING}`,
			cause: {
				name: "AggregateError",
				message: `${SDK_EXTENSION_READ_FAILURE} (its cleanup also failed)`,
				errors: [SDK_EXTENSION_READ_FAILURE, SDK_SINK_FAILURE],
			},
		},
		sinkCalls: [[SDK_MEMORY_WARNING]],
		loaderDisposals: 1,
		memoryFaultFired: true,
		worldWarnings: [],
	},
	noSink: {
		failure: {
			message: `${SDK_EXTENSION_READ_FAILURE} ${SDK_MEMORY_WARNING}`,
			cause: { name: "Error", message: SDK_EXTENSION_READ_FAILURE },
		},
		sinkCalls: [],
		loaderDisposals: 1,
		memoryFaultFired: true,
		worldWarnings: [],
	},
	control: {
		disposed: true,
		subscriberWarnings: [SDK_MEMORY_WARNING],
		sinkCalls: [],
		memoryFaultFired: true,
	},
	disposalFailed: {
		failure: {
			message: `${SDK_EXTENSION_READ_FAILURE} ${SDK_MEMORY_WARNING}`,
			cause: {
				name: "AggregateError",
				message: `${SDK_EXTENSION_READ_FAILURE} (its cleanup also failed)`,
				errors: [
					SDK_EXTENSION_READ_FAILURE,
					{
						name: "AggregateError",
						message: SDK_CONTEXT_CLEANUP_FAILURE,
						errors: ["scripted IO fault sdk-disposal-lease-write-disposal-failed (EIO)"],
					},
				],
			},
		},
		loaderDisposals: 1,
		memoryFaultFired: true,
		worldWarnings: [],
		artifactFiles: { seeded: 2, afterDisposal: 2 },
		cleanupFaultFired: true,
	},
	disposalControl: {
		failure: {
			message: `${SDK_EXTENSION_READ_FAILURE} ${SDK_MEMORY_WARNING}`,
			cause: { name: "Error", message: SDK_EXTENSION_READ_FAILURE },
		},
		loaderDisposals: 1,
		memoryFaultFired: true,
		worldWarnings: [],
		artifactFiles: { seeded: 2, afterDisposal: 0 },
		cleanupFaultFired: false,
	},
	providerErrors: {
		bearerTab: {
			diagnostics: [
				{
					provider: "witness-memory",
					operation: "initialize",
					status: "error",
					message: "Error: request failed [REDACTED]",
				},
			],
			console: ["Memory provider witness-memory initialize error: Error: request failed [REDACTED]"],
			worldWarnings: [],
		},
		nonStringName: {
			diagnostics: [
				{ provider: "witness-memory", operation: "initialize", status: "error", message: "object: disk full" },
			],
			console: ["Memory provider witness-memory initialize error: object: disk full"],
			worldWarnings: [],
		},
		throwingName: {
			diagnostics: [
				{ provider: "witness-memory", operation: "initialize", status: "error", message: "object: disk full" },
			],
			console: ["Memory provider witness-memory initialize error: object: disk full"],
			worldWarnings: [],
		},
		tokenName: {
			diagnostics: [
				{ provider: "witness-memory", operation: "initialize", status: "error", message: "[REDACTED]: disk full" },
			],
			console: ["Memory provider witness-memory initialize error: [REDACTED]: disk full"],
			worldWarnings: [],
		},
		plainCause: {
			diagnostics: [
				{
					provider: "witness-memory",
					operation: "initialize",
					status: "error",
					message: "Error: disk quota exceeded",
				},
			],
			console: ["Memory provider witness-memory initialize error: Error: disk quota exceeded"],
			worldWarnings: [],
		},
		callbacks: {
			failingLines: [
				"Memory provider witness-memory-cb failed to give its system prompt block key: Error: callback failed [REDACTED]",
				"Memory provider witness-memory-cb failed to generate system prompt block: Error: callback failed [REDACTED]",
				"Memory provider witness-memory-cb failed to give its system prompt block key: Error: callback failed [REDACTED]",
				"Memory provider witness-memory-cb failed to observe the frozen system prompt block: Error: callback failed [REDACTED]",
				"Failed to get tool definitions from provider witness-memory-cb: Error: callback failed [REDACTED]",
				"Failed to get context markers from provider witness-memory-cb: Error: callback failed [REDACTED]",
			],
			failingBlock: "",
			failingToolCount: 0,
			failingMarkers: [],
			registrationRefusal:
				"Failed to get tool definitions from provider witness-memory-refuse: Error: callback failed [REDACTED]",
			hostileRefusal: "Failed to get tool definitions from provider witness-memory-hostile: object: [object]",
			controlLines: [],
			controlBlockHasText: true,
			controlMarkers: ["witness-marker"],
		},
	},
	workDirectory: {
		leasedExhausted: {
			removed: [],
			remaining: ["a-expensive", "b-neighbour", "c-neighbour"],
			refusedScans: 0,
			leasedTreeUnchanged: true,
		},
		leasedUnmeasured: {
			removed: [],
			remaining: ["a-leased", "b-neighbour", "c-neighbour"],
			refusedScans: 1,
			leasedTreeUnchanged: true,
		},
		leasedControl: {
			removed: [],
			remaining: ["a-leased", "b-neighbour", "c-neighbour"],
			refusedScans: 0,
			leasedTreeUnchanged: true,
		},
		unleasedUnmeasured: {
			removed: [],
			remaining: ["a-unleased", "b-neighbour", "c-neighbour"],
			refusedScans: 1,
		},
		unleasedControl: {
			removed: [],
			remaining: ["a-unleased", "b-neighbour", "c-neighbour"],
			refusedScans: 0,
		},
		countEviction: {
			removed: ["a-unleased"],
			remaining: ["b-neighbour", "c-neighbour"],
			refusedScans: 1,
		},
		countControl: {
			removed: ["a-unleased"],
			remaining: ["b-neighbour", "c-neighbour"],
			refusedScans: 0,
		},
		overBudgetEviction: {
			removed: ["a-heavy"],
			remaining: ["b-neighbour", "c-neighbour"],
			refusedScans: 0,
		},
		partialByteEviction: {
			removed: ["a-partial"],
			remaining: ["b-neighbour", "c-neighbour"],
			refusedScans: 1,
		},
		partialByteControl: {
			removed: [],
			remaining: ["a-partial", "b-neighbour", "c-neighbour"],
			refusedScans: 1,
		},
		ageEviction: {
			removed: ["a-stale"],
			remaining: [],
			refusedScans: 1,
		},
		ageControl: {
			removed: ["a-stale"],
			remaining: [],
			refusedScans: 0,
		},
		removalRefusal: {
			refusedPrune: { removed: ["b-neighbour"], remaining: ["a-refused"], refusedScans: 0 },
			refusedRemovals: 1,
			partialDeletionReached: true,
			ownedAfterRefusal: true,
			blockedAfterRefusal: false,
			retriedPrune: { removed: ["a-refused"], remaining: [], refusedScans: 0 },
			recoveryRefusal: {
				failure: {
					name: "AggregateError",
					message: "Work run removal recovery is incomplete: <RUN_DIR>",
					errors: [
						"scripted IO fault recovery-root-refused (EACCES)",
						"scripted IO fault recovery-manifest-refused (EIO)",
					],
				},
				partialDeletionReached: true,
				fenceBlocksAdoption: true,
				manifestMissing: true,
				acquisitionLeaseRolledBack: true,
				retryRemoved: true,
			},
			unreadableSnapshot: {
				faultFired: true,
				contentUnchanged: true,
				refused: true,
				oversizedRefused: true,
				retryRemoved: true,
			},
			acquisitionRace: {
				metadataBoundaryReached: true,
				concurrentAcquisitionRefused: true,
				lateEntryPreserved: true,
				exactManifestRestored: true,
				normalLeaseActive: true,
				postLeaseOwnershipLossRefused: true,
				postLeaseRolledBack: true,
				staleLeaseSnapshotReached: true,
				newMarkerDeletedByCleanup: true,
				recoveredManifestMatches: true,
				deletedLeaseRefused: true,
				survivingMarkerControl: true,
				normalRetryRemoved: true,
			},
		},
		leaseProbes: {
			alive: { active: true, markers: 1, probed: true },
			dead: { active: false, markers: 0, probed: true },
			unknown: { active: true, markers: 1, probed: true },
			denied: { active: true, markers: 1, probed: true },
			unmarked: { active: false, markers: 0, probed: false },
		},
		unknownProbePrune: {
			removed: ["b-dead"],
			remaining: ["a-probe", "c-neighbour"],
			refusedScans: 0,
		},
		deadProbePrune: {
			removed: ["a-probe"],
			remaining: ["b-dead", "c-neighbour"],
			refusedScans: 0,
		},
		adoption: {
			unreadable: {
				failure: {
					message: "Work directory manifest could not be read: <RUN_DIR>",
					cause: { name: "Error", message: "scripted IO fault work-manifest-read-eio (EIO)" },
				},
				faultFired: true,
			},
			readable: { adoptedPath: "<RUN_DIR>" },
			unowned: { failure: { message: "Refusing to adopt unowned work directory: <RUN_DIR>" } },
		},
	},
};

/** A scripted IO fault is named by its fault and code: its message embeds the run's lease path, which is random per session. */
function failureText(error: unknown): string {
	if (error instanceof Error && "faultName" in error) {
		return `scripted IO fault ${String(error.faultName)} (${String((error as NodeJS.ErrnoException).code)})`;
	}
	return error instanceof Error ? error.message : String(error);
}

function describeErrorEntry(error: unknown): SdkErrorDescription {
	if (error instanceof AggregateError) {
		return { name: error.name, message: error.message, errors: error.errors.map(describeErrorEntry) };
	}
	return failureText(error);
}

function describeSdkFailure(error: unknown): SdkFailureDescription {
	const cause = error instanceof Error ? error.cause : undefined;
	if (cause === undefined) return { message: failureText(error) };
	if (cause instanceof AggregateError) {
		return {
			message: failureText(error),
			cause: { name: cause.name, message: cause.message, errors: cause.errors.map(describeErrorEntry) },
		};
	}
	return {
		message: failureText(error),
		cause: { name: cause instanceof Error ? cause.name : typeof cause, message: failureText(cause) },
	};
}

/** The outcome with the memory read fault's name and the MEMORY.md path replaced by tokens, wherever they appear in its texts. */
function tokenizeMemoryFault<T>(world: HarnessWorld, faultName: string, value: T): T {
	const memoryFile = resolve(configFile(world.agentDir, "MEMORY.md"));
	const text = JSON.stringify(value)
		.replaceAll(JSON.stringify(memoryFile).slice(1, -1), "<MEMORY.md>")
		.replaceAll(faultName, "<memory-fault>");
	return JSON.parse(text) as T;
}

/**
 * Arms the file-store read of the managed MEMORY.md, the first read of a creation's memory initialization. A read of a missing file fails
 * before the IO fault is consulted, so the file is seeded empty for the read to reach the fault.
 */
function armSdkMemoryReadFault(world: HarnessWorld, name: string): void {
	const memoryFile = resolve(configFile(world.agentDir, "MEMORY.md"));
	if (world.io.peekFile(memoryFile) === undefined) world.io.seed(memoryFile, "");
	world.io.failNext({ name, kind: "read", code: "EIO", matches: (operation) => operation.path === memoryFile });
}

/**
 * A creation the SDK constructs, then rejects at its extension read after memory initialized. The SDK disposes the constructed session and
 * routes its held warning to the sink: `accepts` records it, `refuses` records it and throws, `none` passes no sink.
 */
async function failedSdkCreation(
	world: HarnessWorld,
	label: string,
	closing: "accepts" | "refuses" | "none",
): Promise<SdkConstructionFailureOutcome> {
	const faultName = `sdk-construction-memory-read-${label}`;
	armSdkMemoryReadFault(world, faultName);
	const sinkCalls: string[][] = [];
	const probe = { loaderDisposals: 0 };
	const mark = world.warnings.length;
	const outcome = await world
		.createRootSession("root", {
			systemOneEnabled: false,
			closingSink:
				closing === "none"
					? null
					: (warnings) => {
							sinkCalls.push([...warnings]);
							if (closing === "refuses") throw new Error(SDK_SINK_FAILURE);
						},
			extensionReadFailure: { afterFault: faultName, message: SDK_EXTENSION_READ_FAILURE, probe },
		})
		.then(
			() => "created" as const,
			(error: unknown) => error,
		);
	if (outcome === "created") throw new Error(`${label}: the creation was not refused by its extension read`);
	return tokenizeMemoryFault(world, faultName, {
		failure: describeSdkFailure(outcome),
		sinkCalls,
		loaderDisposals: probe.loaderDisposals,
		memoryFaultFired: world.io.consumedFaults.includes(faultName),
		worldWarnings: world.warnings.splice(mark),
	});
}

/**
 * Normal order: the same memory fault with no extension failure. The creation completes, the first subscriber takes the held warning, and
 * disposal hands the closing sink nothing.
 */
async function controlSdkCreation(world: HarnessWorld): Promise<SdkConstructionFailureWitness["control"]> {
	const faultName = "sdk-construction-memory-read-control";
	armSdkMemoryReadFault(world, faultName);
	const sinkCalls: string[][] = [];
	const mark = world.warnings.length;
	// The fixture-built loader (no factories) is the failing creations' loader without the extension read failure.
	const created = await world.createRootSession("root", {
		systemOneEnabled: false,
		extensionFactories: [],
		closingSink: (warnings) => {
			sinkCalls.push([...warnings]);
		},
	});
	const subscriberWarnings = world.warnings.splice(mark);
	const disposal = await world.disposeSessionInBody(created.session);
	return tokenizeMemoryFault(world, faultName, {
		disposed: disposal === undefined,
		subscriberWarnings,
		sinkCalls,
		memoryFaultFired: world.io.consumedFaults.includes(faultName),
	});
}

/**
 * A creation that the SDK constructs and then rejects: the loop the owner selects needs an objective controller that System One-off sessions
 * never bind. The SDK disposes the constructed session and rethrows the failure itself.
 */
async function objectiveSdkCreation(world: HarnessWorld): Promise<SdkConstructionFailureWitness["objective"]> {
	const mark = world.warnings.length;
	const failure = await world
		.createRootSession("root", {
			systemOneEnabled: false,
			executionLoopMode: "objective_primary",
			settings: { memorySystem: "okf" },
		})
		.then(
			() => "created",
			(error: unknown) => failureText(error),
		);
	return { failure, warnings: world.warnings.splice(mark) };
}

/**
 * Seeds one valid, unreferenced tool artifact in the store a session with `sessionId` reads. The run is acquired through the production
 * retention lease, so it carries the manifest that adoption requires, and the lease is released before the creation.
 */
function seedToolArtifactStore(world: HarnessWorld, sessionId: string): string {
	const artifactsDir = getContextStoreDir(world.agentDir, "artifacts", sessionId);
	const lease = acquireContextStoreRetention(world.agentDir, sessionId);
	try {
		createFileArtifactStore({ baseDir: artifactsDir }).write({
			kind: "tool_output",
			content: "SDK disposal witness: one unreferenced artifact.",
			toolName: "grep",
			createdAtTurn: 1,
			reproducible: true,
		});
	} finally {
		lease.release();
	}
	return artifactsDir;
}

/**
 * A creation the SDK constructs over a session whose artifact store holds one seeded artifact, then rejects at its extension read after memory
 * initialized. The held warning has no sink, so it rides the failure. `cleanupFault` refuses the disposal's lease write: the cleanup acquires its
 * lease before it scans, so the refused write ends the cleanup before the scan and the artifact stays.
 */
async function disposalSdkCreation(
	world: HarnessWorld,
	label: string,
	cleanupFault: boolean,
): Promise<SdkDisposalFailureOutcome> {
	const memoryFaultName = `sdk-disposal-memory-read-${label}`;
	const leaseFaultName = `sdk-disposal-lease-write-${label}`;
	const sessionManager = SessionManager.inMemory(HARNESS_PROJECT_CWD);
	const artifactsDir = seedToolArtifactStore(world, sessionManager.getSessionId());
	const seeded = world.io.captureTree(artifactsDir).files.size;
	armSdkMemoryReadFault(world, memoryFaultName);
	if (cleanupFault) {
		// acquireWorkRun writes its lease marker before the retention prune, and the prune reads every run's artifact directory: a read fault
		// would be spent (and swallowed) there, so the lease marker write is the boundary the cleanup itself reaches first.
		const leasesDir = join(dirname(artifactsDir), ".leases");
		world.io.failNext({
			name: leaseFaultName,
			kind: "write",
			code: "EIO",
			matches: (operation) =>
				operation.path.startsWith(`${leasesDir}${sep}`) && world.io.consumedFaults.includes(memoryFaultName),
		});
	}
	const probe = { loaderDisposals: 0 };
	const mark = world.warnings.length;
	const outcome = await world
		.createRootSession("root", {
			sessionManager,
			systemOneEnabled: false,
			closingSink: null,
			extensionReadFailure: { afterFault: memoryFaultName, message: SDK_EXTENSION_READ_FAILURE, probe },
		})
		.then(
			() => "created" as const,
			(error: unknown) => error,
		);
	if (outcome === "created") throw new Error(`${label}: the creation was not refused by its extension read`);
	return tokenizeMemoryFault(world, memoryFaultName, {
		failure: describeSdkFailure(outcome),
		loaderDisposals: probe.loaderDisposals,
		memoryFaultFired: world.io.consumedFaults.includes(memoryFaultName),
		worldWarnings: world.warnings.splice(mark),
		artifactFiles: { seeded, afterDisposal: world.io.captureTree(artifactsDir).files.size },
		cleanupFaultFired: world.io.consumedFaults.includes(leaseFaultName),
	});
}

/** The category of the work-directory witness tenants: its own directory, so no production retention reaches these runs. */
const WORK_WITNESS_CATEGORY = "fixture-witness";
/** The age bound every retention prune of the witness uses. */
const WORK_WITNESS_MAX_AGE_MS = 60 * 60 * 1000;
/** Explicit bounds: the neighbours fit the byte budget with room to spare, so an eviction in a witness is the one its scenario names. */
const WORK_WITNESS_BOUNDS: Omit<WorkRetentionOptions, "now"> = {
	maxAgeMs: WORK_WITNESS_MAX_AGE_MS,
	maxRuns: 8,
	maxTotalBytes: 1024,
};
/** How far before the witness clock a leased run is acquired: twice the age bound, so the prune reaches the run's lease check expired. */
const WORK_WITNESS_STALE_MS = 2 * WORK_WITNESS_MAX_AGE_MS;
/** The lease directory a run keeps its markers in: the production layout. */
const WORK_WITNESS_LEASES = ".leases";
/** The cleanup marker a removal writes into the run it removes: the production name. */
const WORK_WITNESS_CLEANUP_MARKER = ".cleanup.json";
/** The provider every memory witness registers; each failing initialization builds its own manager, so the name is never a duplicate. */
const MEMORY_WITNESS_PROVIDER = "witness-memory";

/** One run of a witness tenant. */
interface WorkWitnessRun {
	readonly name: string;
	/** Holds the run's own lease until the witness releases it. */
	readonly leased: boolean;
	/** Artifact files under the run, each of `bytes` bytes; the default is one small file. */
	readonly artifacts?: { readonly count: number; readonly bytes: number };
	/** A sub-directory of the artifacts holding one small file, so a scenario can refuse its listing (see {@link WorkPruneScenario.refusedDirectory}). */
	readonly nestedDirectory?: string;
	/** A lease marker for `pid`, written after the run is released; the process table answers the pid with `state`. */
	readonly marker?: { readonly pid: number; readonly state: VirtualProcessState };
}

/** One prune of a witness tenant. */
interface WorkPruneScenario {
	readonly tenant: string;
	readonly runs: readonly WorkWitnessRun[];
	/** The witness clock: a leased run is acquired before it, and an unleased run is stamped at its release. */
	readonly now: number;
	/** The clock the prune reads; defaults to the witness clock. */
	readonly pruneAt?: number;
	/** The run whose artifact listing the virtual filesystem refuses for the whole prune; undefined is the normal-order control. */
	readonly refusedRun?: string;
	/** The directory of the refused run that is refused, relative to its run directory; defaults to its artifacts. */
	readonly refusedDirectory?: string;
	/** Bounds that replace the witness bounds for this prune. */
	readonly bounds?: Omit<WorkRetentionOptions, "now">;
}

function workWitnessRunDir(world: HarnessWorld, tenant: string, runId: string): string {
	return getWorkRunDir(world.agentDir, WORK_WITNESS_CATEGORY, tenant, runId);
}

/** A run directory's native path replaced by a token, wherever it appears in the value's texts (see {@link tokenizeMemoryFault}). */
function tokenizeRunDir<T>(runDir: string, value: T): T {
	const text = JSON.stringify(value).replaceAll(JSON.stringify(runDir).slice(1, -1), "<RUN_DIR>");
	return JSON.parse(text) as T;
}

/**
 * Creates a tenant's runs in order through the production acquisition, each with its artifact files and marker. A leased run keeps the stale stamp
 * it was acquired with. An unleased run is released at once, which stamps it fresh, so the release order (ties broken by the name) is the prune's
 * age order. Returns the leases the runs still hold.
 */
function seedWorkTenant(
	world: HarnessWorld,
	tenant: string,
	runs: readonly WorkWitnessRun[],
	now: number,
): WorkRunLease[] {
	const held: WorkRunLease[] = [];
	for (const run of runs) {
		const lease = acquireWorkRun({
			agentDir: world.agentDir,
			category: WORK_WITNESS_CATEGORY,
			tenant,
			runId: run.name,
			retention: false,
			now: now - WORK_WITNESS_STALE_MS,
		});
		const artifacts = run.artifacts ?? { count: 1, bytes: 12 };
		for (let index = 0; index < artifacts.count; index++) {
			world.io.seed(join(lease.path, "artifacts", `payload-${index}.txt`), "x".repeat(artifacts.bytes));
		}
		if (run.nestedDirectory !== undefined) {
			world.io.seed(join(lease.path, "artifacts", run.nestedDirectory, "nested.txt"), "x");
		}
		if (run.leased) held.push(lease);
		else lease.release();
		if (run.marker !== undefined) {
			world.processTable.setState(run.marker.pid, run.marker.state);
			world.io.seed(
				join(lease.path, WORK_WITNESS_LEASES, `active-${run.marker.pid}-witness.json`),
				JSON.stringify({ version: 1, hostname: hostname(), pid: run.marker.pid, createdAt: now }),
			);
		}
	}
	return held;
}

/**
 * Seeds one tenant, prunes it through the production owner under the witness bounds, and releases the leases the seeding holds. The leased run's
 * tree is compared before and after the prune. The refused listing is an operation-specific readdir EIO: armed for the whole prune, and counted
 * once the prune has run.
 */
function runWorkTenantPrune(world: HarnessWorld, scenario: WorkPruneScenario): WorkRetentionWitness {
	const { tenant, runs, now, refusedRun, refusedDirectory } = scenario;
	const held = seedWorkTenant(world, tenant, runs, now);
	const leasedRun = runs.find((run) => run.leased);
	const leasedTree = leasedRun === undefined ? undefined : workWitnessRunDir(world, tenant, leasedRun.name);
	const treeBefore = leasedTree === undefined ? undefined : world.io.captureTree(leasedTree);
	const refusal =
		refusedRun === undefined
			? undefined
			: world.io.denyUntilCleared({
					name: `${tenant}-scan-refused`,
					kind: "readdir",
					matches: (operation) =>
						operation.path ===
						join(workWitnessRunDir(world, tenant, refusedRun), refusedDirectory ?? "artifacts"),
				});
	const removedPaths = pruneWorkTenant(world.agentDir, WORK_WITNESS_CATEGORY, tenant, {
		...WORK_WITNESS_BOUNDS,
		...scenario.bounds,
		now: scenario.pruneAt ?? now,
	});
	const refusedScans = refusal?.clear() ?? 0;
	// Read before the release: the lease's own marker is part of the leased tree until then.
	const leasedTreeUnchanged =
		leasedTree === undefined || treeBefore === undefined
			? undefined
			: isDeepStrictEqual(treeBefore, world.io.captureTree(leasedTree));
	const remaining = remainingWitnessRuns(world, tenant, runs);
	for (const lease of held) lease.release();
	return {
		removed: removedPaths.map((path) => basename(path)),
		remaining,
		refusedScans,
		...(leasedTreeUnchanged === undefined ? {} : { leasedTreeUnchanged }),
	};
}

/** The runs of a witness tenant still on disk, in the order given. */
function remainingWitnessRuns(world: HarnessWorld, tenant: string, runs: readonly WorkWitnessRun[]): string[] {
	return runs.map((run) => run.name).filter((name) => world.io.existsSync(workWitnessRunDir(world, tenant, name)));
}

/**
 * Content is deleted first, then the owner withdraws its manifest and fence before the root removal's EACCES. Recovery restores ownership and
 * releases the fence, the expired neighbour is still removed, and the identical retry removes the recovered run. Separate branches refuse
 * recovery and the initial ownership snapshot through the same owner.
 */
function removalRefusalWitness(world: HarnessWorld, now: number): WorkRemovalRefusalWitness {
	const tenant = "removal-refused";
	const runs: readonly WorkWitnessRun[] = [
		{ name: "a-refused", leased: false },
		{ name: "b-neighbour", leased: false },
	];
	seedWorkTenant(world, tenant, runs, now);
	const refusedDir = workWitnessRunDir(world, tenant, "a-refused");
	const originalManifest = world.io.peekFile(join(refusedDir, WORK_RUN_MANIFEST_FILE));
	let partialDeletionReached = false;
	// Both runs are past the age bound at this clock, so the removal of each is what the prune attempts.
	const pruneOptions = { ...WORK_WITNESS_BOUNDS, now: now + 2 * WORK_WITNESS_MAX_AGE_MS };
	const refusal = world.io.denyUntilCleared({
		name: `${tenant}-removal-refused`,
		kind: "rm",
		code: "EACCES",
		matches: (operation) => {
			if (operation.path !== refusedDir) return false;
			partialDeletionReached =
				!world.io.existsSync(join(refusedDir, "artifacts")) &&
				!world.io.existsSync(join(refusedDir, WORK_RUN_MANIFEST_FILE)) &&
				!world.io.existsSync(join(refusedDir, WORK_WITNESS_CLEANUP_MARKER));
			return true;
		},
	});
	const refusedRemoved = pruneWorkTenant(world.agentDir, WORK_WITNESS_CATEGORY, tenant, pruneOptions);
	const refusedRemovals = refusal.clear();
	const refusedPrune: WorkRetentionWitness = {
		removed: refusedRemoved.map((path) => basename(path)),
		remaining: remainingWitnessRuns(world, tenant, runs),
		refusedScans: 0,
	};
	const ownedAfterRefusal =
		world.io.peekFile(join(refusedDir, WORK_RUN_MANIFEST_FILE)) === originalManifest &&
		!world.io.existsSync(join(refusedDir, WORK_WITNESS_CLEANUP_MARKER));
	const blockedAfterRefusal = hasActiveWorkRunLease(refusedDir);
	const retriedRemoved = pruneWorkTenant(world.agentDir, WORK_WITNESS_CATEGORY, tenant, pruneOptions);
	return {
		refusedPrune,
		refusedRemovals,
		partialDeletionReached,
		ownedAfterRefusal,
		blockedAfterRefusal,
		retriedPrune: {
			removed: retriedRemoved.map((path) => basename(path)),
			remaining: remainingWitnessRuns(world, tenant, runs),
			refusedScans: 0,
		},
		recoveryRefusal: workRemovalRecoveryRefusal(world),
		unreadableSnapshot: workRemovalUnreadableSnapshot(world),
		acquisitionRace: workRemovalAcquisitionRace(world),
	};
}

/** Acquisition at the final metadata boundary refuses; a late entry makes non-recursive removal recover rather than consume it. */
function workRemovalAcquisitionRace(world: HarnessWorld): WorkRemovalRefusalWitness["acquisitionRace"] {
	const options = {
		agentDir: world.agentDir,
		category: WORK_WITNESS_CATEGORY,
		tenant: "acquisition-race",
		runId: "held",
		retention: false as const,
	};
	const lease = acquireWorkRun(options);
	const manifestPath = join(lease.path, WORK_RUN_MANIFEST_FILE);
	const fencePath = join(lease.path, WORK_WITNESS_CLEANUP_MARKER);
	const manifest = world.io.peekFile(manifestPath);
	if (manifest === undefined) throw new Error("acquisition race witness has no manifest");
	const latePath = join(lease.path, "late.txt");
	let metadataBoundaryReached = false;
	let concurrentAcquisitionRefused = false;
	world.io.observeNext({
		name: "acquire-at-final-metadata",
		kind: "unlink",
		phase: "after",
		matches: (operation) => operation.path === fencePath,
		onMatch: () => {
			metadataBoundaryReached = !world.io.existsSync(manifestPath) && !world.io.existsSync(fencePath);
			try {
				acquireWorkRun(options);
			} catch (error) {
				concurrentAcquisitionRefused = error instanceof Error && error.message.includes("unowned");
			}
			// A concurrent writer's new entry is already present when the owner attempts the final directory syscall.
			world.io.seed(latePath, "concurrent content");
		},
	});
	if (removeWorkRun(lease)) throw new Error("root removal consumed the concurrent entry");
	const lateEntryPreserved = world.io.peekFile(latePath) === "concurrent content";
	const exactManifestRestored = world.io.peekFile(manifestPath) === manifest;
	const normal = acquireWorkRun(options);
	const normalLeaseActive = hasActiveWorkRunLease(normal.path);
	normal.release();
	let postLeaseOwnershipLossRefused = false;
	world.io.observeNext({
		name: "ownership-loss-after-new-lease",
		kind: "write",
		phase: "after",
		matches: (operation) => operation.path.startsWith(`${join(lease.path, WORK_WITNESS_LEASES)}${sep}`),
		onMatch: () => {
			world.io.unlinkSync(manifestPath);
		},
	});
	try {
		acquireWorkRun(options);
	} catch (error) {
		postLeaseOwnershipLossRefused = (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	const postLeaseRolledBack = world.io.captureTree(join(lease.path, WORK_WITNESS_LEASES)).files.size === 0;
	world.io.writeFileSync(manifestPath, manifest);
	let staleLeaseSnapshotReached = false;
	let newMarkerDeletedByCleanup = false;
	let recoveredManifestMatches = false;
	let deletedLeaseRefused = false;
	const leasesDir = join(lease.path, WORK_WITNESS_LEASES);
	world.io.failNext({
		name: "lease-race-root-refused",
		kind: "rm",
		code: "EACCES",
		matches: (operation) => operation.path === lease.path,
	});
	world.io.observeNext({
		name: "defer-new-marker-until-cleaner-snapshot",
		kind: "write",
		phase: "after",
		matches: (operation) => operation.path.startsWith(`${leasesDir}${sep}`),
		onMatch: (operation, data) => {
			if (data === undefined) throw new Error("lease race boundary has no written marker bytes");
			// Model the two OS syscalls' ordering: the acquirer's actual write is pending visibility when the cleaner captures
			// its empty listing, then these exact bytes land before that captured listing returns. No domain result is supplied.
			world.io.unlinkSync(operation.path);
			world.io.observeNext({
				name: "new-marker-lands-after-empty-lease-snapshot",
				kind: "readdir",
				phase: "after",
				matches: (listing) => listing.path === leasesDir,
				onMatch: () => {
					staleLeaseSnapshotReached = world.io.captureTree(leasesDir).files.size === 0;
					world.io.writeFileSync(operation.path, data);
				},
			});
			if (removeWorkRun(lease)) throw new Error("lease race cleanup did not reach its refused root removal");
			newMarkerDeletedByCleanup = !world.io.existsSync(operation.path);
			recoveredManifestMatches = world.io.peekFile(manifestPath) === manifest && !world.io.existsSync(fencePath);
		},
	});
	try {
		acquireWorkRun(options);
	} catch (error) {
		deletedLeaseRefused = (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	const markerControl = acquireWorkRun(options);
	const survivingMarkerControl =
		hasActiveWorkRunLease(markerControl.path) && world.io.captureTree(leasesDir).files.size === 1;
	markerControl.release();
	return {
		metadataBoundaryReached,
		concurrentAcquisitionRefused,
		lateEntryPreserved,
		exactManifestRestored,
		normalLeaseActive,
		postLeaseOwnershipLossRefused,
		postLeaseRolledBack,
		staleLeaseSnapshotReached,
		newMarkerDeletedByCleanup,
		recoveredManifestMatches,
		deletedLeaseRefused,
		survivingMarkerControl,
		normalRetryRemoved: removeWorkRun(lease),
	};
}

/** Root removal loses metadata and fails after content deletion; ownership restoration is also refused. */
function workRemovalRecoveryRefusal(world: HarnessWorld): WorkRemovalRefusalWitness["recoveryRefusal"] {
	const lease = acquireWorkRun({
		agentDir: world.agentDir,
		category: WORK_WITNESS_CATEGORY,
		tenant: "recovery-refused",
		retention: false,
	});
	const manifestPath = join(lease.path, WORK_RUN_MANIFEST_FILE);
	const fencePath = join(lease.path, WORK_WITNESS_CLEANUP_MARKER);
	const manifest = world.io.peekFile(manifestPath);
	if (manifest === undefined) throw new Error("recovery witness has no manifest");
	world.io.seed(join(lease.path, "payload.txt"), "owned content");
	let partialDeletionReached = false;
	world.io.failNext({
		name: "recovery-root-refused",
		kind: "rm",
		code: "EACCES",
		matches: (operation) => {
			if (operation.path !== lease.path) return false;
			partialDeletionReached =
				!world.io.existsSync(join(lease.path, "payload.txt")) &&
				!world.io.existsSync(manifestPath) &&
				!world.io.existsSync(fencePath);
			return true;
		},
	});
	world.io.failNext({
		name: "recovery-manifest-refused",
		kind: "write",
		code: "EIO",
		matches: (operation) => operation.path === manifestPath,
	});
	let failure: unknown;
	lease.release();
	const candidatePath = workWitnessRunDir(world, lease.tenant, "new-candidate");
	try {
		acquireWorkRun({
			agentDir: world.agentDir,
			category: WORK_WITNESS_CATEGORY,
			tenant: lease.tenant,
			runId: "new-candidate",
			retention: { maxRuns: 1 },
		});
	} catch (error) {
		failure = error;
	}
	if (failure === undefined) throw new Error("incomplete recovery reported no failure");
	const acquisitionLeaseRolledBack = world.io.captureTree(join(candidatePath, WORK_WITNESS_LEASES)).files.size === 0;
	const manifestMissing = !world.io.existsSync(manifestPath);
	// Exact owner repair permits a retry; before releasing its fence, even matching restored ownership cannot be adopted.
	world.io.writeFileSync(manifestPath, manifest);
	let adoptionRefused = false;
	try {
		acquireWorkRun({
			agentDir: world.agentDir,
			category: WORK_WITNESS_CATEGORY,
			tenant: lease.tenant,
			runId: lease.runId,
			retention: false,
		});
	} catch (error) {
		adoptionRefused = error instanceof Error && error.message.includes("being cleaned");
	}
	const fenceBlocksAdoption = hasActiveWorkRunLease(lease.path) && adoptionRefused;
	world.io.unlinkSync(fencePath);
	removeWorkRun(
		acquireWorkRun({
			agentDir: world.agentDir,
			category: WORK_WITNESS_CATEGORY,
			tenant: lease.tenant,
			runId: "new-candidate",
			retention: false,
		}),
	);
	return {
		failure: tokenizeRunDir(lease.path, describeErrorEntry(failure)),
		partialDeletionReached,
		fenceBlocksAdoption,
		manifestMissing,
		acquisitionLeaseRolledBack,
		retryRemoved: removeWorkRun(lease),
	};
}

/** An unreadable ownership snapshot refuses removal before the first content mutation; the same lease removes normally once readable. */
function workRemovalUnreadableSnapshot(world: HarnessWorld): WorkRemovalRefusalWitness["unreadableSnapshot"] {
	const lease = acquireWorkRun({
		agentDir: world.agentDir,
		category: WORK_WITNESS_CATEGORY,
		tenant: "snapshot-unreadable",
		retention: false,
	});
	const payload = join(lease.path, "payload.txt");
	world.io.seed(payload, "owned content");
	world.io.failNext({
		name: "snapshot-read-refused",
		kind: "read",
		code: "EIO",
		matches: (operation) => operation.path === join(lease.path, WORK_RUN_MANIFEST_FILE),
	});
	let refused = false;
	try {
		removeWorkRun(lease);
	} catch (error) {
		refused =
			error instanceof Error && error.message.includes("snapshotted before removal") && error.cause instanceof Error;
	}
	const manifestPath = join(lease.path, WORK_RUN_MANIFEST_FILE);
	const manifest = world.io.peekFile(manifestPath);
	if (manifest === undefined) throw new Error("snapshot witness has no manifest");
	// Still valid matching JSON, but beyond the ownership snapshot cap: refusal must precede content deletion.
	world.io.writeFileSync(manifestPath, manifest.padEnd(4097));
	let oversizedRefused = false;
	try {
		removeWorkRun(lease);
	} catch (error) {
		oversizedRefused =
			error instanceof Error &&
			error.cause instanceof Error &&
			error.cause.message.includes("Invalid work metadata file");
	}
	world.io.writeFileSync(manifestPath, manifest);
	return {
		faultFired: world.io.consumedFaults.includes("snapshot-read-refused"),
		contentUnchanged: world.io.peekFile(payload) === "owned content",
		refused,
		oversizedRefused,
		retryRemoved: removeWorkRun(lease),
	};
}

/**
 * Lease liveness through the public owner: one run per process state, and an unmarked run. The states are the process table's own answers, so the
 * production probe classifies them as it does a real pid; the marker files left in each run's lease directory are counted after the probe.
 */
function leaseProbeWitness(world: HarnessWorld, now: number): WorkDirectoryWitness["leaseProbes"] {
	const tenant = "lease-probe";
	seedWorkTenant(
		world,
		tenant,
		[
			{ name: "alive", leased: false, marker: { pid: 880101, state: "alive" } },
			{ name: "dead", leased: false, marker: { pid: 880102, state: "dead" } },
			{ name: "unknown", leased: false, marker: { pid: 880103, state: "unknown" } },
			{ name: "denied", leased: false, marker: { pid: 880104, state: "denied" } },
			{ name: "unmarked", leased: false },
		],
		now,
	);
	const probe = (name: string, pid?: number): WorkLeaseProbeWitness => {
		const runDir = workWitnessRunDir(world, tenant, name);
		const active = hasActiveWorkRunLease(runDir);
		return {
			active,
			markers: world.io.captureTree(join(runDir, WORK_WITNESS_LEASES)).files.size,
			probed: world.processTable.probes.some((entry) => entry.pid === pid && entry.signal === 0),
		};
	};
	return {
		alive: probe("alive", 880101),
		dead: probe("dead", 880102),
		unknown: probe("unknown", 880103),
		denied: probe("denied", 880104),
		unmarked: probe("unmarked"),
	};
}

/** An Error whose name is replaced, so the witness reaches the kind the diagnostic reads from it. */
function namedError(message: string, name: unknown): Error {
	const error = new Error(message);
	Object.assign(error, { name });
	return error;
}

/** An Error whose name getter throws. */
function throwingNameError(message: string): Error {
	const error = new Error(message);
	Object.defineProperty(error, "name", {
		get: () => {
			throw new Error("the name getter refused");
		},
	});
	return error;
}

/**
 * A provider whose initialization rejects with `failure`, run through the memory manager's own lifecycle: the diagnostics it retains, the console
 * lines it writes for this provider, and any world warning. The console is captured for this initialization only and restored after it.
 */
async function providerFailureWitness(world: HarnessWorld, failure: unknown): Promise<MemoryFailureWitness> {
	const manager = new MemoryManager();
	manager.registerProvider({
		name: MEMORY_WITNESS_PROVIDER,
		isAvailable: () => true,
		getCapabilities: () => ({ surfaces: [] }),
		initialize: async () => {
			throw failure;
		},
		shutdown: async () => {},
	});
	const lines: string[] = [];
	const mark = world.warnings.length;
	const logError = console.error;
	console.error = (...data: unknown[]) => {
		const line = data.map(String).join(" ");
		if (line.startsWith(`Memory provider ${MEMORY_WITNESS_PROVIDER} `)) lines.push(line);
		else logError(...data);
	};
	try {
		await manager.initializeAll("witness-session", {
			agentDir: world.agentDir,
			cwd: HARNESS_PROJECT_CWD,
			isChildSession: false,
		});
	} finally {
		console.error = logError;
	}
	return {
		diagnostics: manager.getLifecycleDiagnostics(),
		console: lines,
		worldWarnings: world.warnings.splice(mark),
	};
}

/** Runs `body` with console.error captured; lines that are not this witness's own are forwarded to the real console untouched. */
function captureMemoryConsole<T>(prefixes: readonly string[], body: () => T): { value: T; lines: string[] } {
	const lines: string[] = [];
	const logError = console.error;
	console.error = (...data: unknown[]) => {
		const line = data.map(String).join(" ");
		if (prefixes.some((prefix) => line.startsWith(prefix))) lines.push(line);
		else logError(...data);
	};
	try {
		return { value: body(), lines };
	} finally {
		console.error = logError;
	}
}

/** A registration the manager refuses: the message of the error `registerProvider` throws. */
function registrationRefusal(name: string, failure: unknown): string {
	const manager = new MemoryManager();
	try {
		manager.registerProvider({
			name,
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: [] }),
			initialize: async () => {},
			shutdown: async () => {},
			getToolDefinitions: () => {
				throw failure;
			},
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`${name}: the registration was not refused`);
}

/**
 * The memory manager's callback routes after a provider initialized: a failing key, block, frozen observer, tool-definition and marker
 * callback each write one masked line and leave the result empty, a registration whose tool definitions throw is refused with a masked cause
 * (also for a value no conversion can read), and the same callbacks succeeding write nothing.
 */
async function memoryCallbackWitness(world: HarnessWorld): Promise<MemoryCallbackWitness> {
	const failure = new Error("callback failed Bearer\topaque0123456789token");
	const failing = new MemoryManager();
	let toolCalls = 0;
	failing.registerProvider({
		name: "witness-memory-cb",
		isAvailable: () => true,
		getCapabilities: () => ({ surfaces: [] }),
		initialize: async () => {},
		shutdown: async () => {},
		systemPromptBlockKey: () => {
			throw failure;
		},
		systemPromptBlock: () => {
			throw failure;
		},
		onSystemPromptBlockFrozen: () => {
			throw failure;
		},
		// The registration reads the definitions once and must succeed; every later read fails.
		getToolDefinitions: () => {
			toolCalls++;
			if (toolCalls > 1) throw failure;
			return [];
		},
		getContextMarkers: () => {
			throw failure;
		},
	});
	const hostile = {
		toString: () => {
			throw new Error("the witness value refuses conversion");
		},
		get [Symbol.toStringTag](): string {
			throw new Error("the witness value refuses its tag");
		},
	};
	const refusal = registrationRefusal("witness-memory-refuse", failure);
	const hostileRefusal = registrationRefusal("witness-memory-hostile", hostile);
	await failing.initializeAll("witness-session", {
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		isChildSession: false,
	});
	const prefixes = ["Memory provider witness-memory-cb ", "Failed to get "];
	const failed = captureMemoryConsole(prefixes, () => {
		const block = failing.buildSystemPromptBlock();
		failing.freezeSystemPromptBlock();
		return { block, tools: failing.getToolDefinitions(), markers: failing.getContextMarkers() };
	});
	const ok = new MemoryManager();
	ok.registerProvider({
		name: "witness-memory-ok",
		isAvailable: () => true,
		getCapabilities: () => ({ surfaces: [] }),
		initialize: async () => {},
		shutdown: async () => {},
		systemPromptBlockKey: () => "k1",
		systemPromptBlock: () => "witness control block",
		onSystemPromptBlockFrozen: () => {},
		getToolDefinitions: () => [],
		getContextMarkers: () => ["witness-marker"],
	});
	await ok.initializeAll("witness-session", {
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		isChildSession: false,
	});
	const control = captureMemoryConsole(["Memory provider witness-memory-ok ", "Failed to get "], () => ({
		block: ok.buildSystemPromptBlock(),
		markers: ok.getContextMarkers(),
	}));
	return {
		failingLines: failed.lines,
		failingBlock: failed.value.block,
		failingToolCount: failed.value.tools.length,
		failingMarkers: failed.value.markers,
		registrationRefusal: refusal,
		hostileRefusal,
		controlLines: control.lines,
		controlBlockHasText: control.value.block.includes("witness control block"),
		controlMarkers: control.value.markers,
	};
}

/** The provider errors the memory manager reads into its diagnostic: a token behind a tab, three hostile errors, and a plain cause. */
async function providerErrorsWitness(world: HarnessWorld): Promise<ProviderErrorWitness> {
	return {
		bearerTab: await providerFailureWitness(world, new Error("request failed Bearer\topaque0123456789token")),
		nonStringName: await providerFailureWitness(world, namedError("disk full", 42)),
		throwingName: await providerFailureWitness(world, throwingNameError("disk full")),
		tokenName: await providerFailureWitness(world, namedError("disk full", "sk-abcdefghijklmnop")),
		plainCause: await providerFailureWitness(world, new Error("disk quota exceeded")),
		callbacks: await memoryCallbackWitness(world),
	};
}

/** Adoption of an existing run directory: an unreadable manifest refuses with the read's cause, the same run with its manifest readable is
 * adopted, and a directory with no manifest is refused as unowned. */
function workAdoptionWitness(world: HarnessWorld): WorkAdoptionWitness {
	const tenant = "adoption";
	const held = workWitnessRunDir(world, tenant, "held-manifest");
	const manifestPath = join(held, WORK_RUN_MANIFEST_FILE);
	const faultName = "work-manifest-read-eio";
	acquireWorkRun({
		agentDir: world.agentDir,
		category: WORK_WITNESS_CATEGORY,
		tenant,
		runId: "held-manifest",
		retention: false,
	}).release();
	world.io.failNext({
		name: faultName,
		kind: "read",
		code: "EIO",
		matches: (operation) => operation.path === manifestPath,
	});
	let unreadableError: unknown;
	try {
		acquireWorkRun({
			agentDir: world.agentDir,
			category: WORK_WITNESS_CATEGORY,
			tenant,
			runId: "held-manifest",
			retention: false,
		});
	} catch (error) {
		unreadableError = error;
	}
	if (unreadableError === undefined) throw new Error("the manifest read fault did not refuse the adoption");
	const adopted = acquireWorkRun({
		agentDir: world.agentDir,
		category: WORK_WITNESS_CATEGORY,
		tenant,
		runId: "held-manifest",
		retention: false,
	});
	adopted.release();
	const unownedDir = workWitnessRunDir(world, tenant, "unowned-dir");
	world.io.mkdirSync(unownedDir, { recursive: true });
	let unownedError: unknown;
	try {
		acquireWorkRun({
			agentDir: world.agentDir,
			category: WORK_WITNESS_CATEGORY,
			tenant,
			runId: "unowned-dir",
			retention: false,
		});
	} catch (error) {
		unownedError = error;
	}
	if (unownedError === undefined) throw new Error("the directory without a manifest was adopted");
	return {
		unreadable: {
			failure: tokenizeRunDir(held, describeSdkFailure(unreadableError)),
			faultFired: world.io.consumedFaults.includes(faultName),
		},
		readable: { adoptedPath: tokenizeRunDir(held, adopted.path) },
		unowned: { failure: tokenizeRunDir(unownedDir, describeSdkFailure(unownedError)) },
	};
}

/**
 * Work-directory retention, lease liveness and adoption through the production owners over the virtual filesystem. A leased run is acquired stale,
 * past the age bound, so the prune reaches its lease check; released neighbours are fresh. Tenants are separate directories, so no scenario sees
 * another's runs.
 */
function workDirectoryWitness(world: HarnessWorld): WorkDirectoryWitness {
	const now = Date.now();
	const leasedRuns: readonly WorkWitnessRun[] = [
		{ name: "a-leased", leased: true },
		{ name: "b-neighbour", leased: false },
		{ name: "c-neighbour", leased: false },
	];
	const exhaustingRuns: readonly WorkWitnessRun[] = [
		{ name: "a-expensive", leased: true, artifacts: { count: 6, bytes: 1 } },
		{ name: "b-neighbour", leased: false },
		{ name: "c-neighbour", leased: false },
	];
	const unleasedRuns: readonly WorkWitnessRun[] = [
		{ name: "a-unleased", leased: false },
		{ name: "b-neighbour", leased: false },
		{ name: "c-neighbour", leased: false },
	];
	const heavyRuns: readonly WorkWitnessRun[] = [
		{ name: "a-heavy", leased: false, artifacts: { count: 1, bytes: 1000 } },
		{ name: "b-neighbour", leased: false },
		{ name: "c-neighbour", leased: false },
	];
	/** One run whose payload of `bytes` is counted, and whose sub-directory listing is refused: an incomplete measurement, beside two counted neighbours. */
	const partialRuns = (bytes: number): readonly WorkWitnessRun[] => [
		{ name: "a-partial", leased: false, artifacts: { count: 1, bytes }, nestedDirectory: "zz-nested" },
		{ name: "b-neighbour", leased: false },
		{ name: "c-neighbour", leased: false },
	];
	return {
		leasedExhausted: runWorkTenantPrune(world, {
			tenant: "leased-exhausted",
			runs: exhaustingRuns,
			now,
			bounds: { maxScannedEntries: 3 },
		}),
		leasedUnmeasured: runWorkTenantPrune(world, {
			tenant: "leased-unmeasured",
			runs: leasedRuns,
			now,
			refusedRun: "a-leased",
		}),
		leasedControl: runWorkTenantPrune(world, { tenant: "leased-control", runs: leasedRuns, now }),
		unleasedUnmeasured: runWorkTenantPrune(world, {
			tenant: "unleased-unmeasured",
			runs: unleasedRuns,
			now,
			refusedRun: "a-unleased",
		}),
		unleasedControl: runWorkTenantPrune(world, { tenant: "unleased-control", runs: unleasedRuns, now }),
		countEviction: runWorkTenantPrune(world, {
			tenant: "count-eviction",
			runs: unleasedRuns,
			now,
			refusedRun: "a-unleased",
			bounds: { maxRuns: 2 },
		}),
		countControl: runWorkTenantPrune(world, {
			tenant: "count-control",
			runs: unleasedRuns,
			now,
			bounds: { maxRuns: 2 },
		}),
		overBudgetEviction: runWorkTenantPrune(world, { tenant: "over-budget", runs: heavyRuns, now }),
		// The scan counts a-partial's payload, then refuses the listing of zz-nested, so the run is measured incomplete. Its counted bytes (the payload
		// plus the manifest) are over the 1024-byte budget on their own. The former owner charged an incomplete run nothing (its bytes were undefined),
		// so a-partial was never evicted for bytes and this case removed nothing.
		partialByteEviction: runWorkTenantPrune(world, {
			tenant: "partial-bytes",
			runs: partialRuns(2000),
			now,
			refusedRun: "a-partial",
			refusedDirectory: "artifacts/zz-nested",
		}),
		// Normal order: the same incomplete shape with about 300 counted bytes, well under the budget, so nothing is evicted for bytes.
		partialByteControl: runWorkTenantPrune(world, {
			tenant: "partial-control",
			runs: partialRuns(300),
			now,
			refusedRun: "a-partial",
			refusedDirectory: "artifacts/zz-nested",
		}),
		ageEviction: runWorkTenantPrune(world, {
			tenant: "age-eviction",
			runs: [{ name: "a-stale", leased: false }],
			now,
			pruneAt: now + 2 * WORK_WITNESS_MAX_AGE_MS,
			refusedRun: "a-stale",
		}),
		ageControl: runWorkTenantPrune(world, {
			tenant: "age-control",
			runs: [{ name: "a-stale", leased: false }],
			now,
			pruneAt: now + 2 * WORK_WITNESS_MAX_AGE_MS,
		}),
		removalRefusal: removalRefusalWitness(world, now),
		leaseProbes: leaseProbeWitness(world, now),
		unknownProbePrune: runWorkTenantPrune(world, {
			tenant: "unknown-probe",
			runs: [
				{ name: "a-probe", leased: false, marker: { pid: 880201, state: "unknown" } },
				{ name: "b-dead", leased: false, marker: { pid: 880202, state: "dead" } },
				{ name: "c-neighbour", leased: false },
			],
			now,
			bounds: { maxRuns: 2 },
		}),
		deadProbePrune: runWorkTenantPrune(world, {
			tenant: "dead-probe",
			runs: [
				{ name: "a-probe", leased: false, marker: { pid: 880203, state: "dead" } },
				{ name: "b-dead", leased: false, marker: { pid: 880202, state: "dead" } },
				{ name: "c-neighbour", leased: false },
			],
			now,
			bounds: { maxRuns: 2 },
		}),
		adoption: workAdoptionWitness(world),
	};
}

/** Session-owned memory diagnostics stay live, ambiguous durable history warns again on reload, and closing drains stay bounded. */
async function sessionWarningRoutesWitness(world: HarnessWorld): Promise<SessionWarningRoutesWitness> {
	// E13b intentionally retains a failed physical-join lane in the journey's shared agent directory. These independent
	// SDK owners use their own agent directory; the real reload guard must continue to see the original retained lane.
	const agentDir = `${world.agentDir}-session-warnings`;
	const sharedBefore = getInFlightWorkUnits(world.agentDir).map((unit) => ({ ...unit }));
	const sharedRetainedLanePresent = sharedBefore.some(
		(unit) => unit.kind === "lane" && unit.label === "worker:worker-1",
	);
	let dedicatedScopeQuiescent = getInFlightWorkUnits(agentDir).length === 0;
	if (!sharedRetainedLanePresent || !dedicatedScopeQuiescent)
		throw new Error(
			"warning reload scope premise is not the retained shared lane beside a quiescent independent SDK directory",
		);
	const closing: string[][] = [];
	const optional = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: { memorySystem: "okf" },
		closingSink: (warnings) => closing.push([...warnings]),
	});
	let initializeCalls = 0;
	let failInitialize = true;
	optional.session.registerMemoryProvider({
		name: "witness-session-optional",
		isAvailable: () => true,
		getCapabilities: () => ({ surfaces: [] }),
		initialize: async () => {
			initializeCalls++;
			if (failInitialize) throw new Error("optional init failed Bearer\topaque0123456789token");
		},
		shutdown: async () => {},
	});
	const liveListenerWarnings: string[] = [];
	const unsubscribe = optional.session.subscribe((event) => {
		if (event.type === "warning") liveListenerWarnings.push(event.message);
	});
	const consoleLines: string[] = [];
	const logError = console.error;
	console.error = (...data: unknown[]) => {
		const line = data.map(String).join(" ");
		if (line.startsWith("Memory provider witness-session-optional ")) consoleLines.push(line);
		else logError(...data);
	};
	const failureMark = world.warnings.length;
	let failureWarnings: string[];
	let controlWarnings: string[];
	try {
		await optional.session.initializeMemory();
		failureWarnings = world.warnings.splice(failureMark);
		failInitialize = false;
		const controlMark = world.warnings.length;
		await optional.session.initializeMemory();
		controlWarnings = world.warnings.splice(controlMark);
	} finally {
		console.error = logError;
		unsubscribe();
	}
	const optionalDisposal = await world.disposeSessionInBody(optional.session);
	const disposedSnapshot = optional.session.getResourceSnapshot();
	for (let index = 0; index < 101; index++) {
		optional.session.emitHostWarning(
			index === 0 ? `${"a".repeat(499)}\u{1f9ed}tail` : `overflow-${index}: ${"x".repeat(600)}`,
		);
	}
	await optional.session.disposeAndWait();
	const retained = closing[0] ?? [];
	const expectedRetained = Array.from({ length: 100 }, (_, index) => {
		if (index === 0) return `${"a".repeat(499)}…`;
		const prefix = `overflow-${index}: `;
		return `${prefix}${"x".repeat(499 - prefix.length)}…`;
	});
	const emptyRepeatedDrain = optional.session.takeUndeliveredWarnings().length === 0;
	await optional.session.disposeAndWait();
	const cleanReentry =
		closing.length === 1 && isDeepStrictEqual(disposedSnapshot, optional.session.getResourceSnapshot());

	// A loaded end without its start is valid persisted syntax and ambiguous lifecycle evidence. Opening the crafted file
	// establishes the inspector's actual in-memory branch; changing disk behind an already loaded manager would not do so.
	const fixtureManager = world.createSessionManager(agentDir);
	const file = fixtureManager.getSessionFile();
	if (file === undefined) throw new Error("lifecycle warning witness has no session path");
	const timestamp = new Date().toISOString();
	const ambiguous = {
		type: "compaction_end",
		id: "warning-end",
		parentId: null,
		timestamp,
		compactionId: "warning-compaction",
		outcome: "interrupted",
	};
	world.io.seed(
		file,
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: fixtureManager.getSessionId(), timestamp, cwd: HARNESS_PROJECT_CWD })}\n${JSON.stringify(ambiguous)}\n`,
	);
	const reopened = world.openSessionManager(file, agentDir);
	const refusalReasons = reopened.inspectSessionLifecycle().refusalReasons;
	const heldMark = world.warnings.length;
	const lifecycleOwner = await world.createRootSession("root", {
		agentDir,
		sessionManager: reopened,
		systemOneEnabled: false,
		settings: { memorySystem: "okf" },
	});
	const heldWarnings = world.warnings.splice(heldMark);
	const reloadMark = world.warnings.length;
	await lifecycleOwner.session.reload();
	const liveReloadWarnings = world.warnings.splice(reloadMark);
	const ambiguousEntries = reopened.getEntries().filter((entry) => entry.type === "compaction_end");
	const ambiguousEntryUnchanged =
		ambiguousEntries.length === 1 && JSON.stringify(ambiguousEntries[0]) === JSON.stringify(ambiguous);
	const lifecycleDisposal = await world.disposeSessionInBody(lifecycleOwner.session);
	const normalMark = world.warnings.length;
	const normal = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: { memorySystem: "okf" },
	});
	await normal.session.reload();
	const normalWarnings = world.warnings.splice(normalMark);
	await world.disposeSessionInBody(normal.session);
	dedicatedScopeQuiescent = dedicatedScopeQuiescent && getInFlightWorkUnits(agentDir).length === 0;
	const sharedRegistrationsUnchanged = isDeepStrictEqual(sharedBefore, getInFlightWorkUnits(world.agentDir));
	return {
		reloadScope: { sharedRetainedLanePresent, dedicatedScopeQuiescent, sharedRegistrationsUnchanged },
		optionalProvider: {
			initializeCalls,
			failureWarnings,
			liveListenerWarnings,
			consoleLines,
			controlWarnings,
			disposal: optionalDisposal,
		},
		lifecycle: {
			refusalReasons,
			heldWarnings,
			liveReloadWarnings,
			ambiguousEntryUnchanged,
			controlWarnings: normalWarnings,
			disposal: lifecycleDisposal,
		},
		overflow: {
			closingCalls: closing.length,
			retainedCount: Math.max(0, retained.length - 1),
			boundedEntriesExact: isDeepStrictEqual(retained.slice(0, 100), expectedRetained),
			astralBoundaryExact: retained[0] === `${"a".repeat(499)}…` && retained[0].length === 500,
			disclosure: retained[100],
			emptyRepeatedDrain,
			cleanReentry,
		},
	};
}

/** Real SDK runs: end-listener refusal reaches all listeners without fabricating failure, and failed-run cleanup keeps its original cause. */
async function runLifecycleWitness(world: HarnessWorld): Promise<SdkConstructionFailureWitness["runLifecycle"]> {
	const results: {
		-readonly [K in keyof SdkConstructionFailureWitness["runLifecycle"]]?: SdkConstructionFailureWitness["runLifecycle"][K];
	} = {};
	for (const variant of ["refusedEnd", "failedRun", "control"] as const) {
		const owner = await world.createRootSession("root", {
			systemOneEnabled: false,
			sessionManager: world.createSessionManager(),
			settings: { memorySystem: "okf" },
		});
		let firstEnds = 0;
		let secondEnds = 0;
		const hold = createBarrier();
		const reached = createBarrier();
		const first = owner.session.agent.subscribe(async (event) => {
			if (variant !== "refusedEnd" && event.type === "message_start" && event.message.role === "user") {
				reached.release();
				await hold.promise;
				if (variant === "failedRun") throw new Error("original run failure");
			}
			if (
				variant === "failedRun" &&
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.errorMessage === "original run failure"
			)
				throw new Error("failure-record refusal");
			if (event.type !== "agent_end") return;
			firstEnds++;
			if (variant === "refusedEnd") throw new Error("run-end refusal");
			if (variant === "failedRun") throw new Error("failed-end refusal");
		});
		const second = owner.session.agent.subscribe((event) => {
			if (event.type === "agent_end") secondEnds++;
		});
		if (variant !== "failedRun")
			world.provider.enqueue("root", {
				name: `listener-${variant}`,
				reply: { content: [{ type: "text", text: `Completed ${variant}.` }] },
			});
		const run = owner.session.prompt(`Run the ${variant} lifecycle boundary.`).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (variant !== "refusedEnd") {
			try {
				await withDeadline(
					world.trace,
					`listener ${variant}: owner run holds before provider work`,
					reached.promise,
				);
				world.shell.enqueue(
					...["first", "second"].map((name) => {
						// The public command is portable. The scripted transport receives the real router's backend projection,
						// including Windows' PowerShell floor when explicit operations disable the Python engine.
						const route = routeShellContract(`echo -n ${name}`, process.platform, { pythonEngine: false });
						if (route.kind !== "passthrough" && route.kind !== "powershell")
							throw new Error("bash publication fixture command did not reach a supported shell route");
						return {
							name: `listener-${variant}-bash-${name}`,
							command: route.command,
							output: name,
							exitCode: 0,
						};
					}),
				);
				await owner.session.executeBash("echo -n first", undefined, { operations: world.shell });
				await owner.session.executeBash("echo -n second", undefined, { operations: world.shell });
				if (!owner.session.hasPendingBashMessages)
					throw new Error(`${variant}: owner bash outputs were not deferred by the real streaming session`);
				if (variant === "failedRun") {
					const file = owner.sessionManager.getSessionFile();
					world.io.failNext({
						name: "bash-second-append-refused",
						kind: "append",
						code: "EIO",
						matches: (operation, data) =>
							operation.path === file && data?.includes('"command":"echo -n second"') === true,
					});
				}
			} finally {
				hold.release();
			}
		}
		const failure = await withDeadline(world.trace, `listener ${variant}: run settles`, run);
		if (variant === "control") {
			if (failure !== undefined) throw failure;
		} else {
			if (failure === undefined) throw new Error(`${variant}: the refusing listener produced no caller failure`);
			world.trace.claimRejection(failure, variant === "refusedEnd" ? "run-end refusal" : "failure-record refusal");
		}
		await owner.session.agent.waitForIdle();
		const errors = owner.session.state.messages.filter(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		const idle = !owner.session.isStreaming;
		const publishedBash = () =>
			owner.session.state.messages
				.filter((message) => message.role === "bashExecution")
				.map((message) => (message.role === "bashExecution" ? message.command : ""));
		const persistedBash = () =>
			owner.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.command] : [],
				);
		if (variant === "failedRun") {
			const published = publishedBash();
			const persisted = owner.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.command] : [],
				);
			let retryRefused = false;
			try {
				await owner.session.prompt("Retry the failed owner flush before starting provider work.");
			} catch (error) {
				retryRefused = error instanceof Error && error.message.includes("persistence state is uncertain");
				world.trace.claimRejection(error, /persistence state is uncertain/);
			}
			const retryDidNotDuplicate = isDeepStrictEqual(publishedBash(), published);
			const pendingSuffix = owner.session.hasPendingBashMessages;
			const file = owner.sessionManager.getSessionFile();
			if (file === undefined) throw new Error("bash recovery has no persisted session file");
			const canonical = world.io.peekFile(file) ?? "";
			const canonicalPrefixConfirmed =
				canonical.includes('"command":"echo -n first"') && !canonical.includes('"command":"echo -n second"');
			if (!canonicalPrefixConfirmed)
				throw new Error("pre-write bash refusal did not preserve the exact committed prefix");
			first();
			second();
			// This is recovery from the witnessed pre-write refusal, not a claim about a write that may have physically completed.
			owner.sessionManager.setSessionFile(file);
			world.provider.enqueue("root", {
				name: "listener-repaired-bash",
				reply: { content: [{ type: "text", text: "Reopened owner resumes after its bash suffix commits." }] },
			});
			await owner.session.prompt("Resume after reopening the session's witnessed committed prefix.");
			results.failedRun = {
				failure: describeErrorEntry(failure),
				firstEnds,
				secondEnds,
				originalFailureMessages: errors.filter(
					(message) => message.role === "assistant" && message.errorMessage === "original run failure",
				).length,
				idle,
				bashCleanup: {
					faultFired: world.io.consumedFaults.includes("bash-second-append-refused"),
					published,
					persisted,
					pendingSuffix,
					retryRefused,
					retryDidNotDuplicate,
					canonicalPrefixConfirmed,
					repairedPublished: publishedBash(),
					repairedPersisted: persistedBash(),
					repairedPendingEmpty: !owner.session.hasPendingBashMessages,
				},
			};
		} else if (variant === "refusedEnd")
			results.refusedEnd = {
				failure: describeErrorEntry(failure),
				firstEnds,
				secondEnds,
				fabricatedFailures: errors.length,
				idle,
			};
		else
			results.control = {
				firstEnds,
				secondEnds,
				fabricatedFailures: errors.length,
				idle,
				publishedBash: publishedBash(),
				persistedBash: persistedBash(),
			};
		first();
		second();
		await world.disposeSessionInBody(owner.session);
	}
	if (results.refusedEnd === undefined || results.failedRun === undefined || results.control === undefined)
		throw new Error("run lifecycle variant did not execute");
	return { refusedEnd: results.refusedEnd, failedRun: results.failedRun, control: results.control };
}

/** A persisted interrupted source has paid metadata but no reply: its real fork is unwritten when the runtime captures the copy baseline. */
async function unwrittenForkWitness(world: HarnessWorld): Promise<SdkConstructionFailureWitness["unwrittenFork"]> {
	const source = world.createSessionManager();
	const sourceFile = source.getSessionFile();
	if (sourceFile === undefined) throw new Error("unwritten fork source has no path");
	const timestamp = new Date().toISOString();
	const copiedUsage = createEmptyUsage();
	copiedUsage.input = 19;
	copiedUsage.totalTokens = 19;
	const copied = {
		type: "custom",
		id: "unwritten-paid-copy",
		parentId: null,
		timestamp,
		customType: SEMANTIC_USAGE_CUSTOM_TYPE,
		data: semanticUsageReportOf({
			receiptId: "unwritten-copy-usage",
			provider: HARNESS_PROVIDER,
			model: "root",
			attempt: 1,
			costStatus: "unpriced",
			route: "history_summary",
			usage: copiedUsage,
		}),
	};
	world.io.seed(
		sourceFile,
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: source.getSessionId(), timestamp, cwd: HARNESS_PROJECT_CWD })}\n${JSON.stringify(copied)}\n`,
	);
	const reopened = world.openSessionManager(sourceFile);
	let candidateFile: string | undefined;
	let absentAtRuntimeConstruction = false;
	let copiedPaidRowsAtConstruction = 0;
	const routed: string[] = [];
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager }) => {
			if (sessionManager.getSessionId() !== reopened.getSessionId()) {
				candidateFile = sessionManager.getSessionFile();
				absentAtRuntimeConstruction = candidateFile !== undefined && !world.io.existsSync(candidateFile);
				copiedPaidRowsAtConstruction = sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE).length;
			}
			const root = await world.createRootSession("root", {
				agentDir,
				sessionManager,
				systemOneEnabled: false,
				settings: { memorySystem: "okf" },
			});
			return {
				session: root.session,
				sessionManager: root.sessionManager,
				getExtensionRunner: root.getExtensionRunner,
				extensionsResult: root.extensionsResult,
				services: {
					cwd,
					agentDir,
					authStorage: world.authStorage,
					settingsManager: root.settingsManager,
					modelRegistry: world.modelRegistry,
					resourceLoader: root.session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		},
		{
			cwd: HARNESS_PROJECT_CWD,
			agentDir: world.agentDir,
			sessionManager: reopened,
			onTerminalWarnings: (warnings) => routed.push(...warnings),
		},
	);
	let firstReplyReached = false;
	runtime.setRebindSession(async (session) => {
		if (session.sessionFile === sourceFile) return;
		if (!absentAtRuntimeConstruction || copiedPaidRowsAtConstruction !== 1)
			throw new Error("unwritten-fork baseline premise was not reached");
		world.provider.enqueue("root", {
			name: "unwritten-fork-first-reply",
			reply: { content: [{ type: "text", text: "Candidate writes its first reply." }] },
		});
		await session.prompt("Write this candidate's first reply before its activation is refused.");
		firstReplyReached =
			world.provider.reached.includes("root:unwritten-fork-first-reply") &&
			candidateFile !== undefined &&
			world.io.existsSync(candidateFile);
		throw new Error("unwritten candidate activation refused");
	});
	const warningMark = world.warnings.length;
	let rejection: unknown;
	try {
		await runtime.fork(copied.id, { position: "at" });
	} catch (error) {
		rejection = error;
	}
	if (!(rejection instanceof Error) || !rejection.message.includes("unwritten candidate activation refused"))
		throw new Error("unwritten fork activation did not preserve its refusal");
	const warnings = [...world.warnings.splice(warningMark), ...runtime.session.takeUndeliveredWarnings(), ...routed];
	const candidateKept = candidateFile !== undefined && world.io.existsSync(candidateFile);
	const paidCopyDisclosed = warnings.some(
		(warning) =>
			warning.startsWith("Usage handoff: 1 paid usage row(s) are present in ") &&
			warning.includes("rows copied from a source session may also be recorded there."),
	);
	const previousRestored = runtime.sessionManager.getSessionId() === reopened.getSessionId();
	await runtime.dispose();
	return {
		absentAtRuntimeConstruction,
		copiedPaidRowsAtConstruction,
		firstReplyReached,
		candidateKept,
		paidCopyDisclosed,
		previousRestored,
	};
}

/** The unchanged history-share bound is reached by one bounded stored journal, then two real summary calls cover overflow and late delivery. */
async function historyUsageBoundsWitness(
	world: HarnessWorld,
): Promise<SdkConstructionFailureWitness["historyUsageBounds"]> {
	const manager = world.createSessionManager();
	const slot = journalSlotOf(createSessionManagerLedgerPort(manager).identity());
	if (slot === undefined) throw new Error("history usage bound witness has no journal slot");
	const storedUsage = createEmptyUsage();
	storedUsage.input = 1;
	storedUsage.totalTokens = 1;
	const createdAt = new Date().toISOString();
	const records = Array.from({ length: SEMANTIC_USAGE_JOURNAL_MAX_RECORDS / 2 }, (_, index) => {
		const reportId = `stored-history-${index}`;
		return {
			reportId,
			payload: {
				receiptId: reportId,
				provider: HARNESS_PROVIDER,
				model: "root",
				attempt: 1,
				route: "history_summary",
				costStatus: "unpriced",
				usage: storedUsage,
			},
			createdAt,
		};
	});
	// Stored recovery input, not 512 provider requests: it remains within the journal's unchanged record/byte validator.
	world.io.seed(
		slot.path,
		JSON.stringify({
			version: 1,
			kind: "semantic-usage-pending",
			sessionId: slot.sessionId,
			sessionFile: slot.sessionFile,
			headerTimestamp: slot.headerTimestamp,
			updatedAt: createdAt,
			records,
			conflicts: [],
			droppedConflicts: 0,
		}),
	);
	const validated = readJournal(slot);
	if (validated?.records.length !== 512) throw new Error("history share bound journal premise did not validate");
	const warningMark = world.warnings.length;
	const closing: string[] = [];
	const owner = await world.createRootSession("root", {
		sessionManager: manager,
		systemOneEnabled: false,
		settings: { memorySystem: "okf" },
		closingSink: (warnings) => closing.push(...warnings),
	});
	const delivery = sessionSemanticUsageOf(manager);
	if (delivery.snapshot().retained !== 512)
		throw new Error("session usage owner did not adopt the history-share bound");
	const baseline = owner.session.getCumulativeUsage().totalTokens;
	const resolution = resolveTranscriptSummarizer(`${HARNESS_PROVIDER}/root`, {
		resolveModel: () => world.provider.model("root"),
		runIsolatedCompletion: (options) => owner.session.runIsolatedCompletion(options),
		recordHistoryUsage: (usage, call) => delivery.recordHistoryUsage(usage, call),
	});
	if (!resolution.ok) throw new Error(resolution.reason);
	const summarySignal = new AbortController().signal;
	const paid = createEmptyUsage();
	paid.input = 11;
	paid.output = 7;
	paid.totalTokens = 18;
	world.provider.enqueue("root", {
		name: "history-share-overflow",
		reply: { content: [{ type: "text", text: "Bounded summary." }], usage: paid },
	});
	await resolution.summarizer.summarize(
		{
			system: "Summarize this archived conversation.",
			prompt: "One bounded archived source.",
			maxOutputBytes: 128,
		},
		summarySignal,
	);
	const overflow = delivery.pendingProjection().overflow;
	const liveDelta = owner.session.getCumulativeUsage().totalTokens - baseline;
	const hold = createBarrier();
	const reached = createBarrier();
	const latePaid = createEmptyUsage();
	latePaid.input = 13;
	latePaid.output = 10;
	latePaid.totalTokens = 23;
	world.provider.enqueue("root", {
		name: "history-summary-after-disposal",
		gate: hold.promise,
		check: () => reached.release(),
		reply: { content: [{ type: "text", text: "Late summary." }], usage: latePaid },
	});
	const late = resolution.summarizer.summarize(
		{
			system: "Summarize this archived conversation.",
			prompt: "A second bounded archived source.",
			maxOutputBytes: 128,
		},
		summarySignal,
	);
	let disposedUsage = 0;
	try {
		await withDeadline(world.trace, "history usage: the second real provider call is held", reached.promise);
		const disposal = await world.disposeSessionInBody(owner.session);
		if (disposal !== undefined) throw disposal.error;
		disposedUsage = owner.session.getCumulativeUsage().totalTokens;
	} finally {
		hold.release();
		await withDeadline(world.trace, "history usage: released late summary physically settles", late);
	}
	const disposedOwnerUncharged = owner.session.getCumulativeUsage().totalTokens === disposedUsage;
	const lateJournalTokens =
		readJournal(slot)?.records.find((record) => !record.reportId.startsWith("stored-history-"))?.payload.usage
			.totalTokens ?? 0;
	const reopened = await world.createRootSession("root", {
		sessionManager: manager,
		systemOneEnabled: false,
		settings: { memorySystem: "okf" },
		closingSink: (warnings) => closing.push(...warnings),
	});
	const reopenedDelta = reopened.session.getCumulativeUsage().totalTokens - baseline;
	const overflowAbsentOnReopen = sessionSemanticUsageOf(manager).pendingProjection().overflow === undefined;
	const disposal = await world.disposeSessionInBody(reopened.session);
	if (disposal !== undefined) throw disposal.error;
	const warnings = [
		...world.warnings.splice(warningMark),
		...owner.session.takeUndeliveredWarnings(),
		...reopened.session.takeUndeliveredWarnings(),
		...closing,
	];
	const overflowText =
		"A history summary usage report could not be retained (the usage journal has no room for it); its spend is counted in this session's live total only and is lost when the session is reopened.";
	const lateText =
		"A history summary usage report was kept in the session journal after its session ended; it is recorded when a session manager next opens the file.";
	const allWarningsClassified = warnings.every(
		(warning) =>
			warning === overflowText ||
			warning === lateText ||
			(warning.startsWith("Usage handoff: ") && warning.includes("none is charged to another session.")),
	);
	return {
		seededRecords: validated.records.length,
		liveOverflowTokens: overflow?.usage.totalTokens ?? 0,
		overflowReports: overflow?.reports ?? 0,
		liveDelta,
		overflowWarning: warnings.includes(overflowText),
		lateProviderReached: world.provider.reached.includes("root:history-summary-after-disposal"),
		disposedOwnerUncharged,
		lateJournalTokens,
		reopenedDelta,
		overflowAbsentOnReopen,
		lateWarning: warnings.includes(lateText),
		allWarningsClassified,
	};
}

/**
 * The SDK's construction failures: the objective-loop binding error, then the extension read after memory initialization with its held memory
 * warning routed three ways, and the normal-order control. Each creation consumes its own memory read fault. The disposal branches then fail
 * the artifact cleanup of a disposal that follows the same extension read, with the normal-order control over the same seeded artifact. The
 * provider-error witnesses (the memory manager's diagnostics for a failing initialization) and the work-directory witnesses (retention,
 * lease liveness and adoption over the same virtual filesystem) run last.
 */
export async function runSdkConstructionFailure(world: HarnessWorld): Promise<SdkConstructionFailureWitness> {
	const objective = await objectiveSdkCreation(world);
	const drained = await failedSdkCreation(world, "drained", "accepts");
	const sinkRefused = await failedSdkCreation(world, "sink-refused", "refuses");
	const noSink = await failedSdkCreation(world, "no-sink", "none");
	const control = await controlSdkCreation(world);
	const disposalFailed = await disposalSdkCreation(world, "disposal-failed", true);
	const disposalControl = await disposalSdkCreation(world, "disposal-control", false);
	const providerErrors = await providerErrorsWitness(world);
	const workDirectory = workDirectoryWitness(world);
	const sessionWarningRoutes = await sessionWarningRoutesWitness(world);
	const runLifecycle = await runLifecycleWitness(world);
	const unwrittenFork = await unwrittenForkWitness(world);
	const historyUsageBounds = await historyUsageBoundsWitness(world);
	return {
		objective,
		drained,
		sinkRefused,
		noSink,
		control,
		disposalFailed,
		disposalControl,
		providerErrors,
		workDirectory,
		sessionWarningRoutes,
		runLifecycle,
		unwrittenFork,
		historyUsageBounds,
	};
}

/**
 * Two native branch copies of a session at its current leaf. Each is a new session file with its own identity; the source manager is only
 * read, so the session it came from continues untouched.
 */
export function branchForClosingReflection(manager: SessionManager | undefined): {
	readonly held: SessionManager;
	readonly control: SessionManager;
} {
	if (manager === undefined) throw new Error("the closing reflection has no owner session to branch");
	const leafId = manager.getLeafId();
	if (leafId === null) throw new Error("the closing reflection owner has no leaf to branch from");
	return { held: manager.createBranchedSessionManager(leafId), control: manager.createBranchedSessionManager(leafId) };
}

/** The reflection's cue state as the reflection gate reads it on a branch. */
interface ReflectionCueProbe {
	readonly status?: string;
	readonly triggers?: readonly string[];
}

/** The triggers that buy a reflection turn (`REFLECTION_TURN_WORTHY_TRIGGERS`, reflection-controller.ts; not exported). */
const CLOSING_WORTHY_TRIGGERS: readonly string[] = ["complex", "corrective", "durable", "session-end"];

function reflectionCueProbe(manager: SessionManager): ReflectionCueProbe | undefined {
	return manager.getLatestCustomEntryOnBranch(CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE)?.data as
		| ReflectionCueProbe
		| undefined;
}

/**
 * Throws, with the bounded gate state, unless a reopened copy reaches the closing reflection: okf memory, a due cue with a worthy trigger,
 * and no goal or task step in progress. Without those the quit has no reflection to hold, so the witness cannot say anything.
 */
function requireClosingReflectionGate(session: AgentSession, manager: SessionManager): void {
	const cue = reflectionCueProbe(manager);
	const goal = session.getGoalStateSnapshot();
	const steps = session.getTaskStepsStateSnapshot()?.steps ?? [];
	const inProgress = steps.filter((step) => step.status === "in_progress").length;
	const worthy = cue?.triggers?.some((trigger) => CLOSING_WORTHY_TRIGGERS.includes(trigger)) === true;
	const open = (goal !== undefined && isGoalExecutionActive(goal.status)) || inProgress > 0;
	if (session.getMemorySystem() === "okf" && cue?.status === "due" && worthy && !open) return;
	const state = { memorySystem: session.getMemorySystem(), cue, goal: goal?.status, inProgressSteps: inProgress };
	throw new Error(
		`the reopened copy does not reach the closing reflection gate: ${JSON.stringify(state).slice(0, 600)}`,
	);
}

/**
 * Holds the reflection turn at its `input` event: `reached` is released when the reflection's own prompt arrives, and nothing reaches the
 * provider until `hold` is released. Any other input passes straight through.
 */
function holdReflectionTurn(hold: Barrier, reached: Barrier, reflectionPrompt: string): ExtensionFactory {
	return (pi) => {
		pi.on("input", async (event) => {
			if (event.text !== reflectionPrompt) return;
			reached.release();
			await hold.promise;
		});
	};
}

function carriesReflectionMarker(request: ScriptedRequest, marker: string): boolean {
	return request.context.messages.some((message) => JSON.stringify(message).includes(marker));
}

/** Warnings since `mark`, without the closing verification notice that System One's own closing work emits. */
function warningsSince(world: HarnessWorld, mark: number): string[] {
	return world.warnings.slice(mark).filter((message) => message !== CLOSING_VERIFICATION_NOTICE);
}

/**
 * What a closing reflection leaves behind. The held owner quits while its reflection waits at the input hold; `quitWarnings` and
 * `warningsAfterRelease` are the disclosures, `fileUnchangedByRelease` the byte comparison, and the control is the normal order, where the
 * reflection's provider step is consumed before the owner quits.
 */
export interface ClosingReflectionTimeoutWitness {
	readonly heldCueStatus: string | undefined;
	readonly quitWarnings: readonly string[];
	readonly warningsAfterRelease: readonly string[];
	readonly providerRequestsAfterQuit: number;
	readonly fileUnchangedByRelease: boolean;
	readonly controlReflectionReached: boolean;
	readonly controlDisposal: unknown;
	readonly controlQuitWarnings: readonly string[];
}

/**
 * Reopens both branch copies in fresh owners and runs the closing reflection in each. The acknowledgement is small talk: its owner words wait
 * in the owner-policy queue and the reflection's routing settles them, so the held owner asks System One nothing and the control asks only the
 * `carries_0` screen. The copies carry the cue the start turn would have bought: `requireClosingReflectionGate` checks it before any turn runs.
 */
export async function runClosingReflectionTimeout(
	world: HarnessWorld,
	copies: { readonly held: SessionManager; readonly control: SessionManager },
	reflectionPrompt: string,
): Promise<ClosingReflectionTimeoutWitness> {
	const { trace } = world;
	const hold = createBarrier();
	const reached = createBarrier();
	const held = await world.createRootSession("root", {
		sessionManager: copies.held,
		extensionFactories: [holdReflectionTurn(hold, reached, reflectionPrompt)],
	});
	const heldSession = held.session;
	await heldSession.bindExtensions({ uiContext: world.humanInput.ui });
	requireClosingReflectionGate(heldSession, held.sessionManager);
	const heldFile = held.sessionManager.getSessionFile();
	if (heldFile === undefined) throw new Error("the held reflection owner has no file");
	world.systemOne.enterPhase("closing-held", {});
	world.provider.enqueue("root", {
		name: "closing-held-ack",
		reply: { content: [{ type: "text", text: "Acknowledged." }] },
	});
	await withDeadline(
		trace,
		"closing held: the acknowledgement completes",
		heldSession.prompt("Acknowledge the closing check."),
	);
	await withDeadline(trace, "closing held: the reflection reaches its input hold", reached.promise);
	const heldCueStatus = reflectionCueProbe(held.sessionManager)?.status;
	const mark = world.warnings.length;
	let fileAtQuit = "";
	let requestsAtQuit = 0;
	let quitWarnings: string[] = [];
	try {
		await withDeadline(
			trace,
			"closing held: the owner quits while the reflection is held",
			heldSession.disposeAndWait(),
			60_000,
		);
		fileAtQuit = world.io.peekFile(heldFile) ?? "";
		requestsAtQuit = world.provider.requests.length;
		quitWarnings = warningsSince(world, mark);
	} finally {
		hold.release();
		await withDeadline(
			trace,
			"closing held: the released reflection settles",
			heldSession.settleReflectionTurn(),
			60_000,
		);
	}
	const fileAfterRelease = world.io.peekFile(heldFile) ?? "";
	const providerRequestsAfterQuit = world.provider.requests.length - requestsAtQuit;
	const warningsAfterRelease = warningsSince(world, mark);

	const released = createBarrier();
	released.release();
	const control = await world.createRootSession("root", {
		sessionManager: copies.control,
		extensionFactories: [holdReflectionTurn(released, createBarrier(), reflectionPrompt)],
	});
	const controlSession = control.session;
	await controlSession.bindExtensions({ uiContext: world.humanInput.ui });
	requireClosingReflectionGate(controlSession, control.sessionManager);
	world.systemOne.enterPhase("closing-control", { carries_0: { kind: "noul", probability: 0.97 } });
	world.provider.enqueue(
		"root",
		{ name: "closing-control-ack", reply: { content: [{ type: "text", text: "Acknowledged." }] } },
		{
			name: "closing-control-reflection",
			check: (request) => {
				if (!carriesReflectionMarker(request, reflectionPrompt)) {
					throw new Error("the turn after the acknowledgement is not the reflection checkpoint");
				}
			},
			reply: { content: [{ type: "text", text: "Nothing durable to record." }] },
		},
	);
	await withDeadline(
		trace,
		"closing control: the acknowledgement completes",
		controlSession.prompt("Acknowledge the closing check."),
	);
	await withDeadline(
		trace,
		"closing control: the reflection completes",
		controlSession.settleReflectionTurn(),
		60_000,
	);
	const controlReflectionReached = world.provider.reached.includes("root:closing-control-reflection");
	const controlMark = world.warnings.length;
	const controlDisposal = await world.disposeSessionInBody(controlSession);
	return {
		heldCueStatus,
		quitWarnings,
		warningsAfterRelease,
		providerRequestsAfterQuit,
		fileUnchangedByRelease: fileAfterRelease.length > 0 && fileAfterRelease === fileAtQuit,
		controlReflectionReached,
		controlDisposal,
		controlQuitWarnings: warningsSince(world, controlMark),
	};
}

/** The closing warning the signal witness's dispose hands to the terminal. Plain text: no control characters. */
export const SIGNAL_CLOSING_WARNING = "Signal witness: a closing warning the held terminal keeps until stop.";
/** The resume command the quit path prints once every cleanup step succeeded. */
export const SIGNAL_RESUME_COMMAND = "pi --session signal-witness";

/**
 * One shutdown of an interactive host with its process effects injected. The dispose hands one closing warning to a held
 * `TerminalWarnings`, whose sink records what the terminal releases. `writesBeforeStop` counts the sink writes made before `stop()`
 * releases the terminal, and `stop` (when given) fails after that release.
 */
export async function runSignalShutdown(script: {
	readonly fromSignal: boolean;
	readonly dispose?: () => Promise<void>;
	readonly drainInput?: () => Promise<void>;
	readonly stop?: () => void;
	readonly resumeCommand?: string;
}): Promise<{
	readonly log: readonly string[];
	readonly writesBeforeStop: number;
	readonly warnings: readonly string[];
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
	readonly exits: readonly number[];
}> {
	const log: string[] = [];
	const warnings: string[] = [];
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exits: number[] = [];
	let sinkWrites = 0;
	const terminal = new TerminalWarnings((released) => {
		sinkWrites++;
		warnings.push(...released);
	});
	terminal.hold();
	let writesBeforeStop = -1;
	const lifecycle = new SignalLifecycle(
		{
			runtimeHost: {
				dispose: async () => {
					log.push("dispose");
					terminal.write([SIGNAL_CLOSING_WARNING]);
					await script.dispose?.();
				},
			},
			ui: {
				start: () => {},
				stop: () => {},
				requestRender: () => {},
				terminal: {
					drainInput: async () => {
						log.push("drain");
						await script.drainInput?.();
					},
				},
			},
			isShutdownRequested: () => false,
			stop: () => {
				log.push("stop");
				writesBeforeStop = sinkWrites;
				terminal.release();
				script.stop?.();
			},
			formatResumeCommand: () => script.resumeCommand,
			showStatus: () => {},
			showError: () => {},
		},
		{
			exit: (code) => {
				exits.push(code);
			},
			stderr: (text) => {
				stderr.push(text);
			},
			stdout: (text) => {
				stdout.push(text);
			},
		},
	);
	await lifecycle.shutdown({ fromSignal: script.fromSignal });
	return { log, writesBeforeStop, warnings, stdout, stderr, exits };
}

/** Closing warning the RPC witness's dispose writes while the stream is open: it must reach the stream as a warning event. */
export const RPC_CLOSING_WARNING = "RPC witness: a closing warning the open stream delivers as a warning event.";
/** A warning written after the host released its stream: it must reach the terminal's sink, not the stream. */
export const RPC_LATE_WARNING = "RPC witness: a warning after the stream was released.";

/** What one RPC host run reported: its stream lines, its failure stream, its exit statuses and the terminal's sink after release. */
interface RpcHostRun {
	readonly lines: readonly Record<string, unknown>[];
	readonly stderr: readonly string[];
	readonly exits: readonly number[];
	/** What the host had done while its dispose was held, before the scenario released it (only with `holdDispose`). */
	readonly whileHeld?: {
		readonly exits: readonly number[];
		readonly stderr: readonly string[];
		readonly sinkWarnings: readonly string[];
		readonly outputFailureHandlers: number;
		readonly flushRequests: number;
	};
	/** The output-failure owners still registered once the host has exited. */
	readonly outputFailureHandlersAfterExit: number;
	/** The closing warnings the stream received as warning events. */
	readonly closingWarningsOnStream: number;
	readonly sinkWarnings: readonly string[];
	readonly flushRequests: number;
	readonly elapsedMs: number;
	readonly startupErrors: readonly unknown[];
}

/**
 * One RPC host on a real runtime of the world, with its process effects injected. The host answers a scripted `get_state` command, then
 * shuts down through its injected termination handler (SIGTERM) or by its input ending. The runtime's dispose is wrapped: the real dispose
 * runs first, then the dispose writes one closing warning to the open stream and fails with two causes when `disposeFails` is set.
 */
export async function runRpcHost(
	world: HarnessWorld,
	trace: HarnessTrace,
	script: {
		readonly trigger: "sigterm" | "stdin-end" | "output-failure";
		readonly disposeFails?: boolean;
		readonly flushNeverResolves?: boolean;
		/**
		 * With the SIGTERM trigger: the dispose's completion holds until the scenario releases it. While it holds, `input-end` ends the input,
		 * and `output-failures` invokes the registered output-failure handler twice (handler lifetime and idempotence: the host stays registered, nothing exits and the cleanup is not restarted). It does NOT drive two real queued writes through the output guard, which the injected writer replaces.
		 */
		readonly holdDispose?: "input-end" | "output-failures";
	},
): Promise<RpcHostRun> {
	const sinkWarnings: string[] = [];
	const terminal = new TerminalWarnings((released) => {
		sinkWarnings.push(...released);
	});
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager }) => {
			const root = await world.createRootSession("root", {
				agentDir,
				sessionManager,
				settings: { memorySystem: "okf" },
			});
			return {
				session: root.session,
				sessionManager: root.sessionManager,
				getExtensionRunner: root.getExtensionRunner,
				extensionsResult: root.extensionsResult,
				services: {
					cwd,
					agentDir,
					authStorage: world.authStorage,
					settingsManager: root.settingsManager,
					modelRegistry: world.modelRegistry,
					resourceLoader: root.session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		},
		{
			cwd: HARNESS_PROJECT_CWD,
			agentDir: world.agentDir,
			sessionManager: world.createSessionManager(),
			onTerminalWarnings: (warnings) => terminal.write(warnings),
		},
	);
	const realDispose = runtime.dispose.bind(runtime);
	const disposeReached = createBarrier();
	const disposeHold = createBarrier();
	runtime.dispose = async () => {
		// The real disposal is in flight while the scenario holds its completion: the shutdown waits on this wrapper, not on the real call.
		const disposal = realDispose();
		if (script.holdDispose !== undefined) {
			disposeReached.release();
			await disposeHold.promise;
		}
		await disposal;
		terminal.write([RPC_CLOSING_WARNING]);
		if (script.disposeFails) {
			throw new AggregateError([new Error("cleanup a"), new Error("cleanup b")], "dispose failed");
		}
	};

	const stdin = new PassThrough();
	const lines: Record<string, unknown>[] = [];
	const stderr: string[] = [];
	const exits: number[] = [];
	const startupErrors: unknown[] = [];
	const signals: TerminationSignalHandler[] = [];
	const outputFailureHandlers: Array<(error: unknown) => void> = [];
	const exited = createBarrier();
	let arrival = createBarrier();
	let flushRequests = 0;
	const io: RpcModeIo = {
		stdin,
		environment: {},
		takeOverStdout: () => {},
		writeStdout: (text) => {
			for (const line of text.split("\n")) {
				if (line.length > 0) lines.push(JSON.parse(line) as Record<string, unknown>);
			}
			const arrived = arrival;
			arrival = createBarrier();
			arrived.release();
		},
		flushStdout: () => {
			flushRequests++;
			return script.flushNeverResolves ? new Promise<void>(() => {}) : Promise.resolve();
		},
		waitForStdoutBackpressure: async () => {},
		stderr: (text) => {
			stderr.push(text);
		},
		exit: (code) => {
			exits.push(code);
			exited.release();
		},
		onTerminationSignal: (handler) => {
			signals.push(handler);
			return () => {};
		},
		onOutputFailure: (handler) => {
			outputFailureHandlers.push(handler);
			return () => {
				const index = outputFailureHandlers.indexOf(handler);
				if (index >= 0) outputFailureHandlers.splice(index, 1);
			};
		},
	};
	// The host never resolves; a startup failure is recorded instead of surfacing as an unhandled rejection.
	void runRpcMode(runtime, terminal, io).catch((error: unknown) => {
		startupErrors.push(error);
	});

	// Waits for an output line that satisfies `match`, whether it was written before or after the call.
	const awaitLine = async (match: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
		while (true) {
			const found = lines.find(match);
			if (found) return found;
			await arrival.promise;
		}
	};
	stdin.write(`${JSON.stringify({ id: "rpc-state", type: "get_state" })}\n`);
	await withDeadline(
		trace,
		"rpc: the host answers the scripted get_state command",
		awaitLine((line) => line.id === "rpc-state"),
	);

	const started = Date.now();
	if (script.trigger === "sigterm") {
		const onSignal = signals[0];
		if (onSignal === undefined) throw new Error("the rpc host registered no termination handler");
		onSignal(143, "SIGTERM");
	} else if (script.trigger === "output-failure") {
		const onFailure = outputFailureHandlers[0];
		if (onFailure === undefined) throw new Error("the rpc host registered no output failure handler");
		onFailure(new Error("stdout write failed"));
	} else {
		stdin.end();
	}
	let whileHeld: RpcHostRun["whileHeld"];
	if (script.holdDispose !== undefined) {
		await withDeadline(trace, "rpc: the dispose reaches its hold", disposeReached.promise);
		if (script.holdDispose === "input-end") {
			// The host's own input-end listener is registered before this one, so once this fires the host has handled the end.
			const inputEnded = createBarrier();
			stdin.once("end", () => inputEnded.release());
			stdin.end();
			await withDeadline(trace, "rpc: the input end is delivered during the dispose", inputEnded.promise);
		} else {
			const onFailure = outputFailureHandlers[0];
			if (onFailure === undefined) throw new Error("the rpc host registered no output failure handler");
			onFailure(new Error("stdout write failed"));
			onFailure(new Error("stdout write failed"));
		}
		whileHeld = {
			exits: [...exits],
			stderr: [...stderr],
			sinkWarnings: [...sinkWarnings],
			outputFailureHandlers: outputFailureHandlers.length,
			flushRequests,
		};
		disposeHold.release();
	}
	await withDeadline(trace, "rpc: the host exits after its shutdown", exited.promise);
	const elapsedMs = Date.now() - started;
	const outputFailureHandlersAfterExit = outputFailureHandlers.length;
	// Release: the stream is detached once the host has exited, so a later warning reaches the terminal's sink.
	terminal.write([RPC_LATE_WARNING]);
	return {
		lines,
		stderr,
		exits,
		whileHeld,
		outputFailureHandlersAfterExit,
		closingWarningsOnStream: lines.filter((line) => line.message === RPC_CLOSING_WARNING).length,
		sinkWarnings,
		flushRequests,
		elapsedMs,
		startupErrors,
	};
}

/** Input end during a held SIGTERM dispose: the host exits once, after the dispose, and the closing warning reaches the stream once. */
export const RPC_INPUT_END_HELD_EXPECTED = {
	whileHeld: { exits: [] },
	exits: [143],
	stderr: [],
	closingWarningsOnStream: 1,
	sinkWarnings: [RPC_LATE_WARNING],
};

/**
 * Output failures during a held SIGTERM dispose: the owner stays registered, the flush is skipped, nothing reports, the closing warning
 * goes to the sink, and the owner is gone once the host exits.
 */
export const RPC_OUTPUT_OWNER_EXPECTED = {
	whileHeld: { exits: [], stderr: [], sinkWarnings: [], outputFailureHandlers: 1, flushRequests: 0 },
	exits: [143],
	stderr: [],
	flushRequests: 0,
	outputFailureHandlersAfterExit: 0,
	closingWarningsOnStream: 0,
	sinkWarnings: [RPC_CLOSING_WARNING, RPC_LATE_WARNING],
};
