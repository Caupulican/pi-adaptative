import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createLocalWorkerProcessOwnerId, isLocalProcessAlive } from "../src/core/delegation/worker-process-owner.ts";
import { setConcurrentResponses } from "./suite/concurrent-responses.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["dead", "live", "unknown", "original"] as const)(
	"queued enrolled worker preserves accepted work under %s ownership",
	async (mode) => {
		const harness = await createHarness();
		const original = (harness.session as unknown as { _backgroundLanes: BackgroundLaneController })._backgroundLanes;
		const deps = (original as unknown as { deps: BackgroundLaneControllerDeps }).deps;
		const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
		expect(exited.status).toBe(0);
		const pid = Number(exited.stdout.trim());
		expect(isLocalProcessAlive(pid)).toBe(false);
		const owner =
			mode === "unknown"
				? "unclassified-owner"
				: createLocalWorkerProcessOwnerId(mode === "dead" ? pid : process.pid, randomUUID());
		const identity = vi.spyOn(WorkerAgentControlCoordinator.prototype, "getProcessOwnerId").mockReturnValue(owner);
		let reopened: BackgroundLaneController | undefined;
		let requests = 0;
		const remaining = setConcurrentResponses(harness, [
			() => {
				requests++;
				return fauxAssistantMessage('{"summary":"Recovered accepted task","status":"completed"}');
			},
		]);
		try {
			const request = { instructions: "Preserve this queued task across owner restart." };
			const admitted = await original.startWorkerDelegation(request);
			expect(admitted).toMatchObject({ started: true, record: { status: "queued" } });
			if (!admitted.started) throw new Error(admitted.skipReason);
			identity.mockRestore();
			const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
			const before = lifecycle.getTaskRuntimeSnapshot();
			const agent = lifecycle.getAgent(admitted.record.laneId);
			if (!agent?.resumeContext.sessionFile) throw new Error("Expected enrolled worker transcript");
			const conversations = new WorkerConversationStore();
			const open = {
				agentDir: harness.tempDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agent.agentId,
			};
			const binding = conversations.getProjectContextBinding(open);
			expect(binding?.ownership).toMatchObject({ state: "busy", claim: { incarnation: owner, generation: 1 } });
			const metadataPath = `${agent.resumeContext.sessionFile}.worker.json`;
			const metadata = readFileSync(metadataPath);
			const transcript = readFileSync(agent.resumeContext.sessionFile);
			expect(Object.values(before.attempts)).toEqual([expect.objectContaining({ status: "queued" })]);
			expect(Object.values(before.attempts)[0].lease).toBeUndefined();
			expect(requests).toBe(0);
			reopened = mode === "original" ? undefined : new BackgroundLaneController(deps);
			const result = await (reopened ?? original).runWorkerDelegationOnce(request, undefined, admitted.record);
			if (mode === "dead" || mode === "original") {
				expect(result.record?.status).toBe("succeeded");
				expect(requests).toBe(1);
				expect(remaining()).toBe(0);
				const after = lifecycle.getTaskRuntimeSnapshot();
				expect(Object.keys(after.tasks)).toEqual(Object.keys(before.tasks));
				expect(Object.keys(after.attempts)).toEqual(Object.keys(before.attempts));
				expect(conversations.getProjectContextBinding(open)?.ownership.claim.generation).toBe(
					mode === "dead" ? 2 : 1,
				);
			} else {
				expect(result.started).toBe(false);
				expect(requests).toBe(0);
				expect(remaining()).toBe(1);
				expect(lifecycle.getTaskRuntimeSnapshot()).toEqual(before);
				expect(readFileSync(metadataPath)).toEqual(metadata);
				expect(readFileSync(agent.resumeContext.sessionFile)).toEqual(transcript);
			}
		} finally {
			identity.mockRestore();
			reopened?.abortInFlightLanes();
			await harness.cleanup();
		}
	},
);

it.each(["live", "unknown"] as const)("disposing a foreign controller preserves %s queued ownership", async (mode) => {
	const harness = await createHarness();
	const original = (harness.session as unknown as { _backgroundLanes: BackgroundLaneController })._backgroundLanes;
	const deps = (original as unknown as { deps: BackgroundLaneControllerDeps }).deps;
	const identity = vi
		.spyOn(WorkerAgentControlCoordinator.prototype, "getProcessOwnerId")
		.mockReturnValue(
			mode === "live" ? createLocalWorkerProcessOwnerId(process.pid, randomUUID()) : "unclassified-owner",
		);
	try {
		const admitted = await original.startWorkerDelegation({ instructions: "Keep the original owner's queued task." });
		expect(admitted).toMatchObject({ started: true, record: { status: "queued" } });
		identity.mockRestore();
		const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
		const before = lifecycle.getTaskRuntimeSnapshot();
		const foreign = new BackgroundLaneController(deps);
		foreign.getLaneRecords();
		foreign.abortInFlightLanes();
		expect(lifecycle.getTaskRuntimeSnapshot()).toEqual(before);
	} finally {
		identity.mockRestore();
		await harness.cleanup();
	}
});
