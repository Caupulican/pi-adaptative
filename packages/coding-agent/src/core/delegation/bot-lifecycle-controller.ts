/**
 * Bot lifecycle on the authority of the root, a leader or the owner: a bot is created (its id, model, soul and write grant
 * checked against the creator), upserted (a binding change is refused while its worker is live), started as a leader's
 * child under the leader's running goal, stopped or retired. It also builds the message directory a bot's worker uses to
 * reach its own bots. The coordinator supplies the roster, the worker runtime and the leaders through its host port.
 */
import { createHash } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { isOrchestrationThinkingLevel } from "../orchestration/thinking-level-guard.ts";
import { botStartModelStance } from "../orchestration/worker-model-pins.ts";
import {
	type BotCreationRequest,
	type CreatedBotView,
	MAX_BOTS_PER_LEADER,
	mayNotCreateBotsText,
} from "./bot-creation.ts";
import type { BotMessageDirectory, BotOwnedStartOutcome } from "./bot-message-contract.ts";
import { createBotMessageDirectory } from "./bot-message-directory.ts";
import { displayNameFor, suggestBotId } from "./bot-naming.ts";
import type { BotRuntimeBindings } from "./bot-runtime-bindings.ts";
import type { LeaderController } from "./leader-controller.ts";
import type { DelegationRecord } from "./leader-delegation-ledger.ts";
import {
	BOT_MEMORY_BLOCK_SEPARATOR,
	normalizeBotOrTeamId,
	normalizeBotSoul,
	type PersistentBotRecord,
	type PersistentBotTeamStore,
	RESERVED_BOT_CREATOR_IDS,
	type UpsertPersistentBotInput,
} from "./persistent-bot-team-store.ts";
import type {
	WorkerAgentControlPort,
	WorkerAgentControlScope,
	WorkerAgentRetireOptions,
	WorkerAgentRetireResult,
	WorkerAgentView,
} from "./worker-agent-control.ts";
import type { WorkerDelegationController } from "./worker-delegation-controller.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { contractGrantsChildren } from "./worker-nested-start.ts";

/** What the lifecycle reads from and asks of the coordinator: the roster, the worker runtime and the leaders. */
export interface BotLifecycleHost {
	getBotTeamStore(): PersistentBotTeamStore;
	/** Drops the cached bot roster: a bot changed under it. */
	invalidateBotViews(): void;
	hasWorkerState(): boolean;
	listWorkerAgents(): WorkerAgentView[];
	interruptWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
		options?: { message?: string; force?: boolean },
	): ReturnType<WorkerAgentControlPort["interruptWorkerAgent"]>;
	retireWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
		options?: WorkerAgentRetireOptions,
	): WorkerAgentRetireResult;
	assertBotDispatchIdle(agentId: string): void;
	resolveModelSpec(rawModel?: string): { provider: string; modelId: string; thinkingLevel?: string };
	getLeaders(): LeaderController;
	leaderDelegations(): DelegationRecord[];
	workerLifecycle(): Pick<WorkerLifecycle, "getAgentTurnDispatch">;
	workerController(): Pick<WorkerDelegationController, "admitNested">;
}

/** Creates, upserts, starts, stops and retires bots, and builds the directory a bot's worker reaches its bots through. */
export class BotLifecycleController {
	private readonly deps: Pick<
		BackgroundLaneControllerDeps,
		"getSessionManager" | "isChildSession" | "isDisposed" | "getSettingsManager"
	>;
	private readonly botBindings: BotRuntimeBindings;
	private readonly host: BotLifecycleHost;

	constructor(
		deps: Pick<
			BackgroundLaneControllerDeps,
			"getSessionManager" | "isChildSession" | "isDisposed" | "getSettingsManager"
		>,
		botBindings: BotRuntimeBindings,
		host: BotLifecycleHost,
	) {
		this.deps = deps;
		this.botBindings = botBindings;
		this.host = host;
	}

