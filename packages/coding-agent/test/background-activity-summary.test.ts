import type { CustomMessage } from "@caupulican/pi-agent-core";
import { beforeAll, describe, expect, it } from "vitest";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("background activity summary", () => {
	beforeAll(() => initTheme("dark"));

	it("renders worker terminal batches as one line with verification ids", () => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "background-worker-completion",
			content: "verbose internal handoff that must stay collapsed",
			display: true,
			details: {
				records: [
					{ laneId: "worker-1", status: "succeeded" },
					{ laneId: "worker-2", status: "partial", claim: { parentReviewRequired: true } },
					{ laneId: "worker-3", status: "failed" },
				],
			},
			timestamp: Date.now(),
		};

		const text = stripAnsi(new CustomMessageComponent(message).render(160).join("\n"));

		expect(text.split("\n").filter((line) => line.trim())).toHaveLength(1);
		expect(text).toContain("3 agents finished");
		expect(text).toContain("1 agent needs verification [worker-2]");
		expect(text).toContain("1 agent failed [worker-3]");
		expect(text).not.toContain("background-worker-completion");
		expect(text).not.toContain("verbose internal handoff");
	});

	it("renders background tool batches through the same one-line contract", () => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "background-tool-completion",
			content: "verbose internal tool handoff",
			display: true,
			details: {
				records: [
					{ taskId: "tool-task-1", toolName: "delegate", status: "completed" },
					{ taskId: "tool-task-2", toolName: "bash", status: "failed" },
				],
			},
			timestamp: Date.now(),
		};

		const text = stripAnsi(new CustomMessageComponent(message).render(160).join("\n"));

		expect(text.split("\n").filter((line) => line.trim())).toHaveLength(1);
		expect(text).toContain("2 background tasks finished");
		expect(text).toContain("1 background task failed [tool-task-2]");
		expect(text).not.toContain("background-tool-completion");
		expect(text).not.toContain("verbose internal tool handoff");
	});

	it("keeps exact aggregate counts when terminal details are bounded", () => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "background-worker-completion",
			content: "bounded handoff",
			display: true,
			details: {
				records: Array.from({ length: 8 }, (_, index) => ({ laneId: `worker-${index + 1}`, status: "succeeded" })),
				summary: {
					kind: "agent",
					totalCount: 10,
					attentionCount: 0,
					failedCount: 2,
					canceledCount: 0,
				},
			},
			timestamp: Date.now(),
		};

		const text = stripAnsi(new CustomMessageComponent(message).render(160).join("\n"));

		expect(text).toContain("10 agents finished");
		expect(text).toContain("2 agents failed");
	});

	it.each(["background-worker-completion", "background-tool-completion"] as const)(
		"uses a generic one-line fallback for malformed %s messages",
		(customType) => {
			const message: CustomMessage<unknown> = {
				role: "custom",
				customType,
				content: "verbose malformed handoff",
				display: true,
				details: { records: "not an array" },
				timestamp: Date.now(),
			};

			const text = stripAnsi(new CustomMessageComponent(message).render(160).join("\n"));

			expect(text.split("\n").filter((line) => line.trim())).toHaveLength(1);
			expect(text).toContain("activity unavailable");
			expect(text).not.toContain("verbose malformed handoff");
		},
	);

	it.each([
		["worktree-sync-notice", "worktree sync changed main"],
		["process-matrix-notice", "process matrix recovered a worker"],
	] as const)("collapses %s supervision notices through the background contract", (customType, content) => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType,
			content: `${content}\nverbose durable guidance remains model-visible`,
			display: true,
			timestamp: Date.now(),
		};

		const text = stripAnsi(new CustomMessageComponent(message).render(160).join("\n"));

		expect(text.split("\n").filter((line) => line.trim())).toHaveLength(1);
		expect(text).toContain(customType === "worktree-sync-notice" ? "Worktree sync" : "Process supervision");
		expect(text).not.toContain(content);
		expect(text).not.toContain("verbose durable guidance");
	});

	it("truncates the collapsed summary safely at narrow widths", () => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "background-worker-completion",
			content: "narrow handoff",
			display: true,
			details: { records: [{ laneId: "worker-1", status: "failed" }] },
			timestamp: Date.now(),
		};

		const text = stripAnsi(new CustomMessageComponent(message).render(12).join("\n"));

		expect(text.split("\n").filter((line) => line.trim())).toHaveLength(1);
		expect(text.split("\n").filter((line) => line.trim())[0]?.length).toBeLessThanOrEqual(12);
	});
});
