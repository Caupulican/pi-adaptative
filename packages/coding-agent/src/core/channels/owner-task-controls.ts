/** Admission and replay of model-free phone commands. The channel journal binds each event to one task incarnation. */

import { enqueueBotInbox } from "../bots/bot-inbox.ts";
import { botSessionOnDisk } from "../bots/bot-remote-view.ts";
import { stopRoutineBotJobs } from "../remote/routine-job-results.ts";
import { routineBotOccurrenceRef } from "../routines/routine-bot-reference.ts";
import type { ChannelJournal, ChannelJournalState, ChannelOwnerConversation } from "./channel-journal.ts";
import { DAY_MS, digest, MAX_OWNER_CONVERSATIONS } from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { policyFingerprint } from "./owner-channel.ts";
import {
	MAX_PHONE_TASK_COMMANDS,
	OWNER_TASK_GONE,
	OWNER_TASK_HELP,
	type OwnerTaskAction,
	type OwnerTaskPort,
	ownerTaskOccurrences,
	parseTaskAction,
	pausedTaskReply,
	phoneCommandRef,
	readOwnerTask,
	taskStatus,
} from "./owner-task.ts";

export type TaskAdmission = {
	readonly reply?: string;
	readonly pending?: true;
	readonly conversation: ChannelOwnerConversation;
};

/** Called under the inbound journal write, before the provider acknowledges the event. */
function admitTaskControl(
	port: OwnerTaskPort | undefined,
	state: ChannelJournalState,
	conversation: ChannelOwnerConversation,
	action: OwnerTaskAction,
	event: string,
	policy: ResolvedChannelPolicy,
	cwd: string,
): TaskAdmission {
	if (!port) return { conversation, reply: "This host cannot access scheduled bot tasks." };
	if (action.kind === "taskHelp") return { conversation, reply: OWNER_TASK_HELP };
	if (action.kind === "unselect") {
		const { selection: _removed, ...rest } = conversation;
		return { conversation: rest, reply: "Returned to the channel conversation." };
	}
	const store = port.getBotTeamStore();
	if (action.kind === "select") {
		const routine = readOwnerTask(store, action.bot, action.routine);
		if (!routine) return { conversation, reply: OWNER_TASK_GONE };
		const selection = { bot: action.bot, routine: routine.routineId, incarnation: routine.incarnationId };
		return { conversation: { ...conversation, selection }, reply: taskStatus(port, selection) };
	}
	const selection = conversation.selection;
	if (!selection) return { conversation, reply: OWNER_TASK_HELP };
	if (action.kind === "taskStatus") {
		const latest = state.ownerTaskCommands?.findLast(
			(cmd) =>
				cmd.sender === conversation.senderDigest &&
				cmd.conversation === conversation.conversationKey &&
				cmd.selection.incarnation === selection.incarnation &&
				cmd.selection.bot === selection.bot,
		);
		const progress = latest?.state === "running" ? latest.state : (latest?.reply ?? latest?.state);
		return {
			conversation,
			reply: [
				taskStatus(port, selection),
				latest && `Phone ${latest.action}: ${progress}`,
				latest?.terminalDraft && `Held action ${latest.terminalDraft} requires the bot’s terminal.`,
			]
				.filter(Boolean)
				.join("\n"),
		};
	}
	const routine = readOwnerTask(store, selection.bot, selection.routine, selection.incarnation);
	if (!routine) return { conversation, reply: OWNER_TASK_GONE };
	state.ownerTaskCommands ??= [];
	const commands = state.ownerTaskCommands;
	const stop = action.kind === "taskStop";
	const matching = commands.filter((c) => (c.action === "stop") === stop);
	if (matching.length >= MAX_PHONE_TASK_COMMANDS) {
		// Stops have their own capacity. A settled zero-spend receipt can be replaced while the seen journal still deduplicates it.
		const remove = matching.find((c) => c.state === "finished" && !c.spend?.usd);
		if (remove) commands.splice(commands.indexOf(remove), 1);
		else if (stop) {
			const existing = matching.find(
				(c) =>
					c.state !== "finished" &&
					c.selection.incarnation === selection.incarnation &&
					c.revision === routine.revision,
			);
			if (existing) return { conversation, reply: "A stop for this task is already pending." };
			throw new Error("Phone stop queue is busy; redeliver this event.");
		} else return { conversation, reply: "The phone steering queue is full. Task stops remain available." };
	}
	const runs = ownerTaskOccurrences(store, selection);
	const last = runs.reduce<(typeof runs)[number] | undefined>(
		(latest, run) => (!latest || run.createdAt >= latest.createdAt ? run : latest),
		undefined,
	);
	const occurrences = stop
		? runs
		: last && (last.phase === "running" || last.result?.outcome === "succeeded")
			? [last]
			: [];
	const occurrenceIds = occurrences.map((o) => o.occurrenceId);
	const project = action.kind === "steer" ? occurrences.at(-1)?.definition.botProjectCwd : undefined;
	if (!stop && !occurrenceIds.length)
		return { conversation, reply: "This schedule has not run yet or its latest run did not reach the bot." };
	const refs =
		action.kind === "taskStop"
			? [
					...occurrenceIds.map(routineBotOccurrenceRef),
					...commands
						.filter(
							(c) =>
								c.action === "steer" &&
								c.selection.bot === selection.bot &&
								c.selection.incarnation === selection.incarnation,
						)
						.map((c) => phoneCommandRef(c.id)),
				]
			: undefined;
	commands.push({
		id: event,
		occurrenceIds,
		...(refs ? { refs } : {}),
		selection,
		sender: conversation.senderDigest,
		conversation: conversation.conversationKey,
		address: conversation.address,
		admittedAt: conversation.at,
		revision: routine.revision,
		cwd: project ?? cwd,
		...(project ? { projectBound: true } : {}),
		policyHash: digest(policyFingerprint(policy)),
		action: action.kind === "taskStop" ? "stop" : "steer",
		...(action.kind === "steer" ? { words: action.words } : {}),
		state: "pending",
	});
	return { conversation, pending: true };
}

