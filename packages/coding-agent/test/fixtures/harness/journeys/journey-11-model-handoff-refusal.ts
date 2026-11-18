import "../builtin-install.ts";
import { basename, dirname, join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { terminalAttemptStatus } from "../../../../src/core/orchestration/task-runtime-state.ts";
import { readLaneSync, syncStorePaths } from "../../../../src/core/worktree-sync/store.ts";
import { calls, createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { handoffBlocks, J9_ROOT_REPLY } from "./journey-9-shared.ts";

const CALL = "handoff-after-checkout-credential";
const MODEL = "worker-c";
const REF = `${HARNESS_PROVIDER}/${MODEL}`;
const AUTH_ERROR = "Fixture credential could not be resolved for the admitted successor";
export const CREDENTIAL_HANDOFF_WARNINGS = [
	/^Worker handoff handoff-after-checkout-credential: (?:completion_error|failed)$/,
	new RegExp(`^Worker delegation failed: ${AUTH_ERROR}$`),
];

/** Revoke credentials at the successor execution boundary, after durable admission and checkout transfer. */
export async function refuseAfterCheckout(
	world: HarnessWorld,
	session: AgentSession,
	sourceId: string,
	sourceAttempt: string,
	cwd: string,
) {
	const lanes = session.backgroundLanes;
	const store = syncStorePaths(join(HARNESS_PROJECT_CWD, ".git"));
	const laneRoot = dirname(cwd);
	const owner = () => {
		const lane = readLaneSync(store, basename(laneRoot));
		expect(lane?.worktreePath).toBe(laneRoot);
		return lane!.boundLaneId;
	};
	const failed = createBarrier();
	const atCredential = createBarrier();
	const allowFailure = createBarrier();
	const terminalWake = createBarrier();
	const registry = world.modelRegistry;
	const auth = registry.getApiKeyAndHeaders;
	const state = () => lanes.getTaskRuntimeSnapshot()!;
	const command = () => state().attempts[sourceAttempt]?.modelTransfer;
	const mark = world.provider.requests.length;
	let checkedOwner: string | undefined;
	let checkedTransferStatus: string | undefined;
	let checkedSuccessorStarted: boolean | undefined;
	let credentialRequests = 0;
	const stop = session.subscribe((event) => {
		if (event.type === "warning" && event.message.startsWith(`Worker handoff ${CALL}:`)) failed.release();
	});
	registry.getApiKeyAndHeaders = async function (model) {
		const transfer = command();
		if (model.id !== MODEL || transfer?.commandId !== CALL || transfer.status !== "successor_admitted")
			return auth.call(this, model);
		credentialRequests++;
		checkedOwner = owner();
		checkedTransferStatus = transfer.status;
		checkedSuccessorStarted = transfer.successorStarted;
		atCredential.release();
		await allowFailure.promise;
		return { ok: false, error: AUTH_ERROR };
	};
	try {
		expect(owner()).toBe(sourceId);
		world.provider.enqueue(
			"root",
			calls(CALL, [
				{ id: CALL, name: "delegate", arguments: { action: "handoff", agentId: sourceId, model: MODEL } },
			]),
			text("handoff-after-checkout-ack", J9_ROOT_REPLY),
			{
				...text("handoff-after-checkout-failure-wake", J9_ROOT_REPLY),
				until: (request) => {
					const transfer = command();
					const successor = transfer && state().attempts[transfer.successorAttemptId];
					if (!successor || !terminalAttemptStatus(successor.status) || !handoffBlocks(request).length)
						return false;
					terminalWake.release();
					return true;
				},
			},
		);
		await withDeadline(
			world.trace,
			"request a transfer that reaches its credential gate",
			session.prompt("Hand the task to worker-c."),
		);
		await withDeadline(world.trace, "successor credentials requested after ownership change", atCredential.promise);
		const admitted = command()!;
		expect(checkedTransferStatus).toBe("successor_admitted");
		expect(checkedSuccessorStarted).toBeUndefined();
		expect(checkedOwner).toBe(admitted.successorAgentId);
		expect(state().agents[sourceId]?.status).not.toBe("retired");
		allowFailure.release();
		await withDeadline(world.trace, "checkout returned after credential refusal", failed.promise);
		await withDeadline(world.trace, "failed successor wakes parent", terminalWake.promise);
		await withDeadline(world.trace, "root idle after successor refusal", session.waitForForegroundIdle());
		const refused = command()!;
		expect(refused).toMatchObject({ status: "refused", reasonCode: "successor_did_not_start", commandId: CALL });
		expect(refused.successorStarted).toBeUndefined();
		expect(owner()).toBe(sourceId);
		expect(state().agents[sourceId]?.status).not.toBe("retired");
		expect(world.io.readFileSync(join(cwd, "limits.ts"), "utf8")).toContain("MAX_RETRIES = 7");
		expect(await lanes.handOffWorkerAgent(sourceId, REF, CALL)).toEqual(refused);
		expect(state().tasks[refused.taskId]?.attemptIds).toEqual([sourceAttempt, refused.successorAttemptId]);
		expect(credentialRequests).toBe(1);
		expect(world.provider.requests.slice(mark).filter((request) => request.model.id === MODEL)).toHaveLength(0);
		return refused;
	} finally {
		allowFailure.release();
		registry.getApiKeyAndHeaders = auth;
		stop();
	}
}
