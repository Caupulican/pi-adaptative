import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ActivityLaneItem } from "../src/modes/interactive/components/activity-lane.ts";
import {
	AgentsOverlay,
	buildAgentsPanelModel,
	formatElapsed,
} from "../src/modes/interactive/components/agents-overlay.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const NOW = Date.parse("2026-08-06T12:10:00Z");

const worker = (overrides: Partial<LaneRecord> & Pick<LaneRecord, "laneId" | "status">): LaneRecord => ({
	type: "worker",
	...overrides,
});

const tool = (id: string, label: string, tag?: string, waiting = false): ActivityLaneItem => ({
	id: `background-tool:${id}`,
	kind: "tool",
	label,
	status: waiting ? "waiting" : "active",
	...(tag === undefined ? {} : { tag }),
});

describe("agents overlay", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("formats elapsed durations across magnitudes", () => {
		expect(formatElapsed(42_000)).toBe("42s");
		expect(formatElapsed(7 * 60_000 + 12_000)).toBe("7m12s");
		expect(formatElapsed(63 * 60_000)).toBe("1h03m");
		expect(formatElapsed(-5)).toBe("");
	});

	it("names each worker with runtime, elapsed, and cost; tools keep their tags", () => {
		const model = buildAgentsPanelModel(
			{
				laneRecords: [
					worker({
						laneId: "lane-1",
						status: "running",
						label: "Verify reconcile flow",
						profileId: "fast-coder",
						startedAt: "2026-08-06T12:00:00Z",
						costUsd: 0.42,
					}),
					worker({ laneId: "lane-2", status: "queued", label: "Fix corner rendering", type: "tmux-worker" }),
				],
				items: [tool("5", "Scan Sales1.cpp charge paths", "python"), tool("7", "Locate sqlcmd", "bash", true)],
			},
			NOW,
		);

		expect(model.rows).toEqual([
			expect.objectContaining({
				status: "running",
				label: "Verify reconcile flow",
				section: "Workers",
				meta: ["agent", "fast-coder", "10m00s", "$0.42"],
			}),
			expect.objectContaining({ status: "queued", label: "Fix corner rendering", meta: ["tmux"] }),
			expect.objectContaining({ status: "running", label: "Scan Sales1.cpp charge paths", meta: ["python"] }),
			expect.objectContaining({ status: "queued", label: "Locate sqlcmd", meta: ["bash"] }),
		]);
		expect(model.summary).toEqual(["1 running", "1 queued", "2 background tools"]);
		expect(model.status).toBe("info");
	});

	it("caps rows, keeps newest finished workers, and flags failures in the badge", () => {
		const finished = Array.from({ length: 8 }, (_, index) =>
			worker({
				laneId: `done-${index}`,
				status: index === 0 ? "failed" : "succeeded",
				label: `Worker ${index}`,
				completedAt: `2026-08-06T11:0${index}:00Z`,
			}),
		);
		const active = Array.from({ length: 10 }, (_, index) =>
			worker({ laneId: `run-${index}`, status: "running", label: `Active ${index}` }),
		);
		const model = buildAgentsPanelModel({ laneRecords: [...finished, ...active], items: [] }, NOW);

		expect(model.rows).toHaveLength(12);
		expect(model.hiddenRowCount).toBe(2); // 10 active + 4 newest finished - 12 shown
		expect(model.status).toBe("error");
		// Newest finished (completedAt 11:07) survives the cut, oldest do not.
		const labels = model.rows?.map((row) => row.label) ?? [];
		expect(labels).toContain("Worker 7");
		expect(labels).not.toContain("Worker 1");
	});

	it("renders an empty state and stays within width", () => {
		const keybindings = KeybindingsManager.create(join(tmpdir(), "pi-agents-overlay-test-empty"));
		const overlay = new AgentsOverlay({
			keybindings,
			snapshot: () => ({ laneRecords: [], items: [] }),
			onClose: vi.fn(),
			now: () => NOW,
		});
		for (const width of [40, 80, 120]) {
			const lines = overlay.render(width);
			expect(stripAnsi(lines.join("\n"))).toContain("No agents or background work");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("closes on the close key and on the toggle key, not on other input", () => {
		const keybindings = KeybindingsManager.create(join(tmpdir(), "pi-agents-overlay-test-empty"));
		const onClose = vi.fn();
		const overlay = new AgentsOverlay({
			keybindings,
			snapshot: () => ({ laneRecords: [], items: [] }),
			onClose,
			now: () => NOW,
		});
		overlay.handleInput("x");
		expect(onClose).not.toHaveBeenCalled();
		overlay.handleInput("\x1b"); // escape → app.agents.close
		expect(onClose).toHaveBeenCalledTimes(1);
		overlay.handleInput("\x11"); // ctrl+q → app.agents.open (toggle)
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
