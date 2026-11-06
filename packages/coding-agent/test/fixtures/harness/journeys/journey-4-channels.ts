import { basename, join } from "node:path";
import { expect } from "vitest";
import { configFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type {
	ChannelInboundHandler,
	ChannelMessage,
	ChannelProvider,
	ChannelSenderIds,
} from "../../../../src/core/gateways/channel-provider.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { THIRD_PARTY_MEMORY_WITHHELD } from "../../../../src/core/system-prompt-builder.ts";
import { entryTurnOrigin } from "../../../../src/core/turn-origin.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { type Barrier, calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { flushedSessionManager, icmLatestResult, refusalDiagnostic } from "./shared.ts";

/**
 * A deployment's transport as the core sees it: it is started with the core's inbound handler, hands events over and
 * records what the core sends. `deliver` hands a burst over the way one transport poll does: every event before any of
 * them is answered.
 */
class ScriptedChannel implements ChannelProvider {
	readonly name: string;
	/** A transport whose platform assigns each sender's id, so a held sender's notice may name it. */
	readonly senderIds: ChannelSenderIds = { assignedBy: "platform" };
	readonly sent: ChannelMessage[] = [];
	starts = 0;
	stops = 0;
	private inbound: ChannelInboundHandler | undefined;
	private sendWaiter: Barrier | undefined;
	private startWaiter: Barrier | undefined;
	private stopWaiter: Barrier | undefined;

	constructor(name: string) {
		this.name = name;
	}

	start(onInbound: ChannelInboundHandler): void {
		this.starts++;
		this.inbound = onInbound;
		this.startWaiter?.release();
	}

	send(message: ChannelMessage): void {
		this.sent.push(structuredClone(message));
		this.sendWaiter?.release();
	}

	stop(): void {
		this.stops++;
		this.inbound = undefined;
		this.stopWaiter?.release();
	}

	/** Resolves on the next start of this transport. */
	nextStart(): Promise<void> {
		this.startWaiter = createBarrier();
		return this.startWaiter.promise;
	}

	/** Resolves on the next stop of this transport. */
	nextStop(): Promise<void> {
		this.stopWaiter = createBarrier();
		return this.stopWaiter.promise;
	}

	async deliver(...events: ChannelMessage[]): Promise<void> {
		const inbound = this.inbound;
		if (inbound === undefined) throw new Error(`channel ${this.name} was not started`);
		await Promise.all(events.map((event) => inbound(event)));
	}

	/** Resolves on the next message the core sends on this channel. */
	nextSend(): Promise<void> {
		this.sendWaiter = createBarrier();
		return this.sendWaiter.promise;
	}
}

function event(
	id: string,
	conversation: string,
	sender: { readonly id: string; readonly label: string; readonly verified: boolean },
	text: string,
): ChannelMessage {
	return {
		eventId: id,
		conversationKey: conversation,
		address: `${conversation}-address`,
		sender: { id: sender.id, label: sender.label, verified: sender.verified },
		kind: "message",
		text,
	};
}

interface JournalView {
	readonly holder?: { readonly sessionId: string; readonly away?: true };
	readonly pending: readonly { readonly eventDigest: string }[];
	readonly seen: readonly unknown[];
	readonly held: readonly { readonly reason: string }[];
	readonly heldTotal: number;
	readonly batches: readonly { readonly id: string; readonly state: string; readonly away?: true }[];
	readonly drafts: readonly {
		readonly id: string;
		readonly state: string;
		readonly address: string;
		readonly reason: string;
		readonly text: string;
		readonly away?: true;
		readonly told?: true;
	}[];
	readonly gaps: readonly { readonly reason: string; readonly away?: true; readonly told?: true }[];
	readonly toldFlags?: true;
	readonly awayHeld?: Readonly<Record<string, number>>;
	readonly onboarding: readonly unknown[];
}

/** The harness notices of `kind` the session saved for its owner: one per delivery (reason and generation). */
export function notices(manager: SessionManager, kind: string): { readonly reason: string; readonly text: string }[] {
	const deliveries = new Map<string, { readonly reason: string; readonly text: string }>();
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== HARNESS_NOTICE_CUSTOM_TYPE) continue;
		const details = parentInputOriginalDetails(entry);
		if (typeof details !== "object" || details === null || !("kind" in details) || details.kind !== kind) continue;
		const reason = "reason" in details && typeof details.reason === "string" ? details.reason : "";
		const generation = "generation" in details ? String(details.generation) : "";
		deliveries.set(`${reason}#${generation}`, { reason, text: JSON.stringify(entry.content) });
	}
	return [...deliveries.values()];
}

/** Everything the request carries after its last assistant message: the latest batch's results and their records. */
function latestBatchText(request: ScriptedRequest): string {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	return JSON.stringify(messages.slice(start));
}

