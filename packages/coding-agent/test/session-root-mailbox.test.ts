import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionRootMailboxFile } from "../src/core/agent-paths.ts";
import {
	SessionRootMailbox,
	sessionRootAddress,
	sessionRootReplyMessageId,
} from "../src/core/delegation/session-root-mailbox.ts";
import { loadedSuiteTimeout } from "./loaded-suite-timeout.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-session-root-mailbox-"));
	roots.push(value);
	return value;
}

function retainedReply(acceptance: ReturnType<SessionRootMailbox["enqueueReply"]>) {
	if (acceptance.status !== "retained") throw new Error("Expected a retained session-root reply.");
	return acceptance.reply;
}

afterEach(() => {
	vi.useRealTimers();
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("SessionRootMailbox", () => {
	it("derives one opaque stable address from the normalized foreground-session identity", () => {
		const address = sessionRootAddress("parent-1");
		const replyId = sessionRootReplyMessageId("parent-1", "worker-1", "request-1");

		expect(address).toMatch(/^session-root-[a-f0-9]{64}$/);
		expect(sessionRootAddress(" parent-1 ")).toBe(address);
		expect(sessionRootAddress("parent-2")).not.toBe(address);
		expect(sessionRootReplyMessageId(" parent-1 ", " worker-1 ", " request-1 ")).toBe(replyId);
		expect(() => sessionRootAddress("  ")).toThrow("parent session id is invalid");
	});

	it("persists one deterministic reply and replays the exact intent without rotating its acknowledgement token", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const first = mailbox.enqueueReply({
			sourceAgentId: "worker-1",
			requestMessageId: "request-1",
			threadId: "thread-1",
			content: "Exact evidence.",
		});
		const reopened = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const replay = reopened.enqueueReply({
			sourceAgentId: "worker-1",
			requestMessageId: "request-1",
			threadId: "thread-1",
			content: "Exact evidence.",
		});

		expect(first.created).toBe(true);
		expect(first.status).toBe("retained");
		if (first.status !== "retained") throw new Error("Expected the first reply to remain retained.");
		expect(first.reply.messageId).toMatch(/^session-root-reply-[a-f0-9]{64}$/);
		expect(replay).toEqual({
			status: "retained",
			messageId: first.reply.messageId,
			reply: first.reply,
			created: false,
		});
		expect(reopened.pendingReplies()).toEqual([first.reply]);
	});

	it("fails closed when one deterministic reply identity is reused with divergent content or thread", () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		mailbox.enqueueReply({
			sourceAgentId: "worker-1",
			requestMessageId: "request-1",
			threadId: "thread-1",
			content: "Exact evidence.",
		});

		expect(() =>
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-1",
				threadId: "thread-1",
				content: "Drifted evidence.",
			}),
		).toThrow("identity conflicts");
		expect(() =>
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-1",
				threadId: "thread-2",
				content: "Exact evidence.",
			}),
		).toThrow("identity conflicts");
		expect(mailbox.pendingReplies()).toHaveLength(1);
	});

	it("validates source, request, thread, and content before creating durable state", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const invalid = [
			{ sourceAgentId: "", requestMessageId: "request-1", content: "evidence" },
			{ sourceAgentId: "worker-1", requestMessageId: "", content: "evidence" },
			{ sourceAgentId: "worker-1", requestMessageId: "request-1", threadId: "", content: "evidence" },
			{ sourceAgentId: "worker-1", requestMessageId: "request-1", content: "" },
			{ sourceAgentId: "w".repeat(513), requestMessageId: "request-1", content: "evidence" },
			{ sourceAgentId: "worker-1", requestMessageId: "r".repeat(513), content: "evidence" },
			{ sourceAgentId: "worker-1", requestMessageId: "request-1", threadId: "t".repeat(513), content: "evidence" },
			{ sourceAgentId: "worker-1", requestMessageId: "request-1", content: "x".repeat(4_097) },
		];

		for (const input of invalid) expect(() => mailbox.enqueueReply(input)).toThrow();
		expect(mailbox.pendingReplies()).toEqual([]);
		expect(existsSync(sessionRootMailboxFile(agentDir, "parent-1"))).toBe(false);
	});

	it("rejects reply JSON that cannot fit one inbox result while retaining normal 4096-character Unicode", () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });

		expect(() =>
			mailbox.enqueueReply({
				sourceAgentId: "worker-pathological",
				requestMessageId: "request-pathological",
				content: `a${"\0".repeat(4_095)}`,
			}),
		).toThrow("encoded byte bound");

		const content = "界".repeat(4_096);
		const accepted = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-unicode",
				requestMessageId: "request-unicode",
				content,
			}),
		);
		expect(mailbox.pendingReplies()).toEqual([accepted]);
		expect(mailbox.pendingReplies()[0]?.content).toBe(content);
	});

	it("fails closed when durable state contains one reply above the encoded byte bound", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		mailbox.enqueueReply({
			sourceAgentId: "worker-1",
			requestMessageId: "request-1",
			content: "valid",
		});
		const file = sessionRootMailboxFile(agentDir, "parent-1");
		const state = JSON.parse(readFileSync(file, "utf-8")) as { replies: Array<{ content: string }> };
		state.replies[0]!.content = `a${"\0".repeat(4_095)}`;
		writeFileSync(file, `${JSON.stringify(state)}\n`);

		expect(() => new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" }).retainedReplies()).toThrow(
			"encoded byte bound",
		);
	});

	it("uses independent random tokens and requires the exact token for idempotent acknowledgement", () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const first = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-1",
				content: "first",
			}),
		);
		const second = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-2",
				content: "second",
			}),
		);

		expect(first.ackToken).not.toBe(second.ackToken);
		expect(() => mailbox.acknowledge(first.messageId, ` ${first.ackToken} `)).toThrow(
			"acknowledgement token is invalid",
		);
		expect(() => mailbox.acknowledge(first.messageId, "bounded-but-not-a-random-uuid")).toThrow(
			"acknowledgement token is invalid",
		);
		expect(() => mailbox.acknowledge(first.messageId, second.ackToken)).toThrow("token does not match");
		expect(mailbox.acknowledge(first.messageId, first.ackToken)).toBe(true);
		const acknowledgedAt = mailbox.getReply(first.messageId)?.acknowledgedAt;
		expect(acknowledgedAt).toEqual(expect.any(String));
		expect(mailbox.acknowledge(first.messageId, first.ackToken)).toBe(true);
		expect(mailbox.getReply(first.messageId)?.acknowledgedAt).toBe(acknowledgedAt);
		expect(mailbox.acknowledge("unknown-reply", first.ackToken)).toBe(false);
	});

	it("marks source reconciliation idempotently without acknowledging root consumption", () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const reply = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-1",
				content: "evidence",
			}),
		);

		expect(mailbox.markSourceReconciled(reply.messageId)).toBe(true);
		const reconciledAt = mailbox.getReply(reply.messageId)?.sourceReconciledAt;
		expect(reconciledAt).toEqual(expect.any(String));
		expect(mailbox.markSourceReconciled(reply.messageId)).toBe(true);
		expect(mailbox.getReply(reply.messageId)).toMatchObject({ sourceReconciledAt: reconciledAt });
		expect(mailbox.getReply(reply.messageId)).not.toHaveProperty("acknowledgedAt");
		expect(mailbox.markSourceReconciled("unknown-reply")).toBe(false);
	});

	it("keeps lifecycle timestamps valid when the wall clock moves backwards", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T03:00:00.000Z"));
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const reply = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-1",
				content: "evidence",
			}),
		);
		vi.setSystemTime(new Date("2026-08-07T02:00:00.000Z"));

		mailbox.markSourceReconciled(reply.messageId);
		mailbox.acknowledge(reply.messageId, reply.ackToken);

		expect(new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" }).getReply(reply.messageId)).toMatchObject(
			{
				createdAt: "2026-08-07T03:00:00.000Z",
				sourceReconciledAt: "2026-08-07T03:00:00.000Z",
				acknowledgedAt: "2026-08-07T03:00:00.000Z",
			},
		);
	});

	it("protects every reply missing either reconciliation or acknowledgement at the 64-entry mandatory bound", () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const replies = Array.from({ length: 64 }, (_, index) =>
			retainedReply(
				mailbox.enqueueReply({
					sourceAgentId: "worker-1",
					requestMessageId: `request-${index}`,
					content: "x",
				}),
			),
		);
		for (const reply of replies.slice(0, 32)) mailbox.acknowledge(reply.messageId, reply.ackToken);
		for (const reply of replies.slice(32)) mailbox.markSourceReconciled(reply.messageId);

		expect(() =>
			mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "overflow", content: "x" }),
		).toThrow("64 mandatory reply limit");
		expect(mailbox.pendingReplies({ maxMessages: 64 })).toHaveLength(32);

		mailbox.markSourceReconciled(replies[0]!.messageId);
		expect(
			mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "accepted", content: "x" }).created,
		).toBe(true);
	});

	it("retains at most 128 replies while preserving recent fully completed history", () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const messageIds: string[] = [];
		for (let index = 0; index < 160; index++) {
			const reply = retainedReply(
				mailbox.enqueueReply({
					sourceAgentId: "worker-1",
					requestMessageId: `request-${index}`,
					content: "x",
				}),
			);
			messageIds.push(reply.messageId);
			mailbox.markSourceReconciled(reply.messageId);
			mailbox.acknowledge(reply.messageId, reply.ackToken);
		}

		expect(mailbox.getReply(messageIds[0]!)).toBeUndefined();
		expect(mailbox.getReply(messageIds.at(-1)!)).toBeDefined();
		expect(mailbox.retainedReplies()).toHaveLength(128);
		expect(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-0",
				content: "x",
			}),
		).toEqual({ status: "completed_replay", messageId: messageIds[0], created: false });
		expect(() =>
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-0",
				content: "drifted",
			}),
		).toThrow("durable replay receipt");
	});

	it(
		"backpressures new replies before an accepted replay identity could expire",
		() => {
			const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
			const original = retainedReply(
				mailbox.enqueueReply({
					sourceAgentId: "worker-1",
					requestMessageId: "request-original",
					content: "original evidence",
				}),
			);
			mailbox.markSourceReconciled(original.messageId);
			mailbox.acknowledge(original.messageId, original.ackToken);

			let rejected = false;
			for (let index = 0; index < 600; index++) {
				try {
					const reply = retainedReply(
						mailbox.enqueueReply({
							sourceAgentId: "worker-1",
							requestMessageId: `request-${index}`,
							content: "later evidence",
						}),
					);
					mailbox.markSourceReconciled(reply.messageId);
					mailbox.acknowledge(reply.messageId, reply.ackToken);
				} catch (error) {
					expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("replay receipt") }));
					rejected = true;
					break;
				}
			}

			expect(rejected).toBe(true);
			expect(
				mailbox.enqueueReply({
					sourceAgentId: "worker-1",
					requestMessageId: "request-original",
					content: "original evidence",
				}),
			).toEqual({ status: "completed_replay", messageId: original.messageId, created: false });
			expect(mailbox.pendingReplies({ maxMessages: 64 })).toEqual([]);
		},
		loadedSuiteTimeout(15_000),
	);

	it("always sees another writer's transaction, before and after its own", () => {
		// Each instance keeps the last file text it parsed or wrote and skips the parse when the file
		// still matches. The one thing that must never happen is an instance answering from that memory
		// after a foreign writer -- a worker in another process -- has changed the file underneath it.
		const agentDir = root();
		const first = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const second = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const own = retainedReply(
			first.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-own", content: "own evidence" }),
		);
		expect(first.pendingReplies().map((reply) => reply.messageId)).toEqual([own.messageId]);

		const foreign = retainedReply(
			second.enqueueReply({
				sourceAgentId: "worker-2",
				requestMessageId: "request-foreign",
				content: "foreign evidence",
			}),
		);
		expect(first.pendingReplies().map((reply) => reply.messageId)).toEqual([own.messageId, foreign.messageId]);

		expect(second.markSourceReconciled(own.messageId)).toBe(true);
		expect(second.acknowledge(own.messageId, own.ackToken)).toBe(true);
		expect(first.pendingReplies().map((reply) => reply.messageId)).toEqual([foreign.messageId]);
		expect(first.getReply(own.messageId)?.acknowledgedAt).toBeDefined();

		// A hand-written file is a foreign write too.
		const file = sessionRootMailboxFile(agentDir, "parent-1");
		const state = JSON.parse(readFileSync(file, "utf-8")) as { replies: Array<{ messageId: string }> };
		state.replies = state.replies.filter((reply) => reply.messageId !== foreign.messageId);
		writeFileSync(file, `${JSON.stringify(state)}\n`);
		expect(first.pendingReplies()).toEqual([]);
		expect(second.getReply(foreign.messageId)).toBeUndefined();
	});

	it("reserves a source-owned reply across projected default lifecycle growth", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const replies = Array.from({ length: 64 }, (_, index) =>
			retainedReply(
				mailbox.enqueueReply({
					sourceAgentId: `default-source-${index}`,
					requestMessageId: `default-request-${index}`,
					content: "x".repeat(1_280),
				}),
			),
		);
		for (const reply of replies) expect(mailbox.markSourceReconciled(reply.messageId)).toBe(true);
		expect(mailbox.acknowledge(replies[0]!.messageId, replies[0]!.ackToken)).toBe(true);
		const maximumIdentity = `i${"\0".repeat(511)}`;
		const maximumEncodedContent = `c${"\0".repeat(968)}xx`;

		const accepted = retainedReply(
			mailbox.enqueueSourceOwnedReply({
				sourceAgentId: maximumIdentity,
				requestMessageId: maximumIdentity,
				threadId: maximumIdentity,
				content: maximumEncodedContent,
			}),
		);

		expect(accepted).toEqual(
			expect.objectContaining({
				sourceAgentId: maximumIdentity,
				requestMessageId: maximumIdentity,
				threadId: maximumIdentity,
				content: maximumEncodedContent,
			}),
		);
		expect(() => mailbox.markSourceReconciled(accepted.messageId)).not.toThrow();
		expect(new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" }).getReply(accepted.messageId)).toEqual(
			expect.objectContaining({ sourceReconciledAt: expect.any(String) }),
		);
	});

	it("evicts oldest completed history under byte pressure before admitting a fresh reply", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		for (let index = 0; index < 10; index++) {
			const reply = retainedReply(
				mailbox.enqueueSourceOwnedReply({
					sourceAgentId: "worker-1",
					requestMessageId: `large-request-${index}`,
					content: "界".repeat(4_096),
				}),
			);
			mailbox.markSourceReconciled(reply.messageId);
			mailbox.acknowledge(reply.messageId, reply.ackToken);
			mailbox.releaseSourceReplayReceipt(reply.messageId);
		}
		for (let index = 0; index < 13; index++) {
			const reply = retainedReply(
				mailbox.enqueueSourceOwnedReply({
					sourceAgentId: "worker-1",
					requestMessageId: `small-request-${index}`,
					content: "ok",
				}),
			);
			mailbox.markSourceReconciled(reply.messageId);
			mailbox.acknowledge(reply.messageId, reply.ackToken);
			mailbox.releaseSourceReplayReceipt(reply.messageId);
		}

		expect(mailbox.pendingReplies({ maxMessages: 64 })).toEqual([]);
		const fresh = retainedReply(
			mailbox.enqueueSourceOwnedReply({
				sourceAgentId: "worker-1",
				requestMessageId: "fresh-request",
				content: "ok",
			}),
		);
		expect(mailbox.pendingReplies()).toEqual([fresh]);
		expect(statSync(sessionRootMailboxFile(agentDir, "parent-1")).size).toBeLessThanOrEqual(154 * 1024);
	});

	it("rejects an enqueue that would exceed the durable byte bound without a partial reply", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		let accepted = 0;
		for (; accepted < 64; accepted++) {
			try {
				mailbox.enqueueSourceOwnedReply({
					sourceAgentId: "worker-1",
					requestMessageId: `request-${accepted}`,
					content: "x".repeat(4_096),
				});
			} catch (error) {
				expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("durable size bound") }));
				break;
			}
		}
		expect(accepted).toBeGreaterThan(0);
		expect(accepted).toBeLessThan(64);
		expect(new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" }).retainedReplies()).toHaveLength(
			accepted,
		);
		expect(statSync(sessionRootMailboxFile(agentDir, "parent-1")).size).toBeLessThanOrEqual(154 * 1024);
	});

	it("rejects malformed and oversized persisted state before exposing any reply", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-1", content: "bounded" });
		const file = sessionRootMailboxFile(agentDir, "parent-1");
		const valid = JSON.parse(readFileSync(file, "utf-8")) as {
			version: number;
			replies: Array<{ ackToken: string }>;
		};
		valid.replies[0]!.ackToken = "";
		writeFileSync(file, JSON.stringify(valid));
		expect(() => mailbox.pendingReplies()).toThrow("invalid reply");

		writeFileSync(file, "x".repeat(154 * 1024 + 1));
		expect(() => mailbox.pendingReplies()).toThrow("durable size bound");
	});

	it("rejects persisted tokens that are not unique random UUIDs", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-1", content: "first" });
		mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-2", content: "second" });
		const file = sessionRootMailboxFile(agentDir, "parent-1");
		const state = JSON.parse(readFileSync(file, "utf-8")) as {
			replies: Array<{ ackToken: string }>;
		};
		state.replies[1]!.ackToken = state.replies[0]!.ackToken;
		writeFileSync(file, JSON.stringify(state));

		expect(() => mailbox.pendingReplies()).toThrow("duplicate acknowledgement tokens");

		state.replies[1]!.ackToken = "bounded-but-not-a-random-uuid";
		writeFileSync(file, JSON.stringify(state));
		expect(() => mailbox.pendingReplies()).toThrow("invalid reply acknowledgement token");
	});

	it("rejects persisted lifecycle timestamps that predate reply creation", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-1", content: "evidence" });
		const file = sessionRootMailboxFile(agentDir, "parent-1");
		const state = JSON.parse(readFileSync(file, "utf-8")) as {
			replies: Array<{ createdAt: string; sourceReconciledAt?: string; acknowledgedAt?: string }>;
		};
		state.replies[0]!.createdAt = "2026-08-07T03:00:00.000Z";
		state.replies[0]!.sourceReconciledAt = "2026-08-07T02:59:59.999Z";
		writeFileSync(file, JSON.stringify(state));
		expect(() => mailbox.pendingReplies()).toThrow("source reconciliation timestamp predates creation");

		delete state.replies[0]!.sourceReconciledAt;
		state.replies[0]!.acknowledgedAt = "2026-08-07T02:59:59.999Z";
		writeFileSync(file, JSON.stringify(state));
		expect(() => mailbox.pendingReplies()).toThrow("acknowledgement timestamp predates creation");
	});

	it("rejects state copied across foreground-session boundaries", () => {
		const agentDir = root();
		const source = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		source.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-1", content: "evidence" });
		const copiedState = readFileSync(sessionRootMailboxFile(agentDir, "parent-1"), "utf-8");
		const targetFile = sessionRootMailboxFile(agentDir, "parent-2");
		mkdirSync(dirname(targetFile), { recursive: true });
		writeFileSync(targetFile, copiedState);

		const target = new SessionRootMailbox({ agentDir, parentSessionId: "parent-2" });
		expect(() => target.pendingReplies()).toThrow("identity conflicts");
	});

	it("keeps durable mutations authoritative when one listener throws", () => {
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const observed = vi.fn();
		const unsubscribeThrowing = mailbox.subscribe(() => {
			throw new Error("simulated listener failure");
		});
		const unsubscribeObserved = mailbox.subscribe(observed);

		const reply = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-1",
				content: "durable",
			}),
		);
		mailbox.markSourceReconciled(reply.messageId);
		mailbox.acknowledge(reply.messageId, reply.ackToken);

		expect(new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" }).getReply(reply.messageId)).toMatchObject(
			{
				sourceReconciledAt: expect.any(String),
				acknowledgedAt: expect.any(String),
			},
		);
		expect(observed).toHaveBeenCalledTimes(3);
		unsubscribeThrowing();
		unsubscribeObserved();
	});

	it("waits on the durable predicate and ignores unrelated replies", async () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const waiting = mailbox.waitForReplies({ requestMessageId: "request-target", timeoutMs: 5_000 });
		mailbox.enqueueReply({ sourceAgentId: "worker-1", requestMessageId: "request-other", content: "other" });
		const target = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-2",
				requestMessageId: "request-target",
				content: "target",
			}),
		);

		await expect(waiting).resolves.toEqual({ replies: [target], timedOut: false });
	});

	it("closes the check-subscribe race with a predicate recheck", async () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const subscribe = mailbox.subscribe.bind(mailbox);
		let racedReply: ReturnType<typeof retainedReply> | undefined;
		vi.spyOn(mailbox, "subscribe").mockImplementation((listener) => {
			racedReply = retainedReply(
				mailbox.enqueueReply({
					sourceAgentId: "worker-1",
					requestMessageId: "request-race",
					content: "raced",
				}),
			);
			return subscribe(listener);
		});

		await expect(mailbox.waitForReplies({ requestMessageId: "request-race", timeoutMs: 5_000 })).resolves.toEqual({
			replies: [racedReply],
			timedOut: false,
		});
	});

	it("notifies a waiter through another in-process owner of the same durable mailbox", async () => {
		vi.useFakeTimers();
		const agentDir = root();
		const waitingOwner = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const writingOwner = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const waiting = waitingOwner.waitForReplies({ requestMessageId: "request-shared", timeoutMs: 25 });
		const reply = retainedReply(
			writingOwner.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-shared",
				content: "shared notification",
			}),
		);

		await vi.advanceTimersByTimeAsync(25);
		await expect(waiting).resolves.toEqual({ replies: [reply], timedOut: false });
	});

	it("rejects and cleans up a subscribed wait when its durable predicate read fails", async () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const unrelated = vi.fn(() => {
			throw new Error("unrelated observer failure");
		});
		const unsubscribeUnrelated = mailbox.subscribe(unrelated);
		const waiting = mailbox.waitForReplies({ requestMessageId: "request-failure", timeoutMs: 5_000 });
		vi.spyOn(mailbox, "pendingReplies").mockImplementation(() => {
			throw new Error("durable mailbox read failed");
		});

		mailbox.enqueueReply({
			sourceAgentId: "worker-1",
			requestMessageId: "request-failure",
			content: "trigger notification",
		});

		await expect(waiting).rejects.toThrow("durable mailbox read failed");
		expect(unrelated).toHaveBeenCalledOnce();
		unsubscribeUnrelated();
	});

	it("times out event-driven waits without consuming a later reply", async () => {
		vi.useFakeTimers();
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const waiting = mailbox.waitForReplies({ requestMessageId: "request-late", timeoutMs: 25 });
		await vi.advanceTimersByTimeAsync(25);

		await expect(waiting).resolves.toEqual({ replies: [], timedOut: true });
		const late = retainedReply(
			mailbox.enqueueReply({
				sourceAgentId: "worker-1",
				requestMessageId: "request-late",
				content: "late",
			}),
		);
		expect(mailbox.pendingReplies({ requestMessageId: "request-late" })).toEqual([late]);
	});

	it("rejects an aborted wait and releases its subscription", async () => {
		const mailbox = new SessionRootMailbox({ agentDir: root(), parentSessionId: "parent-1" });
		const unsubscribe = vi.fn();
		vi.spyOn(mailbox, "subscribe").mockReturnValue(unsubscribe);
		const controller = new AbortController();
		const waiting = mailbox.waitForReplies({ timeoutMs: 5_000, signal: controller.signal });
		controller.abort(new Error("owner cancelled wait"));

		await expect(waiting).rejects.toThrow("owner cancelled wait");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("returns timedOut: false when trailing out-of-process replies are captured on timeout", async () => {
		vi.useFakeTimers();
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const mailboxPath = sessionRootMailboxFile(agentDir, "parent-1");

		const waiting = mailbox.waitForReplies({ requestMessageId: "req-trail", timeoutMs: 50 });

		// Direct disk write without in-memory notification
		mkdirSync(dirname(mailboxPath), { recursive: true });
		writeFileSync(
			mailboxPath,
			JSON.stringify({
				version: 1,
				parentSessionId: "parent-1",
				replies: [
					{
						messageId: sessionRootReplyMessageId("parent-1", "worker-ext", "req-trail"),
						sourceAgentId: "worker-ext",
						requestMessageId: "req-trail",
						content: "out of process evidence",
						createdAt: "2026-08-17T00:00:00.000Z",
						ackToken: "11111111-2222-4333-8444-555555555555",
					},
				],
				replayReceipts: [],
			}),
			"utf-8",
		);

		await vi.advanceTimersByTimeAsync(50);
		const result = await waiting;
		expect(result.timedOut).toBe(false);
		expect(result.replies).toHaveLength(1);
		expect(result.replies[0]?.content).toBe("out of process evidence");
	});

	it("propagates an out-of-process durable read failure from the timeout boundary", async () => {
		vi.useFakeTimers();
		const agentDir = root();
		const mailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-1" });
		const mailboxPath = sessionRootMailboxFile(agentDir, "parent-1");
		const waiting = mailbox.waitForReplies({ requestMessageId: "req-corrupt", timeoutMs: 50 });
		const rejected = expect(waiting).rejects.toThrow();

		mkdirSync(dirname(mailboxPath), { recursive: true });
		writeFileSync(mailboxPath, "{not valid json", "utf-8");
		await vi.advanceTimersByTimeAsync(50);
		await rejected;
	});
});
