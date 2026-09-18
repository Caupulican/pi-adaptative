import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../src/core/agent-session-contracts.ts";
import { SessionAnalytics } from "../src/core/session-analytics.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const directories: string[] = [];

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-parent-usage-receipt-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory, join(directory, "sessions"));
	const analyticsFor = (session: SessionManager) =>
		new SessionAnalytics({
			getState: () => ({ messages: [] }) as unknown as AgentState,
			getMessages: () => [],
			getModel: () => undefined,
			getSessionManager: () => session,
			getSettingsManager: () => SettingsManager.inMemory(),
			getToolDefinition: () => undefined,
			getToolRecoveryEventLogPath: () => join(directory, "recovery.jsonl"),
			getAgentDir: () => directory,
		});
	const usage = { ...createEmptyUsage(), input: 7, totalTokens: 7 };
	const options = { parentSessionId: manager.getSessionId(), reportId: "worker-receipt-1" };
	const flush = () =>
		manager.appendMessage({
			role: "assistant",
			content: [],
			api: "messages",
			provider: "anthropic",
			model: "usage-test",
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
	return { directory, manager, analyticsFor, analytics: analyticsFor(manager), usage, options, flush };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("parent usage receipt persistence", () => {
	it("keeps buffered reports pending, confirms the flushed receipt, and deduplicates after reopening", () => {
		const { directory, manager, analytics, analyticsFor, usage, options, flush } = setup();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("pending");
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("pending");
		expect(manager.getEntries()).toHaveLength(1);
		flush();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		const reopened = SessionManager.open(manager.getSessionFile()!, directory);
		expect(analyticsFor(reopened).deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		expect(reopened.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
		expect(analyticsFor(reopened).getCumulativeUsage().totalTokens).toBe(7);
	});

	it("does not acknowledge a changed charge or a truncated or mismatched persisted receipt", () => {
		const { manager, analytics, usage, options, flush } = setup();
		flush();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		expect(() => analytics.deliverSpawnedUsageReceipt({ ...usage, totalTokens: 8 }, options)).toThrow(/conflict/);
		const read = vi.spyOn(manager, "readEntryJsonPrefix");
		read.mockReturnValueOnce('{"type":"custom"');
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("pending");
		read.mockImplementationOnce((entryId) =>
			JSON.stringify({
				...manager.getEntry(entryId),
				data: { usage: { ...usage, totalTokens: 99 }, reportId: options.reportId },
			}),
		);
		expect(() => analytics.deliverSpawnedUsageReceipt(usage, options)).toThrow(/persisted.*conflict/);
		read.mockImplementationOnce(() => {
			throw new Error("read unavailable");
		});
		expect(() => analytics.deliverSpawnedUsageReceipt(usage, options)).toThrow("read unavailable");
		read.mockRestore();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		expect(analytics.getCumulativeUsage().totalTokens).toBe(7);
	});

	it("rejects a late receipt for a different parent before appending and retains caller-independent usage", () => {
		const { manager, analytics, usage, options } = setup();
		expect(analytics.deliverSpawnedUsageReceipt(usage, { ...options, parentSessionId: "another-parent" })).toBe(
			"foreign_session",
		);
		expect(manager.getEntries()).toHaveLength(0);
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("pending");
		usage.cost.total = 100;
		usage.totalTokens = 100;
		expect(analytics.getCumulativeUsage().totalTokens).toBe(7);
		expect(analytics.getCumulativeUsage().cost.total).toBe(0);
		manager.newSession();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("foreign_session");
		expect(manager.getEntries()).toHaveLength(0);
	});

	it("never acknowledges an append failure, an invalid identity, or an in-memory-only parent", () => {
		const { manager, analytics, analyticsFor, usage, options } = setup();
		vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("write unavailable");
		});
		expect(() => analytics.deliverSpawnedUsageReceipt(usage, options)).toThrow("write unavailable");
		expect(manager.getEntries()).toHaveLength(0);
		expect(() => analytics.deliverSpawnedUsageReceipt(usage, { ...options, reportId: "" })).toThrow(/identity/);
		expect(manager.getEntries()).toHaveLength(0);
		const memory = SessionManager.inMemory();
		expect(
			analyticsFor(memory).deliverSpawnedUsageReceipt(usage, { ...options, parentSessionId: memory.getSessionId() }),
		).toBe("pending");
		expect(
			memory
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("does not carry receipt identities into a replacement session with the same entry count", () => {
		const { manager, analytics, usage, options } = setup();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("pending");
		manager.newSession();
		manager.appendCustomEntry(SPAWNED_USAGE_CUSTOM_TYPE, { usage, reportId: "another-receipt" });
		const replacement = { ...options, parentSessionId: manager.getSessionId() };
		expect(analytics.deliverSpawnedUsageReceipt(usage, replacement)).toBe("pending");
		expect(analytics.getCumulativeUsage().totalTokens).toBe(14);
		expect(manager.getEntries()).toHaveLength(2);
		expect(analytics.deliverSpawnedUsageReceipt(usage, replacement)).toBe("pending");
		expect(manager.getEntries()).toHaveLength(2);
	});

	it("rebases receipt identities after reloading the same parent instead of trusting an equal count", () => {
		const { manager, analytics, usage, options, flush } = setup();
		flush();
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		const file = manager.getSessionFile()!;
		const entries = manager.getEntries();
		const receipt = entries.find((entry) => entry.type === "custom")!;
		const prior = manager.readEntryJsonPrefix(receipt.id, 64 * 1024)!;
		writeFileSync(
			file,
			readFileSync(file, "utf8").replace(prior, prior.replace(options.reportId, "replacement-receipt")),
		);
		manager.setSessionFile(file);
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		expect(manager.getEntries()).toHaveLength(entries.length + 1);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(14);
		expect(analytics.deliverSpawnedUsageReceipt(usage, options)).toBe("persisted");
		expect(manager.getEntries()).toHaveLength(entries.length + 1);
	});

	it("invalidates footer and daily accounting together with receipt deduplication when the parent changes", () => {
		const { manager, analytics, usage, options, flush } = setup();
		const first = { ...usage, cost: { ...usage.cost, input: 1, total: 1 } };
		const second = { ...usage, cost: { ...usage.cost, input: 3, total: 3 } };
		analytics.deliverSpawnedUsageReceipt(first, options);
		flush();
		const now = new Date();
		const original = analytics.getCostSummary(now);
		expect(original.currentCost).toBe(1);
		expect(original.todayCost).toBe(1);
		expect(analytics.getCostSummary(now)).toBe(original);
		manager.newSession();
		manager.appendCustomEntry(SPAWNED_USAGE_CUSTOM_TYPE, { usage: second, reportId: "next-parent" });
		flush();
		const changed = analytics.getCostSummary(now);
		expect(changed).not.toBe(original);
		expect(changed.currentCost).toBe(3);
		expect(changed.todayCost).toBe(4);
		expect(analytics.getCostSummary(now)).toBe(changed);
	});
});
