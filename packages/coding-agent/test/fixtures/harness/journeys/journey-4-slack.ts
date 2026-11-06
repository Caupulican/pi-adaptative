import { join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { digest } from "../../../../src/core/channels/channel-journal.ts";
import { type Barrier, calls, createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { noticeSaved, notices } from "./journey-4-channels.ts";
import { icmLatestResult } from "./shared.ts";

const API_ORIGIN = "https://slack.com";
/**
 * Token-shaped sentinels: each must reach its own request's Authorization header and nothing else. They are joined from
 * parts so the source holds no literal a secret scanner would take for a real Slack token.
 */
const APP_TOKEN = ["xapp", "1", "A0JOURNEY", "1700000000", "SentinelAppTokenForTheJourney"].join("-");
const BOT_TOKEN = ["xoxb", "1700000000", "SentinelBotTokenForTheJourney"].join("-");
/** The connection ticket the socket URL carries: it must reach the socket's constructor and nothing else. */
const TICKET = "SentinelTicketForTheJourney";
const SOCKET_URL = `wss://wss-primary.slack.com/link/?ticket=${TICKET}&app_id=A0JOURNEY`;
const OWNER_ID = "U0OWNER01";
const OWNER_DM = "D0OWNERDM";
const STRANGER_ID = "U0STRANGER";
const STRANGER_DM = "D0STRANGER";
const THREAD = "1700000000.000100";

/** An `events_api` envelope carrying one direct message event. */
function directMessage(
	envelopeId: string,
	eventId: string,
	event: { readonly user: string; readonly channel: string; readonly text: string } & Record<string, unknown>,
): Record<string, unknown> {
	return {
		envelope_id: envelopeId,
		type: "events_api",
		accepts_response_payload: false,
		retry_attempt: 0,
		payload: {
			type: "event_callback",
			event_id: eventId,
			event: { type: "message", channel_type: "im", ts: "1700000000.000200", ...event },
		},
	};
}

/** A Socket Mode connection as the shipped transport opens it through the world's WebSocket port. */
class ScriptedSlackSocket extends EventTarget {
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = 1;
	private readonly slack: FakeSlack;

	constructor(slack: FakeSlack) {
		super();
		this.slack = slack;
	}

	send(data: unknown): void {
		if (this.readyState !== this.OPEN) throw new Error("The scripted Slack socket is not open.");
		this.slack.received(data);
	}

	close(): void {
		if (this.readyState === this.CLOSED) return;
		this.readyState = this.CLOSED;
		queueMicrotask(() => this.dispatchEvent(new Event("close")));
	}

	/** One frame from Slack. */
	deliver(frame: Record<string, unknown>): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}
}

/**
 * Slack's Web API (through the world's fetch port) and its Socket Mode server (through the world's WebSocket port).
 * Each acknowledgement is checked against the channel journal at that moment: an envelope that carried a message may be
 * acknowledged only once the journal holds the message's event.
 */
class FakeSlack {
	readonly sockets: ScriptedSlackSocket[] = [];
	readonly posts: Record<string, unknown>[] = [];
	readonly acks: string[] = [];
	readonly violations: string[] = [];
	connectionOpens = 0;
	/** The event id each envelope handed over carries, by envelope id. */
	private readonly envelopes = new Map<string, string>();
	private socketWaiter: Barrier | undefined;
	private postWaiter: Barrier | undefined;
	private readonly ackWaiters = new Map<string, Barrier>();
	private readonly journalSeen: () => readonly string[];

	constructor(journalSeen: () => readonly string[]) {
		this.journalSeen = journalSeen;
	}

	respond(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> | undefined {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.origin !== API_ORIGIN || !url.pathname.startsWith("/api/")) return undefined;
		const authorization = new Headers(init?.headers).get("authorization");
		const method = url.pathname.slice("/api/".length);
		if (init?.method !== "POST") return Promise.resolve(Response.json({ ok: false, error: "method_not_supported" }));
		if (method === "apps.connections.open") {
			if (authorization !== `Bearer ${APP_TOKEN}`)
				return Promise.resolve(Response.json({ ok: false, error: "invalid_auth" }));
			this.connectionOpens++;
			return Promise.resolve(Response.json({ ok: true, url: SOCKET_URL }));
		}
		if (method === "chat.postMessage") {
			if (authorization !== `Bearer ${BOT_TOKEN}`)
				return Promise.resolve(Response.json({ ok: false, error: "invalid_auth" }));
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			this.posts.push(body);
			this.postWaiter?.release();
			return Promise.resolve(Response.json({ ok: true, channel: body.channel, ts: "1700000100.000300" }));
		}
		return Promise.resolve(Response.json({ ok: false, error: "unknown_method" }));
	}

	/** The socket for one `new WebSocket(url)`; any other URL is refused by the world's port. */
	connect(url: string): ScriptedSlackSocket | undefined {
		if (url !== SOCKET_URL) return undefined;
		const socket = new ScriptedSlackSocket(this);
		this.sockets.push(socket);
		this.socketWaiter?.release();
		return socket;
	}

	get openSockets(): number {
		return this.sockets.filter((socket) => socket.readyState !== socket.CLOSED).length;
	}

	/**
	 * Hand a frame to the newest socket. The event id of an envelope the journal must hold (`journaled`) is remembered for
	 * the acknowledgement check; an envelope the transport ignores is acknowledged without it.
	 */
	deliver(frame: Record<string, unknown>, journaled = true): void {
		const payload = frame.payload as { readonly event_id?: string } | undefined;
		if (journaled && typeof frame.envelope_id === "string" && payload?.event_id)
			this.envelopes.set(frame.envelope_id, payload.event_id);
		this.sockets.at(-1)?.deliver(frame);
	}

	received(data: unknown): void {
		const frame = JSON.parse(String(data)) as { readonly envelope_id?: unknown };
		if (typeof frame.envelope_id !== "string") {
			this.violations.push(`the transport sent a frame that is not an acknowledgement: ${String(data)}`);
			return;
		}
		const envelopeId = frame.envelope_id;
		this.acks.push(envelopeId);
		const eventId = this.envelopes.get(envelopeId);
		if (eventId !== undefined && !this.journalSeen().includes(digest(eventId)))
			this.violations.push(`envelope ${envelopeId} was acknowledged before the journal held ${eventId}`);
		this.ackWaiters.get(envelopeId)?.release();
	}

	nextSocket(): Promise<void> {
		this.socketWaiter = createBarrier();
		return this.socketWaiter.promise;
	}

	nextPost(): Promise<void> {
		this.postWaiter = createBarrier();
		return this.postWaiter.promise;
	}

	/** Resolves when the transport acknowledged `envelopeId`. */
	acked(envelopeId: string): Promise<void> {
		const barrier = createBarrier();
		if (this.acks.includes(envelopeId)) barrier.release();
		else this.ackWaiters.set(envelopeId, barrier);
		return barrier.promise;
	}
}

interface SlackJournal {
	readonly holder?: unknown;
	readonly pending: readonly unknown[];
	readonly seen: readonly { readonly d: string }[];
	readonly held: readonly { readonly reason: string }[];
	readonly drafts: readonly { readonly id: string; readonly state: string; readonly address: string }[];
}

/**
 * The shipped Slack transport starts by itself under an owner-written `channels.slack` policy, with its two tokens in
 * `<agentDir>/channels/slack.app-token` and `slack.bot-token` (mode 600) and nothing registered by a wrapper. It opens a
 * Socket Mode connection (`apps.connections.open` with the app-level token, then the socket). A bot's message and an
 * edit are acknowledged without reaching the journal. An allowlisted person's threaded direct message whose journal
 * write fails is not acknowledged; Slack's redelivery is acknowledged only once the journal holds it and becomes one
 * third-party turn whose answer waits as a draft. A message from a user the policy does not list is held, starts no
 * turn, and one notice tells the owner that user's id and the key to add it to. Slack's `disconnect` (refresh) closes
 * the socket and a new one opens at once. The owner's `channel_reply send` posts exactly the drafted text with the bot
 * token into the thread it came from, as plain text. Closing the session leaves no socket open and gives up the
 * journal, and neither token nor the connection ticket appears in any file, warning, entry, notice or draft.
 */
export async function runJourney4SlackPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-slack`;
	const channelsDir = join(agentDir, "channels");
	const appTokenPath = join(channelsDir, "slack.app-token");
	const botTokenPath = join(channelsDir, "slack.bot-token");
	const journalPath = join(channelsDir, "slack.json");
	world.io.mkdirSync(channelsDir, { recursive: true });
	world.io.writeFileSync(appTokenPath, `${APP_TOKEN}\n`, { mode: 0o600 });
	world.io.writeFileSync(botTokenPath, `${BOT_TOKEN}\n`, { mode: 0o600 });
	const journal = (): SlackJournal =>
		world.io.existsSync(journalPath)
			? (JSON.parse(String(world.io.readFileSync(journalPath))) as SlackJournal)
			: { pending: [], seen: [], held: [], drafts: [] };
	const slack = new FakeSlack(() => journal().seen.map((entry) => entry.d));
	world.fetchResponder = (input, init) => slack.respond(input, init);
	world.webSocketResponder = (url) => slack.connect(url);
	const warningsBefore = world.warnings.length;
	try {
		const firstSocket = slack.nextSocket();
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
				channels: { slack: { mode: "explicit", allowedSenders: [OWNER_ID] } },
			},
		});
		const session: AgentSession = created.session;
		await withDeadline(trace, "the Slack transport's first socket", firstSocket);
		slack.deliver({ type: "hello", num_connections: 1, debug_info: { approximate_connection_time: 18060 } });
		trace.mark("root", "slack.connected");

		// A bot's post and an edit are acknowledged at once and never reach the journal.
		slack.deliver(
			directMessage("env-bot", "EvBOT01", {
				user: OWNER_ID,
				channel: OWNER_DM,
				text: "a bot post",
				bot_id: "B0BOT",
			}),
			false,
		);
		slack.deliver(
			directMessage("env-edit", "EvEDIT01", {
				user: OWNER_ID,
				channel: OWNER_DM,
				text: "an edit",
				subtype: "message_changed",
			}),
			false,
		);
		await withDeadline(trace, "the ignored envelopes' acknowledgements", slack.acked("env-edit"));
		expect(slack.acks, "both ignored envelopes are acknowledged in order").toEqual(["env-bot", "env-edit"]);
		expect(journal().seen, "an ignored envelope never reaches the journal").toEqual([]);
		trace.mark("root", "slack.ignored");

		// The owner's threaded message: its first journal write fails, so it is not acknowledged; the redelivery is.
		const question = "is the staging deploy live";
		const answer = "The staging deploy is live.";
		const ownerTurn = createBarrier();
		world.provider.enqueue("root", {
			name: "slack-third-party-answer",
			check: (request) => {
				const delivered = JSON.stringify(request.context.messages);
				expect(delivered.split('source=\\"channel:slack\\"').length - 1, "the message arrives fenced").toBe(1);
				expect(delivered).toContain(question);
				ownerTurn.release();
			},
			reply: { content: [{ type: "text", text: answer }] },
		});
		const ownerEvent = "EvOWNER01";
		const journalWriteFault = "slack-journal-write-fails";
		world.io.failNext({
			name: journalWriteFault,
			kind: "write",
			matches: (operation, data) =>
				operation.path.startsWith(`${journalPath}.`) && data?.includes(digest(ownerEvent)) === true,
			code: "EIO",
		});
		const ownerMessage = { user: OWNER_ID, channel: OWNER_DM, text: question, thread_ts: THREAD };
		slack.deliver(directMessage("env-owner", ownerEvent, ownerMessage));
		slack.deliver({ ...directMessage("env-owner-retry", ownerEvent, ownerMessage), retry_attempt: 1 });
		await withDeadline(trace, "the redelivery's acknowledgement", slack.acked("env-owner-retry"));
		expect(world.io.consumedFaults, "the first journal write failed").toContain(journalWriteFault);
		expect(slack.acks, "the envelope the core rejected is not acknowledged").not.toContain("env-owner");
		await withDeadline(trace, "the Slack message's turn", ownerTurn.promise);
		await session.agent.waitForIdle();
		await withDeadline(trace, "the Slack draft notice", noticeSaved(manager, "channel-reply", "draft:slack:"));
		expect(slack.posts, "draft mode sends nothing on its own").toEqual([]);
		expect(
			session.channels.getStates().find((state) => state.name === "slack")?.state,
			"the shipped transport runs under the owner's policy with no wrapper",
		).toBe("armed");
		trace.mark("root", "slack.drafted");

		// A user the policy does not list: held, no turn, and the owner learns the id and the key to add it to.
		const strangerWords = "hello, who reads this app";
		slack.deliver(
			directMessage("env-stranger", "EvSTRANGER01", {
				user: STRANGER_ID,
				channel: STRANGER_DM,
				text: strangerWords,
			}),
		);
		await withDeadline(trace, "the stranger's acknowledgement", slack.acked("env-stranger"));
		await withDeadline(trace, "the sender notice", noticeSaved(manager, "channel-sender", "sender:slack:"));
		const senderNotices = notices(manager, "channel-sender").filter((notice) =>
			notice.reason.startsWith("sender:slack:"),
		);
		expect(senderNotices.length, "the stranger is told once").toBe(1);
		expect(senderNotices[0]?.text).toContain(
			`Channel slack held a message from sender ${STRANGER_ID}, who is not in channels.slack.allowedSenders. To let them start turns, add \\"${STRANGER_ID}\\" to that list.`,
		);
		expect(senderNotices[0]?.text, "nor their words").not.toContain(strangerWords);
		const afterStranger = journal();
		expect(afterStranger.held.map((entry) => entry.reason)).toEqual(["not_allowed"]);
		expect(afterStranger.pending, "a held message waits for no turn").toEqual([]);
		expect(JSON.stringify(afterStranger), "a held message's words are not kept").not.toContain(strangerWords);
		trace.mark("root", "slack.stranger-held");

		// Slack announces a refresh: the transport closes that socket and opens the next one at once.
		const secondSocket = slack.nextSocket();
		slack.deliver({ type: "disconnect", reason: "refresh_requested" });
		await withDeadline(trace, "the reconnect after the refresh", secondSocket);
		slack.deliver({ type: "hello", num_connections: 1 });
		expect(slack.connectionOpens, "a new connection is opened with the app-level token").toBe(2);
		expect(slack.sockets[0]?.readyState, "the refreshed socket is closed").toBe(3);
		expect(slack.openSockets, "one socket is open").toBe(1);
		trace.mark("root", "slack.reconnected");

		// The owner's own turn releases the draft: the exact text goes into the thread it came from, as plain text.
		const draft = journal().drafts[0];
		const draftId = draft?.id ?? "";
		expect(draft?.address, "the draft answers the thread the message came from").toBe(`${OWNER_DM}/${THREAD}`);
		const released = slack.nextPost();
		const releaseTurn = createBarrier();
		world.provider.enqueue(
			"root",
			calls("slack-owner-release", [
				{ id: "slack-owner-send", name: "channel_reply", arguments: { action: "send", draft: draftId } },
			]),
			{
				name: "slack-owner-answer",
				check: (request) => {
					expect(icmLatestResult(request, "channel_reply").text, "the owner's run releases the draft").toBe(
						`Sent draft ${draftId} to its conversation on slack.`,
					);
					releaseTurn.release();
				},
				reply: { content: [{ type: "text", text: "Sent the Slack reply." }] },
			},
		);
		await withDeadline(trace, "the owner's release turn", session.prompt("Send the waiting Slack reply."));
		await withDeadline(trace, "the owner's release answer", releaseTurn.promise);
		await withDeadline(trace, "the reply reaches the Web API", released);
		await session.agent.waitForIdle();
		expect(slack.posts, "one plain-text message into the right thread").toEqual([
			{
				channel: OWNER_DM,
				text: answer,
				mrkdwn: false,
				unfurl_links: false,
				unfurl_media: false,
				thread_ts: THREAD,
			},
		]);
		expect(journal().drafts.map((entry) => entry.state)).toEqual(["sent"]);
		trace.mark("root", "slack.released");

		expect(await world.disposeSessionInBody(session), "the Slack session closes").toBeUndefined();
		expect(slack.openSockets, "closing leaves no socket open").toBe(0);
		expect(journal().holder, "the closed session no longer serves slack").toBeUndefined();
		expect(slack.violations, "every acknowledgement followed the journal").toEqual([]);

		const secrets = [APP_TOKEN, BOT_TOKEN, TICKET];
		for (const [path, text] of world.io.fileEntries())
			for (const secret of secrets)
				if (path !== appTokenPath && path !== botTokenPath)
					expect(text, `${path} never holds a Slack secret`).not.toContain(secret);
		for (const secret of secrets) {
			expect(world.warnings.join("\n"), "no warning carries a Slack secret").not.toContain(secret);
			expect(JSON.stringify(manager.getEntries()), "no entry, notice or draft carries a Slack secret").not.toContain(
				secret,
			);
		}
		expect(
			world.warnings.slice(warningsBefore).filter((warning) => /slack/i.test(warning)),
			"the transport ran without a warning",
		).toEqual([]);
		trace.mark("root", "slack.closed");
	} finally {
		world.fetchResponder = undefined;
		world.webSocketResponder = undefined;
	}
}
