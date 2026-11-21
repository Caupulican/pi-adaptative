import "../builtin-install.ts";
import { join } from "node:path";
import { expect } from "vitest";
import type { ModelTransferRecord } from "../../../../src/core/orchestration/model-transfer.ts";
import type { AgentMessage } from "../../../../src/kernel/index.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { handoffBlocks, J9_ROOT_JUDGMENTS, J9_ROOT_REPLY, J9_SETTINGS, workerReport } from "./journey-9-shared.ts";
import { CREDENTIAL_HANDOFF_WARNINGS, refuseAfterCheckout } from "./journey-11-model-handoff-refusal.ts";
import { LIMITS_PATH, latestBatchResults, NO_DELIVERY_CLAIMS, ORIGINAL_LIMITS, runJourney } from "./shared.ts";

const TASK = "Update the retry limit in limits.ts in the isolated src workspace and verify its new value.";
const BLOCKED_SUMMARY = "The retry edit is present; an independent reader must verify the value.";
const BLOCKER = "The owner requested an independent reader.";
const HISTORY_ROWS = 32;
const HISTORY = Array.from({ length: HISTORY_ROWS }, (_, index) => `Evidence line ${index + 1}`).join("\n");
const TARGET = `${HARNESS_PROVIDER}/worker-b`;

function receiptFor(messages: readonly AgentMessage[], callId: string) {
	const result = messages.findLast((message) => message.role === "toolResult" && message.toolCallId === callId);
	if (result?.role !== "toolResult") throw new Error(`Missing delegate receipt for ${callId}`);
	return result;
}

