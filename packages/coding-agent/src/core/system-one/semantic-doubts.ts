import {
	DOUBT_REASON_PREFIX,
	PROGRAM_SETTLED_REASON,
	type SemanticEvaluationRecord,
	type SemanticEvaluationScope,
	semanticQuestionNamespace,
} from "./semantic-evaluation-ledger.ts";

export interface SemanticDoubt {
	readonly programId: string;
	readonly question: string;
	readonly text: string;
	readonly label: string;
	readonly evaluationId: string;
	readonly at: number;
	readonly evaluationScope?: SemanticEvaluationScope;
}

export interface ResolveSemanticDoubtInput {
	readonly evaluationId: string;
	readonly question: string;
	readonly disposition: "conservative_path" | "evidence_based_decision";
	readonly reason: string;
	readonly evidence: string;
}

export interface SemanticDoubtDecision extends ResolveSemanticDoubtInput {
	readonly decidedAt: number;
}

export type ResolveSemanticDoubtResult = {
	readonly resolved: boolean;
	readonly reason?: "stale_question" | "not_owned" | "invalid_record" | "storage_unavailable";
};

/**
 * Advisory decisions only: the owning session may disposition its journal's questions, including
 * worker-task questions after reviewing the responsible worker's evidence. This never changes
 * same-lane verification obligations or execution grants.
 */
export interface SemanticUncertaintyPort {
	listOwnSession(): readonly SemanticDoubt[];
	/** Records an advisory disposition in this session's journal; scope and verification remain intact. */
	resolveOwnSession(input: ResolveSemanticDoubtInput): ResolveSemanticDoubtResult;
}

interface EvaluationGeneration {
	readonly order: number;
	readonly namespaceKey: string;
	recent: boolean;
	record?: SemanticEvaluationRecord;
}

function questionIdentity(text: string): string {
	const colon = text.indexOf(": ");
	return colon > 0 ? text.slice(0, colon) : text;
}

/** Live question state, independent of the bounded historical evaluation ring. */
export class SemanticDoubtTracker {
	private sequence = 0;
	private readonly generations = new Map<string, EvaluationGeneration>();
	private readonly questions = new Map<string, { order: number; doubt?: SemanticDoubt; decided?: boolean }>();
	private readonly settledPrograms = new Map<string, number>();

	start(evaluationId: string, programId: string, scope?: SemanticEvaluationScope, namespace?: string): void {
		const namespaceKey = JSON.stringify([scope?.kind, scope?.id, namespace ?? semanticQuestionNamespace(programId)]);
		this.generations.set(evaluationId, { order: ++this.sequence, namespaceKey, recent: true });
	}

	observe(record: SemanticEvaluationRecord): void {
		const generation = this.generations.get(record.evaluationId);
		if (!generation) return;
		generation.record = record;
		if (record.outcome !== "ok") return;
		const programFence = this.settledPrograms.get(generation.namespaceKey) ?? 0;
		if (generation.order < programFence) return;
		if (record.verdict === "pass" && record.reasons?.length === 1 && record.reasons[0] === PROGRAM_SETTLED_REASON) {
			this.settledPrograms.set(generation.namespaceKey, generation.order);
			for (const [key, current] of this.questions) {
				if (key.startsWith(`${generation.namespaceKey}\u0000`) && current.order <= generation.order) {
					this.questions.delete(key);
				}
			}
		} else {
			const questions =
				record.questionStates !== undefined
					? record.questionStates.map((state) => ({
							question: state.question,
							text: state.text ?? state.question,
							uncertain: state.uncertain,
						}))
					: (record.reasons ?? []).map((reason) => {
							const uncertain = reason.startsWith(DOUBT_REASON_PREFIX);
							const text = uncertain ? reason.slice(DOUBT_REASON_PREFIX.length) : reason;
							return { question: questionIdentity(text), text, uncertain };
						});
			for (const { question, text, uncertain } of questions) {
				const key = `${generation.namespaceKey}\u0000${question}`;
				const previous = this.questions.get(key);
				if (
					previous &&
					(previous.order > generation.order || (previous.decided && previous.order === generation.order))
				)
					continue;
				this.questions.set(key, {
					order: generation.order,
					...(uncertain
						? {
								doubt: {
									programId: record.programId,
									question,
									text,
									label: record.label,
									evaluationId: record.evaluationId,
									at: record.endedAt,
									...(record.evaluationScope ? { evaluationScope: record.evaluationScope } : {}),
								},
							}
						: {}),
				});
			}
		}
		this.pruneGenerations();
	}

	forgetRecent(evaluationId: string): void {
		const generation = this.generations.get(evaluationId);
		if (generation) generation.recent = false;
		this.pruneGenerations();
	}

	getRecord(evaluationId: string): SemanticEvaluationRecord | undefined {
		return this.generations.get(evaluationId)?.record;
	}

	snapshot(): readonly SemanticDoubt[] {
		return [...this.questions.values()].flatMap((current) => (current.doubt ? [current.doubt] : []));
	}

	resolveCurrent(input: Pick<ResolveSemanticDoubtInput, "evaluationId" | "question">): boolean {
		for (const [key, current] of this.questions) {
			if (current.doubt?.evaluationId !== input.evaluationId || current.doubt.question !== input.question) continue;
			this.questions.set(key, { order: current.order, decided: true });
			this.pruneGenerations();
			return true;
		}
		return false;
	}

	private pruneGenerations(): void {
		const activeIds = new Set(this.snapshot().map((doubt) => doubt.evaluationId));
		for (const [id, generation] of this.generations) {
			if (!generation.recent && !activeIds.has(id)) this.generations.delete(id);
		}
		// Resolved fences live only while an earlier retained callback can replay that question.
		// An old unresolved question protects its own identity, never every later resolved question.
		const openPrograms = new Map<string, number>();
		const replayablePrograms = new Map<string, number>();
		const replayableQuestions = new Map<string, number>();
		for (const generation of this.generations.values()) {
			const namespace = generation.namespaceKey;
			replayablePrograms.set(namespace, Math.min(replayablePrograms.get(namespace) ?? Infinity, generation.order));
			if (!generation.record) {
				openPrograms.set(namespace, Math.min(openPrograms.get(namespace) ?? Infinity, generation.order));
				continue;
			}
			const questions =
				generation.record.questionStates !== undefined
					? generation.record.questionStates.map((state) => state.question)
					: (generation.record.reasons ?? []).map((reason) =>
							reason.startsWith(DOUBT_REASON_PREFIX) ? reason.slice(DOUBT_REASON_PREFIX.length) : reason,
						);
			for (const text of questions) {
				const question = generation.record.questionStates !== undefined ? text : questionIdentity(text);
				const key = `${namespace}\u0000${question}`;
				replayableQuestions.set(key, Math.min(replayableQuestions.get(key) ?? Infinity, generation.order));
			}
		}
		for (const [key, current] of this.questions) {
			if (current.doubt) continue;
			const namespace = key.slice(0, key.indexOf("\u0000"));
			if (
				(openPrograms.get(namespace) ?? Infinity) > current.order &&
				(replayableQuestions.get(key) ?? Infinity) > current.order
			)
				this.questions.delete(key);
		}
		for (const [namespace, order] of this.settledPrograms) {
			if ((replayablePrograms.get(namespace) ?? Infinity) > order) this.settledPrograms.delete(namespace);
		}
	}
}
