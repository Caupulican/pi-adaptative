/**
 * Operator messages to a bot or a group: each send to a bot is ordered behind the earlier send to the same bot generation,
 * then goes to the bot's own session as its turn (the owner's word, a group's message, a routine's prompt, to a bot that
 * answers in a session of its own), or reaches the bot's live worker (a follow-up, a queued message or a steer) or starts
 * a fresh worker generation bound to the bot, and a group send fans out to its members and records the group's message.
 * The branch and disposal guards are checked before each durable write. The coordinator supplies the lanes, workers and
 * roster through its host port.
 */
import { randomUUID } from "node:crypto";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { botMailAddressText, botMailPrompt, botMailRef } from "../bots/bot-mail.ts";
import type { BotSessionDelivery } from "../bots/bot-session-host.ts";
import type { OrchestrationDelegationLimits, WorkerResultContract } from "../orchestration/contracts.ts";
import type { RemoteHubController } from "../remote/hub-controller.ts";
import { agentMailTurnOrigin } from "../turn-origin.ts";
import { BOT_MEMORY_BLOCK_SEPARATOR } from "./bot-chat-text.ts";
import { groupMailRoomBlock, readGroupRoom } from "./bot-group-room.ts";
import type {
	BotDeliveryOrigin,
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "./bot-operator-message-options.ts";
import { assertBotId, type BotRuntimeBindings, type BotRuntimeContext } from "./bot-runtime-bindings.ts";
import { freshBotRuntimeId, keyedBotRuntimeId } from "./bot-runtime-id.ts";
import { assertBotReachable } from "./bot-unreachable.ts";
import { botWorkerStart } from "./bot-worker-start.ts";
import {
	normalizeBotOrTeamId,
	type PersistentBotTeamStore,
	type PersistentTeamMemberDelivery,
	type PersistentTeamMessage,
	type TeamOperatorMessageDispatchResult,
	teamIncarnation,
} from "./persistent-bot-team-store.ts";
import type {
	SessionRootWorkerAgentMessageOptions,
	WorkerAgentControlScope,
	WorkerAgentView,
} from "./worker-agent-control.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";

/** What a dispatch reads from and asks of the coordinator: the roster, the lanes and the worker runtime. */
export interface BotOperatorDispatchHost {
	/**
	 * The bots that run as sessions of their own: the owner's direct words, a group's message and a routine's prompt to such
	 * a bot go to its session.
	 */
	readonly botSessions: BotSessionDelivery;
	getBotTeamStore(): PersistentBotTeamStore;
	getRemoteHub(): Pick<RemoteHubController, "ask" | "send">;
	/** Drops the cached bot roster: a bot or group changed under it. */
	invalidateBotViews(): void;
	listWorkerAgents(): WorkerAgentView[];
	resolveModelSpec(rawModel?: string): { provider: string; modelId: string; thinkingLevel?: string };
	getLaneRecords(): LaneRecord[];
	sendSessionRootWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { messageId: string; queued: true };
	followUpSessionRootWorkerAgent(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string };
	noteOwnerDirectAttempt(attemptId: string): void;
	startWorkerDelegation(
		request: WorkerDelegationRequest,
		signal?: AbortSignal,
	): Promise<{ started: false; skipReason: string } | { started: true; record: LaneRecord }>;
	leaderDelegationLimits(): OrchestrationDelegationLimits;
	getWorkerAttemptResult(attemptId: string): WorkerResultContract | undefined;
	cancelWorkerAgent(agentId: string, reasonCode?: string, scope?: WorkerAgentControlScope): LaneRecord | undefined;
}

/**
 * Whether a message is the owner's own direct word to a bot (the roster chat, `/bot msg`, `@bot`): only it makes a bot it
 * names or brings a retired one back. A group's message, the orchestrator's ask, a routine's send and a leader's brief are
 * not: a group's message and a routine's prompt go to a bot's own session under an origin of their own (`sessionWords`),
 * and the orchestrator's ask and a leader's words still run as workers of this session.
 */
function isOwnerDirect(context: BotRuntimeContext, options: BotOperatorMessageOptions | undefined): boolean {
	return (
		context.teamId === undefined &&
		!options?.fromRoot &&
		!options?.fromRoutine &&
		options?.fromLeader === undefined &&
		options?.delegationObjectiveId === undefined &&
		options?.idempotencyKey === undefined
	);
}

/**
 * The words a group's message or a routine's prompt gives a bot's own session, and the origin its turn is stamped with: a
 * group's message is a mail from the group (`agent-mail`, its answer appended to the group's log), a routine's prompt to
 * the bot alone carries the routine's origin. None for the orchestrator's ask and a leader's words, which run as workers.
 */
function sessionWords(
	context: BotRuntimeContext,
	message: string,
	options: GroupMemberMessageOptions | undefined,
	room: () => string,
): { readonly message: string; readonly origin: BotDeliveryOrigin } | undefined {
	if (
		options?.fromRoot ||
		options?.fromLeader !== undefined ||
		options?.delegationObjectiveId !== undefined ||
		options?.idempotencyKey !== undefined
	)
		return undefined;
	const { teamId, teamIncarnationId } = context;
	if (teamId === undefined || teamIncarnationId === undefined)
		return options?.fromRoutine ? { message, origin: options.fromRoutine } : undefined;
	const group = { kind: "group", teamId, incarnation: teamIncarnationId } as const;
	// The group's message is the owner's room words or a routine's prompt: a third party's only when the routine's is.
	const origin = agentMailTurnOrigin({
		from: botMailAddressText(group),
		hop: 1,
		// A routine's occurrence names its mail, so an occurrence delivered again runs one turn of each member.
		ref: botMailRef(options?.fromRoutine?.ref ?? randomUUID()),
		shown: message,
		thirdParty: options?.fromRoutine?.thirdParty === true,
	});
	// The group's room (its blackboard and recent activity) follows the words, as a worker's start carries it.
	const block = room();
	const prompt = botMailPrompt(group, 1, message, false);
	return { message: block.length > 0 ? `${prompt}${BOT_MEMORY_BLOCK_SEPARATOR}${block}` : prompt, origin };
}

/** A send to one bot, and for a group member the group, its incarnation and the group's message it delivers. */
type GroupMemberMessageOptions = BotOperatorMessageOptions & {
	teamId?: string;
	teamIncarnationId?: string;
	/** The group's message this send delivers: the room the member reads leaves it out, since it is the mail itself. */
	teamMessageId?: string;
};

/** Dispatches operator messages to bots and groups, one send at a time per bot generation. */
export class BotOperatorDispatch {
	private readonly deps: Pick<BackgroundLaneControllerDeps, "getSessionManager" | "isDisposed" | "getSettingsManager">;
	private readonly botBindings: Pick<BotRuntimeBindings, "runtime" | "bind">;
	private readonly host: BotOperatorDispatchHost;

	constructor(
		deps: Pick<BackgroundLaneControllerDeps, "getSessionManager" | "isDisposed" | "getSettingsManager">,
		botBindings: Pick<BotRuntimeBindings, "runtime" | "bind">,
		host: BotOperatorDispatchHost,
	) {
		this.deps = deps;
		this.botBindings = botBindings;
		this.host = host;
	}

	/** Includes queued callers: configuration cannot pass a start that has not published its runtime yet. */
	private readonly botDispatches = new Map<string, Promise<void>>();

	async sendOperatorMessageToBot(
		agentId: string,
		message: string,
		options?: GroupMemberMessageOptions,
	): Promise<BotOperatorMessageDispatchResult> {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		assertBotId(normId);
		const manager = this.deps.getSessionManager();
		const teamId = options?.teamId ? normalizeBotOrTeamId(options.teamId, "teamId") : undefined;
		const team = teamId ? this.host.getBotTeamStore().getTeam(teamId) : undefined;
		if (
			teamId &&
			(!team?.memberAgentIds.includes(normId) ||
				(options?.teamIncarnationId && options.teamIncarnationId !== teamIncarnation(team)))
		)
			throw new Error("Bot is not a member of the selected group generation.");
		const context: BotRuntimeContext = {
			agentId: normId,
			...(team ? { teamId: team.teamId, teamIncarnationId: teamIncarnation(team) } : {}),
		};
		const assertBranchContext = manager.captureBranchContext();
		const assertBranch = () => {
			if (this.deps.isDisposed()) throw new Error("Cannot dispatch a bot message after session disposal.");
			if (this.deps.getSessionManager() !== manager) throw new Error("Bot message belongs to a previous session.");
			assertBranchContext();
		};
		const key = JSON.stringify([manager.getSessionId(), normId, context.teamId, context.teamIncarnationId]);
		const previous = this.botDispatches.get(key) ?? Promise.resolve();
		const result = previous.then(() => {
			assertBranch();
			return this.dispatchOperatorMessageToBot(context, message, options, assertBranch);
		});
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.botDispatches.set(key, settled);
		void settled.then(() => {
			if (this.botDispatches.get(key) === settled) this.botDispatches.delete(key);
		});
		return result;
	}

	assertBotDispatchIdle(agentId: string): void {
		const sessionId = this.deps.getSessionManager().getSessionId();
		if (
			[...this.botDispatches.keys()].some((key) => {
				const [parent, alias] = JSON.parse(key);
				return parent === sessionId && alias === agentId;
			})
		)
			throw new Error(
				`Bot ${agentId} has a pending message dispatch; wait for it before editing or retiring the bot.`,
			);
	}

	private async dispatchOperatorMessageToBot(
		context: BotRuntimeContext,
		message: string,
		options: GroupMemberMessageOptions | undefined,
		assertCurrentBranch: () => void,
	): Promise<BotOperatorMessageDispatchResult> {
		const { agentId: normId, teamId, teamIncarnationId } = context;
		const store = this.host.getBotTeamStore();
		if (teamId) {
			if (store.reload(true)) this.host.invalidateBotViews();
			const team = store.getTeam(teamId);
			if (!team || teamIncarnation(team) !== teamIncarnationId || !team.memberAgentIds.includes(normId))
				throw new Error("Bot membership or selected group changed before dispatch.");
		}
		// Only the owner's own word makes a bot it names or brings a retired one back; any other send to an id no bot has, or
		// to a retired bot, is refused before anything is written or started (`bot-unreachable.ts`).
		const ownerDirect = isOwnerDirect(context, options);
		const known = store.getBot(normId);
		if (known?.remote) {
			if (!ownerDirect) assertBotReachable(normId, known);
			// A machine joined over the link answers on its own; nothing here starts a worker for it.
			const hub = this.host.getRemoteHub();
			// The orchestrator's turn is a lane, so its end notifies the asker; the owner's own words stay chat.
			const messageId =
				options?.fromRoot || options?.answerInSession ? await hub.ask(normId, message) : hub.send(normId, message);
			return { agentId: normId, mode: "queued", messageId, modelRef: "link/remote" };
		}
		// The owner's word, a group's message and a routine's prompt to a bot with a session of its own never need the worker
		// runtime: they are that session's turn, the owner's or under their own origin.
		const room = () => {
			const team = teamId === undefined ? undefined : store.getTeam(teamId);
			return team ? groupMailRoomBlock(readGroupRoom(store, team, options?.teamMessageId)) : "";
		};
		const words = ownerDirect ? { message, origin: "owner" as const } : sessionWords(context, message, options, room);
		if (words) {
			let sessionBot = store.ensureBotForDispatch(
				normId,
				ownerDirect ? () => this.host.resolveModelSpec() : undefined,
			);
			// The one predicate the bot's host opens and keeps its session by: never a leader's, nor one only a worker holds.
			if (this.host.botSessions.runsAsSession(sessionBot)) {
				// Only the owner's word reaches a retired bot: the store refused every other send.
				const wasRetired = sessionBot.retired === true;
				if (wasRetired) sessionBot = store.upsertBot({ agentId: normId, retired: false });
				assertCurrentBranch();
				try {
					const delivered = await this.host.botSessions.deliver(
						normId,
						words.message,
						options ?? {},
						words.origin,
					);
					this.host.invalidateBotViews();
					return delivered;
				} catch (error) {
					// A refused message (another session hosts the bot, its model is refused) leaves a retired bot retired.
					if (wasRetired) store.retireBot(normId);
					throw error;
				}
			}
		}
		const runtime = this.botBindings.runtime(normId, teamId, teamIncarnationId);
		let liveAgents: WorkerAgentView[] = [];
		try {
			liveAgents = this.host.listWorkerAgents();
		} catch {
			liveAgents = [];
		}
		let bot = store.ensureBotForDispatch(
			normId,
			ownerDirect
				? () => this.host.resolveModelSpec(liveAgents.find((agent) => agent.agentId === runtime)?.modelRef)
				: undefined,
		);

		const requestedMode = options?.mode ?? "follow_up";

		const existingAgent = liveAgents.find((a) => a.agentId === runtime && a.status !== "retired");

		const memoryCtx = store.composeBotUnifiedMemoryContext(normId, teamId, teamIncarnationId);
		const messageOptions = {
			...(teamId ? { threadId: `team:${teamId}:${teamIncarnationId}` } : {}),
			...(options?.delegationObjectiveId ? { delegationObjectiveId: options.delegationObjectiveId } : {}),
			...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
			...(options?.fromLeader ? { fromLeader: this.botBindings.runtime(options.fromLeader) } : {}),
		};

		if (existingAgent && (requestedMode === "follow_up" || requestedMode === "queue")) {
			// The bot received its memory block when it started and edits its blackboards directly; repeating the
			// block in every operator message would bloat its transcript and the chat the operator reads.
			const modelRef = existingAgent.modelRef ?? `${bot.provider}/${bot.modelId}`;
			if (requestedMode === "queue") {
				const res = this.host.sendSessionRootWorkerAgentMessage(runtime, message, messageOptions);
				return { agentId: normId, mode: "queued", messageId: res.messageId, modelRef };
			}
			const res = this.host.followUpSessionRootWorkerAgent(runtime, message, messageOptions);
			if (res.record?.attemptId && !options?.fromRoot) this.host.noteOwnerDirectAttempt(res.record.attemptId);
			return {
				agentId: normId,
				mode: res.steering ? "steered" : res.started ? "followed_up" : "queued",
				messageId: res.messageId,
				laneId: res.record?.laneId,
				modelRef,
			};
		}

		// Only the owner's own word reaches a retired bot here: the store refused every other send.
		if (bot.retired) {
			bot = store.upsertBot({ agentId: normId, retired: false });
		}

		// Fresh worker start with preferredAgentId so lane and worker identity match the persistent bot
		// The memory block follows the task: the lane label, the roster line and the chat open on what the operator sent.
		const fullInstructions =
			memoryCtx.promptBlock.length > 0 ? `${message}${BOT_MEMORY_BLOCK_SEPARATOR}${memoryCtx.promptBlock}` : message;

		const activeIds = Array.from(
			new Set(
				this.host
					.getLaneRecords()
					.filter((r) => r.status === "running" || r.status === "queued")
					.map((r) => r.agentId ?? r.laneId)
					.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== normId),
			),
		);

		const preferredAgentId =
			options?.idempotencyKey === undefined
				? freshBotRuntimeId()
				: keyedBotRuntimeId(normId, options.idempotencyKey);
		// Publish the context before execution: recovery never has to guess a group's origin from its name.
		assertCurrentBranch();
		this.botBindings.bind(normId, preferredAgentId, teamId, teamIncarnationId);
		// The run joins the bot's history in its home, so a later session reads this conversation too.
		if (!teamId)
			this.host.botSessions.noteHistoryRun(normId, this.deps.getSessionManager().getSessionId(), preferredAgentId);
		const started = await this.host.startWorkerDelegation({
			// The current record returned by the locked mutation, including another parent's edits.
			...botWorkerStart(this.deps.getSettingsManager().getWorkerModelPinPolicy(), bot),
			instructions: fullInstructions,
			preferredAgentId,
			// A leader's brief to a bot that has no live worker starts it under the delegation, not the foreground goal.
			...(options?.delegationObjectiveId ? { delegationObjectiveId: options.delegationObjectiveId } : {}),
			...(options?.idempotencyKey ? { messageReplayKey: options.idempotencyKey } : {}),
			// A standing leader's runtime is granted the children it may start (`admitNested`); any other bot is a leaf.
			...(bot.leader === true ? { delegationLimits: this.host.leaderDelegationLimits() } : {}),
			...(activeIds.length > 0
				? {
						parallelWork: {
							independentOf: activeIds,
							justification: `Direct operator chat with persistent bot ${normId}`,
						},
					}
				: {}),
		});

		if (!started.started) {
			throw new Error(`Failed to start persistent bot agent "${normId}": ${started.skipReason ?? "unknown error"}`);
		}
		const startedAgentId = started.record.agentId ?? started.record.laneId;
		if (started.record.attemptId && !options?.fromRoot) this.host.noteOwnerDirectAttempt(started.record.attemptId);
		try {
			assertCurrentBranch();
			if (startedAgentId !== preferredAgentId) throw new Error("Bot start returned a different runtime identity.");
			if (teamId) {
				if (store.reload(true)) this.host.invalidateBotViews();
				const current = store.getTeam(teamId);
				if (!current || teamIncarnation(current) !== teamIncarnationId || !current.memberAgentIds.includes(normId))
					throw new Error("Bot membership or selected group changed while starting.");
			}
		} catch (bindingError) {
			try {
				const current = this.host.listWorkerAgents().find((agent) => agent.agentId === startedAgentId);
				if (!started.record.attemptId || current?.attemptId !== started.record.attemptId)
					throw new Error("The started attempt is no longer current; later work was not cancelled.");
				if (!this.host.getWorkerAttemptResult(started.record.attemptId)) {
					const cancelled = this.host.cancelWorkerAgent(startedAgentId, "bot_binding_publication_failed");
					if (cancelled?.attemptId !== started.record.attemptId)
						throw new Error("Cancellation did not confirm the exact started attempt.");
				}
			} catch (cleanupError) {
				throw new AggregateError(
					[bindingError, cleanupError],
					`Bot ${normId} binding failed for ${startedAgentId}/${started.record.attemptId ?? "unknown"}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
			throw new Error(
				`Bot ${normId} binding failed for ${startedAgentId}/${started.record.attemptId}; its started work was cancelled or already terminal: ${bindingError instanceof Error ? bindingError.message : String(bindingError)}`,
				{ cause: bindingError },
			);
		}
		this.host.invalidateBotViews();

		return {
			mode: "started",
			agentId: normId,
			laneId: started.record.laneId,
			modelRef: started.record.modelRef ?? `${bot.provider}/${bot.modelId}`,
			messageId: `bot-msg-${Date.now()}`,
		};
	}

	/**
	 * `routine`: the origin of the routine whose prompt this is (`BotOperatorMessageOptions.fromRoutine`); absent for the
	 * owner's room words.
	 */
	async sendOperatorMessageToTeam(
		teamIdRaw: string,
		message: string,
		routine?: TurnOriginRecord,
	): Promise<TeamOperatorMessageDispatchResult> {
		const manager = this.deps.getSessionManager();
		const assertBranch = manager.captureBranchContext();
		const assertContext = () => {
			if (this.deps.isDisposed() || this.deps.getSessionManager() !== manager)
				throw new Error("Group message belongs to a previous session.");
			assertBranch();
		};
		assertContext();
		const teamId = normalizeBotOrTeamId(teamIdRaw, "teamId");
		const store = this.host.getBotTeamStore();
		const team = store.getTeam(teamId);
		if (!team) {
			throw new Error(`Cannot send message to nonexistent team "${teamId}". Create the team first.`);
		}

		const members = team.memberAgentIds;
		if (members.length === 0) {
			throw new Error(`Team "${teamId}" has no members to receive messages.`);
		}

		store.ensureTeamMemoryFile(teamId);
		const timestamp = Date.now();
		const messageId = `team-msg-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
		const deliveries: PersistentTeamMemberDelivery[] = [];

		const trimmedMessage = message.trim();
		let targetAgentIds: string[] = [];
		let contentForBots = trimmedMessage;

		if (trimmedMessage.startsWith("@")) {
			const spaceIdx = trimmedMessage.indexOf(" ");
			const targetRaw = (spaceIdx === -1 ? trimmedMessage.slice(1) : trimmedMessage.slice(1, spaceIdx)).replace(
				/[:,;]+$/,
				"",
			);
			const matched = members.find((m) => m.toLowerCase() === targetRaw.toLowerCase());
			if (matched) {
				targetAgentIds = [matched];
				contentForBots = spaceIdx === -1 ? "" : trimmedMessage.slice(spaceIdx + 1).trim();
			} else throw new Error(`Bot ${targetRaw} is not a member of group ${teamId}.`);
		}

		const targets = targetAgentIds.length > 0 ? targetAgentIds : members;
		// The owner's message enters the log before the first dispatch, so a member that answers at once is logged after
		// the question it answers. Each member's outcome is recorded on it as that member's dispatch settles.
		const teamMsg: PersistentTeamMessage = {
			messageId,
			teamId,
			sender: { kind: "operator" },
			text: message,
			timestamp,
			targetAgentIds: [...targets],
			deliveries: [],
		};
		assertContext();
		store.appendScopedTeamMessage(teamMsg, teamIncarnation(team));
		const noteDelivery = (delivery: PersistentTeamMemberDelivery): void => {
			deliveries.push(delivery);
			store.recordTeamMessageDelivery(teamId, messageId, delivery);
		};

		for (const memberId of targets) {
			assertContext();
			try {
				const botResult = await this.sendOperatorMessageToBot(memberId, contentForBots, {
					teamId,
					teamIncarnationId: teamIncarnation(team),
					teamMessageId: messageId,
					...(routine ? { fromRoutine: routine } : {}),
				});
				assertContext();
				// A member either takes the words as a steer or in a follow-up turn of its own, and the record keeps which.
				noteDelivery({
					agentId: memberId,
					outcome: botResult.mode === "steered" ? "steering" : botResult.mode,
					messageId: botResult.messageId,
				});
			} catch (err) {
				assertContext();
				noteDelivery({
					agentId: memberId,
					outcome: "failed",
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return {
			teamId,
			message: { ...teamMsg, deliveries: [...deliveries] },
			deliveries,
		};
	}
}
