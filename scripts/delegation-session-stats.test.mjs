import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { delegationStats } from "./delegation-session-stats.mjs";

test("start evidence and visible terminal handoffs keep their own identities", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-delegation-stats-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const call = (action, id, name = "delegate") => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { action } }] },
	});
	const result = (toolCallId, details, toolName = "delegate") => ({
		type: "message",
		message: { role: "toolResult", toolCallId, toolName, details },
	});
	const save = (name, rows) =>
		writeFile(path.join(dir, name + ".jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
	const terminal = { type: "worker", laneId: "lane", attemptId: "attempt", status: "partial" };
	const snapshot = { type: "custom", customType: "lane_record", data: { version: 1, record: terminal } };
	const handoff = (records) => ({
		type: "custom_message",
		customType: "background-worker-completion",
		display: true,
		details: { records },
	});
	await save("failed-first", [
		call("list", "list"),
		call("spawn", "a"),
		result("a", { started: false }),
		call("start", "b"),
		result("b", { started: true, laneId: "lane" }),
		snapshot,
		snapshot,
		handoff([terminal]),
	]);
	await save("wrong-attempt", [
		call(undefined, "a"),
		result("a", { started: true, laneId: "lane" }),
		snapshot,
		handoff([{ ...terminal, attemptId: "another" }]),
	]);
	await save("incomplete", [call("start", "a"), handoff([terminal])]);
	await save("conflict", [snapshot, handoff([terminal, { ...terminal, status: "succeeded" }])]);
	await save("mailbox", [call("start", "a"), result("a", { started: true, messageId: "m" })]);
	await save("assign", [call(undefined, "a", "assign"), result("a", { started: true, laneId: "lane" }, "assign")]);
	await save("distinct-tools", [call(undefined, "c", "assign"), call("start", "c"), result("c", { started: true, laneId: "lane" }, "assign")]);
	await save("cross-tool", [call(undefined, "b", "assign"), result("b", { started: true, laneId: "lane" })]);
	const stats = await delegationStats(dir);
	assert.deepEqual(stats.firstDispatch, {
		admitted: 3,
		partial: 0,
		refused: 1,
		existingAgentMessage: 1,
		unknown: 2,
		noStartAttempt: 1,
	});
	assert.deepEqual(stats.handoffs.partial, { matched: 1, missingVisibleRecord: 1, conflicting: 1 });
});
