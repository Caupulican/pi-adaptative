/**
 * The bot messaging directory one bot runtime reads and writes through: which bots and groups it may reach, the
 * conversation's group admission, and the leader moves a leader bot may make (create a bot, ask the root, start an owned
 * bot, hand a part of its goal to a leader, update a leader it handed a goal to). It is built per attempt from a host of
 * the coordinator's ports; the coordinator's private members are reached through arrow functions in its own method, never
 * through a cast. `createBotMessageBroker` turns the directory into the broker the bot_message tool calls.
 */

import type { SessionManager } from "../../kernel/node.ts";
import type { BotCreationRequest, CreatedBotView } from "./bot-creation.ts";
import type { BotMessageBroker, BotMessageDirectory, BotOwnedStartOutcome } from "./bot-message-contract.ts";
import type { BotRuntimeBindings } from "./bot-runtime-bindings.ts";
import type { LeaderController } from "./leader-controller.ts";
import type { LeadRequest } from "./leader-delegation.ts";
import type { DelegationRecord } from "./leader-delegation-ledger.ts";
import { currentDelegationFor } from "./leader-view.ts";
import { normalizeBotOrTeamId, type PersistentBotTeamStore, teamIncarnation } from "./persistent-bot-team-store.ts";
import { sessionRootAddress } from "./session-root-mailbox.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";

/** The coordinator's members one bot messaging directory uses; each is a plain port, bound at the call. */
export interface BotMessageDirectoryHost {
	getSessionManager(): SessionManager;
	isDisposed(): boolean;
	readonly botBindings: Pick<BotRuntimeBindings, "generationContext" | "runtime">;
	getBotTeamStore(): PersistentBotTeamStore;
	invalidateBotViews(): void;
	listWorkerAgents(): WorkerAgentView[];
	createBotFor(
		creator: { readonly kind: "root" } | { readonly kind: "leader"; readonly agentId: string },
		request: BotCreationRequest,
	): CreatedBotView;
	getLeaders(): LeaderController;
	/** Every delegation to a leader, read without building the leader controller. */
	leaderDelegations(): DelegationRecord[];
	startOwnedBotAsChild(
		leaderAgentId: string,
		leaderAlias: string,
		alias: string,
		message: string,
		invocationId: string,
	): Promise<BotOwnedStartOutcome>;
}