/** Replay commands through their target's owner; identity and revision were fixed at admission. */
export async function drainTaskControls(
	port: OwnerTaskPort,
	commands: NonNullable<ChannelJournalState["ownerTaskCommands"]>,
	journal: ChannelJournal,
	agentDir: string,
	channel: string,
	now: number,
	live: (sender: string, policyHash: string) => boolean,
	reply: (chat: { conversationKey: string; address: string }, key: string, text: string) => Promise<void>,
) {
	for (const command of commands) {
		if (command.state === "finished") continue;
		if (now - command.admittedAt >= DAY_MS) {
			journal.update(now, (state) => {
				const item = state.ownerTaskCommands?.find((entry) => entry.id === command.id);
				if (item && item.state !== "finished") {
					item.state = "finished";
					item.settledAt = now;
					item.reply = "The phone command expired.";
				}
			});
			continue;
		}
		const resignal = command.resignal === true && command.state !== "pending";
		if (command.state !== "pending" && !resignal) continue;
		let text: string | undefined;
		let queued = false;
		const admitted = live(command.sender, command.policyHash);
		const task = command.selection;
		if (!admitted) text = "The channel no longer has authority for this command.";
		else if (
			command.action !== "stop" &&
			!readOwnerTask(port.getBotTeamStore(), task.bot, task.routine, task.incarnation)
		)
			text = OWNER_TASK_GONE;
		else {
			const store = port.getBotTeamStore();
			const key = digest(
				JSON.stringify([
					channel,
					command.id,
					command.sender,
					command.conversation,
					task.bot,
					task.routine,
					task.incarnation,
					command.revision,
				]),
			);
			const paused =
				command.action === "stop" && !resignal
					? command.stopCaptured
						? { kind: "paused" as const, ids: command.occurrenceIds }
						: store.stopBotTask({
								key,
								...task,
								revision: command.revision,
								now,
								expiresAt: command.admittedAt + DAY_MS,
							})
					: undefined;
			if (paused?.kind === "gone") text = OWNER_TASK_GONE;
			else if (paused?.kind === "changed")
				text = "The schedule changed before the stop. Check status and send stop task again.";
			else {
				if (paused?.kind === "paused") {
					const seen = command.stopCaptured
						? command
						: journal.update(now, (state) => {
								const current = state.ownerTaskCommands?.find((item) => item.id === command.id);
								if (!current || current.stopCaptured) return current;
								current.occurrenceIds = [...new Set([...current.occurrenceIds, ...paused.ids])];
								current.refs = [
									...new Set([...(current.refs ?? []), ...paused.ids.map(routineBotOccurrenceRef)]),
								];
								current.stopCaptured = true;
								return current;
							}).result;
					if (!seen) continue;
					store.consumeTaskStop(key);
					stopRoutineBotJobs(agentDir, task.bot, seen.occurrenceIds);
					const refs = new Set(seen.refs);
					journal.update(now, (state) => {
						for (const item of state.ownerTaskCommands ?? []) {
							if (item.state === "finished" || item.action !== "steer" || !refs.has(phoneCommandRef(item.id)))
								continue;
							item.stopRequested = true;
							if (item.state !== "running") {
								item.state = "finished";
								item.settledAt = now;
								item.reply = "Stopped before delivery.";
							}
						}
					});
				}
				enqueueBotInbox(agentDir, {
					agentId: task.bot,
					text: `Phone ${command.action} for task ${task.routine}`,
					at: command.admittedAt,
					from: {
						pid: process.pid,
						cwd: command.projectBound ? command.cwd : (botSessionOnDisk(agentDir, task.bot)?.cwd ?? command.cwd),
					},
					...(command.projectBound ? { projectBound: true } : {}),
					phone: { channel, command: command.id, action: command.action },
					wakeExisting: resignal,
				});
				queued = true;
				text =
					paused?.kind === "paused"
						? store.getRoutine(task.routine)?.enabled
							? `Stopped the captured dispatches for task ${task.routine}. Its current schedule is enabled.`
							: pausedTaskReply(task)
						: `Steering queued for bot ${task.bot}, task ${task.routine}.`;
			}
		}
		journal.update(now, (state) => {
			const item = state.ownerTaskCommands?.find((entry) => entry.id === command.id);
			if (item && resignal) {
				delete item.resignal;
				if (!queued && item.state !== "finished") {
					item.state = "finished";
					item.settledAt = now;
					item.reply = text;
				}
			} else if (item?.state === "pending") {
				item.state = queued ? "queued" : "finished";
				if (!queued) item.settledAt = now;
				item.reply = text;
			}
		});
		if (!resignal && admitted && text)
			await reply({ conversationKey: command.conversation, address: command.address }, command.id, text);
	}
}

