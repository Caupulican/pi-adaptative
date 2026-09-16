import { afterEach, expect, it, vi } from "vitest";
import { CollaborationCoordinator } from "../src/core/collaboration/coordinator.ts";
import { WorkerDirectoryAdmission } from "../src/core/delegation/worker-directory-admission.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function holdDirectoryAdmission() {
	let announce!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(WorkerDirectoryAdmission.prototype, "namespaceKey").mockImplementation(async () => {
		announce();
		await gate;
		return "test-physical-directory";
	});
	return { entered, release };
}

it("a stop command cancels its owned pending admission before any pane or durable task exists", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	const held = holdDirectoryAdmission();
	const starting = f
		.execute({ action: "fire_task", launchKey: "pending", task: "Work", agents: [{ provider: "pi" }] })
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	await held.entered;
	const stopError = await f.execute({ action: "stop_job", jobId: "pending" }).then(
		() => undefined,
		(error: unknown) => error,
	);
	held.release();
	const startError = await starting;
	expect(stopError).toBeUndefined();
	expect(startError).toBeInstanceOf(Error);
	expect(f.store.list()).toHaveLength(0);
	expect(f.backend.createWorkspace).not.toHaveBeenCalled();
	expect(f.launchTurn).not.toHaveBeenCalled();
});

it("the direct agent stop boundary cancels a preflight without claiming a closed native resource", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	const held = holdDirectoryAdmission();
	const coordinator = new CollaborationCoordinator({
		store: f.store,
		backend: async () => f.backend,
		launchTurn: async () => {},
		report: f.report,
	});
	const starting = coordinator
		.launch({
			id: "pending",
			parentSessionId: "parent",
			sessionName: "pending",
			cwd: f.root,
			title: "Pending",
			createdAt: 0,
			deadlineSeconds: 30,
			agents: [
				{
					id: "worker",
					name: "worker",
					provider: "pi",
					cwd: f.root,
					args: [],
					env: {},
					profile: { identity: "worker", allowedTools: ["bash"], writePaths: [] },
				},
			],
		})
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	await held.entered;
	const stopped = await coordinator.stopAgent("pending", "worker").then(
		(closed) => ({ closed }),
		(error: unknown) => ({ error }),
	);
	held.release();
	const startError = await starting;
	coordinator.dispose();
	expect(stopped).toEqual({ closed: false });
	expect(startError).toBeInstanceOf(Error);
	expect(f.store.list()).toHaveLength(0);
	expect(f.backend.createWorkspace).not.toHaveBeenCalled();
});

it("negative control: a dry-run stop leaves an owned pending admission intact", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	const held = holdDirectoryAdmission();
	const starting = f
		.execute({ action: "fire_task", launchKey: "pending", task: "Work", agents: [{ provider: "pi" }] })
		.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
	await held.entered;
	const previewError = await f.execute({ action: "stop_job", jobId: "pending", dryRun: true }).then(
		() => undefined,
		(error: unknown) => error,
	);
	held.release();
	const started = await starting;
	expect(previewError).toBeUndefined();
	expect(started).toHaveProperty("value");
	expect(f.store.load("pending").agents[0].turn).toBe(1);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});

it("negative control: an unknown job remains unavailable to stop", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await expect(f.execute({ action: "stop_job", jobId: "unknown" })).rejects.toThrow();
	expect(f.backend.closePane).not.toHaveBeenCalled();
	expect(f.backend.closeWorkspace).not.toHaveBeenCalled();
});