async function exercise(
	world: HarnessWorld,
	sourceStatus: "running" | "blocked",
	refuseCredentials = false,
): Promise<void> {
	// Exercise the durable long-instruction representation through one real source/successor transfer.
	const assignment =
		sourceStatus === "running" && !refuseCredentials
			? `${TASK}\n${"Inspect only limits.ts.\n".repeat(850)}Verify the final value.`
			: TASK;
	const id = (label: string) => `handoff-${refuseCredentials ? "credential" : sourceStatus}-${label}`;
	const delegate = (label: string, args: Record<string, unknown>) =>
		calls(id(label), [{ id: id(label), name: "delegate", arguments: args }]);
	const done = (label: string) => text(id(label), J9_ROOT_REPLY);
	let lastWorkingRequest: ScriptedRequest | undefined;
	const afterEdit = createBarrier();
	const sourceGate = createBarrier();
	const blockedWake = createBarrier();
	const successorGate = createBarrier();
	const completedWake = createBarrier();
	world.systemOne.enterPhase(id("intake"), { ...J9_ROOT_JUDGMENTS, ...NO_DELIVERY_CLAIMS });
	const { session } = await world.createRootSession("root", {
		settings: { ...J9_SETTINGS, worktreeSync: { enabled: true }, modelRouter: { fitnessGate: false } },
	});
	const lanes = session.backgroundLanes;
	const mark = world.provider.requests.length;
	world.provider.enqueue(
		"root",
		delegate("start", {
			action: "start",
			model: "worker-a",
			instructions: assignment,
			path: "src",
			writePaths: ["src/limits.ts"],
		}),
		done("started"),
	);
	if (sourceStatus === "blocked")
		world.provider.enqueue("root", {
			...done("blocked-wake"),
			until: (request) => {
				if (!handoffBlocks(request).length) return false;
				blockedWake.release();
				return true;
			},
		});
	if (sourceStatus === "running") {
		// Distinct real reads build the accepted worker history without spending a model request per row.
		world.provider.enqueue(
			"worker-a",
			calls(
				id("evidence"),
				Array.from({ length: HISTORY_ROWS }, (_, index) => ({
					id: id(`evidence-${index}`),
					name: "read",
					arguments: { path: "evidence.txt", offset: index + 1, limit: 1 },
				})),
			),
		);
	}
	world.provider.enqueue(
		"worker-a",
		calls(id("edit"), [
			{
				id: id("edit-file"),
				name: "edit",
				arguments: {
					path: "limits.ts",
					edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 7" }],
				},
			},
		]),
		{
			...(sourceStatus === "running"
				? calls(id("working"), [{ id: id("working-read"), name: "read", arguments: { path: "limits.ts" } }])
				: workerReport(id("source-report"), {
						status: "blocked",
						summary: BLOCKED_SUMMARY,
						blockers: [BLOCKER],
						blockerCode: "needs_owner_decision",
					})),
			gate: sourceGate.promise,
			check: (request) => {
				expect(latestBatchResults(request)).toContainEqual(
					expect.objectContaining({ toolName: "edit", isError: false }),
				);
				lastWorkingRequest = request;
				afterEdit.release();
			},
		},
	);
	if (sourceStatus === "running")
		world.provider.enqueue("worker-a", {
			...text(id("halt-report"), "The partial retry edit is in limits.ts. Verify its value before completing."),
			check: (request) => {
				if (!lastWorkingRequest) throw new Error("The source never reached its working request.");
				const previous = lastWorkingRequest.context;
				const prefix = previous.messages.length;
				expect(
					previous.messages.filter((row) => row.role === "toolResult" && row.toolName === "read" && !row.isError),
				).toHaveLength(HISTORY_ROWS);
				expect(previous.tools?.some((tool) => tool.name === "edit")).toBe(true);
				expect(request.context.systemPrompt).toBe(previous.systemPrompt);
				expect(JSON.stringify(request.context.tools)).toBe(JSON.stringify(previous.tools));
				expect(JSON.stringify(request.context.messages.slice(0, prefix))).toBe(JSON.stringify(previous.messages));
				const haltRows = request.context.messages.filter(
					(row) => row.role === "user" && JSON.stringify(row.content).includes("[Worker control halt]"),
				);
				expect(haltRows).toHaveLength(1);
				expect(request.context.messages.at(-1)).toBe(haltRows[0]);
				expect(request.context.messages.slice(prefix)).toContainEqual(
					expect.objectContaining({ role: "toolResult", toolCallId: id("working-read") }),
				);
			},
		});
	const wait = <T>(label: string, promise: Promise<T>) => withDeadline(world.trace, id(label), promise);
	try {
		await wait("root-start", session.prompt("Start the retry limit worker."));
		const started = receiptFor(session.messages, id("start"));
		expect(started.isError, JSON.stringify(started.content)).toBe(false);
		const { agentId } = started.details as { agentId: string };
		await wait("uncommitted-edit", afterEdit.promise);
		if (sourceStatus === "blocked") {
			sourceGate.release();
			await wait("blocked-report", blockedWake.promise);
			await wait("blocked-idle", session.waitForForegroundIdle());
		}
		const source = Object.values(lanes.getTaskRuntimeSnapshot()!.attempts)[0]!;
		const cwd = source.dispatch.executionContract!.worker.authority.cwd;
		if (!cwd) throw new Error("Missing execution directory for source worker");
		expect(source.status).toBe(sourceStatus);
		expect(world.io.readFileSync(join(cwd, "limits.ts"), "utf8")).toContain("MAX_RETRIES = 7");

		world.provider.enqueue(
			"root",
			delegate("deny", {
				action: "handoff",
				agentId,
				model: { provider: HARNESS_PROVIDER, modelId: "missing-model" },
			}),
			done("denied"),
		);
		await wait("unavailable", session.prompt("Transfer this worker to the specified unavailable model."));
		const denied = receiptFor(session.messages, id("deny"));
		expect(denied.isError, JSON.stringify(denied.content)).toBe(true);
		const unchanged = lanes.getTaskRuntimeSnapshot()!;
		expect(Object.keys(unchanged.attempts)).toEqual([source.attemptId]);
		expect(unchanged.attempts[source.attemptId]?.status).toBe(sourceStatus);
		expect(unchanged.agents[agentId]?.status).not.toBe("retired");
		expect(world.io.readFileSync(join(cwd, "limits.ts"), "utf8")).toContain("MAX_RETRIES = 7");
		world.faultMatrix.witness("worker-model-handoff", { control: false });
		const refused = refuseCredentials
			? await refuseAfterCheckout(world, session, agentId, source.attemptId, cwd)
			: undefined;

		world.provider.enqueue(
			"root",
			delegate("move", { action: "handoff", agentId, model: "worker-b" }),
			done("acknowledged"),
			{
				...done("completed-wake"),
				until: (request) => {
					const attempts = lanes.getTaskRuntimeSnapshot()!.attempts;
					const successorId = attempts[source.attemptId]?.modelTransfer?.successorAttemptId;
					const successor = successorId ? attempts[successorId] : undefined;
					if (!successor?.result || !handoffBlocks(request).some((block) => block.outcome.includes("Outcome: ")))
						return false;
					completedWake.release();
					return true;
				},
			},
		);
		world.provider.enqueue(
			"worker-b",
			{
				...calls(id("read"), [{ id: id("read-file"), name: "read", arguments: { path: "limits.ts" } }]),
				gate: successorGate.promise,
				check: (request) => {
					const task = request.context.messages
						.filter((message) => message.role === "user")
						.flatMap((message) =>
							typeof message.content === "string"
								? [message.content]
								: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
						)
						.find((value) => value.includes(assignment));
					expect(task).toBeDefined();
					const fence =
						/<untrusted_content [^>]*source="previous-worker"[^>]*>([\s\S]*?)<\/untrusted_content>/i.exec(task!);
					expect(fence, task).toBeTruthy();
					expect(task!.slice(0, fence!.index)).toContain(assignment);
					if (sourceStatus === "blocked") {
						expect(fence![1]).toContain(BLOCKED_SUMMARY);
						expect(fence![1]).toContain(BLOCKER);
					}
				},
			},
			{
				...workerReport(id("successor-report"), { status: "completed", summary: "Verified MAX_RETRIES is 7." }),
				check: (request) => {
					expect(latestBatchResults(request)).toContainEqual({
						toolName: "read",
						isError: false,
						text: expect.stringContaining("MAX_RETRIES = 7"),
					});
				},
			},
		);
		await wait("root-returned-while-successor-held", session.prompt("Hand the current task to worker-b."));
		const result = receiptFor(session.messages, id("move"));
		expect(result.isError, JSON.stringify(result.content)).toBe(false);
		const { modelTransfer } = result.details as { modelTransfer: ModelTransferRecord };
		expect(modelTransfer).toMatchObject({
			sourceAgentId: agentId,
			sourceAttemptId: source.attemptId,
			taskId: source.taskId,
			targetModelRef: TARGET,
			status: "requested",
		});
		const replay = () => lanes.handOffWorkerAgent(agentId, TARGET, result.toolCallId);
		expect((await replay()).commandId).toBe(modelTransfer.commandId);
		if (sourceStatus === "running") {
			// The provider barrier keeps the source's original attempt active while the transfer owns future intake.
			expect(() =>
				lanes.followUpWorkerAgent(agentId, "A new follow-up.", { idempotencyKey: id("late-follow-up") }),
			).toThrow("is transferring its task");
			expect(() =>
				lanes.sendWorkerAgentMessage(agentId, "A fresh peer message.", { idempotencyKey: id("late-peer") }),
			).toThrow("is transferring its task");
			expect(() =>
				lanes.sendSessionRootWorkerAgentMessage(agentId, "Fresh root mail.", { idempotencyKey: id("late-root") }),
			).toThrow("is transferring its task");
		}

		sourceGate.release();
		successorGate.release();
		try {
			await wait("successor-handoff", completedWake.promise);
		} catch (error) {
			const attempts = Object.values(lanes.getTaskRuntimeSnapshot()!.attempts).map(
				({ attemptId, status, reasonCode, modelTransfer }) => ({ attemptId, status, reasonCode, modelTransfer }),
			);
			throw new Error(
				`${String(error)}; attempts ${JSON.stringify(attempts)}; warnings ${JSON.stringify(world.warnings.slice(-4))}`,
				{ cause: error },
			);
		}
		await wait("root-idle", session.waitForForegroundIdle());
		const final = await replay();
		expect(final).toMatchObject({
			commandId: modelTransfer.commandId,
			sourceAgentId: agentId,
			status: "completed",
			successorStarted: true,
			successorAgentId: modelTransfer.successorAgentId,
		});
		const state = lanes.getTaskRuntimeSnapshot()!;
		const successor = state.attempts[final.successorAttemptId]!;
		expect(state.tasks[source.taskId]?.attemptIds).toEqual([
			source.attemptId,
			...(refused ? [refused.successorAttemptId] : []),
			successor.attemptId,
		]);
		if (refused) expect(state.attempts[source.attemptId]?.modelTransferRefusals).toContainEqual(refused);
		expect(state.agents[agentId]?.status).toBe("retired");
		expect(final.successorAgentId).not.toBe(agentId);
		expect(successor.modelTransferSourceAttemptId).toBe(source.attemptId);
		expect(successor.dispatch.instructions).toBe(source.dispatch.instructions);
		expect(successor.result).toMatchObject({
			status: "partial",
			reasonCode: "worker_host_findings",
			nextAction: "parent_review",
			summary: "Verified MAX_RETRIES is 7.",
			errors: [{ code: "worker_blocker", message: expect.stringContaining("uncommitted changes") }],
		});
		expect(successor.dispatch.executionContract?.worker).toMatchObject({
			modelBinding: { provider: HARNESS_PROVIDER, modelId: "worker-b" },
			authority: source.dispatch.executionContract!.worker.authority,
		});
		expect(world.provider.requests.slice(mark).filter((request) => request.model.id === "worker-b")).toHaveLength(2);
		expect(world.io.readFileSync(LIMITS_PATH, "utf8")).toBe(ORIGINAL_LIMITS);
		world.provider.enqueue("root", delegate("status", { action: "status", agentId }), done("status-read"));
		await wait("read-source-status", session.prompt("Read the source worker’s current handoff status."));
		const status = receiptFor(session.messages, id("status"));
		expect(status.details).toMatchObject({ modelTransfer: final });
		expect(JSON.stringify(status.content)).toContain(final.successorAgentId);
		world.faultMatrix.witness("worker-model-handoff", { control: true });
		expect(await world.disposeSessionInBody(session)).toBeUndefined();
	} finally {
		sourceGate.release();
		successorGate.release();
	}
}

export async function runWorkerModelHandoffJourney(): Promise<void> {
	await runJourney(
		{
			name: "worker-model-handoff",
			journey: 11,
			warningAllowances: [...CREDENTIAL_HANDOFF_WARNINGS],
			repository: { committed: { "src/limits.ts": ORIGINAL_LIMITS, "src/evidence.txt": HISTORY } },
			files: { [LIMITS_PATH]: ORIGINAL_LIMITS, [projectPath("src", "evidence.txt")]: HISTORY },
		},
		async (world) => {
			await exercise(world, "running");
			await exercise(world, "blocked");
			await exercise(world, "blocked", true);
		},
	);
}
