/**
 * The operation gate: one check per tool call, after the envelope and the edge. With System One bound it asks
 * about every operation {@link triageOperation} sends to it and applies the verdict: the operator's standing
 * grant of `operation.irreversible` authorizes; otherwise the root asks the operator at the edge and a worker
 * is refused, since only the root can reach the owner. The owner's standing grant is authoritative for
 * either actor, so a granted operation is not judged by System One. Each call names its own authority
 * ({@link OperationCaller}): a call carrying a third party's words, the root's or a worker's, is asked
 * against no owner request and is authorized only by a standing grant.
 *
 * What an operation does is remembered ({@link OperationEffectCache}); only whether the owner's request asks
 * for it is asked fresh, and only when the remembered effects are not nil. A call whose arguments are
 * already known when its assistant message starts executing is judged ahead of its turn in the queue
 * ({@link OperationGate.prewarm}), the calls of one message in a single request. A System One that cannot
 * answer in {@link OPERATION_JUDGMENT_TIMEOUT_MS} leaves the call to run with the doubt shown.
 */

import { tmpdir } from "node:os";
import { harnessLog } from "../../kernel/harness-log.ts";
import { getToolExecutionKey } from "../../kernel/tool-failure-memory.ts";
import type { EdgeOperation } from "../autonomy/edge-policy.ts";
import { englishText, type InterfaceText, interfaceText } from "../language/interface-text.ts";
import type { NestedCallPurpose } from "../tools/nested-tool-call.ts";
import {
	askOperation,
	askOperationBatch,
	OPERATION_EFFECT_IDS,
	OPERATION_REQUEST_ID,
	type OperationEffectEngine,
	type OperationEffectReading,
	type OperationEvaluation,
	type OperationVerdict,
	operationDroveIds,
	operationHasNoEffect,
	operationJudgmentReading,
	readOperationEffects,
	readOperationRequest,
	triageOperation,
	unavailableOperationVerdict,
	verdictFromReadings,
} from "./operation-classifier.ts";
import {
	OperationEffectCache,
	type OperationEffectDurableStore,
	operationEffectKey,
	operationIdentityHash,
} from "./operation-effect-cache.ts";
import { noteDecisionTrace } from "./semantic-evaluation-ledger.ts";

/** p99 of 1,204 recorded calls is under 0.9 s; a call still waiting at 2 s is an outage, not a slow answer. */
export const OPERATION_JUDGMENT_TIMEOUT_MS = 2_000;

type JudgedTriage = Extract<ReturnType<typeof triageOperation>, { kind: "judged" }>;

/**
 * Where a gate decision's answer came from. `"jev"` is the legacy stored id for a System One judgment: decision-ledger
 * rows already carry it, so it stays as the persisted value.
 */
export type OperationDecisionSource = "jev" | "cache" | "outage";

export interface OperationGateDecisionRecord {
	readonly tool: string;
	readonly identityHash: string;
	readonly source: OperationDecisionSource;
	readonly action: OperationVerdict["action"];
	readonly notable: boolean;
	readonly finding: string;
	readonly durationMs: number;
}

/**
 * Who makes the call and whose words it serves. A call made with a third party's words (`thirdParty`) reads no owner
 * request, so a request can never make its operation proceed, and only the owner's standing grants authorize it.
 */
export interface OperationCaller {
	readonly actor: "root" | "worker";
	readonly thirdParty: boolean;
	/** What the call is made for when another call makes it (a watch's check): the operator question names it. */
	readonly purpose?: NestedCallPurpose;
}