/** A line of the owner's MEMORY.md: the owner's runs read it in their system prompt, a third party's runs never do. */
const OWNER_MEMORY = "The owner keeps the release checklist in the team wiki.";

function expectOwnerMemory(request: ScriptedRequest, carried: boolean): void {
	const systemPrompt = request.context.systemPrompt ?? "";
	if (carried) {
		expect(systemPrompt, "the owner's run carries the owner's memory").toContain(OWNER_MEMORY);
		expect(systemPrompt).not.toContain(THIRD_PARTY_MEMORY_WITHHELD);
		return;
	}
	expect(systemPrompt, "a run that carries a third party's words has no owner memory").not.toContain(OWNER_MEMORY);
	expect(systemPrompt, "the run reads that the memory is withheld").toContain(THIRD_PARTY_MEMORY_WITHHELD);
}

export function noticeSaved(manager: SessionManager, kind: string, reasonPrefix: string, count = 1): Promise<void> {
	return new Promise<void>((resolve) => {
		const check = () => {
			if (notices(manager, kind).filter((notice) => notice.reason.startsWith(reasonPrefix)).length < count) return;
			unsubscribe();
			resolve();
		};
		const unsubscribe = manager.onEntriesPersisted(check);
		check();
	});
}

/**
 * Channels registered by a deployment wrapper start under the owner's `channels.<name>` policy and wake the session only
 * for a verified, allowlisted sender. On `mail` (draft replies): an unverified event under an allowlisted id and a
 * verified sender the policy does not list are journaled as held and wake nothing (the owner is told that sender's id
 * once, without its label or words); three messages of the allowlisted
 * sender arriving together become one turn with their words inside one fence; in that turn a push the words ask for is
 * prepared, not run, and the owner's own tools (`channel_reply`, `memory`) are refused; the answer waits as a draft,
 * one notice tells the owner, and the owner's own turn sends it to the address the conversation came from and reads the
 * memory the channel's run was refused; a message that arrives during the owner's turn never joins it and opens its own
 * third-party turn after the owner's answer, whose reply is found by the batch id on that turn's origin; the same
 * event delivered again is not admitted twice. Each run that carries a channel's words sends the system prompt without
 * the owner's MEMORY.md, the owner's run sends it again, and no switch reports a prompt prefix change. On `chat` (`replyMode: "auto"`, one turn a day): the answer goes back to
 * the same address without the owner, and later messages are held behind the bound with one notice. A registered
 * channel the owner wrote no policy for never starts, and its notice is saved once the session keeps entries. Closing
 * the session stops every channel and gives up the journal.
 */