/** Update the conversation address and its selection together under the channel's inbound lock. */
export function admitOwnerConversation(
	port: OwnerTaskPort | undefined,
	state: ChannelJournalState,
	conversation: ChannelOwnerConversation,
	event: { text: string; key: string; cwd: string },
	policy: ResolvedChannelPolicy,
	live: boolean,
): TaskAdmission | undefined {
	const previous = state.ownerConversations?.find(
		(c) => c.conversationKey === conversation.conversationKey && c.senderDigest === conversation.senderDigest,
	);
	const selected = previous?.selection ? { ...conversation, selection: previous.selection } : conversation;
	const action =
		parseTaskAction(event.text) ??
		(previous?.selection && event.text.trim().toLowerCase() === "status" ? { kind: "taskStatus" } : undefined);
	let result: TaskAdmission | undefined;
	if (action) {
		// Provider event IDs belong to one channel. The bot inbox and turn references are shared by every channel.
		const commandId = digest(JSON.stringify([conversation.senderDigest, conversation.conversationKey, event.key]));
		if (state.ownerTaskCommands?.some((cmd) => cmd.id === commandId || cmd.id === event.key))
			return { conversation: selected };
		result = live
			? admitTaskControl(port, state, selected, action, commandId, policy, event.cwd)
			: { conversation: selected, reply: "Phone task controls are unavailable." };
	}
	const others = (state.ownerConversations ?? []).filter((c) => c.conversationKey !== conversation.conversationKey);
	state.ownerConversations = [...others, result?.conversation ?? selected].slice(-MAX_OWNER_CONVERSATIONS);
	return result;
}

/** A bot may open before the transport after restart. Wake its existing pointer once the new holder can verify it. */
export function takeTaskChannel(
	state: ChannelJournalState,
	sessionId: string,
	away: boolean,
	policy?: ResolvedChannelPolicy,
): void {
	const old = state.holder;
	if (!old || old.sessionId !== sessionId || old.pid !== process.pid)
		for (const command of state.ownerTaskCommands ?? [])
			if (command.state === "queued" || command.state === "running") command.resignal = true;
	state.holder = {
		sessionId,
		pid: process.pid,
		...(away ? { away: true as const } : {}),
		...(policy ? { ownerPolicy: digest(policyFingerprint(policy)) } : {}),
	};
}