export interface OperationGateDeps {
	getEngine(): OperationEffectEngine | undefined;
	/** The owner's latest request; read only for a call that carries no third party's words. */
	getRequest(): string | undefined;
	getScopeCwd(): string;
	/** Identity of the current user turn and its authority; a new one forgets cached verdicts. */
	getTurnKey(): string;
	/** The owner's words are classified lazily; they are settled before the standing authority is read. */
	settleOwnerPolicy?(signal?: AbortSignal): Promise<void>;
	/**
	 * Whether the operator granted `operation.irreversible`; with `standingOnly`, among the owner's standing grants
	 * alone, which alone cover a call carrying a third party's words.
	 */
	isGranted(standingOnly: boolean): boolean;
	/** Ask the operator at the edge; never used for a worker, which is refused instead. */
	askOperator?(
		operation: EdgeOperation,
		signal?: AbortSignal,
	): Promise<{ authorized: boolean; reason?: string; correction?: string }>;
	notify(message: string): void;
	/** Where effect readings are kept across sessions; absent keeps them for this process only. */
	getEffectStore?(): OperationEffectDurableStore | undefined;
	/** Every decision, with where its answer came from: the measurement a cache or a table is judged by. */
	recordDecision?(decision: OperationGateDecisionRecord): void;
	now?(): number;
}

interface Decided {
	readonly verdict: OperationVerdict;
}

/** The kind of a failure for a log line. Its message is not logged: it can carry the request or the command. */
function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

export interface PrewarmCall {
	readonly toolName: string;
	readonly args: unknown;
	readonly cwd: string;
}

export class OperationGate {
	private readonly deps: OperationGateDeps;
	private readonly verdicts = new Map<string, OperationVerdict>();
	private readonly pending = new Map<string, Promise<Decided | undefined>>();
	private readonly cache: OperationEffectCache;
	private turnKey: string | undefined;
	private storeFailureReported = false;
	/** The model that last answered. Readings are kept and read under it, so a model change never serves an older one. */
	private answeringModel: string | undefined;

	constructor(deps: OperationGateDeps) {
		this.deps = deps;
		this.cache = new OperationEffectCache({
			...(deps.getEffectStore ? { durable: deps.getEffectStore } : {}),
			...(deps.now ? { now: deps.now } : {}),
			onDurableFailure: (error) => this.reportStoreFailure(error),
		});
	}

	async check(
		toolName: string,
		args: unknown,
		cwd: string,
		caller: OperationCaller,
		signal?: AbortSignal,
	): Promise<{ block: true; reason: string; correction?: string } | undefined> {
		const { actor, thirdParty } = caller;
		signal?.throwIfAborted();
		await this.deps.settleOwnerPolicy?.(signal);
		signal?.throwIfAborted();
		if (this.deps.isGranted(thirdParty)) return undefined;
		// No semantic engine means deterministic gates own the call. Avoid filesystem identity work
		// on this hot path; System One is an optional quality plane, never an execution dependency.
		const engine = this.deps.getEngine();
		if (!engine) return undefined;
		const scopeCwd = this.deps.getScopeCwd();
		const triage = triageOperation({ toolName, args, cwd, scopeCwd, tempDir: tmpdir() });
		if (triage.kind === "decided") return undefined;
		this.rollTurn();
		const key = this.verdictKey(caller, toolName, args, triage);
		let verdict = this.verdicts.get(key);
		if (!verdict) {
			const warmed = this.pending.get(key);
			this.pending.delete(key);
			const decided = warmed ? await warmed : undefined;
			signal?.throwIfAborted();
			verdict =
				decided?.verdict ??
				(await this.decide(engine, toolName, triage, actor, this.requestFor(thirdParty), signal)).verdict;
			this.verdicts.set(key, verdict);
		}
		const shown = triage.operation.replace(/\s+/g, " ").trim();
		// One sentence in the operator's language for the notice, in English for the model; a watch's check names the watch.
		const told = (text: InterfaceText) =>
			text.interactive.edgeOperation({
				operation: text.interactive.systemOneOperation.subject(
					shown.length <= 160 ? shown : `${shown.slice(0, 159)}…`,
					actor === "worker",
				),
				purpose: caller.purpose,
			});
		if (verdict.action === "proceed") {
			if (verdict.notable) {
				const text = interfaceText();
				this.deps.notify(text.interactive.systemOneOperation.runs(told(text), verdict.finding));
			}
			return undefined;
		}
		if (this.deps.isGranted(thirdParty)) {
			harnessLog.debug("edge", "an operation ran under the owner's grant", () => ({
				tool: toolName,
				actor,
				edgeClass: "operation.irreversible",
				action: verdict.action,
			}));
			const text = interfaceText();
			this.deps.notify(text.interactive.systemOneOperation.runsUnderGrant(told(text), verdict.finding));
			return undefined;
		}
		const stopped = (text: InterfaceText) =>
			text.interactive.systemOneOperation.stopped(verdict.action === "refuse", told(text), verdict.finding);
		const refusal = stopped(englishText());
		if (verdict.action === "refuse" || actor === "worker" || !this.deps.askOperator) {
			harnessLog.debug("edge", "an operation was stopped without asking the operator", () => ({
				tool: toolName,
				actor,
				edgeClass: "operation.irreversible",
				action: verdict.action,
			}));
			this.deps.notify(stopped(interfaceText()));
			return {
				block: true,
				reason: `${refusal} ${actor === "worker" ? "Report the unresolved boundary to the parent or do the work another way." : "Ask the owner before running it, or do the work another way."}`,
			};
		}
		harnessLog.warn("edge", "an operation is held for the operator", () => ({
			tool: toolName,
			actor,
			edgeClass: "operation.irreversible",
		}));
		const answer = await this.deps.askOperator(
			{
				class: "operation.irreversible",
				operation: triage.operation,
				reason: verdict.finding,
				...(caller.purpose ? { purpose: caller.purpose } : {}),
			},
			signal,
		);
		if (answer.authorized) {
			harnessLog.info("edge", "the operator allowed a held operation", () => ({
				tool: toolName,
				edgeClass: "operation.irreversible",
			}));
			return undefined;
		}
		harnessLog.debug("edge", "the operator declined a held operation", () => ({
			tool: toolName,
			edgeClass: "operation.irreversible",
		}));
		return { block: true, reason: answer.reason ?? refusal, correction: answer.correction };
	}

