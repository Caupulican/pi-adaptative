import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, ProviderResponseTicket, Usage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionOptions } from "../src/core/agent-session-contracts.ts";
import { sessionSemanticUsageOf } from "../src/core/cost/semantic-usage-delivery.ts";
import { readSummarySpendReceipt } from "../src/core/cost/semantic-usage-journal.ts";
import { ContinuousChatCompactionAdapter } from "../src/core/memory/continuous-chat-compaction-adapter.ts";
import {
	ContinuousChatSpendMeter,
	type ContinuousChatSpendOwnerPort,
} from "../src/core/memory/continuous-chat-spend.ts";
import type { TimerPort } from "../src/core/util/timer-port.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { type FaultableFs, nodeFs } from "../src/kernel/storage/faultable-fs.ts";

const journalFault = vi.hoisted(() => ({ refuseRetention: false }));
vi.mock("../src/kernel/storage/atomic-file.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/kernel/storage/atomic-file.ts")>();
	return {
		...original,
		writeFileAtomicSync: (...args: Parameters<typeof original.writeFileAtomicSync>) => {
			if (journalFault.refuseRetention && String(args[0]).includes(".usage-pending."))
				throw new Error("injected sidecar retention failure");
			return original.writeFileAtomicSync(...args);
		},
	};
});

const model = {
	provider: "anthropic",
	id: "restart-witness",
	api: "anthropic-messages",
	baseUrl: "https://unused.invalid",
} as Model<Api>;
const prefix = {
	systemPrompt: "",
	tools: [],
	view: "<chat>\n</chat>",
	viewCache: { authority: "test", stablePrefixLineCount: 0, lines: [] },
};
const paid: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

