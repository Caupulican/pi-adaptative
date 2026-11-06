import { join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type {
	ChannelInboundHandler,
	ChannelMessage,
	ChannelProvider,
} from "../../../../src/core/gateways/channel-provider.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { entryTurnOrigin } from "../../../../src/core/turn-origin.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { type Barrier, calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { icmLatestResult } from "./shared.ts";

/**
 * A deployment's transport as the core sees it: it is started with the core's inbound handler, hands events over and
 * records what the core sends. `deliver` hands a burst over the way one transport poll does: every event before any of
 * them is answered.
 */
class ScriptedChannel implements ChannelProvider {
	readonly name: string;
	readonly sent: ChannelMessage[] = [];
	starts = 0;
	stops = 0;
	private inbound: ChannelInboundHandler | undefined;
	private sendWaiter: Barrier | undefined;

	constructor(name: string) {
		this.name = name;
	}

	start(onInbound: ChannelInboundHandler): void {
		this.starts++;
		this.inbound = onInbound;
	}

	send(message: ChannelMessage): void {
		this.sent.push(structuredClone(message));
		this.sendWaiter?.release();
	}

	stop(): void {
		this.stops++;
		this.inbound = undefined;
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
	readonly holder?: unknown;
	readonly pending: readonly { readonly eventDigest: string }[];
	readonly seen: readonly unknown[];
	readonly held: readonly { readonly reason: string }[];
	readonly heldTotal: number;
	readonly batches: readonly { readonly id: string; readonly state: string }[];
	readonly drafts: readonly { readonly id: string; readonly state: string; readonly address: string }[];
}

/** The harness notices of `kind` the session saved for its owner: one per delivery (reason and generation). */
function notices(manager: SessionManager, kind: string): { readonly reason: string; readonly text: string }[] {
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

function noticeSaved(manager: SessionManager, kind: string, reasonPrefix: string, count = 1): Promise<void> {
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
 * verified sender the policy does not list are journaled as held and wake nothing; three messages of the allowlisted
 * sender arriving together become one turn with their words inside one fence; in that turn a push the words ask for is
 * prepared, not run, and the owner's own tools (`channel_reply`, `memory`) are refused; the answer waits as a draft,
 * one notice tells the owner, and the owner's own turn sends it to the address the conversation came from and reads the
 * memory the channel's run was refused; a message that arrives during the owner's turn never joins it and opens its own
 * third-party turn after the owner's answer, whose reply is found by the batch id on that turn's origin; the same
 * event delivered again is not admitted twice. On `chat` (`replyMode: "auto"`, one turn a day): the answer goes back to
 * the same address without the owner, and later messages are held behind the bound with one notice. A registered
 * channel the owner wrote no policy for never starts, and its notice is saved once the session keeps entries. Closing
 * the session stops every channel and gives up the journal.
 */
export async function runJourney4ChannelsPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-channels`;
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
			check: () => {
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

	expect(await world.disposeSessionInBody(session), "the channels session closes").toBeUndefined();
	expect([mail.stops, chat.stops], "closing stops every started channel").toEqual([1, 1]);
	expect(feed.starts, "the unconfigured channel never started").toBe(0);
	expect(journal("mail").holder, "the closed session no longer serves mail").toBeUndefined();
	trace.mark("root", "channels.closed");
}
