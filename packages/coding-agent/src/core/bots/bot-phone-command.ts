/** The host of a named bot executes a verified channel command on that bot's existing session. Its inbox holds only a
 * pointer. Identity, target, words and spend reservation come from the channel's private journal. */
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { readBatchOutcome } from "../channels/batch-outcome.ts";
import { type ChannelBatchRecord, ChannelJournal, DAY_MS, digest } from "../channels/channel-journal.ts";
import {
	listedOwnerDigests,
	ownerDollarsApply,
	ownerRoom,
	policyFingerprint,
	readOwnerQuota,
} from "../channels/owner-channel.ts";
import { type OwnerTaskCommand, phoneCommandRef, readOwnerTask } from "../channels/owner-task.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { isEmergencyStopEngaged, subscribeEmergencyStop } from "../provider-admission/emergency-stop.ts";
import { routineBotOccurrenceRef } from "../routines/routine-bot-reference.ts";
import { cleanRedactBound } from "../security/secret-text.ts";
import { entryTurnOrigin } from "../turn-origin.ts";
import { type BotPhoneCommand, readBotInbox, refuseBotInboxMessage } from "./bot-inbox.ts";
import type { BotSessionEntry } from "./bot-session-load.ts";

/** The suffix since this command claimed its turn. A branch switch cannot authorize a second run. */
function commandSuffix(entry: BotSessionEntry, anchor: string | null): SessionEntry[] | undefined {
	const suffix: SessionEntry[] = [];
	let cursor = entry.sessionManager.getLeafId();
	while (cursor !== anchor) {
		const row = cursor && entry.sessionManager.getEntry(cursor);
		if (!row) return undefined;
		suffix.push(row);
		cursor = row.parentId;
	}
	return suffix.reverse();
}

/** Called by the host while it drains. A running steering turn leaves the inbox free to take stops. */
export async function admitBotPhoneCommand(
	entry: BotSessionEntry,
	agentDir: string,
	store: PersistentBotTeamStore,
	pointer: BotPhoneCommand,
	now: () => number,
	busy: boolean,
	settled: () => void,
	warn: (message: string) => void,
): Promise<"take" | "keep"> {
	const state = new ChannelJournal(agentDir, pointer.channel).read().result;
	const command = state.ownerTaskCommands?.find((c) => c.id === pointer.command);
	if (!command || command.state === "finished") return "take";
	if (!state.holder || !isProcessAlive(state.holder.pid)) return "keep";
	if (pointer.action === "stop") {
		await givePhoneCommand(entry, agentDir, store, pointer, now);
		return "take";
	}
	if (busy) return "keep";
	entry.inFlight++;
	void givePhoneCommand(entry, agentDir, store, pointer, now)
		.catch((error) => warn(error instanceof Error ? error.message : String(error)))
		.finally(() => {
			entry.inFlight--;
			settled();
		});
	return "keep";
}