	/**
	 * A leader's send to one of its own bots that has no live runtime: the bot starts as the leader's child under the goal
	 * running now, and is held to that goal's envelope (its providers; its write paths only when the goal grants them). A
	 * live bot, or a bot the leader did not make, is left to the ordinary mailbox send.
	 */
	private async startOwnedBotAsChild(
		leaderAgentId: string,
		leaderAlias: string,
		alias: string,
		message: string,
		invocationId: string,
	): Promise<BotOwnedStartOutcome> {
		const store = this.host.getBotTeamStore();
		const bot = store.getBot(alias);
		if (!bot || bot.retired || bot.remote === true || bot.createdBy !== leaderAlias) return { handled: false };
		const runtime = this.botBindings.runtime(alias);
		if (this.host.listWorkerAgents().some((agent) => agent.agentId === runtime && agent.status !== "retired"))
			return { handled: false };
		const goal = this.host.getLeaders().currentFor(leaderAlias);
		if (goal?.state !== "running")
			return {
				handled: true,
				accepted: false,
				detail: `${leaderAlias} has no goal running, so ${alias} is not started.`,
			};
		const leaderContract = this.host.workerLifecycle().getAgentTurnDispatch(leaderAgentId)?.executionContract;
		if (!contractGrantsChildren(leaderContract))
			return {
				handled: true,
				accepted: false,
				detail: `${leaderAlias} cannot start bots yet: its running worker was started before it could lead, and it restarts once its goal ends and nothing is waiting for it.`,
			};
		const envelope = goal.charter.envelope;
		if (envelope.models.providers !== undefined && !envelope.models.providers.includes(bot.provider))
			return {
				handled: true,
				accepted: false,
				detail: `${alias} runs on ${bot.provider}, which this goal may not use.`,
			};
		const writable = bot.canWrite === true && envelope.leaderMayWrite && envelope.writePaths.length > 0;
		// Named by the invocation: a repeated call names the same runtime, and the admission's replay key starts nothing new.
		const preferredAgentId = `bot-${createHash("sha256")
			.update(`leader-owned-start\0${invocationId}\0${alias}`)
			.digest("hex")
			.slice(0, 32)}`;
		const memoryCtx = store.composeBotUnifiedMemoryContext(alias);
		const instructions =
			memoryCtx.promptBlock.length > 0 ? `${message}${BOT_MEMORY_BLOCK_SEPARATOR}${memoryCtx.promptBlock}` : message;
		const stance = botStartModelStance(this.deps.getSettingsManager().getWorkerModelPinPolicy(), bot);
		const outcome = await this.host.workerController().admitNested({
			parentAgentId: leaderAgentId,
			delegationObjectiveId: goal.objectiveId,
			instructions,
			...(writable ? { writePaths: [...envelope.writePaths] } : {}),
			messageReplayKey: `leader-owned-start:${invocationId}:${alias}`,
			bot: {
				...stance.flags,
				...(bot.soul ? { botSoul: bot.soul } : {}),
				...(bot.profileId ? { profileId: bot.profileId } : {}),
				preferredAgentId,
				authority: {
					...(stance.ownModel ? { model: { provider: bot.provider, modelId: bot.modelId } } : {}),
					...(bot.createdBy === "owner" ? { modelChosenBy: "owner" as const } : {}),
					readOnly: !writable,
					...(stance.ownModel && isOrchestrationThinkingLevel(bot.thinkingLevel)
						? { thinkingLevel: bot.thinkingLevel }
						: {}),
				},
			},
		});
		if (!outcome.started)
			return { handled: true, accepted: false, detail: `${alias} was not started: ${outcome.skipReason}.` };
		// The alias is bound to the runtime only once that runtime exists, so a refused start leaves no binding behind.
		this.botBindings.bind(alias, preferredAgentId);
		return {
			handled: true,
			accepted: true,
			detail: `${alias} started under ${leaderAlias}; its answer reaches your next turn.`,
		};
	}

