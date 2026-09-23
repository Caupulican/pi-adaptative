import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import {
	createDecisionLedgerReadTool,
	DECISION_LEDGER_READ_TOOL_NAME,
} from "../src/core/tools/decision-ledger-read.ts";
import { WORKER_FORBIDDEN_TOOLS } from "../src/core/worker-tool-ceiling.ts";

function text(result: unknown): string {
	const part = (result as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text");
	return part?.text ?? "";
}

describe("decision_ledger_read", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("is the root's tool: active by default, never a worker's", () => {
		expect(getDefaultActiveToolNames()).toContain(DECISION_LEDGER_READ_TOOL_NAME);
		expect(WORKER_FORBIDDEN_TOOLS.has(DECISION_LEDGER_READ_TOOL_NAME)).toBe(true);
	});

	it("lists recorded sessions of a directory and replays a session's stages and evaluations from the ledger", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ledger-tool-"));
		dirs.push(dir);
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "state", "decision-ledger.sqlite") });
		const cwd = "/work/project";
		const sink = ledger.stageSink("session-a", cwd);
		const understand = sink.open({ objectiveId: "obj-1", stage: "understand", enteredAt: 1000, loop: 1 });
		sink.close(understand, 3000);
		sink.open({
			objectiveId: "obj-1",
			stage: "repair",
			enteredAt: 3000,
			loop: 2,
			reasonCode: "verification_repair_required",
		});
		ledger.startSemanticEvaluation({
			evaluationId: "e1",
			sessionId: "session-a",
			cwd,
			programId: "system-one:verify",
			label: "verify",
			startedAt: 2000,
			model: "jev-1.13.0",
		});
		ledger.settleSemanticEvaluation("e1", {
			endedAt: 2500,
			outcome: "ok",
			verdict: "repair",
			reasons: ["criterion 3 open"],
		});
		ledger
			.stageSink("session-b", "/work/other")
			.open({ objectiveId: "obj-2", stage: "plan", enteredAt: 9000, loop: 1 });
		const tool = createDecisionLedgerReadTool(cwd, {
			getLedger: () => ledger,
			getSessionId: () => "session-a",
			getCwd: () => cwd,
		});
		const sessions = text(await tool.execute("t1", { action: "sessions" }, undefined as never));
		expect(sessions).toContain("session-a");
		expect(sessions).toContain("stages=2 evaluations=1");
		expect(sessions).not.toContain("session-b");
		const replay = text(await tool.execute("t2", { action: "replay" }, undefined as never));
		expect(replay).toContain("session session-a");
		expect(replay).toMatch(/understand 2\.0s loop=1 objective=obj-1/);
		expect(replay).toMatch(/repair .* loop=2 .*reason=verification_repair_required.*\(open\)/);
		expect(replay).toMatch(/verify \[system-one:verify\] ok verdict=repair 500ms model=jev-1\.13\.0/);
		expect(replay).toContain("  criterion 3 open");
		const stagesOnly = text(
			await tool.execute("t3", { action: "stages", sessionId: "session-b" }, undefined as never),
		);
		expect(stagesOnly).toContain("plan");
		expect(stagesOnly).not.toContain("evaluations (");
		ledger.close();
		const unavailable = createDecisionLedgerReadTool(cwd, { getLedger: () => undefined });
		expect(text(await unavailable.execute("t4", { action: "stages" }, undefined as never))).toContain("unavailable");
	});
});