	/**
	 * Starts judging the calls of one assistant message before each reaches {@link check}. One call is
	 * judged as `check` would; several share one request. Nothing here can block or refuse: a failed or
	 * cancelled pre-warm leaves `check` to judge the call itself.
	 */
	prewarm(calls: readonly PrewarmCall[], caller: OperationCaller, signal?: AbortSignal): void {
		if (signal?.aborted || this.deps.isGranted(caller.thirdParty)) return;
		const engine = this.deps.getEngine();
		if (!engine) return;
		const scopeCwd = this.deps.getScopeCwd();
		this.rollTurn();
		const todo: { key: string; toolName: string; triage: JudgedTriage }[] = [];
		for (const call of calls) {
			let triage: ReturnType<typeof triageOperation>;
			try {
				triage = triageOperation({
					toolName: call.toolName,
					args: call.args,
					cwd: call.cwd,
					scopeCwd,
					tempDir: tmpdir(),
				});
			} catch {
				// Identity work (paths, script hashes) failed: this call is simply not judged ahead; `check`
				// repeats the same work on its own path and surfaces the failure there.
				continue;
			}
			if (triage.kind === "decided") continue;
			const key = this.verdictKey(caller, call.toolName, call.args, triage);
			if (this.verdicts.has(key) || this.pending.has(key)) continue;
			const effectKey = this.effectKey(engine, call.toolName, triage);
			if (effectKey && this.cache.get(effectKey)) continue;
			todo.push({ key, toolName: call.toolName, triage });
		}
		if (todo.length === 0) return;
		const never = (error: unknown): undefined => {
			harnessLog.debug("edge", "a pre-warm judgment did not finish; the call is judged when it runs", () => ({
				error: errorName(error),
			}));
			return undefined;
		};
		const request = this.requestFor(caller.thirdParty);
		// The batch asks every call against the owner's request; with none to read, each call is judged on its effects.
		if (todo.length === 1 || request === undefined) {
			for (const entry of todo)
				this.pending.set(
					entry.key,
					this.decide(engine, entry.toolName, entry.triage, caller.actor, request, signal).catch(never),
				);
			return;
		}
		const started = this.now();
		let evaluation: OperationEvaluation | undefined;
		// Every entry is decided from the one batched evaluation, which then gets one trace naming each verdict.
		const decided = askOperationBatch(engine, {
			entries: todo.map((entry) => ({ triage: entry.triage, toolName: entry.toolName })),
			request,
			signal,
			onModel: (model) => {
				this.answeringModel = model;
			},
			onEvaluation: (returned) => {
				evaluation = returned;
			},
			timeoutMs: OPERATION_JUDGMENT_TIMEOUT_MS,
		}).then((all) => {
			const drove: string[] = [];
			const verdicts = todo.map((entry, index): Decided => {
				const answers = all[index] ?? {};
				const effects = readOperationEffects(answers);
				this.remember(engine, entry.toolName, entry.triage, effects);
				const verdict = verdictFromReadings(effects, readOperationRequest(answers), caller.actor);
				this.record(entry.toolName, entry.triage, "jev", verdict, started);
				drove.push(...operationDroveIds(effects, true, `c${index}_`));
				return { verdict };
			});
			if (evaluation)
				noteDecisionTrace(engine, evaluation, {
					decision: verdicts.map((entry, index) => `c${index}: ${entry.verdict.action}`).join(", "),
					drove,
					exit: verdicts.map((entry) => entry.verdict.action).join(","),
					read: operationJudgmentReading,
				});
			return verdicts;
		});
		todo.forEach((entry, index) => {
			this.pending.set(entry.key, decided.then((verdicts): Decided => verdicts[index]!).catch(never));
		});
	}