export function createBotMessageDirectory(
	host: BotMessageDirectoryHost,
	sender: string,
	attemptId: string,
): BotMessageDirectory {
	const manager = host.getSessionManager();
	const assertBranch = manager.captureBranchContext();
	const context = host.botBindings.generationContext(sender);
	const sourceAlias = context.agentId;
	const thread = context.teamId ? `team:${context.teamId}:${context.teamIncarnationId}` : undefined;
	const store = host.getBotTeamStore();
	const refresh = () => {
		if (store.reload(true)) host.invalidateBotViews();
	};
	refresh();
	const admittedMembers = new Set(context.teamId ? (store.getTeam(context.teamId)?.memberAgentIds ?? []) : []);
	const requireGroup = (teamId?: string) => {
		refresh();
		if (teamId !== undefined && teamId !== context.teamId)
			throw new Error("This bot conversation is not admitted to the requested group.");
		if (!context.teamId) return undefined;
		const team = store.getTeam(context.teamId);
		if (
			!team ||
			teamIncarnation(team) !== context.teamIncarnationId ||
			!team.memberAgentIds.includes(sourceAlias) ||
			!admittedMembers.has(sourceAlias)
		)
			throw new Error("This bot's group membership was removed or replaced.");
		return team;
	};
	const assertCurrent = () => {
		if (host.isDisposed() || host.getSessionManager() !== manager)
			throw new Error("Bot messaging session is no longer current.");
		assertBranch();
		const source = host.listWorkerAgents().find((agent) => agent.agentId === sender);
		if (source?.attemptId !== attemptId || source.dispatch !== "running")
			throw new Error("Bot messaging sender generation is no longer current.");
		if (
			sourceAlias &&
			host.getBotTeamStore().getBot(sourceAlias) &&
			host.botBindings.runtime(sourceAlias, context.teamId, context.teamIncarnationId) !== sender
		)
			throw new Error("Bot messaging sender alias has been rebound.");
		requireGroup();
	};
	const leaderIds = () =>
		store
			.listBots()
			.filter((bot) => bot.leader === true)
			.map((bot) => bot.agentId);
	const senderRecord = sourceAlias ? store.getBot(sourceAlias) : undefined;
	const senderIsLeader = senderRecord?.leader === true && senderRecord.retired !== true;
	// A leader hands a part of its goal on only while that goal runs and its envelope still allows a nested leader.
	const ownGoal =
		senderIsLeader && sourceAlias ? currentDelegationFor(host.leaderDelegations(), sourceAlias) : undefined;
	const mayLead = ownGoal?.state === "running" && ownGoal.charter.envelope.capabilities.includes("delegate");
	// A bot a leader made asks that leader for more bots, while the leader still leads.
	const ownLeader = () => {
		const creator = senderRecord?.createdBy ? store.getBot(senderRecord.createdBy) : undefined;
		return creator?.leader === true && creator.retired !== true ? creator.agentId : undefined;
	};
	return {
		assertCurrent,
		leaderIds,
		ownLeader,
		...(senderIsLeader && sourceAlias
			? {
					createBot: (request: BotCreationRequest) =>
						host.createBotFor({ kind: "leader", agentId: sourceAlias }, request),
					askRoot: (question: string) => host.getLeaders().askRoot(sourceAlias, question),
					startOwnedBot: (agentId: string, message: string, invocationId: string) =>
						host.startOwnedBotAsChild(sender, sourceAlias, agentId, message, invocationId),
					...(mayLead
						? { lead: (request: LeadRequest) => host.getLeaders().delegateFrom(sourceAlias, request) }
						: {}),
					sendToSubLeader: async (agentId: string, message: string) => {
						if (!leadsGoalHandedBy(host.leaderDelegations(), sourceAlias, agentId)) return false;
						await host.getLeaders().update(agentId, message, sourceAlias);
						return true;
					},
				}
			: {}),
		list: (teamId) => {
			assertCurrent();
			const group = requireGroup(teamId);
			const teams = store.listTeams();
			const groups = teams.filter((team) =>
				group ? team.teamId === group.teamId : team.memberAgentIds.includes(sourceAlias),
			);
			const agents = new Map(host.listWorkerAgents().map((agent) => [agent.agentId, agent]));
			const peers = store
				.listBots({ includeRetired: true })
				.filter(
					(bot) =>
						bot.agentId !== sourceAlias &&
						(group
							? group.memberAgentIds.includes(bot.agentId) && admittedMembers.has(bot.agentId)
							: !teams.some((team) => team.memberAgentIds.includes(bot.agentId))),
				)
				.map((bot) => {
					const agent = agents.get(
						host.botBindings.runtime(bot.agentId, context.teamId, context.teamIncarnationId),
					);
					return {
						agentId: bot.agentId,
						displayName: bot.displayName,
						state: bot.retired || agent?.status === "retired" ? "retired" : (agent?.activity ?? "inactive"),
						available: !bot.retired && agent !== undefined && agent.status !== "retired",
						...(bot.leader ? { leader: true as const } : {}),
					};
				});
			return {
				groups: groups.slice(0, 128).map(({ teamId, name }) => ({ teamId, name })),
				totalGroups: groups.length,
				peers: peers.slice(0, 128),
				total: peers.length,
			};
		},
		resolve: (target, teamId) => {
			assertCurrent();
			const group = requireGroup(teamId);
			const alias = normalizeBotOrTeamId(target, "agentId");
			if (
				group
					? !group.memberAgentIds.includes(alias) || !admittedMembers.has(alias)
					: store
							.listTeams()
							.some((team) => team.memberAgentIds.includes(sourceAlias) || team.memberAgentIds.includes(alias))
			)
				throw new Error("Group messages require a conversation admitted to that group.");
			const bot = store.getBot(alias);
			if (!bot || bot.retired) throw new Error(`Bot ${alias} is missing or retired.`);
			const runtime = host.botBindings.runtime(alias, context.teamId, context.teamIncarnationId);
			if (runtime === sender) throw new Error("A bot cannot message itself.");
			const recipient = host.listWorkerAgents().find((agent) => agent.agentId === runtime);
			if (!recipient || recipient.status === "retired")
				throw new Error(`Bot ${alias} is inactive in this parent session; ask the parent to start it.`);
			return runtime;
		},
		threadId: (teamId) => {
			assertCurrent();
			requireGroup(teamId);
			return thread;
		},
		authorizeReply: (requestThread, requester, teamId) => {
			assertCurrent();
			const group = requireGroup(teamId);
			if (requester === sessionRootAddress(manager.getSessionId())) return;
			if (requestThread !== thread || !requester) throw new Error("Reply belongs to another conversation group.");
			const peer = host.botBindings.generationContext(requester);
			if (
				peer.teamId !== context.teamId ||
				peer.teamIncarnationId !== context.teamIncarnationId ||
				(group
					? !group.memberAgentIds.includes(peer.agentId) || !admittedMembers.has(peer.agentId)
					: store.listTeams().some((team) => team.memberAgentIds.includes(peer.agentId)))
			)
				throw new Error("Reply requester is outside this conversation group.");
		},
		recordSent: (messageId, target, message) => {
			if (!context.teamId || !context.teamIncarnationId) return;
			store.appendScopedTeamMessage(
				{
					messageId,
					teamId: context.teamId,
					sender: { kind: "bot", agentId: sourceAlias },
					text: message,
					timestamp: Date.now(),
					targetAgentIds: [target],
					deliveries: [{ agentId: target, outcome: "queued", messageId }],
				},
				context.teamIncarnationId,
			);
		},
	};
}

