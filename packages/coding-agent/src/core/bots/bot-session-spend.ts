/**
 * A loaded bot session's spend, as its host composes it once per session: the dollar ceilings over its spend per request
 * (the root's and the bot's own, each on all spend or on metered spend only), the bot's spend windows over its transcript
 * (`BotSpendWindows`), the bounds each of its workers' runs takes from them, the bound and the spend its turns read, and
 * the accounting that charges its spend to the root and records each turn's outcome (`BotTurnAccounting`). The windows and
 * the charges share one ledger (`BotSpendLedger`), so one write advances both.
 *
 * A ceiling counts the spend it is set on: one on all spend counts the window's whole spend, a metered-only one the part
 * of it made on metered models (the bot's own on its model, which a pinned bot never leaves, and each worker's on its
 * attempt's). A subscription bot's turns are held to the ceilings on all spend only; its metered workers' runs to both.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { botSpendLedgerFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import type { SpendExcess } from "../cost/session-turn-spend-bound.ts";
import type { ParentExecutionPolicy } from "../delegation/parent-execution-context.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { BotSessionDefinition } from "./bot-session-profile.ts";
import type { BotSessionTurnPorts, BotSpendCeiling } from "./bot-session-turns.ts";
import { BotSpendLedger } from "./bot-spend-ledger.ts";
import { BotSpendWindows, type WindowSpend } from "./bot-spend-window.ts";
import { BotTurnAccounting, type BotTurnAccountingPorts } from "./bot-turn-report.ts";

/**
 * The ceilings over a bot's spend per request: the root's (`root`) and the bot's own (`spendBudget`: its profile's
 * `maxCostUsd` on all spend, `maxMeteredCostUsd` on metered spend). A ceiling of zero or less sets none, as the root's do
 * not.
 */
function botSpendCeilings(
	root: readonly BotSpendCeiling[],
	spendBudget: BotSessionDefinition["spendBudget"],
): BotSpendCeiling[] {
	const own: BotSpendCeiling[] = [
		{ usd: spendBudget.maxCostUsd ?? 0, bound: "profile", meteredOnly: false },
		{ usd: spendBudget.maxMeteredCostUsd ?? 0, bound: "profile", meteredOnly: true },
	];
	return [...root, ...own.filter((ceiling) => ceiling.usd > 0)];
}

/**
 * The ceilings that hold spend made on `model`: every one on all spend, and the metered-only ones when that spend is
 * metered. A model the registry does not know (undefined) is held as metered spend, which is never laxer.
 */
export function botSpendCeilingsOn(
	root: readonly BotSpendCeiling[],
	spendBudget: BotSessionDefinition["spendBudget"],
	model: Model<Api> | undefined,
	registry: ModelRegistry,
): BotSpendCeiling[] {
	const metered = isMeteredSpend(model, registry);
	return botSpendCeilings(root, spendBudget).filter((ceiling) => metered || !ceiling.meteredOnly);
}

/** The lowest of `ceilings`; undefined when there is none. */
function lowest(ceilings: readonly BotSpendCeiling[]): BotSpendCeiling | undefined {
	return ceilings.reduce<BotSpendCeiling | undefined>(
		(low, ceiling) => (low === undefined || ceiling.usd < low.usd ? ceiling : low),
		undefined,
	);
}

/** What a bot session's spend reads from its host. */
export interface BotSessionSpendPorts {
	/** The root's ceilings over spend (`BotSessionHostPorts.spendCeilings`). */
	rootCeilings(): readonly BotSpendCeiling[];
	/** The delegation ledger's projection of the session's workers; undefined before the session is built. */
	snapshot(): TaskRuntimeProjection | undefined;
	now(): number;
	/** An owner-facing warning (a spend record that could not be read or written). */
	warn(message: string): void;
}

/** One loaded bot session's spend (see the module comment). */
export class BotSessionSpend {
	private readonly agentId: string;
	private readonly definition: Pick<BotSessionDefinition, "model" | "spendBudget">;
	private readonly registry: ModelRegistry;
	private readonly ports: BotSessionSpendPorts;
	private readonly ledger: BotSpendLedger;
	private readonly windows: BotSpendWindows;

