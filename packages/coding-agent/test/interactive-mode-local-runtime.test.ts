import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/**
 * #27: the router's readiness gate (AgentSession.getLocalRuntime) and interactive-mode's own
 * `/models` command handling must share ONE OllamaRuntime instance per server — otherwise a
 * router-booted pi-managed server has no `_child` reference for `/models stop` to kill. Delegating
 * to the session (rather than interactive-mode keeping its own separate instance) gets this for
 * free, and — as a bonus — means non-TUI callers of AgentSession get the same capability, since it
 * lives on the session, not stranded in this UI layer.
 */
describe("InteractiveMode.localRuntime delegates to the session (shared instance, not a second one)", () => {
	test("returns the session's OllamaRuntime rather than constructing its own", () => {
		const sessionRuntime = { detect: async () => ({}) };
		const fakeThis = {
			session: { getLocalRuntime: () => sessionRuntime },
		};

		const runtime = Reflect.get(InteractiveMode.prototype, "localRuntime", fakeThis);

		expect(runtime).toBe(sessionRuntime);
	});
});