async function givePhoneCommand(
	entry: BotSessionEntry,
	agentDir: string,
	store: PersistentBotTeamStore,
	pointer: BotPhoneCommand,
	now: () => number,
): Promise<void> {
	const journal = new ChannelJournal(agentDir, pointer.channel);
	const find = (commands: OwnerTaskCommand[] | undefined) => commands?.find((item) => item.id === pointer.command);
	const snapshot = journal.read().result;
	const command = find(snapshot.ownerTaskCommands);
	if (!command || command.state === "finished") return;
	if (command.selection.bot !== entry.agentId || command.action !== pointer.action)
		throw new Error("The command belongs to another task.");
	const finish = (reply: string) =>
		journal.update(now(), (state) => {
			const item = find(state.ownerTaskCommands);
			if (item) {
				item.state = "finished";
				item.settledAt = now();
				item.reply = reply;
			}
		});
	const settings = entry.builtFor.settings();
	const delivery = entry.session.ownerChannel;
	const { selection, sender, policyHash } = command;
	const channel = pointer.channel;
	const ref = phoneCommandRef(command.id);
	const resolvePolicy = () => {
		const state = journal.read().result;
		const holder = state.holder;
		const receipt = find(state.ownerTaskCommands);
		if (
			!holder ||
			holder.ownerPolicy !== policyHash ||
			!isProcessAlive(holder.pid) ||
			isEmergencyStopEngaged(agentDir) ||
			now() - command.admittedAt >= DAY_MS ||
			!receipt ||
			receipt.stopRequested ||
			receipt.state === "finished"
		)
			return undefined;
		const policies = holder.away
			? settings.settings.getAwayChannelPolicies()
			: settings.settings.getChannelPolicies();
		const resolved = policies.get(channel);
		if (
			resolved?.kind !== "policy" ||
			resolved.policy.mode !== "explicit" ||
			digest(policyFingerprint(resolved.policy)) !== policyHash ||
			!listedOwnerDigests(channel, resolved.policy, undefined).has(sender)
		)
			return undefined;
		const task = readOwnerTask(store, selection.bot, selection.routine, selection.incarnation);
		return task && (command.action === "stop" || task.enabled) ? resolved.policy : undefined;
	};
	const batch: ChannelBatchRecord = {
		id: ref,
		owner: true,
		sessionId: entry.session.sessionId,
		conversationKey: command.conversation,
		address: command.address,
		eventDigests: [command.id],
		allowlisted: true,
		acceptedAt: command.admittedAt,
		state: "accepted",
	};
	const releases: Array<() => void> = [];
	let releaseMove: (() => void) | undefined;
	let releaseUsage: (() => void) | undefined;
	try {
		const policy = resolvePolicy();
		if (!policy) {
			finish("The phone command expired, the task stopped, or channel authority changed.");
			return;
		}
		if (command.action === "stop") {
			const refs = new Set(command.refs);
			const interrupted = delivery.abortTask(refs);
			for (const item of readBotInbox(agentDir, entry.agentId, () => {})) {
				const targetRef =
					item.message.origin?.ref ??
					(item.message.phone?.action === "steer" ? phoneCommandRef(item.message.phone.command) : undefined);
				if (targetRef && refs.has(targetRef))
					refuseBotInboxMessage(agentDir, item, "The owner stopped this task.", now());
			}
			const foreground = interrupted
				? "Stopped the selected task's foreground turn."
				: "The selected task has no matching foreground turn.";
			const active = entry.session.backgroundLanes
				.listWorkerAgents()
				.filter((worker) => worker.activity === "active").length;
			finish(
				active
					? `${foreground} The bot also has ${active} active local worker(s) outside this stop’s scope.`
					: foreground,
			);
			return;
		}
		const occurrence = command.occurrenceIds.at(-1);
		if (!occurrence) {
			finish("This schedule has not run yet.");
			return;
		}
		const live = () => resolvePolicy() !== undefined;
		const abortIfRevoked = () => {
			if (!live()) delivery.abortRun(ref);
		};
		releases.push(
			store.subscribe(abortIfRevoked),
			settings.settings.subscribeChanges(abortIfRevoked),
			subscribeEmergencyStop(agentDir, abortIfRevoked),
		);
		const quota = () => readOwnerQuota(delivery, policy, () => {});
		releases.push(
			delivery.control().onDraftHeld((view) => {
				if (view.origin.ref !== ref || view.origin.channel !== channel || view.origin.k !== "owner-channel") return;
				journal.update(now(), (state) => {
					const receipt = find(state.ownerTaskCommands);
					if (receipt) receipt.terminalDraft = view.id;
				});
			}),
		);
		const allowance = quota();
		if (allowance.kind === "exhausted") {
			finish("The selected bot's subscription allowance is exhausted.");
			return;
		}
		const anchor = command.anchor !== undefined ? command.anchor : entry.sessionManager.getLeafId();
		const outcome = (suffix: SessionEntry[]) =>
			readBatchOutcome(
				{
					getSessionManager: () => ({ getBranch: () => suffix }),
					getModelRegistry: () => entry.session.modelRegistry,
				},
				channel,
				batch,
				now(),
			);
		const settle = (suffix: SessionEntry[] | undefined) => {
			const result = suffix ? outcome(suffix) : undefined;
			finish(
				result?.kind === "answered"
					? cleanRedactBound(result.text, 1000)
					: "The steering turn ended without a recorded answer.",
			);
		};
		if (command.state === "running") {
			const suffix = command.anchor !== undefined ? commandSuffix(entry, anchor) : undefined;
			if (!suffix || suffix.some((row) => entryTurnOrigin(row)?.ref === ref)) {
				settle(suffix);
				return;
			}
		}
		const reserved = journal.update(now(), (state) => {
			const item = find(state.ownerTaskCommands);
			if (!item || item.state === "finished") return false;
			if (item.state !== "running" && !ownerRoom(channel, state, policy, now(), !ownerDollarsApply(allowance)).fits)
				return false;
			item.state = "running";
			item.anchor = anchor;
			item.spend ??= { reserved: ownerDollarsApply(allowance) ? policy.ownerMaxUsdPerTurn : 0, usd: 0 };
			return true;
		}).result;
		if (!reserved) {
			finish("The phone owner pool has no room for this turn.");
			return;
		}
		const reserveMove = (charge: boolean, save: boolean) =>
			journal.update(now(), (state) => {
				const item = find(state.ownerTaskCommands);
				if (!item?.spend || item.state !== "running") return false;
				if (item.spend.reserved > 0) return true;
				if (!charge && !ownerRoom(channel, state, policy, now()).fits) return false;
				if (save) item.spend = { ...item.spend, reserved: policy.ownerMaxUsdPerTurn };
				return true;
			}).result;
		releaseMove = delivery.holdMeteredMoves({
			fits: () => reserveMove(false, false),
			reserve: (mode) => reserveMove(mode === "charge", true),
		});
		releaseUsage = delivery.observeRunUsage(
			ref,
			(usd) => {
				journal.update(now(), (state) => {
					const item = find(state.ownerTaskCommands);
					if (item?.spend) item.spend.usd = usd;
				});
				if (usd >= policy.ownerMaxUsdPerTurn || quota().kind === "exhausted" || !live()) delivery.abortRun(ref);
			},
			() => {},
		);
		const words = command.words!;
		const accepted = await delivery.deliverTask(
			`Owner message about scheduled task ${selection.routine} on bot ${selection.bot}\n${words}`,
			words,
			{
				channel,
				senderDigest: sender,
				ref,
				routineRef: routineBotOccurrenceRef(occurrence),
			},
			live,
		);
		if (accepted) settle(commandSuffix(entry, anchor));
		else finish("The bot refused this steering turn.");
	} catch (error) {
		finish("The bot could not complete the phone command. See its chat for the failure.");
		throw error;
	} finally {
		for (const release of releases) release();
		releaseUsage?.();
		releaseMove?.();
		settings.release();
	}
}