	createBotMessageDirectory(sender: string, attemptId: string): BotMessageDirectory {
		return createBotMessageDirectory(
			{
				getSessionManager: () => this.deps.getSessionManager(),
				isDisposed: () => this.deps.isDisposed(),
				botBindings: this.botBindings,
				getBotTeamStore: () => this.host.getBotTeamStore(),
				invalidateBotViews: () => {
					this.host.invalidateBotViews();
				},
				listWorkerAgents: () => this.host.listWorkerAgents(),
				createBotFor: (creator, request) => this.createBotFor(creator, request),
				getLeaders: () => this.host.getLeaders(),
				leaderDelegations: () => this.host.leaderDelegations(),
				startOwnedBotAsChild: (leaderAgentId, leaderAlias, alias, message, invocationId) =>
					this.startOwnedBotAsChild(leaderAgentId, leaderAlias, alias, message, invocationId),
			},
			sender,
			attemptId,
		);
	}

	upsertPersistentBot(rawInput: UpsertPersistentBotInput): PersistentBotRecord {
		const store = this.host.getBotTeamStore();
		const agentId = normalizeBotOrTeamId(rawInput.agentId, "agentId");
		// Judge the soul before the grant guard: an invalid soul is the error to show, whatever the bot is doing.
		const input = rawInput.soul === undefined ? rawInput : { ...rawInput, soul: normalizeBotSoul(rawInput.soul) };
		this.host.assertBotDispatchIdle(agentId);
		store.reload();
		const existing = store.getBot(agentId);
		const bindingFields = [
			"provider",
			"modelId",
			"thinkingLevel",
			"profileId",
			"canWrite",
			"soul",
			"leader",
		] as const;
		const bindingChanged =
			existing &&
			bindingFields.some((field) => {
				const value = input[field];
				if (value === undefined) return false;
				const previous = existing[field];
				const next = typeof value === "string" ? value.trim() || undefined : value;
				return next !== (typeof previous === "string" ? previous.trim() || undefined : previous);
			});
		if (
			bindingChanged &&
			this.host.hasWorkerState() &&
			this.host
				.listWorkerAgents()
				.some((agent) => this.botBindings.runtimes(agentId).includes(agent.agentId) && agent.status !== "retired")
		)
			throw new Error(
				`Retire bot ${input.agentId} (/bot retire ${input.agentId}) before changing its model, profile, permissions, soul or leadership: its live worker keeps the grant and soul it started with, and only a new worker generation gets the new ones.`,
			);
		if (input.leader !== undefined)
			harnessLog.info("bots", input.leader ? "a bot was made a leader" : "a bot stopped being a leader", {
				agentId,
			});
		return store.upsertBot({ ...input, agentId });
	}

	/**
	 * Creates a bot on the authority of the orchestrator or of a leader (the owner's `/bot new` is the third way). A leader
	 * cannot make a standing leader, grants write access only when it can write itself, and has a bound on the bots it keeps.
	 * A goal leader (`bot lead` without agentId, appointed by the orchestrator or by a leader) is created a leader, for its one goal.
	 */
	createBotFor(
		creator: { readonly kind: "root" } | { readonly kind: "leader"; readonly agentId: string },
		request: BotCreationRequest,
		options?: { readonly goalLeader?: boolean },
	): CreatedBotView {
		const store = this.host.getBotTeamStore();
		store.reload();
		const agentId = normalizeBotOrTeamId(
			request.agentId ??
				suggestBotId(
					request.description ?? request.soul,
					new Set([
						...RESERVED_BOT_CREATOR_IDS,
						...store.listBots({ includeRetired: true }).map((bot) => bot.agentId),
					]),
				),
			"agentId",
		);
		let createdBy = "root";
		let mayWrite = true;
		if (creator.kind === "leader") {
			const leader = store.getBot(creator.agentId);
			if (leader?.leader !== true || leader.retired === true)
				throw new Error(
					mayNotCreateBotsText(
						store
							.listBots()
							.filter((bot) => bot.leader === true)
							.map((bot) => bot.agentId),
					),
				);
			createdBy = leader.agentId;
			mayWrite = leader.canWrite === true;
		}
		if (request.canWrite === true && !mayWrite)
			throw new Error(`${createdBy} cannot give a bot write access: it has none itself.`);
		const soul = request.soul === undefined ? undefined : normalizeBotSoul(request.soul);
		const spec = this.host.resolveModelSpec(request.model);
		const thinkingLevel = request.thinkingLevel ?? spec.thinkingLevel;
		const bot = store.createBotIfAbsent(
			{
				agentId,
				displayName: displayNameFor(agentId),
				provider: spec.provider,
				modelId: spec.modelId,
				...(thinkingLevel ? { thinkingLevel } : {}),
				...(soul ? { soul } : {}),
				...(request.description ? { description: request.description } : {}),
				canWrite: request.canWrite === true,
				leader: options?.goalLeader === true,
				createdBy,
			},
			creator.kind === "leader" ? { createdBy, max: MAX_BOTS_PER_LEADER } : undefined,
		);
		harnessLog.info("bots", "a bot was created", () => ({
			agentId: bot.agentId,
			by: createdBy,
			model: `${bot.provider}/${bot.modelId}`,
			canWrite: bot.canWrite === true,
			goalLeader: bot.leader === true,
		}));
		return {
			agentId: bot.agentId,
			modelRef: `${bot.provider}/${bot.modelId}`,
			canWrite: bot.canWrite === true,
			createdBy,
		};
	}

