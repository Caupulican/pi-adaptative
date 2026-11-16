/**
 * The bot messaging directory one bot runtime reads and writes through: which bots and groups it may reach, the
 * conversation's group admission, and the leader moves a leader bot may make (ask the root, start an owned bot, hand a
 * part of its goal to a standing leader, update a leader it handed a goal to). No bot creates a bot here: only the
 * orchestrator does, through its own `bot` tool. It is built per attempt from a host of
 * the coordinator's ports; the coordinator's private members are reached through arrow functions in its own method, never
 * through a cast. `createBotMessageBroker` turns the directory into the broker the bot_message tool calls.
 *
 * A bot that answers in a session of its own is reached there, never through a worker runtime: a send to it is mail from the
 * sending worker (`workerMail`), whose answer the orchestrator's session hands back to that worker (`RootBots`).
 *
 * A session that directs workers and manages no bots (a bot's own) gets `createSessionScopedBotMessageDirectory`: its
 * workers stay inside it, so they reach no bot and no group, and answer only their session root.
 */

import type { SessionManager } from "../../kernel/node.ts";
import { MAX_BOT_MAIL_HOPS, replayedMailId, workerMail } from "../bots/bot-mail.ts";
import type { BotSessionHost } from "../bots/bot-session-host.ts";
import { groupMailRoomBlock, readGroupRoom } from "./bot-group-room.ts";
import type { BotMessageBroker, BotMessageDirectory, BotOwnedStartOutcome } from "./bot-message-contract.ts";
import type { BotRuntimeBindings } from "./bot-runtime-bindings.ts";
import { goalMailHop } from "./goal-mail.ts";
import type { LeaderController } from "./leader-controller.ts";
import type { LeadRequest } from "./leader-delegation.ts";
import type { DelegationRecord } from "./leader-delegation-ledger.ts";
import { currentDelegationFor } from "./leader-view.ts";
import {
	normalizeBotOrTeamId,
	type PersistentBotRecord,
	type PersistentBotTeamStore,
	teamIncarnation,
} from "./persistent-bot-team-store.ts";
import { sessionRootAddress } from "./session-root-mailbox.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";

