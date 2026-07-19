import { describe, expect, it } from "vitest";
import { getSessionRole, isWorkerSession } from "../src/core/session-role.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/runtime.ts";

/**
 * Session-role derivation table (D1). Every case passes a hand-built env object -- never mutates
 * `process.env` -- since `getSessionRole`/`isWorkerSession` are env-injectable exactly so callers
 * (and this test) never need to.
 */
describe("getSessionRole / isWorkerSession", () => {
	it("a bound worktree-sync lane yields worker", () => {
		const env = { [PI_WORKTREE_LANE_ENV]: "adhoc-1" };
		expect(getSessionRole(env)).toBe("worker");
		expect(isWorkerSession(env)).toBe(true);
	});

	it("PI_SESSION_ROLE=worker yields worker", () => {
		const env = { PI_SESSION_ROLE: "worker" };
		expect(getSessionRole(env)).toBe("worker");
		expect(isWorkerSession(env)).toBe(true);
	});

	it("a bound lane PLUS PI_SESSION_ROLE=main still yields worker -- main is never an escalation", () => {
		const env = { [PI_WORKTREE_LANE_ENV]: "adhoc-1", PI_SESSION_ROLE: "main" };
		expect(getSessionRole(env)).toBe("worker");
		expect(isWorkerSession(env)).toBe(true);
	});

	it("neither signal present yields main", () => {
		const env = {};
		expect(getSessionRole(env)).toBe("main");
		expect(isWorkerSession(env)).toBe(false);
	});

	it("an invalid lane key is ignored (never a crash, never worker on malformed env)", () => {
		const env = { [PI_WORKTREE_LANE_ENV]: "Not_Valid! key" };
		expect(getSessionRole(env)).toBe("main");
		expect(isWorkerSession(env)).toBe(false);
	});

	it("PI_SESSION_ROLE=main alone (no lane) yields main", () => {
		const env = { PI_SESSION_ROLE: "main" };
		expect(getSessionRole(env)).toBe("main");
		expect(isWorkerSession(env)).toBe(false);
	});
});
