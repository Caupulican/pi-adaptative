/**
 * The operation gate: one check per tool call, after the envelope and the edge. With System One bound it asks
 * about every operation {@link triageOperation} sends to it, caches the verdict for the rest
 * of the turn (a repeated call is not judged twice), and applies it: the operator's standing grant of
 * `operation.irreversible` authorizes; otherwise the root asks the operator at the edge and a worker
 * is refused. Whatever System One found that matters is shown to the operator.
 */

import { tmpdir } from "node:os";
import { getToolExecutionKey } from "@caupulican/pi-agent-core/tool-failure-memory";
import type { EdgeOperation } from "../autonomy/edge-policy.ts";
import {
	judgeOperation,
	type OperationEffectEngine,
	type OperationVerdict,
	triageOperation,
} from "./operation-classifier.ts";

/** A few seconds: a judged call waits this long for System One at most. */
export const OPERATION_JUDGMENT_TIMEOUT_MS = 8_000;

export interface OperationGateDeps {
	getEngine(): OperationEffectEngine | undefined;
	/** The owner's request this turn serves. */
	getRequest(): string;
	getScopeCwd(): string;
	/** Identity of the current user turn; a new one forgets cached verdicts. */
	getTurnKey(): string;
	/** Whether the operator granted `operation.irreversible` (standing authority). */
	isGranted(): boolean;
	/** Ask the operator at the edge; absent for a worker, which is refused instead. */
	askOperator?(operation: EdgeOperation, signal?: AbortSignal): Promise<{ authorized: boolean; reason?: string }>;
	notify(message: string): void;
}

export class OperationGate {
	private readonly deps: OperationGateDeps;
	private readonly verdicts = new Map<string, OperationVerdict>();
	private turnKey: string | undefined;

	constructor(deps: OperationGateDeps) {
		this.deps = deps;
	}

	async check(
		toolName: string,
		args: unknown,
		cwd: string,
		actor: "root" | "worker",
		signal?: AbortSignal,
	): Promise<{ block: true; reason: string } | undefined> {
		const scopeCwd = this.deps.getScopeCwd();
		const triage = triageOperation({ toolName, args, cwd, scopeCwd, tempDir: tmpdir() });
		if (triage.kind === "decided") return undefined;
		// A session without System One keeps the deterministic gates alone, as it always did; an outage
		// of a bound System One is different and goes to the operator (the authority line).
		const engine = this.deps.getEngine();
		if (!engine) return undefined;
		const turnKey = this.deps.getTurnKey();
		if (turnKey !== this.turnKey) {
			this.verdicts.clear();
			this.turnKey = turnKey;
		}
		const key = `${actor}\u0000${getToolExecutionKey(toolName, args)}`;
		let verdict = this.verdicts.get(key);
		if (!verdict) {
			verdict = await judgeOperation(engine, {
				triage,
				toolName,
				scopeCwd,
				request: this.deps.getRequest(),
				actor,
				signal,
				timeoutMs: OPERATION_JUDGMENT_TIMEOUT_MS,
			});
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
		if (verdict.action === "refuse" || !this.deps.askOperator) {
			this.deps.notify(refusal);
			return {
				block: true,
				reason: `${refusal} Ask the owner before running it, or do the work another way.`,
			};
		}
		const answer = await this.deps.askOperator(
			{ class: "operation.irreversible", operation: triage.operation, reason: verdict.finding },
			signal,
		);
		return answer.authorized ? undefined : { block: true, reason: answer.reason ?? refusal };
	}
}