/** The coordinator's members one bot messaging directory uses; each is a plain port, bound at the call. */
export interface BotMessageDirectoryHost {
	getSessionManager(): SessionManager;
	isDisposed(): boolean;
	/** The bots that answer in sessions of their own: a send to one is mail to its session. */
	readonly botSessions: Pick<BotSessionHost, "runsAsSession" | "stateOf" | "mailFromWorker">;
	readonly botBindings: Pick<BotRuntimeBindings, "generationContext" | "runtime">;
	getBotTeamStore(): PersistentBotTeamStore;
	invalidateBotViews(): void;
	listWorkerAgents(): WorkerAgentView[];
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

/** Whether `sender`'s attempt `attemptId` still runs on the session and branch the directory was built on; throws otherwise. */
function senderFence(
	host: Pick<BotMessageDirectoryHost, "getSessionManager" | "isDisposed" | "listWorkerAgents">,
	sender: string,
	attemptId: string,
): () => void {
	const manager = host.getSessionManager();
	const assertBranch = manager.captureBranchContext();
	return () => {
		if (host.isDisposed() || host.getSessionManager() !== manager)
			throw new Error("Bot messaging session is no longer current.");
		assertBranch();
		const source = host.listWorkerAgents().find((agent) => agent.agentId === sender);
		if (source?.attemptId !== attemptId || source.dispatch !== "running")
			throw new Error("Bot messaging sender generation is no longer current.");
	};
}

/**
 * The directory of a worker of a bot's own session: it lists nothing, resolves no bot, and authorizes a reply
 * only to its own session root. No leader move is offered.
 */
export function createSessionScopedBotMessageDirectory(
	host: Pick<BotMessageDirectoryHost, "getSessionManager" | "isDisposed" | "listWorkerAgents">,
	sender: string,
	attemptId: string,
): BotMessageDirectory {
	const manager = host.getSessionManager();
	const assertCurrent = senderFence(host, sender, attemptId);
	const reachesNoBot = (): never => {
		assertCurrent();
		throw new Error("This session's workers reach no bot or group: they answer only their session root.");
	};
	return {
		sessionRootOnly: true,
		assertCurrent,
		ownLeader: () => undefined,
		list: () => {
			assertCurrent();
			return { groups: [], totalGroups: 0, peers: [], total: 0 };
		},
		resolve: reachesNoBot,
		mailSession: async () => reachesNoBot(),
		threadId: () => {
			assertCurrent();
			return undefined;
		},
		authorizeReply: (_thread, requester) => {
			assertCurrent();
			if (requester !== sessionRootAddress(manager.getSessionId()))
				throw new Error("Reply requester is outside this session.");
		},
		recordSent: () => {},
	};
}

export function createBotMessageDirectory(
	host: BotMessageDirectoryHost,
	sender: string,
	attemptId: string,
): BotMessageDirectory {
	const manager = host.getSessionManager();
	const assertSender = senderFence(host, sender, attemptId);
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
		assertSender();
		if (
			sourceAlias &&
			host.getBotTeamStore().getBot(sourceAlias) &&
			host.botBindings.runtime(sourceAlias, context.teamId, context.teamIncarnationId) !== sender
		)
			throw new Error("Bot messaging sender alias has been rebound.");
		requireGroup();
	};
	const senderRecord = sourceAlias ? store.getBot(sourceAlias) : undefined;
	// The one predicate the bots' host keeps a session by; a machine joined over the link takes no mail.
	const answersInSession = (bot: PersistentBotRecord) => bot.remote !== true && host.botSessions.runsAsSession(bot);
	const recordSent = (messageId: string, target: string, message: string) => {
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
	};
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
		ownLeader,
		...(senderIsLeader && sourceAlias
			? {
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
					if (!bot.retired && answersInSession(bot))
						return {
							agentId: bot.agentId,
							displayName: bot.displayName,
							state: host.botSessions.stateOf(bot.agentId) ?? "idle",
							available: true,
						};
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
			if (answersInSession(bot)) {
				if (alias === sourceAlias) throw new Error("A bot cannot message itself.");
				return { kind: "session", agentId: alias };
			}
			const runtime = host.botBindings.runtime(alias, context.teamId, context.teamIncarnationId);
			if (runtime === sender) throw new Error("A bot cannot message itself.");
			const recipient = host.listWorkerAgents().find((agent) => agent.agentId === runtime);
			if (!recipient || recipient.status === "retired")
				throw new Error(`Bot ${alias} is inactive in this parent session; ask the parent to start it.`);
			return { kind: "worker", runtime };
		},
		mailSession: async ({ agentId: alias, message, replayKey, thirdParty, teamId, goalTurn }) => {
			assertCurrent();
			// A worker in a group's thread gives the member its room, as its worker's start and the group's mail carry it.
			const group = requireGroup(teamId);
			const mailId = replayedMailId(replayKey);
			const sessionId = manager.getSessionId();
			// Sent in a goal's turn, the goal waits for the answer (`LeaderController.mailSent`), and the mail carries the hop of
			// the reply that started the turn.
			const leaders = goalTurn ? host.getLeaders() : undefined;
			const hop =
				goalTurn && leaders ? goalMailHop(leaders.goalMails(goalTurn.objectiveId), sessionId, sender, goalTurn) : 1;
			// A replay of a send that failed is not sent either: the goal stopped waiting for its answer when it failed.
			if (
				goalTurn &&
				leaders?.goalMails(goalTurn.objectiveId).some((m) => m.mailId === mailId && m.end?.how === "unsent")
			)
				throw new Error(
					"Not sent: this same send already failed; send the words again as a new message if still needed.",
				);
			if (hop > MAX_BOT_MAIL_HOPS)
				throw new Error(
					`Not sent: this would be mail ${hop} in one chain of mails, past the bound of ${MAX_BOT_MAIL_HOPS}. Stop the exchange and report what you have in your answer.`,
				);
			const mail = workerMail({
				sessionId,
				runtime: sender,
				...(senderRecord ? { name: sourceAlias } : {}),
				text: message,
				thirdParty,
				mailId,
				hop,
				...(group ? { room: groupMailRoomBlock(readGroupRoom(store, group)) } : {}),
			});
			const held =
				goalTurn !== undefined &&
				leaders?.mailSent(goalTurn.objectiveId, { mailId, agentId: alias, worker: sender, hop }) === true;
			let sent: Awaited<ReturnType<typeof host.botSessions.mailFromWorker>>;
			try {
				sent = await host.botSessions.mailFromWorker(sourceAlias, alias, mail);
			} catch (error) {
				// Not sent: no answer comes, so the goal no longer waits for one.
				if (held) leaders?.mailEnded(mailId, { how: "unsent", meteredUsd: 0 });
				throw error;
			} finally {
				// Sent or not, the goal now reads the mail where the bot holds it (`LeaderController.mailLeft`).
				if (goalTurn) leaders?.mailLeft(mailId);
			}
			// The mail has left: the group's log records it without fencing again, so the model never sends it twice.
			recordSent(mailId, alias, message);
			return {
				...sent,
				messageId: mailId,
				detail:
					"Mailed to the bot's own session: its answer reaches you on its own as a later message; do not wait for it.",
			};
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
		recordSent,
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
	readonly control: Pick<
		WorkerAgentControlCoordinator,
		"messageWorkerPeer" | "replyToWorkerAgentMessage" | "senderTurnOrigin" | "senderGoalTurn"
	>;
	/** The replay key of one tool invocation: a repeated call with the same key is one message. */
	idempotencyKey(invocationId: string): string;
}

/**
 * The broker the bot_message tool calls for one bot runtime: every member the directory offers, the sends and replies
 * through the coordinator, and each leader-only move present only where the directory offers it.
 */
export function createBotMessageBroker(directory: BotMessageDirectory, ports: BotMessageBrokerPorts): BotMessageBroker {
	const { askRoot, startOwnedBot, lead, sendToSubLeader, sessionRootOnly } = directory;
	return {
		...(sessionRootOnly ? { sessionRootOnly } : {}),
		list: (teamId) => directory.list(teamId),
		send: async (target, message, expectReply, invocationId, teamId) => {
			const resolved = directory.resolve(target, teamId);
			// A bot with a session of its own takes the words as mail, carrying the sender's third party's taint; its answer
			// always comes back, so expectReply does not apply.
			if (resolved.kind === "session") {
				const goalTurn = ports.control.senderGoalTurn(ports.senderAgentId);
				return directory.mailSession({
					agentId: resolved.agentId,
					message,
					replayKey: ports.idempotencyKey(invocationId),
					thirdParty: ports.control.senderTurnOrigin(ports.senderAgentId) !== undefined,
					...(teamId !== undefined ? { teamId } : {}),
					...(goalTurn ? { goalTurn } : {}),
				});
			}
			const outcome = ports.control.messageWorkerPeer(resolved.runtime, message, {
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
		ownLeader: () => directory.ownLeader(),
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
