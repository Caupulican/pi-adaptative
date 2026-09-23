/**
 * Reconciler for the "uncertain cleanup" gap: a member left `stopping` (mid-stop, never resolved) by
 * a process that died before finishing — D8's recycle exhaustion, the team-wide launch rollback, or
 * `stopCollaborationAgent`'s own paneId branch throwing — used to stay uncertain forever, re-surfaced
 * as the same unresolved notice on every future reload and never reconciled. `reconcileCollaborationSessions`
 * now resolves the provable cases at reload time, exactly as the launch path's own verified-close
 * does, and leaves everything it cannot verify exactly as uncertain as before.
 *
 * The store is real (a scratch directory under tmpdir()); only the terminal backend is a stub.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationBackend, CollaborationAgent as NativeAgent } from "../src/core/collaboration/backend.ts";
import { CollaborationJobStore, type NewCollaborationJob } from "../src/core/collaboration/job-store.ts";
import { reconcileCollaborationSessions } from "../src/core/collaboration/session-recovery.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Builds a job with one member left mid-stop, using the real store's own acquisition/stop primitives
 * — the exact sequence `resolveMemberLaunchFailure`/`stopCollaborationAgent` leave behind when the
 * process dies before finishing. When `pane` is given, its fields are set directly at admission (the
 * schema allows `paneId`/`backendName` without a `terminalId`, unlike `finishAcquisition`'s typed
 * signature, so this is the only way to build the no-terminalId-recorded shape); `beginAcquisition` +
 * a no-argument `finishAcquisition` then only resolve the acquisition flag, leaving those fields
 * untouched. `beginStop` starts the stop that never completes.
 */
async function jobWithStrandedMember(pane?: { paneId: string; backendName: string; terminalId?: string }) {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-uncertain-cleanup-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	const jobId = "job";
	const agentId = "agent";
	const input: NewCollaborationJob = {
		id: jobId,
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 0,
		deadlineSeconds: 30,
		placement: "current-pane",
		callerPaneId: "caller-pane",
		callerTerminalId: "caller-terminal",
		callerWorkspaceId: "caller-workspace",
		callerTabId: "caller-tab",
		agents: [
			{
				id: agentId,
				name: agentId,
				provider: "pi",
				cwd: root,
				args: [],
				env: {},
				profile: { identity: agentId, allowedTools: ["read", "bash"], writePaths: [] },
				...pane,
			},
		],
	};
	store.create(input);
	const reserved = store.reserveTurn(jobId, agentId, "do the work");
	store.beginAcquisition(jobId, agentId);
	store.finishAcquisition(jobId, agentId); // resolves `acquiring` only; leaves any preset pane fields alone
	store.beginStop(jobId, agentId, reserved.turnId);
	return { store, jobId, agentId, turnId: reserved.turnId };
}

