import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, ProviderResponseTicket, Usage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import type { SessionSemanticUsageDelivery } from "../src/core/cost/semantic-usage-delivery.ts";
import { ContinuousChatAccountingHold } from "../src/core/memory/continuous-chat-compaction.ts";
import { ContinuousChatCompactionAdapter } from "../src/core/memory/continuous-chat-compaction-adapter.ts";
import { validateContinuousChatSummaryModel } from "../src/core/memory/continuous-chat-settings.ts";
import { ContinuousChatSpendMeter } from "../src/core/memory/continuous-chat-spend.ts";
import type { TimerPort } from "../src/core/util/timer-port.ts";
import { type FaultableFs, nodeFs } from "../src/kernel/storage/faultable-fs.ts";

const model = {
	provider: "anthropic",
	id: "test-model",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
} as Model<Api>;
const measured: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const missing: Usage = { ...measured, input: 0, output: 0, totalTokens: 0 };
const prefix = {
	systemPrompt: "",
	tools: [],
	view: "<chat>\n</chat>",
	viewCache: { authority: "test", stablePrefixLineCount: 0, lines: [] },
};
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(fs?: FaultableFs) {
	let now = 0;
	let timerId = 0;
	const scheduled = new Map<number, () => void>();
	let current = model;
	let session = "session-a";
	let refuseLease = false;
	let refuseIdentity = false;
	let refuseRequest = false;
	let returnAdmissionError = false;
	let returnBeforeBegin = false;
	let onRecord: (() => void) | undefined;
	let pauseNext = false;
	let refuseAck = false;
	let releasePaused: (() => void) | undefined;
	const cancelled: string[] = [];
	const tickets: ProviderResponseTicket[] = [];
	const finish: Array<(result: IsolatedCompletionResult) => void> = [];
	const reject: Array<(error: Error) => void> = [];
	const unresolved: string[] = [];
	const retained: unknown[] = [];
	const receipts = new Map<string, { costUsd: number; observedAtMs: number; pending: boolean }>();
	const identity = () => ({
		sessionId: session,
		sessionFile: join("/tmp", `${session}.jsonl`),
		headerTimestamp: "1970-01-01T00:00:00.000Z",
		persisted: true as const,
	});
	const journal = {
		requestRecovery: () => {},
		cancelUndispatched: (_identity: unknown, token: string) => {
			if (receipts.has(token)) throw new Error("known receipt cannot be cancelled");
		},
		read: (_identity: unknown, token: string) => {
			const receipt = receipts.get(token);
			return receipt
				? {
						kind: "known" as const,
						costUsd: receipt.costUsd,
						observedAtMs: receipt.observedAtMs,
						summarySpendPending: receipt.pending,
					}
				: { kind: "missing" as const };
		},
		acknowledge: (_identity: unknown, token: string) => {
			if (refuseAck) throw new Error("acknowledgement unavailable");
			const receipt = receipts.get(token);
			if (receipt) receipt.pending = false;
		},
	};
	const owner = {
		captureOrigin: () => ({ sessionId: session }),
		summarySpendIdentity: () => {
			if (refuseIdentity) throw new Error("identity unavailable");
			return identity();
		},
		reportUnresolvedRequest: (id: string) => {
			unresolved.push(id);
		},
		beginMaintenance: () => {
			if (refuseLease) throw new Error("journal unavailable");
			return {
				beginRequest: () => {
					if (refuseRequest) throw new Error("request journal unavailable");
				},
				assertCurrent: () => {},
				cancelUndispatchedRequest: (id: string) => {
					cancelled.push(id);
				},
				record: (receipt: unknown) => {
					retained.push(receipt);
					const record = receipt as {
						receiptId: string;
						usage: { cost: { total: number } };
						summaryAccounting: { observedAtMs: number };
					};
					receipts.set(record.receiptId, {
						costUsd: record.usage.cost.total,
						observedAtMs: record.summaryAccounting.observedAtMs,
						pending: true,
					});
					onRecord?.();
					return { kind: "physically_recorded" };
				},
				release: () => {},
			};
		},
	} as unknown as SessionSemanticUsageDelivery;
	const timers: TimerPort = {
		now: () => now,
		setTimeout: (callback) => {
			const id = ++timerId;
			scheduled.set(id, callback);
			return id;
		},
		clearTimeout: (id) => {
			scheduled.delete(id as number);
		},
	};
	const directory = mkdtempSync(join(tmpdir(), "pi-summary-circuit-"));
	directories.push(directory);
	const spend = new ContinuousChatSpendMeter(join(directory, "spend.json"), () => 10, timers, undefined, fs, journal);
	const adapter = new ContinuousChatCompactionAdapter({
		spend,
		usage: () => owner,
		summary: () => ({ ok: true, model: current, reference: "test", thinkingLevel: "minimal" }),
		prefixHead: () => ({ systemPrompt: "", tools: [], model: undefined }),
		complete: (options: IsolatedCompletionOptions) => {
			const invoke = (): Promise<IsolatedCompletionResult> => {
				if (returnBeforeBegin) return Promise.resolve({ text: "", usage: missing, stopReason: "error" });
				let ticket: ProviderResponseTicket;
				try {
					options.requestGuard?.(options.model!, options.signal);
					ticket = options.providerResponseObserver!.begin(options.model!, options.signal);
				} catch (error) {
					if (!returnAdmissionError) throw error;
					return Promise.resolve({ text: "", usage: missing, stopReason: "error" });
				}
				tickets.push(ticket);
				return new Promise<IsolatedCompletionResult>((resolve, fail) => {
					finish.push(resolve);
					reject.push(fail);
				});
			};
			if (!pauseNext) return invoke();
			pauseNext = false;
			return new Promise<void>((resolve) => {
				releasePaused = resolve;
			}).then(invoke);
		},
	});
	const start = () => adapter.open(prefix, { level: 0, ordinal: 0 }).send({ task: "summarize" });
	const settlePhysical = (index: number, usage: Usage, responseModel = model.id) => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "summary" }],
			api: model.api,
			provider: model.provider,
			model: responseModel,
			usage,
			stopReason: "stop",
			timestamp: 1,
		};
		tickets[index]!.complete(message);
		return message;
	};
	const settle = (index: number, usage: Usage, responseModel = model.id) => {
		const message = settlePhysical(index, usage, responseModel);
		finish[index]!({ text: "summary", usage, stopReason: "stop", messages: [message] });
	};
	return {
		adapter,
		journal,
		refuseIdentity: (value: boolean) => {
			refuseIdentity = value;
		},
		identity,
		receipts,
		start,
		settle,
		settlePhysical,
		abandon: (index: number) => reject[index]!(new Error("logical caller stopped")),
		failPhysical: (index: number) => tickets[index]!.failed(new Error("transport failed")),
		unresolved,
		retained,
		cancelled,
		ticketCount: () => tickets.length,
		pauseNext: () => {
			pauseNext = true;
		},
		refuseAck: () => {
			refuseAck = true;
		},
		releasePaused: () => {
			if (!releasePaused) throw new Error("No paused request");
			releasePaused();
		},
		timers,
		spendFile: join(directory, "spend.json"),
		runNextTimer: () => {
			const next = scheduled.entries().next().value;
			if (!next) throw new Error("No accounting retry was scheduled.");
			scheduled.delete(next[0]);
			next[1]();
		},
		pendingTimers: () => scheduled.size,
		refuseLease: (value: boolean) => {
			refuseLease = value;
		},
		refuseRequest: (value: boolean) => {
			refuseRequest = value;
		},
		returnAdmissionError: (value: boolean) => {
			returnAdmissionError = value;
		},
		returnBeforeBegin: (value: boolean) => {
			returnBeforeBegin = value;
		},
		onRecord: (callback: () => void) => {
			onRecord = callback;
		},
		advance: (ms: number) => {
			now += ms;
		},
		switchModel: (next: Model<Api>) => {
			current = next;
		},
		switchSession: (next: string) => {
			session = next;
		},
	};
}

