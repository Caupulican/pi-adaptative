import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMMAND_TIMEOUT_SECONDS,
	MAX_COMMAND_TIMEOUT_SECONDS,
	resolveCommandTimeoutSeconds,
} from "../src/core/tools/bash.ts";

/**
 * The default wall-clock bound exists so a call the agent waits on cannot stall the loop. A background
 * run blocks nothing, so without an explicit timeout it gets the ceiling: a long build or suite started
 * in the background finishes instead of being killed at the foreground default. It is still bounded.
 */
describe("background command timeout", () => {
	it("gives a background run without a timeout the ceiling, and a foreground call the default", () => {
		expect(resolveCommandTimeoutSeconds(undefined, true)).toBe(MAX_COMMAND_TIMEOUT_SECONDS);
		expect(resolveCommandTimeoutSeconds(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_SECONDS);
	});

	it("keeps an explicit timeout, capped at the ceiling, in either mode", () => {
		expect(resolveCommandTimeoutSeconds(300, true)).toBe(300);
		expect(resolveCommandTimeoutSeconds(300)).toBe(300);
		expect(resolveCommandTimeoutSeconds(MAX_COMMAND_TIMEOUT_SECONDS * 2, true)).toBe(MAX_COMMAND_TIMEOUT_SECONDS);
	});
});
