import { describe, expect, it } from "vitest";
import { parseTaskCommand } from "../src/core/tasks/task-command.ts";

describe("native /task command parser", () => {
	it("parses list aliases", () => {
		expect(parseTaskCommand("/task")).toEqual({ ok: true, command: { type: "list", includeTerminal: false } });
		expect(parseTaskCommand("/steps list")).toEqual({ ok: true, command: { type: "list", includeTerminal: false } });
		expect(parseTaskCommand("/task all")).toEqual({ ok: true, command: { type: "list", includeTerminal: true } });
	});

	it("parses add and default text compatibility", () => {
		expect(parseTaskCommand("/task add Verify native tool")).toEqual({
			ok: true,
			command: { type: "add", content: "Verify native tool" },
		});
		expect(parseTaskCommand("/task Verify native tool")).toEqual({
			ok: true,
			command: { type: "add", content: "Verify native tool" },
		});
	});

	it("parses lifecycle updates with optional evidence or reasons", () => {
		expect(parseTaskCommand("/task start current")).toEqual({
			ok: true,
			command: { type: "update", selector: "current", status: "in_progress" },
		});
		expect(parseTaskCommand("/task done step-2 -- focused test passed")).toEqual({
			ok: true,
			command: { type: "update", selector: "step-2", status: "completed", evidence: "focused test passed" },
		});
		expect(parseTaskCommand("/task block current -- waiting for fixture")).toEqual({
			ok: true,
			command: { type: "update", selector: "current", status: "blocked", note: "waiting for fixture" },
		});
		expect(parseTaskCommand("/task cancel step-3 obsolete")).toEqual({
			ok: true,
			command: { type: "update", selector: "step-3", status: "cancelled", note: "obsolete" },
		});
		expect(parseTaskCommand("/task reopen Implement native task steps")).toEqual({
			ok: true,
			command: { type: "update", selector: "Implement native task steps", status: "pending" },
		});
	});

	it("parses clear and compact", () => {
		expect(parseTaskCommand("/task clear")).toEqual({ ok: true, command: { type: "clear" } });
		expect(parseTaskCommand("/steps compact")).toEqual({ ok: true, command: { type: "compact" } });
	});

	it("retires duplicate background commands with native migration guidance", () => {
		expect(parseTaskCommand("/task run current")).toEqual({
			ok: true,
			command: { type: "retired_execution", operation: "run" },
		});
		expect(parseTaskCommand("/task team list")).toEqual({
			ok: true,
			command: { type: "retired_execution", operation: "team" },
		});
	});

	it("returns actionable usage errors", () => {
		expect(parseTaskCommand("/task add")).toMatchObject({ ok: false, error: expect.stringContaining("/task add") });
		expect(parseTaskCommand("/task done")).toMatchObject({ ok: false, error: expect.stringContaining("selector") });
		expect(parseTaskCommand("/task block current")).toMatchObject({
			ok: false,
			error: expect.stringContaining("reason"),
		});
	});
});