describe("continuous chat response accounting circuit", () => {
	it.each(["cap", "unknown", "pending acknowledgement", "healthy"] as const)(
		"rechecks %s accounting after a reserved request waits",
		async (outcome) => {
			const h = setup();
			h.pauseNext();
			const first = h.start();
			const reserved = Object.values(JSON.parse(readFileSync(h.spendFile, "utf8")).circuits) as Array<{
				status: string;
				token: string;
			}>;
			expect(reserved).toHaveLength(1);
			expect(reserved[0]!.status).toBe("reserved");
			h.switchSession("session-b");
			const second = h.start();
			if (outcome === "pending acknowledgement") h.refuseAck();
			if (outcome === "unknown") {
				h.settle(0, missing);
				await expect(second).rejects.toThrow("without reporting measured usage");
			} else {
				h.settle(0, { ...measured, cost: { ...measured.cost, total: outcome === "cap" ? 10 : 0.25 } });
				await expect(second).resolves.toBe("summary");
			}
			h.releasePaused();
			if (outcome === "healthy") {
				await vi.waitFor(() => expect(h.ticketCount()).toBe(2));
				h.settle(1, measured);
				await expect(first).resolves.toBe("summary");
			} else {
				await expect(first).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
				expect(h.ticketCount()).toBe(1);
				expect(h.cancelled).toContain(reserved[0]!.token);
				const state = JSON.parse(readFileSync(h.spendFile, "utf8"));
				expect(Object.values(state.circuits)).toContainEqual(
					expect.objectContaining({ token: reserved[0]!.token, status: "held" }),
				);
			}
		},
	);
	it("refuses missing model prices and accepts explicit zero prices", () => {
		const settings = {
			summaryModel: "anthropic/test-model",
			thinkingLevel: "minimal" as const,
			allowExternalSummaryEgress: true,
		};
		const zeroPrice = { ...model, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		const unpriced = validateContinuousChatSummaryModel(settings, {
			resolveModel: () => ({ ...zeroPrice, costDefaulted: true }),
		});
		expect(unpriced.ok).toBe(false);
		if (!unpriced.ok) expect(unpriced.reason).toContain("no declared price");
		expect(validateContinuousChatSummaryModel(settings, { resolveModel: () => zeroPrice }).ok).toBe(true);
		const local = { ...zeroPrice, baseUrl: "http://127.0.0.1:1234", costDefaulted: true };
		expect(
			validateContinuousChatSummaryModel(
				{ ...settings, allowExternalSummaryEgress: false },
				{ resolveModel: () => local },
			).ok,
		).toBe(false);
	});

	it("settles explicitly declared zero pricing with positive measured tokens", async () => {
		const h = setup();
		h.switchModel({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const run = h.start();
		h.settle(0, measured);
		await expect(run).resolves.toBe("summary");
		expect(h.retained[0]).toMatchObject({ priceKnown: true, usage: { totalTokens: 2, cost: { total: 0 } } });
		expect(h.adapter.dispatchHold()).toBeUndefined();
	});

	it("refuses a default-priced model at physical admission even when configuration validation is bypassed", async () => {
		const h = setup();
		h.switchModel({ ...model, costDefaulted: true });
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		expect(h.retained).toHaveLength(0);
		expect(h.unresolved).toHaveLength(0);
	});

	it("holds a backlog, admits one half-open request, and only releases it after measured retention", async () => {
		const h = setup();
		const first = h.start();
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		h.settle(0, missing);
		await expect(first).rejects.toThrow("without reporting measured usage");
		expect(h.unresolved).toHaveLength(1);
		expect(h.adapter.dispatchHold()).toBeDefined();
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		h.advance(120_000);
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		h.receipts.set(h.unresolved[0]!, { costUsd: 0.25, observedAtMs: h.timers.now(), pending: true });
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.advance(120_000);
		const recovery = h.start();
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		h.settle(1, measured);
		await expect(recovery).resolves.toBe("summary");
		expect(h.adapter.dispatchHold()).toBeUndefined();
	});

	it("keeps the failed identity held across model and session switches", async () => {
		const h = setup();
		const first = h.start();
		h.settle(0, missing);
		await expect(first).rejects.toThrow();
		h.switchModel({ ...model, id: "other-model" });
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.switchModel(model);
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.switchSession("session-b");
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.switchSession("session-a");
		expect(h.adapter.dispatchHold()).toBeDefined();
	});

	it("reopens after a failed recovery and observes physical failure after logical completion", async () => {
		const h = setup();
		const first = h.start();
		h.abandon(0);
		await expect(first).rejects.toThrow("logical caller stopped");
		h.failPhysical(0);
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.advance(120_000);
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		expect(h.adapter.dispatchHold()).toBeDefined();
	});

	it("retains measured cost before holding a mismatched or tokenless response", async () => {
		const h = setup();
		const mismatch = h.start();
		h.settle(0, measured, "different-model");
		await expect(mismatch).rejects.toThrow("does not match");
		expect(h.retained).toHaveLength(1);
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.advance(120_000);
		const tokenless = h.start();
		h.settle(1, { ...missing, cost: { ...missing.cost, total: 0.1 } });
		await expect(tokenless).rejects.toThrow("without reporting measured usage");
		expect(h.retained).toHaveLength(2);
		expect(h.adapter.dispatchHold()).toBeDefined();
		expect(JSON.parse(readFileSync(h.spendFile, "utf8")).usd).toBe(0.1);
	});

	it("classifies unavailable accounting identity as a controlled hold before dispatch", () => {
		const h = setup();
		h.refuseIdentity(true);
		expect(() => h.adapter.open(prefix, { level: 0, ordinal: 0 })).toThrow(ContinuousChatAccountingHold);
	});

	it("holds on custody refusal before dispatch and reparks a refused half-open admission", async () => {
		const h = setup();
		h.refuseLease(true);
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		expect(h.adapter.dispatchHold()).toBeDefined();
		h.refuseLease(false);
		h.advance(120_000);
		h.refuseRequest(true);
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		expect(h.adapter.dispatchHold()).toBeDefined();
		await expect(h.start()).rejects.toBeInstanceOf(ContinuousChatAccountingHold);
		h.refuseRequest(false);
		h.advance(120_000);
		const recovery = h.start();
		h.settle(0, measured);
		await expect(recovery).resolves.toBe("summary");
		expect(h.adapter.dispatchHold()).toBeUndefined();
	});

	it("preserves the custody failure when the transport returns an error result", async () => {
		const h = setup();
		h.refuseRequest(true);
		h.returnAdmissionError(true);
		const error = await h.start().catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ContinuousChatAccountingHold);
		expect((error as Error).cause).toBeInstanceOf(Error);
		expect(((error as Error).cause as Error).cause).toMatchObject({ message: "request journal unavailable" });
		expect(h.adapter.dispatchHold()).toBeDefined();
	});

	it("does not clear a recovery hold when no physical request was dispatched", async () => {
		const h = setup();
		const first = h.start();
		h.settle(0, missing);
		await expect(first).rejects.toThrow();
		h.advance(120_000);
		h.returnBeforeBegin(true);
		await expect(h.start()).rejects.toThrow();
		expect(h.adapter.dispatchHold()).toBeDefined();
	});

	it("retries a late physical settlement after the logical caller has retired", async () => {
		let refuseReplacement = false;
		const fs: FaultableFs = {
			...nodeFs,
			renameSync: (from, to) => {
				if (refuseReplacement) throw new Error("temporary accounting write failure");
				nodeFs.renameSync(from, to);
			},
		};
		const h = setup(fs);
		const first = h.start();
		h.abandon(0);
		await expect(first).rejects.toThrow("logical caller stopped");
		refuseReplacement = true;
		const paid = { ...measured, cost: { ...measured.cost, total: 0.25 } };
		h.settlePhysical(0, paid);
		expect(h.retained).toHaveLength(1);
		expect(h.pendingTimers()).toBe(1);
		const waiting = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(Object.values(waiting.circuits)).toEqual([expect.objectContaining({ status: "flight" })]);
		expect(waiting.usd).toBe(0);
		refuseReplacement = false;
		// No new dispatch or logical-session callback: the retained retry alarm alone settles the physical receipt.
		h.runNextTimer();
		const settled = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(Object.values(settled.circuits)).toEqual([expect.objectContaining({ status: "settled" })]);
		expect(settled.usd).toBe(0.25);
		expect(h.pendingTimers()).toBe(0);
		h.settlePhysical(0, paid);
		expect(JSON.parse(readFileSync(h.spendFile, "utf8")).usd).toBe(0.25);
	});

	it("settles a retired caller's late response without replacing a newer session's claim", async () => {
		const h = setup();
		const old = h.start();
		h.abandon(0);
		await expect(old).rejects.toThrow("logical caller stopped");
		h.switchSession("session-b");
		const current = h.start();
		const oldPaid = { ...measured, cost: { ...measured.cost, total: 0.1 } };
		h.settlePhysical(0, oldPaid);
		let state = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(Object.values(state.circuits)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "settled" }),
				expect.objectContaining({ status: "flight" }),
			]),
		);
		const currentPaid = { ...measured, cost: { ...measured.cost, total: 0.2 } };
		h.settle(1, currentPaid);
		await expect(current).resolves.toBe("summary");
		state = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(state.usd).toBeCloseTo(0.3);
		expect(Object.values(state.circuits)).toEqual([
			expect.objectContaining({ status: "settled" }),
			expect.objectContaining({ status: "settled" }),
		]);
	});

	it("keeps multiple pre-midnight observed costs out of a newer day's cap after failed writes", async () => {
		let refuseReplacement = false;
		const fs: FaultableFs = {
			...nodeFs,
			renameSync: (from, to) => {
				if (refuseReplacement) throw new Error("temporary accounting write failure");
				nodeFs.renameSync(from, to);
			},
		};
		const h = setup(fs);
		h.advance(86_399_000);
		const first = h.start();
		h.abandon(0);
		await expect(first).rejects.toThrow("logical caller stopped");
		h.switchSession("session-b");
		const second = h.start();
		h.abandon(1);
		await expect(second).rejects.toThrow("logical caller stopped");
		refuseReplacement = true;
		h.settlePhysical(0, { ...measured, cost: { ...measured.cost, total: 0.1 } });
		h.settlePhysical(1, { ...measured, cost: { ...measured.cost, total: 0.2 } });
		expect(h.pendingTimers()).toBe(1);
		h.advance(2_000);
		refuseReplacement = false;
		const other = new ContinuousChatSpendMeter(h.spendFile, () => 10, h.timers, undefined, undefined, h.journal);
		const newDayKey = "a".repeat(64);
		const newDayToken = other.claim(newDayKey, h.identity());
		other.attempt(newDayKey, newDayToken);
		h.receipts.set(newDayToken, { costUsd: 0.4, observedAtMs: h.timers.now(), pending: true });
		other.settle(newDayKey, newDayToken, true, 0.4, h.timers.now());
		h.runNextTimer();
		const state = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(state.day).toBe("1970-01-02");
		expect(state.usd).toBeCloseTo(0.4);
		expect(state.archivedMeasuredUsd).toBeCloseTo(0.3);
		expect(h.pendingTimers()).toBe(0);
		h.settlePhysical(0, { ...measured, cost: { ...measured.cost, total: 0.1 } });
		expect(JSON.parse(readFileSync(h.spendFile, "utf8")).archivedMeasuredUsd).toBeCloseTo(0.3);
	});

	it("freezes the observation day before synchronous usage-journal work crosses midnight", async () => {
		const h = setup();
		h.advance(86_399_000);
		const run = h.start();
		h.onRecord(() => h.advance(2_000));
		h.settle(0, { ...measured, cost: { ...measured.cost, total: 0.25 } });
		await expect(run).resolves.toBe("summary");
		const state = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(state.day).toBe("1970-01-02");
		expect(state.usd).toBe(0);
		expect(state.archivedMeasuredUsd).toBe(0.25);
	});

	it("does not duplicate an observed old-day cost when replacement committed before reporting an error", async () => {
		let failAfterRename = false;
		const fs: FaultableFs = {
			...nodeFs,
			renameSync: (from, to) => {
				nodeFs.renameSync(from, to);
				if (failAfterRename) {
					failAfterRename = false;
					throw new Error("ambiguous accounting replacement");
				}
			},
		};
		const h = setup(fs);
		h.advance(86_399_000);
		const old = h.start();
		h.abandon(0);
		await expect(old).rejects.toThrow("logical caller stopped");
		failAfterRename = true;
		h.settlePhysical(0, { ...measured, cost: { ...measured.cost, total: 0.1 } });
		expect(h.pendingTimers()).toBe(1);
		h.advance(2_000);
		const other = new ContinuousChatSpendMeter(h.spendFile, () => 10, h.timers, undefined, undefined, h.journal);
		const key = "a".repeat(64);
		const token = other.claim(key, h.identity());
		other.attempt(key, token);
		h.receipts.set(token, { costUsd: 0.4, observedAtMs: h.timers.now(), pending: true });
		other.settle(key, token, true, 0.4, h.timers.now());
		h.runNextTimer();
		const state = JSON.parse(readFileSync(h.spendFile, "utf8"));
		expect(state.usd).toBe(0.4);
		expect(state.archivedMeasuredUsd).toBe(0.1);
		expect(h.pendingTimers()).toBe(0);
	});
});