	private rollTurn(): void {
		const turnKey = this.deps.getTurnKey();
		if (turnKey === this.turnKey) return;
		this.verdicts.clear();
		this.pending.clear();
		this.turnKey = turnKey;
	}

	/** The owner's request a call is asked against; none for a call carrying a third party's words. */
	private requestFor(thirdParty: boolean): string | undefined {
		return thirdParty ? undefined : this.deps.getRequest();
	}

	/** A verdict is kept per caller and authority: the same call made with a third party's words is judged apart. */
	private verdictKey(caller: OperationCaller, toolName: string, args: unknown, triage: JudgedTriage): string {
		const authority = caller.thirdParty ? "third-party" : "owner";
		return `${caller.actor}\u0000${authority}\u0000${getToolExecutionKey(toolName, args)}\u0000${JSON.stringify(triage.identity)}`;
	}

	private effectKey(engine: OperationEffectEngine, toolName: string, triage: JudgedTriage): string | undefined {
		const model = this.answeringModel ?? engine.model;
		return model
			? operationEffectKey({
					model,
					toolName,
					operation: triage.operation,
					identity: triage.identity,
				})
			: undefined;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private remember(
		engine: OperationEffectEngine,
		toolName: string,
		triage: JudgedTriage,
		effects: OperationEffectReading,
	): void {
		const key = this.effectKey(engine, toolName, triage);
		const model = this.answeringModel ?? engine.model;
		if (key && model) this.cache.set(key, model, effects);
	}

	private record(
		toolName: string,
		triage: JudgedTriage,
		source: OperationDecisionSource,
		verdict: OperationVerdict,
		started: number,
	): void {
		try {
			const durationMs = this.now() - started;
			harnessLog.debug("edge", "system one decided an operation", () => ({
				tool: toolName,
				source: source === "jev" ? "system_one" : source,
				action: verdict.action,
				notable: verdict.notable,
				durationMs,
			}));
			this.deps.recordDecision?.({
				tool: toolName,
				identityHash: operationIdentityHash(triage.identity, triage.operation),
				source,
				action: verdict.action,
				notable: verdict.notable,
				finding: verdict.finding,
				durationMs,
			});
		} catch (error) {
			// A measurement that cannot be written never changes a verdict; it is reported once.
			this.reportStoreFailure(error);
		}
	}

	private reportStoreFailure(error: unknown): void {
		if (this.storeFailureReported) return;
		this.storeFailureReported = true;
		harnessLog.warn("edge", "the operation store failed; readings stay in memory", () => ({
			error: errorName(error),
		}));
		this.deps.notify(
			`System One: the shell-gate store failed (${error instanceof Error ? error.message : String(error)}); effect readings stay in memory and decisions are not recorded.`,
		);
	}

	/** One call's verdict: the remembered effects when there are any, System One otherwise. */
	private async decide(
		engine: OperationEffectEngine,
		toolName: string,
		triage: JudgedTriage,
		actor: "root" | "worker",
		request: string | undefined,
		signal?: AbortSignal,
	): Promise<Decided> {
		const started = this.now();
		const effectKey = this.effectKey(engine, toolName, triage);
		const remembered = effectKey ? this.cache.get(effectKey) : undefined;
		let evaluation: OperationEvaluation | undefined;
		const ask = (questions: readonly (typeof OPERATION_REQUEST_ID | (typeof OPERATION_EFFECT_IDS)[number])[]) =>
			askOperation(engine, {
				triage,
				toolName,
				request: request ?? "",
				questions,
				signal,
				timeoutMs: OPERATION_JUDGMENT_TIMEOUT_MS,
				onModel: (model) => {
					this.answeringModel = model;
				},
				onEvaluation: (returned) => {
					evaluation = returned;
				},
			});
		// The asked evaluation's row gets the verdict; remembered effects are named as reused.
		const trace = (verdict: OperationVerdict, effects: OperationEffectReading, cached: boolean) => {
			if (!evaluation) return;
			noteDecisionTrace(engine, evaluation, {
				decision: `${verdict.action}: ${verdict.finding}`,
				drove: operationDroveIds(effects, request !== undefined),
				exit: verdict.action,
				read: operationJudgmentReading,
				...(cached ? { facts: ["effects reused from the effect cache"] } : {}),
			});
		};
		if (remembered && operationHasNoEffect(remembered)) {
			const verdict = verdictFromReadings(remembered, undefined, actor);
			this.record(toolName, triage, "cache", verdict, started);
			return { verdict };
		}
		try {
			if (remembered) {
				// The effects are known; only the owner's request is missing. Without an answer it is
				// unsettled, so an operation that has an effect goes to the operator, never past them.
				let asked: number | undefined;
				if (request !== undefined) {
					try {
						asked = readOperationRequest(await ask([OPERATION_REQUEST_ID]));
					} catch (error) {
						signal?.throwIfAborted();
						harnessLog.warn(
							"edge",
							"system one could not read the owner's request; the call is judged on its effects",
							() => ({
								tool: toolName,
								actor,
								error: errorName(error),
							}),
						);
					}
				}
				const verdict = verdictFromReadings(remembered, asked, actor);
				this.record(toolName, triage, "cache", verdict, started);
				trace(verdict, remembered, true);
				return { verdict };
			}
			const answers = await ask(
				request === undefined ? OPERATION_EFFECT_IDS : [...OPERATION_EFFECT_IDS, OPERATION_REQUEST_ID],
			);
			const effects = readOperationEffects(answers);
			this.remember(engine, toolName, triage, effects);
			const verdict = verdictFromReadings(
				effects,
				request === undefined ? undefined : readOperationRequest(answers),
				actor,
			);
			this.record(toolName, triage, "jev", verdict, started);
			trace(verdict, effects, false);
			return { verdict };
		} catch (error) {
			signal?.throwIfAborted();
			harnessLog.warn("edge", "system one could not judge an operation", () => ({
				tool: toolName,
				actor,
				error: errorName(error),
				timedOut: errorName(error) === "TimeoutError",
				durationMs: this.now() - started,
			}));
			const verdict = unavailableOperationVerdict(error, actor);
			this.record(toolName, triage, "outage", verdict, started);
			return { verdict };
		}
	}
}
