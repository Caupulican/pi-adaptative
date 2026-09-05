import { describe, expect, it } from "vitest";
import { PI_PARENT_PID_ENV } from "../src/core/process-identity.ts";
import {
	getSessionRole,
	isWorkerSession,
	setTerminalSessionMode,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/core/session-role.ts";
import { envelopeHasToolCapability } from "../src/core/tool-capability-policy.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/runtime.ts";

/**
 * Session-role derivation table (D1). Every case passes a hand-built env object -- never mutates
 * `process.env` -- since `getSessionRole`/`isWorkerSession` are env-injectable exactly so callers
 * (and this test) never need to.
 */
describe("getSessionRole / isWorkerSession", () => {
	it("keeps persistent native launchers root-owned and requires both launch and delegation authority", () => {
		expect(WORKER_FORBIDDEN_TOOLS.has("pi_collaboration")).toBe(true);
		expect(envelopeHasToolCapability(["process.exec"], "pi_collaboration")).toBe(false);
		expect(envelopeHasToolCapability(["workflow.delegate"], "pi_collaboration")).toBe(false);
		expect(envelopeHasToolCapability(["process.exec", "workflow.delegate"], "pi_collaboration")).toBe(true);
		expect(WORKER_FORBIDDEN_TOOLS.has("bash")).toBe(false);
	});
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

	it("a managed child parent identity yields worker without requiring a worktree lane", () => {
		const env = { [PI_PARENT_PID_ENV]: "4242" };
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

	it("an invalid parent pid is ignored", () => {
		const env = { [PI_PARENT_PID_ENV]: "not-a-pid" };
		expect(getSessionRole(env)).toBe("main");
		expect(isWorkerSession(env)).toBe(false);
	});

	it("PI_SESSION_ROLE=main alone (no lane) yields main", () => {
		const env = { PI_SESSION_ROLE: "main" };
		expect(getSessionRole(env)).toBe("main");
		expect(isWorkerSession(env)).toBe(false);
	});

	it("maps explicit terminal audience onto the authoritative role without allowing escalation", () => {
		const workerEnv: NodeJS.ProcessEnv = {};
		setTerminalSessionMode("worker", workerEnv);
		expect(getSessionRole(workerEnv)).toBe("worker");
		setTerminalSessionMode("user", workerEnv);
		expect(getSessionRole(workerEnv)).toBe("worker");

		const laneEnv: NodeJS.ProcessEnv = { [PI_WORKTREE_LANE_ENV]: "adhoc-1" };
		setTerminalSessionMode("user", laneEnv);
		expect(getSessionRole(laneEnv)).toBe("worker");
	});
});
