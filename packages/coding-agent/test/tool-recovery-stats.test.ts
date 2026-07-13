import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createToolArgumentValidationLogRecord,
	writeToolRecoveryLogRecord,
} from "../src/core/tool-recovery-log-records.ts";
import {
	consumeToolArgumentValidationRecord,
	createEmptyToolArgumentValidationStats,
	readPersistedToolRecoveryStats,
} from "../src/core/tool-recovery-stats.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function event(model: string = "model"): ToolArgumentValidationTelemetryEvent {
	return {
		outcome: "repaired",
		provider: "provider",
		model,
		tool: "edit",
		failureModes: ["jsonStringParse"],
		repairsApplied: ["jsonStringParse"],
		taught: "none",
		executionOutcome: "succeeded",
	};
}

describe("tool recovery cumulative stats", () => {
	it("preserves cumulative totals after detailed event records are removed", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tool-recovery-stats-"));
		tempDirs.push(dir);
		const eventLogPath = join(dir, "tool-recovery-events.jsonl");
		const failureCorpusPath = join(dir, "failure-corpus.jsonl");
		for (let sequence = 0; sequence < 3; sequence++) {
			const record = createToolArgumentValidationLogRecord({
				event: event(),
				recordId: `session-1:${sequence}`,
				sessionId: "session-1",
				ts: "2026-07-13T00:00:00Z",
			});
			writeToolRecoveryLogRecord({ eventLogPath, failureCorpusPath, record });
		}
		writeFileSync(eventLogPath, "", "utf-8");

		const persisted = readPersistedToolRecoveryStats(eventLogPath, "session-1");
		expect(persisted?.lastRecordSequence).toBe(2);
		expect(persisted?.stats.repaired).toBe(3);
		expect(persisted?.stats.repairsApplied.jsonStringParse).toBe(3);
	});

	it("bounds cumulative detail dimensions while preserving outcome totals", () => {
		const stats = createEmptyToolArgumentValidationStats();
		for (let index = 0; index < 1_100; index++) {
			consumeToolArgumentValidationRecord(
				stats,
				createToolArgumentValidationLogRecord({
					event: event(`model-${index}`),
					recordId: `session-1:${index}`,
					sessionId: "session-1",
					ts: "2026-07-13T00:00:00Z",
				}),
			);
		}

		expect(stats.repaired).toBe(1_100);
		expect(Object.keys(stats.teachEfficacy).length).toBeLessThanOrEqual(1_000);
		expect(stats.teachEfficacy.__other__?.repairedThenSucceeded).toBeGreaterThan(0);
	});
});
