import { describe, expect, it } from "vitest";
import { hasRunningBackgroundedToolCall, isSessionSettled } from "../src/core/session-settlement.ts";

const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };

describe("isSessionSettled", () => {
	it("reports settled only when nothing further will happen without new input", () => {
		expect(isSessionSettled(idle, false)).toBe(true);
	});

	it("is not settled while an idle continuation is armed", () => {
		// The goal loop and research lane are scheduled from the same prompt tail that consults this,
		// on debounce timers. Reporting settled here would be contradicted milliseconds later when the
		// timer drives another turn with no new input — the gap this condition closes.
		expect(isSessionSettled(idle, true)).toBe(false);
	});

	it("is not settled while streaming, compacting, or holding queued messages", () => {
		expect(isSessionSettled({ ...idle, isStreaming: true }, false)).toBe(false);
		expect(isSessionSettled({ ...idle, isCompacting: true }, false)).toBe(false);
		expect(isSessionSettled({ ...idle, pendingMessageCount: 1 }, false)).toBe(false);
	});

	it("requires every condition at once", () => {
		expect(isSessionSettled({ ...idle, isStreaming: true }, true)).toBe(false);
	});
});

describe("hasRunningBackgroundedToolCall", () => {
	it("is true only while a record is still running", () => {
		expect(hasRunningBackgroundedToolCall([])).toBe(false);
		expect(hasRunningBackgroundedToolCall([{ status: "completed" }])).toBe(false);
		expect(hasRunningBackgroundedToolCall([{ status: "completed" }, { status: "running" }])).toBe(true);
	});
});
