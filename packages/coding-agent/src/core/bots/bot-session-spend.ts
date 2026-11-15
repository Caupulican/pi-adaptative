/**
 * A loaded bot session's spend, as its host composes it once per session: the bound on spend made on a model (the root's
 * and the bot's own ceilings), the bot's spend windows over its transcript (`BotSpendWindows`), the bound each of its
 * workers' runs takes from them, the bound and the spend its turns read, and the accounting that charges its spend to the
 * root and records each turn's outcome (`BotTurnAccounting`). The windows and the charges share one ledger
 * (`BotSpendLedger`), so one write advances both.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { botSpendLedgerFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import type { ParentExecutionPolicy } from "../delegation/parent-execution-context.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { BotSessionDefinition } from "./bot-session-profile.ts";
import { type BotSessionTurnPorts, type BotTurnSpendBound, botSpendBound } from "./bot-session-turns.ts";
import { BotSpendLedger } from "./bot-spend-ledger.ts";
import { BotSpendWindows } from "./bot-spend-window.ts";
import { BotTurnAccounting, type BotTurnAccountingPorts } from "./bot-turn-report.ts";

/**
 * The bound on spend made on `model`: the root's (`root`) and the bot's own ceilings on that spend. A model the registry
 * does not know (undefined) is held as metered spend, which is never laxer.
 */
export function botSpendBoundOn(
	root: (model: Model<Api> | undefined) => BotTurnSpendBound | undefined,
	model: Model<Api> | undefined,
	spendBudget: BotSessionDefinition["spendBudget"],
	registry: ModelRegistry,
): BotTurnSpendBound | undefined {
	return botSpendBound(root(model), spendBudget, isMeteredSpend(model, registry));
}

/** What a bot session's spend reads from its host. */
export interface BotSessionSpendPorts {
	/** The root's bound on spend made on a model (`BotSessionHostPorts.turnSpendBound`). */
	rootBound(model: Model<Api> | undefined): BotTurnSpendBound | undefined;
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
			now: () => ports.now(),
		});
	}

	/** The bound on spend made on `model` (`botSpendBoundOn`). */
	bound(model: Model<Api> | undefined): BotTurnSpendBound | undefined {
		return botSpendBoundOn((on) => this.ports.rootBound(on), model, this.definition.spendBudget, this.registry);
	}

	/**
	 * A worker's run is held to the bound on its own model's spend, less what the bot's turns spent on the request it
	 * serves; the request's workers share it. No bound on that model, none: its usage windows hold it.
	 */
	readonly workerRunCostBound: NonNullable<ParentExecutionPolicy["runCostBound"]> = (attempt, snapshot) => {
		const binding = attempt.runningModel ?? attempt.dispatch.executionContract?.worker.modelBinding;
		const attemptModel = binding && this.registry.find(binding.provider, binding.modelId);
		return this.windows.runCostBound(attempt, snapshot, this.bound(attemptModel)?.usd);
	};

	/** The bound the bot's turns are held to and the spend they count toward it: the request's, its workers' included. */
	turnBound(): Pick<BotSessionTurnPorts, "spendBound" | "spent"> {
		return {
			spendBound: () => this.bound(this.definition.model),
			spent: (turnUsd, addedUsd) => this.windows.count(turnUsd, addedUsd),
		};
	}

	/** The accounting of the built session's charges and turns. */
	accounting(session: AgentSession, ports: BotTurnAccountingPorts): BotTurnAccounting {
		return new BotTurnAccounting(this.agentId, session, this.ledger, ports);
	}
}