describe("uncertain collaboration cleanup reconciliation", () => {
	it("resolves a member whose acquisition was already provably not-created", async () => {
		const { store, jobId } = await jobWithStrandedMember();
		const publish = vi.fn();
		const listAgents = vi.fn(async () => [] as NativeAgent[]);
		const backend = vi.fn(async () => ({ listAgents }) as unknown as CollaborationBackend);

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		const agent = store.load(jobId).agents[0];
		expect(agent.closed).toBe(true);
		expect(agent.status).toBe("failed");
		expect(agent.evidence).toContain("Resolved at session reconciliation");
		// Resolved before the reattachment check runs, so the job publishes clean, not as a failure.
		expect(publish).toHaveBeenCalledWith(jobId, expect.any(String), undefined);
	});

	it("resolves a member whose pane is verified gone (a different occupant now holds it)", async () => {
		const { store, jobId } = await jobWithStrandedMember({
			paneId: "stranded-pane",
			backendName: "a-agent-stranded",
			terminalId: "stranded-terminal",
		});
		const publish = vi.fn();
		const listAgents = vi.fn(async () => [] as NativeAgent[]);
		const getPane = vi.fn(async () => ({
			paneId: "stranded-pane",
			terminalId: "someone-elses-terminal",
			workspaceId: "w",
			tabId: "t",
		}));
		const closePane = vi.fn(async () => {});
		const backend = vi.fn(async () => ({ listAgents, getPane, closePane }) as unknown as CollaborationBackend);

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		expect(getPane).toHaveBeenCalledWith("stranded-pane");
		// A confirmed different occupant means nothing of ours remains to close.
		expect(closePane).not.toHaveBeenCalled();
		const agent = store.load(jobId).agents[0];
		expect(agent.closed).toBe(true);
		expect(agent.status).toBe("failed");
		expect(publish).toHaveBeenCalledWith(jobId, expect.any(String), undefined);
	});

	it("leaves a member uncertain when its live pane's identity cannot be confirmed", async () => {
		const { store, jobId } = await jobWithStrandedMember({
			paneId: "stranded-pane",
			backendName: "a-agent-stranded",
			terminalId: "stranded-terminal",
		});
		const publish = vi.fn();
		const listAgents = vi.fn(async () => [] as NativeAgent[]);
		const getPane = vi.fn(async () => {
			throw new Error("Unknown pane");
		});
		const backend = vi.fn(async () => ({ listAgents, getPane }) as unknown as CollaborationBackend);

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		const agent = store.load(jobId).agents[0];
		expect(agent.closed).not.toBe(true);
		expect(agent.status).toBe("reserved");
		expect(agent.stopping).toBe(true);
		// The member's own identity can never be reattached without a live registration either, so the
		// job still reports a failure — the member's own record is just never falsely resolved.
		expect(publish).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			expect.stringContaining("could not be reattached"),
		);
	});

	it("leaves every member uncertain when the backend is unreachable", async () => {
		const { store, jobId } = await jobWithStrandedMember({
			paneId: "stranded-pane",
			backendName: "a-agent-stranded",
			terminalId: "stranded-terminal",
		});
		const publish = vi.fn();
		const backend = vi.fn(async () => {
			throw new Error("herdr socket unavailable");
		});

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		const agent = store.load(jobId).agents[0];
		expect(agent.closed).not.toBe(true);
		expect(agent.stopping).toBe(true);
		expect(agent.paneId).toBe("stranded-pane");
		expect(publish).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			expect.stringContaining("herdr socket unavailable"),
		);
	});

	it("leaves a member uncertain when a live pane exists but no terminalId was ever recorded", async () => {
		const { store, jobId } = await jobWithStrandedMember({
			paneId: "stranded-pane",
			backendName: "a-agent-stranded",
			// terminalId deliberately omitted: a paneId alone is never proof, since pane ids get reused.
		});
		const publish = vi.fn();
		const listAgents = vi.fn(async () => [] as NativeAgent[]);
		const getPane = vi.fn(async () => ({
			paneId: "stranded-pane",
			terminalId: "whatever-is-there-now",
			workspaceId: "w",
			tabId: "t",
		}));
		const closePane = vi.fn(async () => {});
		const backend = vi.fn(async () => ({ listAgents, getPane, closePane }) as unknown as CollaborationBackend);

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		// No recorded terminalId means getPane's result can never be checked against anything of ours.
		expect(getPane).not.toHaveBeenCalled();
		expect(closePane).not.toHaveBeenCalled();
		const agent = store.load(jobId).agents[0];
		expect(agent.closed).not.toBe(true);
		expect(agent.stopping).toBe(true);
	});

	it("closes a member's pane when its name was reused elsewhere but its own pane is still alive and matches", async () => {
		const { store, jobId } = await jobWithStrandedMember({
			paneId: "stranded-pane",
			backendName: "a-agent-stranded",
			terminalId: "stranded-terminal",
		});
		const publish = vi.fn();
		// Our old registered name now resolves to a completely different pane/terminal — never proof our
		// own original pane is gone; the reconciler must fall through to a direct lookup on it instead.
		const listAgents = vi.fn(
			async () =>
				[
					{ name: "a-agent-stranded", paneId: "someone-elses-pane", terminalId: "someone-elses-terminal" },
				] as unknown as NativeAgent[],
		);
		const getPane = vi.fn(async (paneId: string) => {
			expect(paneId).toBe("stranded-pane");
			return { paneId: "stranded-pane", terminalId: "stranded-terminal", workspaceId: "w", tabId: "t" };
		});
		const closePane = vi.fn(async () => {});
		const backend = vi.fn(async () => ({ listAgents, getPane, closePane }) as unknown as CollaborationBackend);

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		expect(getPane).toHaveBeenCalledWith("stranded-pane");
		expect(closePane).toHaveBeenCalledWith("stranded-pane");
		const agent = store.load(jobId).agents[0];
		expect(agent.closed).toBe(true);
		expect(agent.status).toBe("failed");
	});

	it("resolves a member as gone when its name was reused elsewhere and its own pane now has a different terminal", async () => {
		const { store, jobId } = await jobWithStrandedMember({
			paneId: "stranded-pane",
			backendName: "a-agent-stranded",
			terminalId: "stranded-terminal",
		});
		const publish = vi.fn();
		const listAgents = vi.fn(
			async () =>
				[
					{ name: "a-agent-stranded", paneId: "someone-elses-pane", terminalId: "someone-elses-terminal" },
				] as unknown as NativeAgent[],
		);
		const getPane = vi.fn(async (paneId: string) => {
			expect(paneId).toBe("stranded-pane");
			return { paneId: "stranded-pane", terminalId: "a-new-occupant", workspaceId: "w", tabId: "t" };
		});
		const closePane = vi.fn(async () => {});
		const backend = vi.fn(async () => ({ listAgents, getPane, closePane }) as unknown as CollaborationBackend);

		await reconcileCollaborationSessions(store, backend, publish, () => true);

		expect(getPane).toHaveBeenCalledWith("stranded-pane");
		// A confirmed different occupant on our own pane: nothing of ours remains to close.
		expect(closePane).not.toHaveBeenCalled();
		const agent = store.load(jobId).agents[0];
		expect(agent.closed).toBe(true);
		expect(agent.status).toBe("failed");
	});
});
