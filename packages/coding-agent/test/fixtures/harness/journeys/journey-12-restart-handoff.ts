/** A clean close parks a requested handoff; a fresh controller in the same process must reacquire its transcript claim. */
import { expect } from "vitest";
import { workerConversationMetadataFile } from "../../../../src/kernel/session/worker-storage-identity.ts";
import { calls, createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { handoffBlocks, J9_ROOT_JUDGMENTS, J9_ROOT_REPLY, J9_SETTINGS, workerReport } from "./journey-9-shared.ts";
import { LIMITS_PATH, NO_DELIVERY_CLAIMS, ORIGINAL_LIMITS, runJourney } from "./shared.ts";

async function exerciseRestartHandoff(world: HarnessWorld): Promise<void> {
	const settings = { ...J9_SETTINGS, worktreeSync: { enabled: true }, modelRouter: { fitnessGate: false } };
	world.systemOne.enterPhase("handoff-restart", { ...J9_ROOT_JUDGMENTS, ...NO_DELIVERY_CLAIMS });
	const owner = await world.createRootSession("root", { settings, sessionManager: world.createSessionManager() });
	const wait = <T>(label: string, pending: Promise<T>) =>
		withDeadline(world.trace, `handoff-restart-${label}`, pending);
	const reached = createBarrier();
	const gate = createBarrier();
	const complete = createBarrier();
	const successorGate = createBarrier();
	const target = `${HARNESS_PROVIDER}/worker-b`;
	world.provider.enqueue(
		"root",
		calls("restart-start", [
			{
				id: "start-restart-worker",
				name: "delegate",
				arguments: {
					action: "start",
					model: "worker-a",
					instructions: "Read limits.ts and report the configured retry count.",
					path: "src",
					readOnly: true,
				},
			},
		]),
		text("restart-accepted", J9_ROOT_REPLY),
	);
	world.provider.enqueue("worker-a", {
		...text("restart-parked", "Still inspecting."),
		gate: gate.promise,
		check: () => reached.release(),
	});
	let disposed = false;
	let reopened: typeof owner | undefined;
	try {
		await wait("start", owner.session.prompt("Start the worker that will inspect the retry count."));
		await wait("source-running", reached.promise);
		const lanes = owner.session.backgroundLanes;
		const snapshot = lanes.getTaskRuntimeSnapshot()!;
		const source = Object.values(snapshot.attempts)[0]!;
		const agentId = source.agentId!;
		const file = owner.sessionManager.getSessionFile()!;
		const transcript = workerConversationMetadataFile(snapshot.agents[agentId]!.resumeContext.sessionFile!);
		const ownership = () => JSON.parse(String(world.io.readFileSync(transcript, "utf8"))).projectContext.ownership;
		expect(ownership().state).toBe("busy");
		const transfer = await wait("request", lanes.handOffWorkerAgent(agentId, target, "restart-transfer"));
		expect(transfer.status).toBe("requested");
		expect(await wait("close", world.disposeSessionInBody(owner.session))).toBeUndefined();
		disposed = true;
		expect(ownership().state).toBe("handoff");
		world.faultMatrix.witness("restart-model-handoff", { control: false });

		world.provider.enqueue("worker-b", {
			gate: successorGate.promise,
			...workerReport("restart-successor", {
				status: "completed",
				summary: "Inspection continued in the original task.",
			}),
		});
		world.provider.enqueue("root", {
			...text("restart-wake", J9_ROOT_REPLY),
			until: (request) => {
				const successor =
					reopened?.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[transfer.successorAttemptId];
				if (!successor?.result || !handoffBlocks(request).length) return false;
				complete.release();
				return true;
			},
		});
		reopened = await world.createRootSession("root", { settings, sessionManager: world.openSessionManager(file) });
		const fresh = reopened.session.backgroundLanes;
		expect((await fresh.handOffWorkerAgent(agentId, target, transfer.commandId)).commandId).toBe(transfer.commandId);
		successorGate.release();
		await wait("successor", complete.promise);
		await wait("root-idle", reopened.session.waitForForegroundIdle());
		const finished = fresh.getTaskRuntimeSnapshot()!;
		expect(finished.attempts[source.attemptId]).toMatchObject({
			status: "cancelled",
			reasonCode: "worker_model_transfer",
			modelTransfer: { status: "completed", successorStarted: true },
		});
		expect(finished.tasks[source.taskId]?.attemptIds).toEqual([source.attemptId, transfer.successorAttemptId]);
		expect(finished.agents[agentId]?.status).toBe("retired");
		expect(finished.attempts[transfer.successorAttemptId]?.agentId).toBe(transfer.successorAgentId);
		world.faultMatrix.witness("restart-model-handoff", { control: true });
	} finally {
		successorGate.release();
		gate.release();
		if (!disposed) await world.disposeSessionInBody(owner.session);
		if (reopened) expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
	}
}

export async function runWorkerModelHandoffRecovery(): Promise<void> {
	await runJourney(
		{
			name: "worker-model-handoff-restart",
			journey: 12,
			repository: { committed: { "src/limits.ts": ORIGINAL_LIMITS } },
			files: { [LIMITS_PATH]: ORIGINAL_LIMITS },
		},
		exerciseRestartHandoff,
	);
}