	constructor(
		agentId: string,
		agentDir: string,
		transcript: SessionManager,
		definition: Pick<BotSessionDefinition, "model" | "spendBudget">,
		registry: ModelRegistry,
		ports: BotSessionSpendPorts,
	) {
		this.agentId = agentId;
		this.definition = definition;
		this.registry = registry;
		this.ports = ports;
		const words = () => interfaceText().botTeam;
		this.ledger = new BotSpendLedger(botSpendLedgerFile(agentDir, agentId), {
			notRead: (reason) => ports.warn(words().botSpendLedgerNotRead(agentId, reason)),
			notWritten: (reason) => ports.warn(words().botSpendLedgerNotWritten(agentId, reason)),
		});
		this.windows = new BotSpendWindows(this.ledger, transcript, {
			snapshot: () => ports.snapshot(),
			attemptMetered: (attempt) => isMeteredSpend(this.attemptModel(attempt), registry),
			now: () => ports.now(),
		});
	}

	/** The ceilings over the bot's spend per request. */
	private ceilings(): BotSpendCeiling[] {
		return botSpendCeilings(this.ports.rootCeilings(), this.definition.spendBudget);
	}

	/** The model an attempt runs on (else the one its contract binds); undefined when the registry does not know it. */
	private attemptModel(attempt: AttemptRuntimeState): Model<Api> | undefined {
		const binding = attempt.runningModel ?? attempt.dispatch.executionContract?.worker.modelBinding;
		return binding && this.registry.find(binding.provider, binding.modelId);
	}

	/**
	 * A worker's run shares the bounds of the request it serves with the request's other workers: each ceiling less what
	 * the bot's turns spent in that window on the spend the ceiling counts (`BotSpendWindows.runCostBound`). With no ceiling
	 * set, none: a subscription's usage windows hold it.
	 */
	readonly workerRunCostBound: NonNullable<ParentExecutionPolicy["runCostBound"]> = (attempt, snapshot) =>
		this.windows.runCostBound(attempt, snapshot, this.ceilings());

	/** The bounds the bot's turns are held to and the spend they count toward them: the request's, its workers' included. */
	turnBound(): Pick<BotSessionTurnPorts, "spendBound" | "exceeded"> {
		return {
			spendBound: () =>
				lowest(
					botSpendCeilingsOn(
						this.ports.rootCeilings(),
						this.definition.spendBudget,
						this.definition.model,
						this.registry,
					),
				),
			exceeded: (turnUsd, addedUsd) => this.exceeded(turnUsd, addedUsd),
		};
	}

	/**
	 * Counts what the bot's turn just spent to its window and returns the window's spend past the lowest ceiling it passes
	 * of those that hold the bot's own spend, each on the spend it counts. Before the transcript holds the turn's input,
	 * the turn's own spend is the window's.
	 */
	private exceeded(turnUsd: number, addedUsd: number): SpendExcess<BotSpendCeiling> | undefined {
		const { model, spendBudget } = this.definition;
		const metered = isMeteredSpend(model, this.registry);
		const spend: WindowSpend = this.windows.count(addedUsd, metered) ?? {
			usd: turnUsd,
			meteredUsd: metered ? turnUsd : 0,
		};
		let excess: SpendExcess<BotSpendCeiling> | undefined;
		for (const ceiling of botSpendCeilingsOn(this.ports.rootCeilings(), spendBudget, model, this.registry)) {
			const spentUsd = ceiling.meteredOnly ? spend.meteredUsd : spend.usd;
			if (spentUsd > ceiling.usd && (excess === undefined || ceiling.usd < excess.limit.usd))
				excess = { spentUsd, limit: ceiling };
		}
		return excess;
	}

	/** The accounting of the built session's charges and turns. */
	accounting(session: AgentSession, ports: BotTurnAccountingPorts): BotTurnAccounting {
		return new BotTurnAccounting(this.agentId, session, this.ledger, ports);
	}
}
