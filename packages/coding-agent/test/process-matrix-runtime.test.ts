import { describe, expect, it } from "vitest";
import {
	getParentPid,
	getParentSessionId,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
} from "../src/core/process-matrix/runtime.ts";

/**
 * Env-accessor tables only -- `startProcessMatrixRuntime` itself runs real (unref'd) timers and is
 * exercised through its pure building blocks (`process-matrix-supervisor.test.ts`) instead, never
 * with real timers in a test.
 */
describe("getParentPid", () => {
	it("parses a valid positive integer", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "12345" })).toBe(12345);
	});

	it("is undefined when unset", () => {
		expect(getParentPid({})).toBeUndefined();
	});

	it("ignores a non-numeric value", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "not-a-pid" })).toBeUndefined();
	});

	it("ignores zero and negative values", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "0" })).toBeUndefined();
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "-5" })).toBeUndefined();
	});

	it("parses the leading integer of a value with trailing garbage (Number.parseInt semantics)", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "123abc" })).toBe(123);
	});
});

describe("getParentSessionId", () => {
	it("returns a trimmed session id", () => {
		expect(getParentSessionId({ [PI_PARENT_SESSION_ENV]: "  session-1  " })).toBe("session-1");
	});

	it("is undefined when unset", () => {
		expect(getParentSessionId({})).toBeUndefined();
	});

	it("is undefined when set to an empty/whitespace-only string", () => {
		expect(getParentSessionId({ [PI_PARENT_SESSION_ENV]: "" })).toBeUndefined();
		expect(getParentSessionId({ [PI_PARENT_SESSION_ENV]: "   " })).toBeUndefined();
	});
});