	retirePersistentBot(agentId: string): { retired: boolean; detail: string } {
		try {
			agentId = normalizeBotOrTeamId(agentId, "agentId");
			// Retiring a leader mid-goal would orphan its goal and its bots: the goal is cancelled first.
			if (
				this.host.hasWorkerState() &&
				!this.deps.isChildSession() &&
				this.host.getLeaders().leadsOpenDelegation(agentId)
			)
				throw new Error(`Bot ${agentId} leads an open goal; cancel it first (/lead cancel ${agentId}).`);
			this.host.assertBotDispatchIdle(agentId);
			const runtimes = new Set(this.botBindings.runtimes(agentId));
			const workers = this.host.hasWorkerState()
				? this.host.listWorkerAgents().filter((agent) => runtimes.has(agent.agentId))
				: [];
			if (workers.some((agent) => agent.status !== "retired" && agent.activity !== "idle"))
				throw new Error(`Bot ${agentId} still has active group or direct work.`);
			for (const worker of workers) this.host.retireWorkerAgent(worker.agentId, undefined, { discardPending: true });
			const hasWorker = workers.length > 0;
			const bot = this.host.getBotTeamStore().retireBot(agentId);
			return {
				retired: hasWorker || bot !== undefined,
				detail: hasWorker || bot ? `Bot ${agentId} retired.` : `Bot ${agentId} does not exist.`,
			};
		} catch (error) {
			return { retired: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	stopPersistentBot(agentId: string): { stopped: boolean; detail: string } {
		try {
			agentId = normalizeBotOrTeamId(agentId, "agentId");
			const runtimes = new Set(this.botBindings.runtimes(agentId));
			// Stopping a leader stops the bots it owns: their work was its work.
			const ownedRuntimes = new Set(
				this.host
					.getBotTeamStore()
					.listBots()
					.filter((bot) => bot.createdBy === agentId)
					.flatMap((bot) => this.botBindings.runtimes(bot.agentId)),
			);
			const agents = this.host.listWorkerAgents();
			const results = agents
				.filter((agent) => runtimes.has(agent.agentId))
				.map((agent) => this.host.interruptWorkerAgent(agent.agentId, undefined, { force: false }));
			const owned = agents
				.filter(
					(agent) => ownedRuntimes.has(agent.agentId) && agent.status !== "retired" && agent.activity !== "idle",
				)
				.map((agent) => this.host.interruptWorkerAgent(agent.agentId, undefined, { force: false }))
				.filter((result) => result.interrupted).length;
			const res = results.find((result) => result.interrupted) ?? results[0] ?? { interrupted: false };
			const ownedText = owned > 0 ? ` and ${owned} of its bots` : "";
			return {
				stopped: res.interrupted || owned > 0,
				detail: res.interrupted
					? `Stopped ${agentId}${ownedText} (${res.mode ?? "halt"}).`
					: owned > 0
						? `Stopped ${owned} of ${agentId}'s bots; ${agentId} itself was not running.`
						: (res.reason ?? `${agentId} is not running.`),
			};
		} catch (error) {
			return {
				stopped: false,
				detail: error instanceof Error ? error.message : `${agentId} is not running.`,
			};
		}
	}
}
