/**
 * The judgments work is accepted on: System One's code-duplicate review, answer and report claim checks, and the
 * unsettled-item ladder (System One, then one bounded consult on the router's expensive-tier model). Built from the
 * System One controller and the expensive model alone, so a parent opened away judges its workers the way the
 * foreground does. What a worker leaves unsettled goes to the queue its caller names: the parent's owner queue.
 */

import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import type { ModelRouterController } from "../model-router-controller.ts";
import { AnswerClaimChecker } from "./claim-delivery.ts";
import { CodeDuplicateReviewer } from "./code-duplicates.ts";
import type { SystemOneController } from "./controller.ts";
import {
	itemConsultMessage,
	type LadderOutcome,
	parseItemConsult,
	settleUnsettledItems,
	toolResultEvidence,
	UNSETTLED_ITEM_CONSULT_PROMPT,
} from "./unsettled-ladder.ts";

export interface SettlementJudgesDeps {
	getSystemOneController(): SystemOneController | undefined;
	resolveExpensiveModel(): ReturnType<ModelRouterController["resolveExpensiveModel"]>;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	warn(message: string): void;
	/** Claims the root's own answer check left open, delivered to the owner; only a session with a root answer has them. */
	deliverToOwner?(items: readonly string[]): void;
}

export class SettlementJudges {
	private readonly deps: SettlementJudgesDeps;
	readonly codeDuplicates: CodeDuplicateReviewer;
	readonly answerClaims: AnswerClaimChecker;

	constructor(deps: SettlementJudgesDeps) {
		this.deps = deps;
		this.codeDuplicates = new CodeDuplicateReviewer({
			getController: () => this.deps.getSystemOneController(),
			warn: (message) => this.deps.warn(message),
		});
		const deliverToOwner = deps.deliverToOwner;
		this.answerClaims = new AnswerClaimChecker({
			getController: () => this.deps.getSystemOneController(),
			warn: (message) => this.deps.warn(message),
			settle: (items, messages, interpretationContext) =>
				this.settleInconclusive({ items, messages, interpretationContext }),
			...(deliverToOwner ? { deliverToOwner: (items: readonly string[]) => deliverToOwner(items) } : {}),
		});
	}

	/** One bounded completion on the router's expensive-tier model, or undefined when none is configured. */
	async consultExpensiveModel(input: {
		systemPrompt: string;
		message: string;
		laneKind: string;
		signal?: AbortSignal;
	}): Promise<{ text: string; ref: string } | undefined> {
		const expensive = this.deps.resolveExpensiveModel();
		if ("skip" in expensive) return undefined;
		const result = await this.deps.runIsolatedCompletion({
			systemPrompt: input.systemPrompt,
			messages: [{ role: "user", content: input.message, timestamp: Date.now() }],
			model: expensive.model,
			maxTokens: 600,
			cacheRetention: "none",
			laneKind: input.laneKind,
			...(input.signal ? { signal: input.signal } : {}),
		});
		return { text: result.text, ref: expensive.ref };
	}

	settleInconclusive(input: {
		items: readonly string[];
		messages: Parameters<typeof toolResultEvidence>[0];
		signal?: AbortSignal;
		interpretationContext?: string;
	}): Promise<LadderOutcome> {
		return settleUnsettledItems(
			{
				getJudge: () => this.deps.getSystemOneController(),
				consult: async ({ item, evidence, signal, interpretationContext }) => {
					const reply = await this.consultExpensiveModel({
						systemPrompt: UNSETTLED_ITEM_CONSULT_PROMPT,
						message: itemConsultMessage({ item, evidence, interpretationContext }),
						laneKind: "unsettled-item-consult",
						...(signal ? { signal } : {}),
					});
					return reply ? parseItemConsult(reply.text, reply.ref) : undefined;
				},
			},
			{
				items: input.items,
				evidence: toolResultEvidence(input.messages),
				...(input.interpretationContext ? { interpretationContext: input.interpretationContext } : {}),
				...(input.signal ? { signal: input.signal } : {}),
			},
		);
	}

	/**
	 * Missing worker evidence remains with the parent. Only owner-reserved decisions are surfaced to the owner,
	 * classified at the turn boundary so missing evidence never delays the terminal handoff.
	 */
	async settleWorkerInconclusive(
		input: {
			items: readonly string[];
			messages: Parameters<typeof toolResultEvidence>[0];
			signal?: AbortSignal;
		},
		queueUnsettled: (items: readonly string[]) => void,
	): Promise<{ settled: readonly string[]; unsettled: readonly string[]; ownerFollowUp?: string }> {
		const outcome = await this.settleInconclusive(input);
		const settled = outcome.settled.map(
			(entry) => `${entry.verdict}: ${entry.item} (${entry.by}${entry.basis ? `; basis: ${entry.basis}` : ""})`,
		);
		const unsettled = outcome.unsettled.map((entry) => `${entry.item} (missing: ${entry.missing})`);
		queueUnsettled(unsettled);
		return { settled, unsettled };
	}
}
