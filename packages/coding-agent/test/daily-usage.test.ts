import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry, SessionEntry } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE } from "../src/core/agent-session.ts";
import {
	aggregateDailyUsageFromEntries,
	aggregateDailyUsageFromSessionFiles,
	aggregateDailyUsageFromSessionRoot,
	formatDailyUsageBreakdown,
} from "../src/core/cost/daily-usage.ts";
import { tempDir } from "./temp-dir.ts";

function usage(costTotal: number, estimate?: Usage["cost"]["estimate"]): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens: 18,
		cost: {
			input: costTotal / 2,
			output: costTotal / 2,
			cacheRead: 0,
			cacheWrite: 0,
			total: costTotal,
			...(estimate ? { estimate } : {}),
		},
	};
}

function assistant(
	id: string,
	timestamp: number,
	costTotal: number,
	estimate?: Usage["cost"]["estimate"],
): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: id }],
		api: "messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(costTotal, estimate),
		stopReason: "stop",
		timestamp,
	};
	return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function spawned(id: string, timestamp: number, costTotal: number, reportId = id): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		customType: SPAWNED_USAGE_CUSTOM_TYPE,
		data: { usage: usage(costTotal), reportId },
	};
}

describe("daily usage aggregation", () => {
	it.each(["own", "spawned", "semantic"] as const)(
		"retains the counted %s estimate through serialization",
		(source) => {
			const startMs = Date.parse("2026-06-28T00:00:00.000Z");
			const estimated: SessionEntry =
				source === "own"
					? assistant("estimated", startMs + 1_000, 0.4, "base-rates")
					: {
							type: "custom",
							id: "estimated",
							parentId: null,
							timestamp: new Date(startMs + 1_000).toISOString(),
							customType: source === "spawned" ? SPAWNED_USAGE_CUSTOM_TYPE : SEMANTIC_USAGE_CUSTOM_TYPE,
							data: { reportId: "estimated", usage: usage(0.4, "base-rates") },
						};
			const totals = aggregateDailyUsageFromEntries([estimated, assistant("exact", startMs + 2_000, 0.6)], {
				startMs,
				endMs: startMs + 86_400_000,
			});
			expect(totals.costEstimate).toBe("base-rates");
			expect(totals.totalCost).toBeCloseTo(1, 10);
			expect(JSON.parse(JSON.stringify(totals))).toMatchObject({ costEstimate: "base-rates", totalCost: 1 });
			expect(formatDailyUsageBreakdown(totals)).toContain("Today: ~$1.0000 (base-rate estimate)");
			const excluded = aggregateDailyUsageFromEntries([estimated, assistant("exact", startMs + 2_000, 0.6)], {
				startMs: startMs + 2_000,
				endMs: startMs + 86_400_000,
			});
			expect(excluded.costEstimate).toBeUndefined();
			expect(excluded.totalCost).toBeCloseTo(0.6, 10);
		},
	);

	it.each([SPAWNED_USAGE_CUSTOM_TYPE, SEMANTIC_USAGE_CUSTOM_TYPE])(
		"ignores estimate metadata on a deduplicated %s receipt",
		(customType) => {
			const startMs = Date.parse("2026-06-28T00:00:00.000Z");
			const entries: SessionEntry[] = [undefined, "base-rates" as const].map((estimate, index) => ({
				type: "custom",
				id: `duplicate-${index}`,
				parentId: null,
				timestamp: new Date(startMs + index).toISOString(),
				customType,
				data: { reportId: "same-report", usage: usage(0.4, estimate) },
			}));
			const totals = aggregateDailyUsageFromEntries(entries, { startMs, endMs: startMs + 86_400_000 });
			expect(totals.costEstimate).toBeUndefined();
			expect(totals.totalCost).toBeCloseTo(0.4, 10);
		},
	);

	it("retains a persisted earlier-session estimate beside an exact live session", () => {
		const root = tempDir("pi-daily-usage-estimate-");
		const dir = join(root, "project");
		mkdirSync(dir);
		const startMs = Date.parse("2026-06-28T00:00:00.000Z");
		const header: FileEntry = {
			type: "session",
			id: "previous",
			timestamp: new Date(startMs).toISOString(),
			cwd: dir,
		};
		writeFileSync(
			join(dir, "previous.jsonl"),
			[header, assistant("ultra", startMs + 1_000, 0.4, "base-rates")]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
		const liveFile = join(dir, "current.jsonl");
		writeFileSync(liveFile, "live-only entries\n");
		const live = { filePath: liveFile, entries: [assistant("current-exact", startMs + 2_000, 0.6)] };
		const window = { startMs, endMs: startMs + 86_400_000 };
		for (const totals of [
			aggregateDailyUsageFromSessionFiles(dir, window, live),
			aggregateDailyUsageFromSessionRoot(root, window, live),
		]) {
			expect(totals.costEstimate).toBe("base-rates");
			expect(totals.totalCost).toBeCloseTo(1, 10);
			expect(totals.sessions).toBe(2);
		}
	});

	it("sums assistant and spawned costs inside the requested local-day window", () => {
		const dayStart = Date.parse("2026-06-28T00:00:00.000Z");
		const dayEnd = Date.parse("2026-06-29T00:00:00.000Z");
		const total = aggregateDailyUsageFromEntries(
			[
				assistant("before", dayStart - 1, 9),
				assistant("own", dayStart + 1_000, 0.4),
				spawned("child", dayStart + 2_000, 0.6),
				assistant("after", dayEnd, 9),
			],
			{ startMs: dayStart, endMs: dayEnd },
		);

		expect(total.ownCost).toBeCloseTo(0.4, 10);
		expect(total.spawnedCost).toBeCloseTo(0.6, 10);
		expect(total.totalCost).toBeCloseTo(1.0, 10);
		expect(total.sessions).toBe(1);
		expect(total.reports).toBe(1);
	});

	it("deduplicates spawned usage reports across all scanned sessions", () => {
		const dayStart = Date.parse("2026-06-28T00:00:00.000Z");
		const dayEnd = Date.parse("2026-06-29T00:00:00.000Z");
		const total = aggregateDailyUsageFromEntries(
			[spawned("dup-a", dayStart + 1_000, 0.5, "dup"), spawned("dup-b", dayStart + 2_000, 0.5, "dup")],
			{ startMs: dayStart, endMs: dayEnd },
		);

		expect(total.totalCost).toBeCloseTo(0.5, 10);
		expect(total.reports).toBe(1);
	});

	it("loads and sums all session files in a directory for the active-day total", () => {
		const dir = tempDir("pi-daily-usage-");
		const dayStart = Date.parse("2026-06-28T00:00:00.000Z");
		const dayEnd = Date.parse("2026-06-29T00:00:00.000Z");
		const writeSession = (name: string, entries: FileEntry[]) => {
			writeFileSync(join(dir, `${name}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		};
		const header: FileEntry = {
			type: "session",
			id: "s1",
			timestamp: new Date(dayStart).toISOString(),
			cwd: dir,
		};

		writeSession("a", [header, assistant("a1", dayStart + 1_000, 0.25)]);
		writeSession("b", [{ ...header, id: "s2" }, assistant("b1", dayStart + 2_000, 0.75)]);

		const total = aggregateDailyUsageFromSessionFiles(dir, { startMs: dayStart, endMs: dayEnd });

		expect(total.totalCost).toBeCloseTo(1.0, 10);
		expect(total.sessions).toBe(2);
	});

	it("uses live entries for the active session instead of reparsing its growing JSONL", () => {
		const dir = tempDir("pi-daily-usage-live-");
		const filePath = join(dir, "active.jsonl");
		writeFileSync(filePath, "deliberately not parseable\n");
		const dayStart = Date.parse("2026-06-28T00:00:00.000Z");
		const dayEnd = Date.parse("2026-06-29T00:00:00.000Z");
		const total = aggregateDailyUsageFromSessionFiles(
			dir,
			{ startMs: dayStart, endMs: dayEnd },
			{ filePath, entries: [assistant("live", dayStart + 1_000, 0.75)] },
		);

		expect(total.totalCost).toBeCloseTo(0.75, 10);
		expect(total.sessions).toBe(1);
	});

	it("loads and sums session files across all project session directories", () => {
		const root = tempDir("pi-daily-usage-root-");
		const dirA = join(root, "project-a");
		const dirB = join(root, "project-b");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		const dayStart = Date.parse("2026-06-28T00:00:00.000Z");
		const dayEnd = Date.parse("2026-06-29T00:00:00.000Z");
		const writeSession = (dir: string, name: string, entries: FileEntry[]) => {
			writeFileSync(join(dir, `${name}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		};
		const header = (id: string): FileEntry => ({
			type: "session",
			id,
			timestamp: new Date(dayStart).toISOString(),
			cwd: root,
		});

		writeSession(dirA, "a", [header("s1"), assistant("a1", dayStart + 1_000, 0.25)]);
		writeSession(dirB, "b", [header("s2"), assistant("b1", dayStart + 2_000, 0.75)]);

		const total = aggregateDailyUsageFromSessionRoot(root, { startMs: dayStart, endMs: dayEnd });

		expect(total.totalCost).toBeCloseTo(1.0, 10);
		expect(total.sessions).toBe(2);
	});

	it("ignores non-directory entries under the session root", () => {
		const root = tempDir("pi-daily-usage-root-file-");
		writeFileSync(join(root, "stray.lock"), "not a directory");

		const total = aggregateDailyUsageFromSessionRoot(root, {
			startMs: Date.parse("2026-06-28T00:00:00.000Z"),
			endMs: Date.parse("2026-06-29T00:00:00.000Z"),
		});

		expect(total.totalCost).toBe(0);
	});

	it("skips stale session files without parsing them", () => {
		const dir = tempDir("pi-daily-usage-stale-");
		const file = join(dir, "stale.jsonl");
		writeFileSync(file, "not json\n");
		const stale = new Date("2026-06-27T00:00:00.000Z");
		utimesSync(file, stale, stale);

		const total = aggregateDailyUsageFromSessionFiles(dir, {
			startMs: Date.parse("2026-06-28T00:00:00.000Z"),
			endMs: Date.parse("2026-06-29T00:00:00.000Z"),
		});

		expect(total.totalCost).toBe(0);
	});

	it("formats a visible own/spawned/background daily cost breakdown", () => {
		const text = formatDailyUsageBreakdown({
			ownCost: 0.4,
			spawnedCost: 0.6,
			totalCost: 1.0,
			input: 10,
			output: 5,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 18,
			sessions: 3,
			reports: 2,
		});

		expect(text).toContain("Today: $1.0000");
		expect(text).toContain("Own/session messages: $0.4000");
		expect(text).toContain("Spawned/background reports: $0.6000");
		expect(text).toContain("Sessions scanned: 3");
		expect(text).toContain("Spawned/background report count: 2");
	});
});
