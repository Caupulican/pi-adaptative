/**
 * The operation gate: one check per tool call, after the envelope and the edge. With System One bound it asks
 * about every operation {@link triageOperation} sends to it and applies the verdict: the operator's standing
 * grant of `operation.irreversible` authorizes; otherwise the root asks the operator at the edge and a worker
 * is refused, since only the root can reach the owner. The owner's standing grant is authoritative for
 * either actor, so a granted operation is not judged by System One.
 *
 * What an operation does is remembered ({@link OperationEffectCache}); only whether the owner's request asks
 * for it is asked fresh, and only when the remembered effects are not nil. A call whose arguments are
 * already known when its assistant message starts executing is judged ahead of its turn in the queue
 * ({@link OperationGate.prewarm}), the calls of one message in a single request. A System One that cannot
 * answer in {@link OPERATION_JUDGMENT_TIMEOUT_MS} leaves the call to run with the doubt shown.
 */

import { tmpdir } from "node:os";
import { getToolExecutionKey } from "../../kernel/tool-failure-memory.ts";
import type { EdgeOperation } from "../autonomy/edge-policy.ts";
import {
	askOperation,
	askOperationBatch,
	OPERATION_EFFECT_IDS,
	OPERATION_REQUEST_ID,
	type OperationEffectEngine,
	type OperationEffectReading,
	type OperationVerdict,
	operationHasNoEffect,
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

/** p99 of 1,204 recorded calls is under 0.9 s; a call still waiting at 2 s is an outage, not a slow answer. */
export const OPERATION_JUDGMENT_TIMEOUT_MS = 2_000;

type JudgedTriage = Extract<ReturnType<typeof triageOperation>, { kind: "judged" }>;

/** Where a gate decision's answer came from. */
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

export interface OperationGateDeps {
	getEngine(): OperationEffectEngine | undefined;
	/** The owner's request this turn serves. */
	getRequest(): string;
	getScopeCwd(): string;
	/** Identity of the current user turn; a new one forgets cached verdicts. */
	getTurnKey(): string;
	/** Whether the operator granted `operation.irreversible` (standing authority). */
	isGranted(): boolean;
	/** Ask the operator at the edge; never used for a worker, which is refused instead. */
	askOperator?(operation: EdgeOperation, signal?: AbortSignal): Promise<{ authorized: boolean; reason?: string }>;
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
		actor: "root" | "worker",
		signal?: AbortSignal,
	): Promise<{ block: true; reason: string } | undefined> {
		signal?.throwIfAborted();
		if (this.deps.isGranted()) return undefined;
		// No semantic engine means deterministic gates own the call. Avoid filesystem identity work
		// on this hot path; System One is an optional quality plane, never an execution dependency.
		const engine = this.deps.getEngine();
		if (!engine) return undefined;
		const scopeCwd = this.deps.getScopeCwd();
		const triage = triageOperation({ toolName, args, cwd, scopeCwd, tempDir: tmpdir() });
		if (triage.kind === "decided") return undefined;
		this.rollTurn();
		const key = this.verdictKey(actor, toolName, args, triage);
		let verdict = this.verdicts.get(key);
		if (!verdict) {
			const warmed = this.pending.get(key);
			this.pending.delete(key);
			const decided = warmed ? await warmed : undefined;
			signal?.throwIfAborted();
			verdict = decided?.verdict ?? (await this.decide(engine, toolName, triage, actor, signal)).verdict;
			this.verdicts.set(key, verdict);
		}
		const shown = triage.operation.replace(/\s+/g, " ").trim();
		const subject = `${actor === "worker" ? "a worker's " : ""}${shown.length <= 160 ? shown : `${shown.slice(0, 159)}…`}`;
		if (verdict.action === "proceed") {
			if (verdict.notable) this.deps.notify(`System One: ${subject}: ${verdict.finding}; it runs.`);
			return undefined;
		}
		if (this.deps.isGranted()) {
			this.deps.notify(
				`System One: ${subject}: ${verdict.finding}; it runs under your operation.irreversible grant.`,
			);
			return undefined;
		}
		const refusal = `System One ${verdict.action === "refuse" ? "refused" : "held"} ${subject}: ${verdict.finding}.`;
		if (verdict.action === "refuse" || actor === "worker" || !this.deps.askOperator) {
			this.deps.notify(refusal);
			return {
				block: true,
				reason: `${refusal} ${actor === "worker" ? "Report the unresolved boundary to the parent or do the work another way." : "Ask the owner before running it, or do the work another way."}`,
			};
		}
		const answer = await this.deps.askOperator(
			{ class: "operation.irreversible", operation: triage.operation, reason: verdict.finding },
			signal,
		);
		return answer.authorized ? undefined : { block: true, reason: answer.reason ?? refusal };
	}

	/**
	 * Starts judging the calls of one assistant message before each reaches {@link check}. One call is
	 * judged as `check` would; several share one request. Nothing here can block or refuse: a failed or
	 * cancelled pre-warm leaves `check` to judge the call itself.
	 */
	prewarm(calls: readonly PrewarmCall[], signal?: AbortSignal): void {
		if (signal?.aborted || this.deps.isGranted()) return;
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
			const key = this.verdictKey("root", call.toolName, call.args, triage);
			if (this.verdicts.has(key) || this.pending.has(key)) continue;
			const effectKey = this.effectKey(engine, call.toolName, triage);
			if (effectKey && this.cache.get(effectKey)) continue;
			todo.push({ key, toolName: call.toolName, triage });
		}
		if (todo.length === 0) return;
		const never = () => undefined;
		if (todo.length === 1) {
			const [only] = todo;
			this.pending.set(only!.key, this.decide(engine, only!.toolName, only!.triage, "root", signal).catch(never));
			return;
		}
		const started = this.now();
		const batch = askOperationBatch(engine, {
			entries: todo.map((entry) => ({ triage: entry.triage, toolName: entry.toolName })),
			request: this.deps.getRequest(),
			signal,
			onModel: (model) => {
				this.answeringModel = model;
			},
			timeoutMs: OPERATION_JUDGMENT_TIMEOUT_MS,
		});
		todo.forEach((entry, index) => {
			this.pending.set(
				entry.key,
				batch
					.then((all): Decided => {
						const answers = all[index] ?? {};
						const effects = readOperationEffects(answers);
						this.remember(engine, entry.toolName, entry.triage, effects);
						const verdict = verdictFromReadings(effects, readOperationRequest(answers), "root");
						this.record(entry.toolName, entry.triage, "jev", verdict, started);
						return { verdict };
					})
					.catch(never),
			);
		});
	}

	private rollTurn(): void {
		const turnKey = this.deps.getTurnKey();
		if (turnKey === this.turnKey) return;
		this.verdicts.clear();
		this.pending.clear();
		this.turnKey = turnKey;
	}

	private verdictKey(actor: string, toolName: string, args: unknown, triage: JudgedTriage): string {
		return `${actor}\u0000${getToolExecutionKey(toolName, args)}\u0000${JSON.stringify(triage.identity)}`;
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
			this.deps.recordDecision?.({
				tool: toolName,
				identityHash: operationIdentityHash(triage.identity, triage.operation),
				source,
				action: verdict.action,
				notable: verdict.notable,
				finding: verdict.finding,
				durationMs: this.now() - started,
			});
		} catch (error) {
			// A measurement that cannot be written never changes a verdict; it is reported once.
			this.reportStoreFailure(error);
		}
	}

	private reportStoreFailure(error: unknown): void {
		if (this.storeFailureReported) return;
		this.storeFailureReported = true;
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
		signal?: AbortSignal,
	): Promise<Decided> {
		const started = this.now();
		const request = this.deps.getRequest();
		const effectKey = this.effectKey(engine, toolName, triage);
		const remembered = effectKey ? this.cache.get(effectKey) : undefined;
		const ask = (questions: readonly (typeof OPERATION_REQUEST_ID | (typeof OPERATION_EFFECT_IDS)[number])[]) =>
			askOperation(engine, {
				triage,
				toolName,
				request,
				questions,
				signal,
				timeoutMs: OPERATION_JUDGMENT_TIMEOUT_MS,
				onModel: (model) => {
					this.answeringModel = model;
				},
			});
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
				try {
					asked = readOperationRequest(await ask([OPERATION_REQUEST_ID]));
				} catch {
					signal?.throwIfAborted();
				}
				const verdict = verdictFromReadings(remembered, asked, actor);
				this.record(toolName, triage, "cache", verdict, started);
				return { verdict };
			}
			const answers = await ask([...OPERATION_EFFECT_IDS, OPERATION_REQUEST_ID]);
			const effects = readOperationEffects(answers);
			this.remember(engine, toolName, triage, effects);
			const verdict = verdictFromReadings(effects, readOperationRequest(answers), actor);
			this.record(toolName, triage, "jev", verdict, started);
			return { verdict };
		} catch (error) {
			signal?.throwIfAborted();
			const verdict = unavailableOperationVerdict(error, actor);
			this.record(toolName, triage, "outage", verdict, started);
			return { verdict };
		}
	}
}