describe("summary accounting crash between durable receipt and shared settlement", () => {
	it("recovers a canonical-only old-session charge before another session's cap decision", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-canonical-only-restart-"));
		try {
			const agentDir = join(directory, "agent"),
				sessionDir = join(directory, "sessions"),
				spendFile = join(directory, "spend.json");
			const manager = SessionManager.create(directory, agentDir, sessionDir);
			manager.appendMessage({ role: "user", content: "Run the old task.", timestamp: 1 });
			manager.flushBufferedEntries();
			const now = Date.UTC(2026, 0, 1, 12);
			const timers: TimerPort = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
			const usageOwner = sessionSemanticUsageOf(manager, timers);
			const identity = usageOwner.summarySpendIdentity();
			const oldOwners: ContinuousChatSpendOwnerPort = {
				own: () => ({ pid: 101, hostname: "test" }),
				judge: () => "alive",
			};
			const newOwners: ContinuousChatSpendOwnerPort = {
				own: () => ({ pid: 202, hostname: "test" }),
				judge: (owner) => (owner.pid === 101 ? "dead" : "alive"),
			};
			const oldMeter = new ContinuousChatSpendMeter(spendFile, () => 10, timers, oldOwners);
			const token = oldMeter.claim("a".repeat(64), identity);
			const origin = { sessionId: identity.sessionId, operationId: token };
			const lease = usageOwner.beginMaintenance("history_summary", 1, origin);
			lease.beginRequest({
				requestId: token,
				provider: model.provider,
				model: model.id,
				route: "history_summary",
				origin,
				startedAt: new Date(now).toISOString(),
				summarySpendPending: true,
			});
			oldMeter.attempt("a".repeat(64), token);
			const receipt = {
				receiptId: token,
				provider: model.provider,
				model: model.id,
				attempt: 1,
				route: "history_summary" as const,
				origin,
				usage: paid,
				costStatus: "catalog_priced" as const,
				priceKnown: true as const,
				summaryAccounting: { observedAtMs: now },
			};
			journalFault.refuseRetention = true;
			try {
				lease.record(receipt);
			} finally {
				journalFault.refuseRetention = false;
			}
			manager.flushBufferedEntries();
			expect(
				manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "semantic_usage"),
			).toBe(true);
			expect(readSummarySpendReceipt(identity, token).kind).toBe("unresolved");
			const otherSession = SessionManager.create(directory, agentDir, sessionDir);
			otherSession.appendMessage({ role: "user", content: "Run another task.", timestamp: 2 });
			otherSession.flushBufferedEntries();
			expect(otherSession.getSessionId()).not.toBe(identity.sessionId);
			const newMeter = new ContinuousChatSpendMeter(spendFile, () => 0.2, timers, newOwners);
			expect(() => newMeter.hold()).toThrow();
			await vi.waitFor(() => expect(readSummarySpendReceipt(identity, token).kind).toBe("known"));
			expect(newMeter.hold()).toContain("daily limit");
			expect(JSON.parse(readFileSync(spendFile, "utf8")).usd).toBe(0.25);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retires the durable journal reservation after a pre-dispatch owner dies", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-reserved-restart-"));
		try {
			const agentDir = join(directory, "agent"),
				sessionDir = join(directory, "sessions"),
				spendFile = join(directory, "spend.json");
			const manager = SessionManager.create(directory, agentDir, sessionDir);
			manager.appendMessage({ role: "user", content: "Run the task.", timestamp: 1 });
			manager.flushBufferedEntries();
			const timers: TimerPort = { now: () => 1000, setTimeout: () => 1, clearTimeout: () => {} };
			const usage = sessionSemanticUsageOf(manager, timers);
			const identity = usage.summarySpendIdentity();
			const oldOwners: ContinuousChatSpendOwnerPort = {
				own: () => ({ pid: 101, hostname: "test" }),
				judge: () => "alive",
			};
			const deadOwners: ContinuousChatSpendOwnerPort = {
				own: () => ({ pid: 202, hostname: "test" }),
				judge: () => "dead",
			};
			const key = "a".repeat(64);
			const token = new ContinuousChatSpendMeter(spendFile, () => 10, timers, oldOwners).claim(key, identity);
			const lease = usage.beginMaintenance("history_summary", 1, {
				sessionId: identity.sessionId,
				operationId: token,
			});
			lease.beginRequest({
				requestId: token,
				provider: model.provider,
				model: model.id,
				route: "history_summary",
				origin: { sessionId: identity.sessionId, operationId: token },
				startedAt: new Date().toISOString(),
				summarySpendPending: true,
			});
			expect(readSummarySpendReceipt(identity, token).kind).toBe("unresolved");
			const recovered = new ContinuousChatSpendMeter(spendFile, () => 10, timers, deadOwners);
			expect(recovered.accountingWait(key)).toBe(120_000);
			expect(readSummarySpendReceipt(identity, token).kind).toBe("missing");
			expect(JSON.parse(readFileSync(spendFile, "utf8")).usd).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("recovers known durable usage into the daily cap when every owner is reopened", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-restart-cost-"));
		try {
			const agentDir = join(directory, "agent"),
				sessionDir = join(directory, "sessions"),
				spendFile = join(directory, "spend.json");
			let now = Date.UTC(2026, 0, 1, 12),
				oldDead = false,
				failSettlement = false;
			const timers: TimerPort = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
			const oldOwners: ContinuousChatSpendOwnerPort = {
				own: () => ({ pid: 101, hostname: "test" }),
				judge: () => "alive",
			};
			const newOwners: ContinuousChatSpendOwnerPort = {
				own: () => ({ pid: 202, hostname: "test" }),
				judge: (owner) => (owner.pid === 101 && oldDead ? "dead" : "alive"),
			};
			const fs: FaultableFs = {
				...nodeFs,
				renameSync: (from, to) => {
					if (failSettlement) throw new Error("spend replacement unavailable");
					nodeFs.renameSync(from, to);
				},
			};
			const manager = SessionManager.create(directory, agentDir, sessionDir);
			manager.appendMessage({ role: "user", content: "Run the task.", timestamp: 1 });
			manager.flushBufferedEntries();
			const sessionFile = manager.getSessionFile()!;
			const oldUsage = sessionSemanticUsageOf(manager, timers);
			const oldMeter = new ContinuousChatSpendMeter(spendFile, () => 10, timers, oldOwners, fs);
			let ticket: ProviderResponseTicket | undefined;
			let rejectCompletion: ((error: Error) => void) | undefined;
			const oldAdapter = new ContinuousChatCompactionAdapter({
				spend: oldMeter,
				usage: () => oldUsage,
				summary: () => ({ ok: true, model, reference: "fixture", thinkingLevel: "minimal" }),
				prefixHead: () => ({ systemPrompt: "", tools: [], model: undefined }),
				complete: (options: IsolatedCompletionOptions) => {
					ticket = options.providerResponseObserver!.begin(model, options.signal);
					return new Promise((_resolve, reject) => {
						rejectCompletion = reject;
					});
				},
			});
			const logical = oldAdapter.open(prefix, { level: 0, ordinal: 0 }).send({ task: "summarize" });
			rejectCompletion!(new Error("logical caller stopped"));
			await expect(logical).rejects.toThrow("logical caller stopped");
			failSettlement = true;
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "text", text: "summary" }],
				usage: paid,
				stopReason: "stop",
				timestamp: now,
			};
			ticket!.complete(message);
			const reopened = SessionManager.open(sessionFile, agentDir, sessionDir);
			const retained = reopened
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "semantic_usage");
			expect(retained).toHaveLength(1);
			expect(retained[0]).toMatchObject({ data: { route: "history_summary", usage: { cost: { total: 0.25 } } } });
			oldDead = true;
			const otherSession = SessionManager.create(directory, agentDir, sessionDir);
			otherSession.appendMessage({ role: "user", content: "A different session.", timestamp: 2 });
			otherSession.flushBufferedEntries();
			expect(otherSession.getSessionId()).not.toBe(reopened.getSessionId());
			const newUsage = sessionSemanticUsageOf(otherSession, timers);
			const newMeter = new ContinuousChatSpendMeter(spendFile, () => 0.2, timers, newOwners);
			const newAdapter = new ContinuousChatCompactionAdapter({
				spend: newMeter,
				usage: () => newUsage,
				summary: () => ({ ok: true, model, reference: "fixture", thinkingLevel: "minimal" }),
				prefixHead: () => ({ systemPrompt: "", tools: [], model: undefined }),
				complete: async () => {
					throw new Error("The witness must not dispatch a new provider request.");
				},
			});
			expect(newAdapter.dispatchHold()).toBeDefined();
			now += 120_000;
			expect(newAdapter.dispatchHold()).toBeDefined();
			expect(JSON.parse(readFileSync(spendFile, "utf8")).usd).toBe(0.25);
			const raisedLimit = new ContinuousChatSpendMeter(spendFile, () => 1, timers, newOwners);
			expect(raisedLimit.hold()).toBeUndefined();
			newUsage.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
