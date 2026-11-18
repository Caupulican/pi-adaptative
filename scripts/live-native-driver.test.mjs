import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeInputDriver } from "./lib/live-native-driver.mjs";

test("a required blocked worker stops the wait only after its owner-only outcome is delivered and answered", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-worker-settlement-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const sessionId = "root";
	const taskId = "worker-1";
	const attemptId = "attempt-1";
	const objectiveId = "session:root";
	const notificationId = "worker-terminal:attempt-1";
	const sessionFile = join(dir, "session.jsonl");
	const eventDir = join(dir, "state", "orchestration", "sessions", "root-workspace", "events", "events");
	mkdirSync(eventDir, { recursive: true });
	const records = [
		{ id: "input", type: "message", message: { role: "user" } },
		{ id: "claim", parentId: "input", customType: "worker_claim", data: { claim: { terminalAttemptId: attemptId, requestId: taskId, status: "blocked", hostVerdict: { verdict: "needs_more", reasonCodes: ["check_without_receipt"] } } } },
		{ id: "lane", parentId: "claim", customType: "lane_record", data: { record: { type: "worker", attemptId, status: "blocked" } } },
		{ id: "handoff", parentId: "lane", type: "custom_message", customType: "background-worker-completion", details: { records: [{ attemptId, status: "blocked" }] } },
		{ id: "answer", parentId: "handoff", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I need your decision." }] } },
	];
	const events = [
		["task.attempt_prepared", taskId, { taskId, attemptId, dispatch: { taskId }, task: { taskId, objectiveId } }],
		["attempt.finished", attemptId, { result: { taskId, attemptId, resultId: "r", status: "blocked", receipts: { status: "captured", acceptance: { disposition: "rejected" } } } }],
		["task.outcome_recorded", taskId, { outcome: { taskId, objectiveId, outcomeId: "o", generation: 1, attempts: [{ attemptId, resultId: "r", laneStatus: "blocked" }], status: "blocked", nextAction: { kind: "rerun_uncovered" } } }],
		["notification.enqueued", objectiveId, { attemptId, objectiveId, notificationId }],
		["notification.delivered", objectiveId, { notificationId }],
	];
	const writeEvent = (index) => {
		const [type, aggregateId, payload] = events[index];
		const ordinal = index + 1;
		writeFileSync(join(eventDir, `${String(ordinal).padStart(16, "0")}.json`), JSON.stringify({ type, aggregateId, payload, ordinal }));
	};
	events.forEach((_, index) => writeEvent(index));
	let observerFile;
	const input = { sessionId, sessionFile, submittedAt: Date.now(), entryId: "input", pane: "test" };
	const driver = createNativeInputDriver({
		directory: dir, jsonl: () => records,
		waitFor: async (_label, check) => {
			let sequence = 0;
			const poll = () => {
				writeFileSync(observerFile, JSON.stringify({ sessionId, sessionFile, leafId: "answer", idle: true, errors: [], observedAt: Date.now(), lastAgentEnd: { sessionId, at: Date.now() }, sequence: ++sequence }));
				return check();
			};
			assert.equal(poll(), undefined);
			assert.equal(poll(), undefined); // Automatic recovery is still possible.
			events[2][2].outcome.nextAction.kind = "ask_owner";
			writeEvent(2);
			records[4].parentId = "lane";
			assert.equal(poll(), undefined);
			assert.equal(poll(), undefined); // The parent's answer is on a branch without this handoff.
			records[4].parentId = "handoff";
			assert.equal(poll(), undefined);
			return poll();
		},
	});
	observerFile = driver.register(input.pane, dir).file;
	await assert.rejects(driver.settleRootPrompt(input, dir, true), /settled blocked \(check_without_receipt\)/);
});