/** Whether `child` leads the open goal that `parent` handed on: the child's goal is nested under the parent's current goal. */
function leadsGoalHandedBy(records: readonly DelegationRecord[], parent: string, child: string): boolean {
	const parentGoal = currentDelegationFor(records, parent);
	const childGoal = currentDelegationFor(records, child);
	return parentGoal !== undefined && childGoal?.charter.parentObjectiveId === parentGoal.objectiveId;
}

/** What a bot's send and reply go through: the coordinator's control calls, the sender's runtime and the invocation's replay key. */
export interface BotMessageBrokerPorts {
	readonly senderAgentId: string;
	readonly control: Pick<WorkerAgentControlCoordinator, "messageWorkerPeer" | "replyToWorkerAgentMessage">;
	/** The replay key of one tool invocation: a repeated call with the same key is one message. */
	idempotencyKey(invocationId: string): string;
}

/**
 * The broker the bot_message tool calls for one bot runtime: every member the directory offers, the sends and replies
 * through the coordinator, and each leader-only move present only where the directory offers it.
 */
export function createBotMessageBroker(directory: BotMessageDirectory, ports: BotMessageBrokerPorts): BotMessageBroker {
	const { createBot, askRoot, startOwnedBot, lead, sendToSubLeader } = directory;
	return {
		list: (teamId) => directory.list(teamId),
		send: (target, message, expectReply, invocationId, teamId) => {
			const runtime = directory.resolve(target, teamId);
			const outcome = ports.control.messageWorkerPeer(runtime, message, {
				senderAgentId: ports.senderAgentId,
				expectReply,
				threadId: directory.threadId(teamId),
				idempotencyKey: ports.idempotencyKey(invocationId),
			});
			if (!outcome.messageId)
				throw new Error(`Bot message was not accepted: ${outcome.skipReason ?? "unknown reason"}`);
			directory.recordSent(outcome.messageId, target, message);
			return outcome;
		},
		reply: (messageId, message, teamId) => {
			directory.assertCurrent();
			return ports.control.replyToWorkerAgentMessage(ports.senderAgentId, message, messageId, (request) =>
				directory.authorizeReply(request.threadId, request.senderAgentId, teamId),
			);
		},
		leaderIds: () => directory.leaderIds(),
		ownLeader: () => directory.ownLeader(),
		...(createBot
			? {
					create: (request: BotCreationRequest) => {
						directory.assertCurrent();
						return createBot(request);
					},
				}
			: {}),
		...(askRoot
			? {
					askRoot: (question: string) => {
						directory.assertCurrent();
						return askRoot(question);
					},
				}
			: {}),
		...(startOwnedBot
			? {
					startOwnedBot: (agentId: string, message: string, invocationId: string) => {
						directory.assertCurrent();
						return startOwnedBot(agentId, message, invocationId);
					},
				}
			: {}),
		...(lead
			? {
					lead: (request: LeadRequest) => {
						directory.assertCurrent();
						return lead(request);
					},
				}
			: {}),
		...(sendToSubLeader
			? {
					sendToSubLeader: (agentId: string, message: string) => {
						directory.assertCurrent();
						return sendToSubLeader(agentId, message);
					},
				}
			: {}),
	};
}