export async function runJourney4ChannelsPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-channels`;
	world.io.seed(configFile(agentDir, "MEMORY.md"), `${OWNER_MEMORY}\n`);
	const warningsBefore = world.warnings.length;
	const manager = world.createSessionManager(agentDir);
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		systemOneEnabled: false,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			orchestrator: { delegationGate: false },
			edge: {},
			channels: {
				mail: { mode: "explicit", allowedSenders: ["alice"] },
				chat: { mode: "explicit", allowedSenders: ["bob"], replyMode: "auto", maxWakesPerDay: 1 },
			},
		},
	});
	const session: AgentSession = created.session;
	const journal = (name: string): JournalView =>
		JSON.parse(String(world.io.readFileSync(join(agentDir, "channels", `${name}.json`)))) as JournalView;
	const mail = new ScriptedChannel("mail");
	const chat = new ScriptedChannel("chat");
	const feed = new ScriptedChannel("feed");
	session.registerChannelProvider(mail);
	session.registerChannelProvider(chat);
	session.registerChannelProvider(feed);
	expect(
		session.channels.getStates().find((state) => state.name === "feed")?.state,
		"a channel without a policy is not started",
	).toBe("not_configured");
	expect(feed.starts, "no policy, no start").toBe(0);
	expect(mail.starts, "an explicit policy starts the channel").toBe(1);
	expect(chat.starts).toBe(1);
	expect(session.getToolDefinition("channel_reply"), "the owner's release tool is offered").toBeDefined();
	expect(session.getToolDefinition("memory"), "the owner's memory tool is offered").toBeDefined();
	trace.mark("root", "channels.registered");

	const alice = { id: "alice", label: "Alice", verified: true };
	const bob = { id: "bob", label: "Bob", verified: true };
	const heldWords = ["an unverified note signed alice", "a verified stranger's note"];

	// Held: the allowlisted id without the provider's verification, and a verified sender the policy does not list.
	await mail.deliver(
		event("m-held-1", "thread-1", { ...alice, verified: false }, heldWords[0] ?? ""),
		event("m-held-2", "thread-1", { id: "mallory", label: "Alice", verified: true }, heldWords[1] ?? ""),
	);
	const afterHeld = journal("mail");
	expect(afterHeld.held.map((entry) => entry.reason)).toEqual(["unverified", "not_allowed"]);
	expect(afterHeld.pending, "held events never wait for a turn").toEqual([]);
	for (const words of heldWords)
		expect(JSON.stringify(afterHeld), "a held event's words are not kept").not.toContain(words);

	// Three messages from Alice arrive together: one turn, one fence. The run carries Alice's words, so the push they ask
	// for is prepared, and the owner's release tool and private records are refused.
	const pushCommand = "git push origin main";
	const batchWords = ["the release notes look fine", "one typo in the title", "please push main when ready"];
	const mailTurn = createBarrier();
	world.provider.enqueue(
		"root",
		{
			...calls("channels-mail-call", [
				{ id: "channels-mail-push", name: "bash", arguments: { command: pushCommand } },
				{ id: "channels-mail-release", name: "channel_reply", arguments: { action: "list" } },
				{ id: "channels-mail-memory", name: "memory", arguments: { action: "list", target: "user" } },
			]),
			check: (request) => {
				expectOwnerMemory(request, false);
				const delivered = JSON.stringify(request.context.messages);
				for (const words of batchWords) expect(delivered, "the batch carries every message").toContain(words);
				expect(delivered.split('source=\\"channel:mail\\"').length - 1, "one fence holds the batch").toBe(1);
				expect(delivered, "the frame says who wrote the fenced text").toContain("not by the owner");
				for (const words of heldWords)
					expect(delivered, "a held event never reaches the model").not.toContain(words);
			},
		},
		{
			name: "channels-mail-answer",
			check: (request) => {
				// The refusals' own words name their tools; the batch's results carry them however the loop records them.
				const results = latestBatchText(request);
				expect(results, "the push is prepared, not run").toContain(
					`Prepared, not run: ${pushCommand} (git.publish`,
				);
				expect(results, "the result names the channel").toContain("asked by the mail channel");
				expect(results, "the release tool is the owner's").toContain(
					"Refused: channel_reply releases or discards the owner's channel replies",
				);
				expect(results, "the owner's records stay out of the run").toContain(
					"Refused: memory reads and changes the owner's private records",
				);
				mailTurn.release();
			},
			reply: { content: [{ type: "text", text: "Thanks Alice, the typo is noted." }] },
		},
	);
	const shellBefore = world.shell.requests.length;
	await mail.deliver(
		event("m-1", "thread-1", alice, batchWords[0] ?? ""),
		event("m-2", "thread-1", alice, batchWords[1] ?? ""),
		event("m-3", "thread-1", alice, batchWords[2] ?? ""),
	);
	await withDeadline(trace, "the mail batch's turn", mailTurn.promise);
	await session.agent.waitForIdle();
	await withDeadline(trace, "the mail draft notice", noticeSaved(manager, "channel-reply", "draft:mail:"));
	expect(
		world.shell.requests.slice(shellBefore).map((request) => request.command),
		"a channel's run never reaches the shell with the push",
	).not.toContain(pushCommand);
	expect(mail.sent, "draft mode sends nothing on its own").toEqual([]);
	const drafted = journal("mail");
	expect(drafted.pending, "the delivered messages left the journal").toEqual([]);
	for (const words of batchWords) expect(JSON.stringify(drafted), "no delivered body is kept").not.toContain(words);
	expect(drafted.batches.map((batch) => batch.state)).toEqual(["drafted"]);
	const draft = drafted.drafts[0];
	expect(drafted.drafts.length, "one draft").toBe(1);
	expect(draft?.address, "the draft answers the address the conversation came from").toBe("thread-1-address");
	expect(notices(manager, "channel-reply").length, "the owner is told once").toBe(1);
	// The unconfigured channel registered before the session kept any entry; its notice is saved once it can be.
	await withDeadline(
		trace,
		"the unconfigured channel's notice",
		noticeSaved(manager, "channel-state", "feed:not_configured:"),
	);
	expect(notices(manager, "channel-state").find((notice) => notice.reason.startsWith("feed:"))?.text).toContain(
		"Channel feed is registered but not started: no channels.feed policy",
	);
	// The verified stranger is named to the owner by id only: never by the label it chose, never with its words.
	await withDeadline(trace, "the stranger's sender notice", noticeSaved(manager, "channel-sender", "sender:mail:"));
	const senderNotice = notices(manager, "channel-sender")[0]?.text ?? "";
	expect(senderNotice).toContain('add \\"mallory\\" to that list');
	expect(senderNotice, "the sender's self-chosen label is not shown").not.toContain("Alice");
	expect(senderNotice, "nor the held words").not.toContain(heldWords[1] ?? "");
	expect(notices(manager, "channel-sender").length, "the unverified event tells nothing").toBe(1);
	trace.mark("root", "channels.mail-drafted");

	// The same event again is not admitted twice: nothing waits, nothing wakes.
	const seenBefore = journal("mail").seen.length;
	await mail.deliver(event("m-1", "thread-1", alice, batchWords[0] ?? ""));
	expect(journal("mail").pending, "a redelivered event waits for nothing").toEqual([]);
	expect(journal("mail").seen.length, "a redelivered event is not recorded again").toBe(seenBefore);

	// Auto replies: Bob's question is answered to the address it came from, without the owner.
	const chatSent = chat.nextSend();
	world.provider.enqueue("root", {
		name: "channels-chat-answer",
		check: (request) => {
			const delivered = JSON.stringify(request.context.messages);
			expect(delivered.split('source=\\"channel:chat\\"').length - 1, "Bob's message arrives fenced").toBe(1);
			expect(delivered).toContain("is main green");
		},
		reply: { content: [{ type: "text", text: "Main is green." }] },
	});
	await chat.deliver(event("c-1", "room-7", bob, "is main green"));
	await withDeadline(trace, "the chat reply is sent", chatSent);
	await session.agent.waitForIdle();
	expect(chat.sent.length, "one reply").toBe(1);
	expect(chat.sent[0]).toMatchObject({
		conversationKey: "room-7",
		address: "room-7-address",
		text: "Main is green.",
		kind: "message",
	});
	expect(chat.sent[0]?.eventId, "the reply carries its own event id").toMatch(/^reply:[0-9a-f]{24}:1\/1$/);
	trace.mark("root", "channels.chat-replied");

	// One turn a day on chat: later messages wait behind the bound, and the owner is told once.
	await chat.deliver(event("c-2", "room-7", bob, "still green?"));
	await withDeadline(trace, "the chat bound notice", noticeSaved(manager, "channel-state", "chat:capped:"));
	await chat.deliver(event("c-3", "room-7", bob, "and now?"));
	const cappedNotices = () =>
		notices(manager, "channel-state").filter((notice) => notice.reason.startsWith("chat:capped:"));
	expect(cappedNotices().length, "the bound is told once").toBe(1);

	// The owner's own turn sends the mail draft exactly as kept, and reads the owner's records the channel's run could not.
	// Alice writes again while that turn runs: her words wait and open their own third-party turn after the owner's answer.
	const draftId = draft?.id ?? "";
	const lateWords = "one more thing on thread two";
	const ownerAnswer = "Sent the reply to Alice.";
	const ownerTurn = createBarrier();
	const lateTurn = createBarrier();
	let lateDelivery: Promise<void> | undefined;
	world.provider.enqueue(
		"root",
		{
			...calls("channels-owner-release", [
				{ id: "channels-owner-send", name: "channel_reply", arguments: { action: "send", draft: draftId } },
				{ id: "channels-owner-memory", name: "memory", arguments: { action: "list", target: "user" } },
			]),
			check: (request) => {
				expectOwnerMemory(request, true);
				lateDelivery = mail.deliver(event("m-4", "thread-2", alice, lateWords));
			},
		},
		{
			name: "channels-owner-answer",
			check: (request) => {
				expect(icmLatestResult(request, "channel_reply").text, "the owner's run releases the draft").toBe(
					`Sent draft ${draftId} to its conversation on mail.`,
				);
				const memory = icmLatestResult(request, "memory");
				expect(memory.text, "the owner's run reads the owner's records").not.toContain("Refused");
				expect(memory.isError, memory.text).toBe(false);
				expect(
					JSON.stringify(request.context.messages),
					"a third party's words never join the owner's run",
				).not.toContain(lateWords);
				ownerTurn.release();
			},
			reply: { content: [{ type: "text", text: ownerAnswer }] },
		},
		{
			name: "channels-mail-late-answer",
			check: (request) => {
				expectOwnerMemory(request, false);
				const messages = request.context.messages.map((message) => JSON.stringify(message));
				const answered = messages.findIndex((message) => message.includes(ownerAnswer));
				const late = messages.findIndex((message) => message.includes(lateWords));
				expect(answered, "the owner's turn answered first").toBeGreaterThanOrEqual(0);
				expect(late, "the late message opens the next turn, after the owner's answer").toBeGreaterThan(answered);
				expect(messages[late], "the late message arrives fenced").toContain('source=\\"channel:mail\\"');
				lateTurn.release();
			},
			reply: { content: [{ type: "text", text: "Noted for thread two." }] },
		},
	);
	await withDeadline(trace, "the owner's release turn", session.prompt("Send the waiting mail reply."));
	await withDeadline(trace, "the owner's release answer", ownerTurn.promise);
	await withDeadline(
		trace,
		"the late message is recorded",
		lateDelivery ?? Promise.reject(new Error("not delivered")),
	);
	await withDeadline(trace, "the late message's own turn", lateTurn.promise);
	await session.agent.waitForIdle();
	await withDeadline(trace, "the late reply's draft notice", noticeSaved(manager, "channel-reply", "draft:mail:", 2));
	const branch = manager.getBranch();
	const ownerAnswerIndex = branch.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			JSON.stringify(entry.message.content).includes(ownerAnswer),
	);
	const lateIndex = branch.findIndex(
		(entry) =>
			entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message).includes(lateWords),
	);
	const lateEntry = branch[lateIndex];
	const lateBatch = journal("mail").batches[1];
	expect(ownerAnswerIndex, "the owner's answer is on the branch").toBeGreaterThanOrEqual(0);
	expect(lateIndex, "the late message is its own entry after the owner's answer").toBeGreaterThan(ownerAnswerIndex);
	expect(lateEntry && entryTurnOrigin(lateEntry), "the late turn carries its own third-party origin").toEqual({
		v: 1,
		k: "inbound-channel",
		channel: "mail",
		verified: true,
		thirdParty: true,
		ref: lateBatch?.id,
	});
	expect(lateBatch?.state, "the late reply is routed by the batch id on its turn's origin").toBe("drafted");
	trace.mark("root", "channels.late-message-queued");
	expect(mail.sent.length, "the released draft is sent once").toBe(1);
	expect(mail.sent[0]).toMatchObject({
		conversationKey: "thread-1",
		address: "thread-1-address",
		text: "Thanks Alice, the typo is noted.",
		kind: "message",
	});
	expect(journal("mail").drafts.map((entry) => entry.state)).toEqual(["sent", "pending"]);
	const capped = cappedNotices();
	expect(capped.length, "the owner's turn does not tell the bound again").toBe(1);
	expect(capped[0]?.text).toContain(
		"Channel chat holds new messages: its bound of 1 turn(s) in 24 hours is reached (channels.chat.maxWakesPerDay).",
	);
	expect(journal("chat").pending.length, "the held-back messages still wait").toBe(2);
	expect(chat.sent.length, "nothing more went out on chat").toBe(1);
	trace.mark("root", "channels.owner-released");
	expect(
		world.warnings.slice(warningsBefore).filter((warning) => warning.startsWith("Prompt cache prefix changed")),
		"each variant of the prompt keeps its own cached prefix: switching between them reports no prefix change",
	).toEqual([]);

	expect(await world.disposeSessionInBody(session), "the channels session closes").toBeUndefined();
	expect([mail.stops, chat.stops], "closing stops every started channel").toEqual([1, 1]);
	expect(feed.starts, "the unconfigured channel never started").toBe(0);
	expect(journal("mail").holder, "the closed session no longer serves mail").toBeUndefined();
	trace.mark("root", "channels.closed");
}

/**
 * Channels while no session is open: the owner's global `channels.phone.awayCwd` makes a session start bring the daemon
 * up by itself, and with every session closed the daemon serves the channel in a headless read-only session. A stranger
 * starts nothing. Alice's question gets its turn there and its answer goes back to her (`replyMode: "auto"`). A
 * session that opens while the daemon's next turn runs takes the channel over at once: the daemon's transport stops,
 * that turn's answer waits as one draft marked as written away, the session delivers nothing again and its status
 * counts the draft. Once that turn is settled the session tells its owner, in one notice, what the daemon left: the
 * draft by id and reason, a message it found past its day and the stranger it held, counted, with none of their words.
 * A gap of the build before told flags (the seeded journal has no marker) counts as told and gets no notice. Closing the
 * session gives the channel back to the daemon, which holds one more stranger; a second session taking it again tells
 * only that stranger, counted, and nothing told before. Stopping the daemon gives it up.
 */
export async function runJourney4AwayChannelsPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-away-channels`;
	const policy = {
		mode: "explicit" as const,
		allowedSenders: ["alice"],
		replyMode: "auto" as const,
		awayCwd: HARNESS_PROJECT_CWD,
	};
	// The daemon reads the owner's global settings file; the sessions read the same values from their own store.
	world.io.seed(
		configFile(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: HARNESS_PROVIDER, defaultModel: "root", channels: { phone: policy } }),
	);
	const settings = {
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
		orchestrator: { delegationGate: false },
		routines: { away: { autostart: "off" as const } },
		channels: { phone: policy },
	};
	const journalPath = join(agentDir, "channels", "phone.json");
	const journal = (): JournalView => JSON.parse(String(world.io.readFileSync(journalPath))) as JournalView;
	const journalHolds = (holds: (state: JournalView) => boolean) =>
		world.io.waitForMutation(() => world.io.existsSync(journalPath) && holds(journal()));
	// A message that has waited past its day when the daemon first serves the channel: the daemon drops it undelivered.
	// The journal is one of the build before told flags: its gap was told by that build's rule and is never told again.
	const expiredWords = "the lilac harbor ledger";
	const waitedSince = Date.now() - 25 * 60 * 60 * 1000;
	const expiredDigest = "seeded-expired-event";
	world.io.seed(
		journalPath,
		JSON.stringify({
			version: 1,
			pending: [
				{
					eventDigest: expiredDigest,
					conversationKey: "chat-7",
					address: "chat-7-address",
					senderId: "alice",
					senderLabel: "Alice",
					verified: true,
					kind: "message",
					text: expiredWords,
					receivedAt: waitedSince,
					admittedAt: waitedSince,
				},
			],
			seen: [{ d: expiredDigest, at: waitedSince, outcome: "pending" }],
			held: [],
			heldTotal: 0,
			ignoredTotal: 0,
			batches: [],
			drafts: [],
			gaps: [{ id: "seeded-legacy-gap", reason: "unanswered", count: 1, at: waitedSince }],
			onboarding: [],
		}),
	);
	const daemonPhone = new ScriptedChannel("phone");
	const built: string[] = [];
	const daemonServes = daemonPhone.nextStart();
	const launched = world.processes.runNextBotDaemon({
		channelProviders: (channel) => {
			built.push(channel);
			return channel === "phone" ? daemonPhone : undefined;
		},
	});
	const opener = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings,
	});
	const daemon = await withDeadline(trace, "a session start launches the daemon for an away channel", launched);
	expect(await world.disposeSessionInBody(opener.session), "the opening session closes").toBeUndefined();
	await withDeadline(trace, "the daemon serves the channel", daemonServes);
	expect(built, "the daemon builds the configured channel's transport once").toEqual(["phone"]);
	expect(journal().holder?.away, "the daemon's host holds the channel").toBe(true);
	await withDeadline(
		trace,
		"the daemon drops the message past its day",
		journalHolds((state) => state.gaps.some((gap) => gap.reason === "expired")),
	);
	expect(
		journal().gaps.map((gap) => [gap.reason, gap.away, gap.told]),
		"the drop is the daemon's, not told yet; the older build's gap reads as told",
	).toEqual([
		["unanswered", undefined, true],
		["expired", true, undefined],
	]);
	expect(journal().toldFlags, "the first write records that the journal keeps told flags").toBe(true);
	expect(journal().pending, "the dropped message's words are gone").toEqual([]);
	trace.mark("root", "away-channels.served");

	// A verified stranger is held: no turn, no request.
	const alice = { id: "alice", label: "Alice", verified: true };
	const requestsBefore = world.provider.requests.length;
	await daemonPhone.deliver(event("p-held", "chat-9", { id: "mallory", label: "Mallory", verified: true }, "hello"));
	expect(
		journal().held.map((entry) => entry.reason),
		"a stranger is held",
	).toEqual(["not_allowed"]);
	expect(journal().awayHeld, "the daemon counts the held stranger for the owner's next session").toEqual({
		not_allowed: 1,
	});
	expect(journal().onboarding, "no owner reads the daemon: the sender's onboarding notice is left").toEqual([]);
	expect(world.provider.requests.length, "a stranger starts no turn").toBe(requestsBefore);

	// Alice's question gets its turn in the headless session, and its answer goes back to her address. Its file tools
	// read the working directory and nothing of the harness: the auth file, the channel token, the channel journals
	// and the project's own settings file are refused before the tool runs.
	const awayTools = ["read", "grep", "find", "ls"];
	const tokenMarker = "away-token-7f3c91";
	const tokenPath = join(agentDir, "channels", "telegram.token");
	world.io.seed(tokenPath, tokenMarker);
	const notesPath = projectPath("docs", "release-notes.md");
	world.io.seed(notesPath, "Release notes live in docs/release-notes.md.\n");
	const refusedReads = {
		"away-read-auth": configFile(agentDir, "auth.json"),
		"away-read-token": tokenPath,
		"away-read-project-settings": projectPath(".pi", "settings.json"),
	};
	world.provider.enqueue(
		"root",
		{
			...calls("away-phone-reads", [
				...Object.entries(refusedReads).map(([id, path]) => ({ id, name: "read", arguments: { path } })),
				{ id: "away-ls-channels", name: "ls", arguments: { path: join(agentDir, "channels") } },
				{ id: "away-read-notes", name: "read", arguments: { path: notesPath } },
			]),
			check: (request) => {
				const delivered = JSON.stringify(request.context.messages);
				expect(delivered.split('source=\\"channel:phone\\"').length - 1, "Alice's message arrives fenced").toBe(1);
				expect(delivered).toContain("where are the release notes");
				const tools = (request.context.tools ?? []).map((tool) => tool.name);
				expect(tools, "the headless session reads").toContain("read");
				expect(
					tools.filter((name) => !awayTools.includes(name)),
					"the headless session has only read-only tools",
				).toEqual([]);
			},
		},
		{
			name: "away-phone-answer",
			check: (request) => {
				const result = (id: string) => {
					const found = request.context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === id,
					);
					if (found?.role !== "toolResult") throw new Error(`Missing tool result ${id}`);
					return {
						isError: found.isError,
						text: found.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
					};
				};
				for (const [id, path] of [
					...Object.entries(refusedReads),
					["away-ls-channels", join(agentDir, "channels")],
				]) {
					const refused = result(id);
					expect(refused.isError, `${id} is refused`).toBe(true);
					// The model's context shortens a long path to its `p/<name>` alias, so the refusal names the path as the
					// tool received it: the file name is what identifies it, the scope and the "not run" verdict are exact.
					const named = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					expect(
						refusalDiagnostic(refused.text),
						`${id} is refused by the private path scope before it runs`,
					).toMatch(
						new RegExp(
							`^envelope_path_denied: ".*${named}" is outside envelope worker-session-private-paths's path scope\\. The tool was NOT run\\.`,
						),
					);
				}
				const notes = result("away-read-notes");
				expect(notes.isError, "a file of the working directory is read").toBeFalsy();
				expect(notes.text).toContain("Release notes live in docs/release-notes.md.");
			},
			reply: { content: [{ type: "text", text: "Hi Alice, the notes are in the docs folder." }] },
		},
	);
	const answered = daemonPhone.nextSend();
	await daemonPhone.deliver(event("p-1", "chat-9", alice, "where are the release notes"));
	await withDeadline(trace, "the away answer goes back to Alice", answered);
	expect(daemonPhone.sent, "one answer, to the address the question came from").toMatchObject([
		{ conversationKey: "chat-9", address: "chat-9-address", text: "Hi Alice, the notes are in the docs folder." },
	]);
	await withDeadline(
		trace,
		"the away turn is settled",
		journalHolds((state) => state.batches.length === 1 && state.batches[0]?.state === "replied"),
	);
	expect(journal().batches[0]?.away, "the turn is charged to the away bound").toBe(true);
	expect(
		world.provider.requests.filter((request) => JSON.stringify(request.context).includes(tokenMarker)).length,
		"the channel token reaches no model request",
	).toBe(0);
	trace.mark("root", "away-channels.answered");

	// A session opens while the daemon's next turn runs: it takes the channel at once, the daemon's transport stops, and
	// that turn's answer waits as one draft (the daemon no longer runs the channel); the session delivers it to no turn.
	const heldTurn = createBarrier();
	const turnReached = createBarrier();
	world.provider.enqueue("root", {
		name: "away-phone-preempted",
		gate: heldTurn.promise,
		check: () => turnReached.release(),
		reply: { content: [{ type: "text", text: "Hi Alice, the wiki has the schedule." }] },
	});
	await daemonPhone.deliver(event("p-2", "chat-9", alice, "and the schedule"));
	await withDeadline(trace, "the daemon's second turn starts", turnReached.promise);
	const daemonYields = daemonPhone.nextStop();
	// Its transcript is written, so what it tells is saved when it is observed.
	const manager = flushedSessionManager(world, agentDir);
	const reopened = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		systemOneEnabled: false,
		settings,
	});
	const sessionPhone = new ScriptedChannel("phone");
	reopened.session.registerChannelProvider(sessionPhone);
	expect(sessionPhone.starts, "the open session takes the channel over").toBe(1);
	await withDeadline(trace, "the daemon yields the channel", daemonYields);
	expect(journal().holder?.sessionId, "the open session holds the channel").toBe(manager.getSessionId());
	heldTurn.release();
	await withDeadline(
		trace,
		"the preempted turn's answer waits as a draft",
		journalHolds((state) => state.drafts.length === 1),
	);
	const preempted = journal();
	expect(preempted.drafts[0], "the preempted answer is kept once").toMatchObject({
		state: "pending",
		away: true,
		reason: "the channel is not running",
		text: "Hi Alice, the wiki has the schedule.",
	});
	expect(
		preempted.batches.map((batch) => batch.state),
		"each batch is settled once",
	).toEqual(["replied", "drafted"]);
	expect(preempted.pending, "nothing waits to be delivered again").toEqual([]);
	await reopened.session.agent.waitForIdle();
	expect(
		world.provider.requests.length - requestsBefore,
		"three requests: the first batch's tool round and answer, the second batch's answer; none in the open session",
	).toBe(3);
	expect([daemonPhone.sent.length, sessionPhone.sent], "the draft is not sent").toEqual([1, []]);
	expect(reopened.session.backgroundLanes.readAwayChannelStatus(), "the session counts the away draft").toEqual([
		{ name: "phone", cwd: HARNESS_PROJECT_CWD, servedBy: "this session", awayDrafts: 1 },
	]);
	trace.mark("root", "away-channels.taken-over");

	// With the preempted turn settled, the session tells its owner once what the daemon left: the draft by id and
	// reason, the dropped message and the held stranger counted, and no sender's id, label or words.
	await withDeadline(
		trace,
		"the owner is told what the daemon left",
		noticeSaved(manager, "channel-gap", "away:phone:"),
	);
	const summaries = notices(manager, "channel-gap");
	expect(summaries.length, "one summary, and no notice per record").toBe(1);
	expect(notices(manager, "channel-reply"), "the daemon's draft has no notice of its own").toEqual([]);
	const summary = summaries[0]?.text ?? "";
	expect(summary).toContain("While the daemon served channel phone:");
	expect(summary, "the draft is named by id and reason").toContain(
		`1 reply draft(s) wait for channel_reply (${preempted.drafts[0]?.id}: the channel is not running)`,
	);
	expect(summary).toContain("1 message(s) expired after 24 hours");
	expect(summary).toContain("1 message(s) held (1 not in channels.phone.allowedSenders)");
	for (const words of [
		expiredWords,
		"alice",
		"mallory",
		"hello",
		"release notes",
		"schedule",
		"chat-7",
		"chat-9",
		"docs folder",
	])
		expect(summary.toLowerCase(), "no third party's text reaches the owner's notice").not.toContain(words);
	const told = journal();
	expect(
		told.gaps.map((gap) => [gap.reason, gap.away, gap.told]),
		"the dropped message is told; the older build's gap had no notice",
	).toEqual([
		["unanswered", undefined, true],
		["expired", true, true],
	]);
	expect(
		told.drafts.map((draft) => [draft.state, draft.told]),
		"the draft is told and still waits",
	).toEqual([["pending", true]]);
	expect(told.awayHeld, "the held stranger is told").toBeUndefined();
	trace.mark("root", "away-channels.told");

	// The session closes: the daemon takes the channel back.
	const daemonReturns = daemonPhone.nextStart();
	expect(await world.disposeSessionInBody(reopened.session), "the open session closes").toBeUndefined();
	await withDeadline(trace, "the daemon takes the channel back", daemonReturns);
	expect(journal().holder?.away, "the daemon serves the channel again").toBe(true);
	await daemonPhone.deliver(
		event("p-held-again", "chat-11", { id: "mallory", label: "Mallory", verified: true }, "hello again"),
	);
	expect(journal().awayHeld, "the daemon counts one more held stranger").toEqual({ not_allowed: 1 });

	// A second session takes the channel from the daemon again: it tells the one stranger held since, and nothing that
	// was told already.
	const daemonYieldsAgain = daemonPhone.nextStop();
	const againManager = flushedSessionManager(world, agentDir);
	const again = await world.createRootSession("root", {
		agentDir,
		sessionManager: againManager,
		systemOneEnabled: false,
		settings,
	});
	const againPhone = new ScriptedChannel("phone");
	again.session.registerChannelProvider(againPhone);
	await withDeadline(trace, "the daemon yields the channel again", daemonYieldsAgain);
	expect(journal().holder?.sessionId, "the second session holds the channel").toBe(againManager.getSessionId());
	await withDeadline(
		trace,
		"the second session tells what the daemon held since",
		noticeSaved(againManager, "channel-gap", "away:phone:"),
	);
	const againNotices = (await again.session.autonomyStatus()).harnessNotices;
	if (againNotices.status !== "available") throw new Error(`Harness notices unavailable: ${againNotices.reason}`);
	expect(
		againNotices.value.observed.items.filter((item) => item.kind === "channel-gap").length,
		"the second takeover observes one summary",
	).toBe(1);
	const againSummaries = notices(againManager, "channel-gap");
	expect(againSummaries.length, "one summary, and no notice per record").toBe(1);
	const againSummary = againSummaries[0]?.text ?? "";
	expect(againSummary, "the new stranger is counted").toContain(
		"While the daemon served channel phone: 1 message(s) held (1 not in channels.phone.allowedSenders).",
	);
	for (const told of ["reply draft", `${preempted.drafts[0]?.id}`, "expired", "no reply", "mallory", "hello"])
		expect(againSummary.toLowerCase(), "nothing told before is told twice, and no sender's text").not.toContain(told);
	expect(journal().awayHeld, "the new stranger is told").toBeUndefined();
	expect(notices(againManager, "channel-reply"), "the told draft is not announced again").toEqual([]);
	expect(
		journal().drafts.map((draft) => [draft.state, draft.told]),
		"the draft still waits, told",
	).toEqual([["pending", true]]);
	const daemonReturnsAgain = daemonPhone.nextStart();
	expect(await world.disposeSessionInBody(again.session), "the second session closes").toBeUndefined();
	await withDeadline(trace, "the daemon takes the channel back again", daemonReturnsAgain);
	trace.mark("root", "away-channels.told-once");

	// Stopping the daemon gives the channel up.
	expect(await withDeadline(trace, "the daemon stops", daemon.stop()), "the daemon exits cleanly").toBe(0);
	expect(journal().holder, "a stopped daemon serves nothing").toBeUndefined();
	expect(
		[daemonPhone.starts, daemonPhone.stops, sessionPhone.stops, againPhone.stops],
		"every start is stopped",
	).toEqual([3, 3, 1, 1]);
	expect(world.provider.requests.length - requestsBefore, "telling the owner starts no turn").toBe(3);
	trace.mark("root", "away-channels.closed");
}
