/** A clean close parks a requested handoff; a fresh controller in the same process must reacquire its transcript claim. */
import { join } from "node:path";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { configFile } from "../../../../src/core/agent-paths.ts";
import { digest } from "../../../../src/core/channels/channel-journal.ts";
import { ORDINARY_WORK_CONTINUATION_TYPE } from "../../../../src/core/ordinary-work-policy.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import { workerConversationMetadataFile } from "../../../../src/kernel/session/worker-storage-identity.ts";
import { isPlainRecord } from "../../../../src/kernel/utils/value-guards.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { FakeBotApi, OWNER_ID, ownerLegUpdate, seedTelegramToken, withFakeBotApi } from "./journey-4-telegram.ts";
import { handoffBlocks, J9_ROOT_JUDGMENTS, J9_ROOT_REPLY, J9_SETTINGS, workerReport } from "./journey-9-shared.ts";
import { exerciseWorkerWaitBound } from "./journey-12-worker-wait.ts";
import { assertBatchOk, LIMITS_PATH, latestBatchResults, ORIGINAL_LIMITS, runJourney } from "./shared.ts";

const OTHER_OWNER_ID = 555000222;
const OWNER_SETTING = "export const OWNER_BACKOFF = true;\n";
const EDITED_LIMITS = ORIGINAL_LIMITS.replace(" = 3", " = 7");
const AUTH_A = "synthetic-restart-initial";
const AUTH_B = "synthetic-restart-replacement";
/** What a phone request's final answer costs: metered, since the phone session signs in with an API key. */
const LATE_ANSWER_USD = 0.25;
const LATE_ANSWER_USAGE = {
	...createEmptyUsage(),
	input: 1,
	output: 1000,
	totalTokens: 1001,
	cost: { ...createEmptyUsage().cost, output: LATE_ANSWER_USD, total: LATE_ANSWER_USD },
};

async function exerciseRestartHandoff(world: HarnessWorld, api?: FakeBotApi, change = false): Promise<void> {
	const request = change
		? "Change the retry count from 3 to 7 in src/limits.ts, land the change and report its source. Leave my other settings alone."
		: "Inspect the retry configuration and report the configured retry count.";
	const preference = "When reporting a configuration value, name its source file.";
	const answer = change
		? "The worker checkout has seven in src/limits.ts. The main checkout still has three because the phone grant ended before integration."
		: "The configured retry count in src/limits.ts is three.";
	if (api) world.authStorage.set(HARNESS_PROVIDER, { type: "api_key", key: AUTH_A });
	world.io.seed(configFile(world.agentDir, "MEMORY.md"), `${preference}\n`);
	const providerMark = world.provider.requests.length;
	const judgmentMark = world.systemOne.decoded.length;
	const stopJudgments = (disposition: "owner_needed" | "fulfilled") => ({
		disposition: { kind: "choice" as const, choice: disposition, confidence: 0.99 },
		delivered_in_answer: { kind: "noul" as const, probability: disposition === "fulfilled" ? 0.99 : 0.01 },
		evidence_sufficient: { kind: "noul" as const, probability: 0.99 },
	});
	const settings = {
		...J9_SETTINGS,
		memorySystem: "okf" as const,
		autoLearn: { enabled: false },
		worktreeSync: { enabled: true },
		modelRouter: { fitnessGate: false },
		...(api
			? {
					channels: {
						telegram: {
							mode: "explicit" as const,
							ownerSenders: [OWNER_ID, OTHER_OWNER_ID],
							ownerAuthority: "full" as const,
						},
					},
				}
			: {}),
	};
	// The request waits on its launched worker as a host fact: no stop judgment is asked while that worker runs.
	world.systemOne.enterPhase("handoff-restart", J9_ROOT_JUDGMENTS);
	const owner = await world.createRootSession("root", { settings, sessionManager: world.createSessionManager() });
	const wait = <T>(label: string, pending: Promise<T>) =>
		withDeadline(world.trace, `handoff-restart-${label}`, pending);
	const reached = createBarrier();
	const gate = createBarrier();
	const complete = createBarrier();
	const successorGate = createBarrier();
	const maintenanceWake = createBarrier();
	let maintenanceLane: string | undefined;
	const target = `${HARNESS_PROVIDER}/worker-b`;
	const expectRootTools = ({ context }: ScriptedRequest): void => {
		const tools = context.tools?.map(({ name }) => name);
		expect(tools).toContain("delegate");
		expect(tools).toContain("memory");
		expect(context.systemPrompt).toContain(preference);
	};
	world.provider.enqueue(
		"root",
		{
			...calls("restart-start", [
				{
					id: "start-restart-worker",
					name: "delegate",
					arguments: {
						action: "start",
						model: "worker-a",
						instructions: change
							? "Change MAX_RETRIES in limits.ts from 3 to 7."
							: "Read limits.ts and report the configured retry count.",
						path: "src",
						...(change ? { writePaths: ["src/limits.ts"] } : { readOnly: true }),
					},
				},
			]),
			check: expectRootTools,
		},
		{ ...text("restart-accepted", J9_ROOT_REPLY), check: expectRootTools },
	);
	if (change) {
		world.provider.enqueue(
			"worker-a",
			calls("restart-denied-adjacent-edit", [
				{
					id: "denied-adjacent",
					name: "edit",
					arguments: { path: "../owner-settings.ts", edits: [{ oldText: "true", newText: "false" }] },
				},
			]),
			{
				...calls("restart-source-edit", [
					{
						id: "allowed-retry-edit",
						name: "edit",
						arguments: { path: "limits.ts", edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 7" }] },
					},
				]),
				check: (request) =>
					expect(latestBatchResults(request), JSON.stringify(latestBatchResults(request))).toContainEqual({
						toolName: "edit",
						isError: true,
						text: expect.stringContaining("A worker writes only inside its working directory"),
					}),
			},
		);
	}
	world.provider.enqueue("worker-a", {
		...text("restart-parked", "Still inspecting."),
		gate: gate.promise,
		check: (request) => {
			if (change) {
				assertBatchOk(request, "restart-source-edit");
				expect(request.options?.apiKey).toBe(AUTH_A);
			}
			reached.release();
		},
	});
	let disposed = false;
	let reopened: typeof owner | undefined;
	try {
		if (api) {
			await wait("owner-poll", api.nextPoll(undefined));
			api.deliver(ownerLegUpdate(1, OWNER_ID, request));
			await wait("owner-acknowledgement", api.untilSent(1));
			expect(api.sent[0]?.body).toMatchObject({ chat_id: String(OWNER_ID), text: J9_ROOT_REPLY });
			await wait("owner-idle", owner.session.waitForForegroundIdle());
		} else await wait("start", owner.session.prompt(request));
		await wait("source-running", reached.promise);
		const records = () =>
			owner.session.getDecisionLedger()!.ordinaryWork.forSession(owner.sessionManager.getSessionId());
		expect(records()).toHaveLength(1);
		const opening = records()[0]!;
		expect(opening).toMatchObject({ status: "waiting", reason: "waiting", continuationCount: 0 });
		expect((await owner.session.autonomyStatus()).ordinaryWork).toMatchObject({
			status: "available",
			value: { state: opening.status, continuationsUsed: 0, continuationLimit: 3 },
		});
		const lanes = owner.session.backgroundLanes;
		const snapshot = lanes.getTaskRuntimeSnapshot()!;
		const source = Object.values(snapshot.attempts)[0]!;
		const agentId = source.agentId!;
		const cwd = source.dispatch.executionContract?.worker.authority.cwd;
		if (change) {
			expect(cwd).toBeTruthy();
			expect(world.io.readFileSync(join(cwd!, "limits.ts"), "utf8")).toBe(EDITED_LIMITS);
			expect(world.io.readFileSync(join(cwd!, "..", "owner-settings.ts"), "utf8")).toBe(OWNER_SETTING);
			expect(world.io.readFileSync(LIMITS_PATH, "utf8")).toBe(ORIGINAL_LIMITS);
		}
		const file = owner.sessionManager.getSessionFile()!;
		const transcript = workerConversationMetadataFile(snapshot.agents[agentId]!.resumeContext.sessionFile!);
		const ownership = () => JSON.parse(String(world.io.readFileSync(transcript, "utf8"))).projectContext.ownership;
		expect(ownership().state).toBe("busy");
		const transfer = await wait("request", lanes.handOffWorkerAgent(agentId, target, "restart-transfer"));
		expect(transfer.status).toBe("requested");
		expect(
			await wait("close", world.disposeSessionInBody(owner.session, { ordinaryWork: "preserve" })),
		).toBeUndefined();
		disposed = true;
		expect(ownership().state).toBe("handoff");
		world.faultMatrix.witness("restart-model-handoff", { control: false });
		if (api) world.authStorage.set(HARNESS_PROVIDER, { type: "api_key", key: AUTH_B });

		world.provider.enqueue(
			"worker-b",
			{
				name: "restart-successor-read",
				gate: successorGate.promise,
				reply: {
					content: [
						{
							type: "toolCall",
							id: "restart-successor-read",
							name: "read",
							arguments: { path: change ? "limits.ts" : LIMITS_PATH },
						},
					],
					stopReason: "toolUse",
					...(change
						? {
								usage: {
									...createEmptyUsage(),
									input: 1,
									output: 1000,
									totalTokens: 1001,
									cost: { ...createEmptyUsage().cost, output: 0.06, total: 0.06 },
								},
							}
						: {}),
				},
			},
			{
				...workerReport("restart-successor", {
					status: "completed",
					summary: change ? "The retry count in my worker checkout is seven in src/limits.ts." : answer,
				}),
				check: (transport) =>
					expect(latestBatchResults(transport)).toContainEqual({
						toolName: "read",
						isError: false,
						text: expect.stringContaining((change ? EDITED_LIMITS : ORIGINAL_LIMITS).trim()),
					}),
			},
		);
		const hasSuccessorHandoff = (request: ScriptedRequest): boolean => {
			const successor =
				reopened?.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[transfer.successorAttemptId];
			const lane = reopened?.session.backgroundLanes
				.getLaneRecords()
				.find((entry) => entry.attemptId === transfer.successorAttemptId);
			return Boolean(
				successor?.result &&
					lane &&
					handoffBlocks(request).some((block) => block.header.startsWith(`- ${lane.laneId}:`)),
			);
		};
		world.provider.enqueue("root", {
			...text("restart-wake", J9_ROOT_REPLY),
			check: (transport) => {
				expectRootTools(transport);
				if (
					maintenanceLane &&
					handoffBlocks(transport).some((block) => block.header.startsWith(`- ${maintenanceLane}:`))
				)
					maintenanceWake.release();
				if (!change && hasSuccessorHandoff(transport))
					world.systemOne.enterPhase("ordinary-stop-restart-delivered", stopJudgments("fulfilled"));
			},
			reply: (transport) => {
				if (change && hasSuccessorHandoff(transport))
					return {
						content: [
							{
								type: "toolCall",
								id: "restart-integrate",
								name: "edit",
								arguments: {
									path: LIMITS_PATH,
									edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 7" }],
								},
							},
						],
						stopReason: "toolUse",
					};
				if (!hasSuccessorHandoff(transport)) return { content: [{ type: "text", text: J9_ROOT_REPLY }] };
				// The phone chat's batch was answered by the acknowledgement; this final answer's cost joins it when it is sent.
				return { content: [{ type: "text", text: answer }], ...(api ? { usage: LATE_ANSWER_USAGE } : {}) };
			},
			until: (request) => {
				if (!hasSuccessorHandoff(request)) return false;
				if (!change) complete.release();
				return true;
			},
		});
		if (change)
			world.provider.enqueue("root", {
				...text("restart-integration-requires-owner", answer),
				check: (request) => {
					expect(latestBatchResults(request), JSON.stringify(latestBatchResults(request))).toEqual([
						{
							toolName: "edit",
							isError: true,
							text: expect.stringContaining("the phone owner's authority ended"),
						},
					]);
					expect(world.io.readFileSync(LIMITS_PATH, "utf8")).toBe(ORIGINAL_LIMITS);
					expect(world.io.readFileSync(projectPath("owner-settings.ts"), "utf8")).toBe(OWNER_SETTING);
					world.systemOne.enterPhase("ordinary-stop-restart-owner-needed", stopJudgments("owner_needed"));
					complete.release();
				},
			});
		reopened = await world.createRootSession("root", { settings, sessionManager: world.openSessionManager(file) });
		const restoredRows = () =>
			reopened!.session.getDecisionLedger()!.ordinaryWork.forSession(reopened!.sessionManager.getSessionId());
		expect(restoredRows()).toHaveLength(1);
		expect(restoredRows()[0]).toMatchObject({
			sessionId: opening.sessionId,
			openingEntryId: opening.openingEntryId,
			status: opening.status,
			continuationCount: 0,
		});
		reopened.session.restoreOrdinaryWorkAfterResume();
		expect((await reopened.session.autonomyStatus()).ordinaryWork).toMatchObject({
			status: "available",
			value: { continuationsUsed: 0, continuationLimit: 3 },
		});
		const fresh = reopened.session.backgroundLanes;
		if (change) {
			const maintenanceGate = createBarrier();
			world.provider.enqueue("worker-c", {
				...workerReport("restart-maintenance-report", {
					status: "completed",
					summary: "The independent inventory finished.",
				}),
				gate: maintenanceGate.promise,
			});
			try {
				const independent = await wait(
					"independent-start",
					fresh.startWorkerDelegation({
						instructions: "Complete an independent inventory, unrelated to the retry edit.",
						objectiveId: null,
						authority: { model: { provider: HARNESS_PROVIDER, modelId: "worker-c" }, readOnly: true },
					}),
				);
				if (!independent.started) throw new Error(`Independent inventory was refused: ${independent.skipReason}`);
				maintenanceLane = independent.record.laneId;
				expect(fresh.getTaskRuntimeSnapshot()!.attempts[independent.record.attemptId!]!.taskId).not.toBe(
					source.taskId,
				);
				maintenanceGate.release();
				await wait("independent-handoff", maintenanceWake.promise);
				await wait("independent-idle", reopened.session.waitForForegroundIdle());
				expect(fresh.getTaskRuntimeSnapshot()!.attempts[independent.record.attemptId!]!.result).toMatchObject({
					summary: "The independent inventory finished.",
					usage: { costUsd: 0 },
				});
				expect(fresh.getTaskRuntimeSnapshot()!.attempts[transfer.successorAttemptId]?.result).toBeUndefined();
				expect(restoredRows()).toHaveLength(1);
				expect(restoredRows()[0]).toMatchObject({
					openingEntryId: opening.openingEntryId,
					status: opening.status,
					continuationCount: 0,
				});
			} finally {
				maintenanceGate.release();
			}
		}
		expect((await fresh.handOffWorkerAgent(agentId, target, transfer.commandId)).commandId).toBe(transfer.commandId);
		successorGate.release();
		await wait("successor", complete.promise);
		await wait("root-idle", reopened.session.waitForForegroundIdle());
		if (api) {
			// The acknowledgement left the request waiting on its worker; its final answer follows to the same chat.
			const isAnswer = (item: (typeof api.sent)[number]) => item.body.text === answer;
			const lateAnswer = async () => {
				while (!api.sent.some(isAnswer)) await api.nextSend();
			};
			await wait("owner-late-answer", lateAnswer());
			expect(api.sent.filter(isAnswer).map((item) => item.body)).toEqual([
				expect.objectContaining({ chat_id: String(OWNER_ID), text: answer }),
			]);
			const journal = JSON.parse(
				String(world.io.readFileSync(join(world.agentDir, "channels", "telegram.json"))),
			) as {
				batches: { eventDigests: string[]; state: string; usd?: number; lateAnswerAfter?: string }[];
			};
			const batch = journal.batches.filter((item) => item.eventDigests.includes(digest("tg:1")));
			expect(batch, "the request's batch is answered and owes the chat nothing more").toEqual([
				expect.objectContaining({ state: "replied" }),
			]);
			expect(batch[0]?.lateAnswerAfter).toBeUndefined();
			expect(batch[0]?.usd ?? 0, "the late answer's metered cost is charged to the request's batch").toBeCloseTo(
				change ? 0 : LATE_ANSWER_USD,
				9,
			);
		}
		const finished = fresh.getTaskRuntimeSnapshot()!;
		expect(finished.attempts[source.attemptId]).toMatchObject({
			status: "cancelled",
			reasonCode: "worker_model_transfer",
			modelTransfer: { status: "completed", successorStarted: true },
		});
		expect(finished.tasks[source.taskId]?.attemptIds).toEqual([source.attemptId, transfer.successorAttemptId]);
		expect(finished.agents[agentId]?.status).toBe("retired");
		expect(finished.attempts[transfer.successorAttemptId]?.agentId).toBe(transfer.successorAgentId);
		const settledState = world.systemOne.enabled ? (change ? "owner_needed" : "fulfilled") : "unverified";
		expect(restoredRows()).toHaveLength(1);
		expect(restoredRows()[0]).toMatchObject({
			sessionId: opening.sessionId,
			openingEntryId: opening.openingEntryId,
			status: settledState,
			continuationCount: 0,
		});
		expect((await reopened.session.autonomyStatus()).ordinaryWork).toMatchObject({
			status: "available",
			value: { state: settledState, continuationsUsed: 0 },
		});
		const entries = reopened.sessionManager.getBranch();
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(
			entries.filter(
				(entry) => entry.type === "custom_message" && entry.customType === ORDINARY_WORK_CONTINUATION_TYPE,
			),
		).toEqual([]);
		const delivered = entries.flatMap((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== "background-worker-completion") return [];
			const details = parentInputOriginalDetails(entry) ?? entry.details;
			return isPlainRecord(details) && Array.isArray(details.records)
				? details.records.filter(
						(record) => isPlainRecord(record) && record.attemptId === transfer.successorAttemptId,
					)
				: [];
		});
		expect(delivered).toHaveLength(1);
		expect(world.provider.reached.filter((name) => name === "worker-b:restart-successor")).toHaveLength(1);
		expect(world.provider.reached.filter((name) => name === "worker-b:restart-successor-read")).toHaveLength(1);
		const physical = world.provider.requests.slice(providerMark);
		expect(
			physical.every((item) => item.model.provider === HARNESS_PROVIDER && item.model.costDefaulted !== true),
		).toBe(true);
		expect(physical.filter((item) => item.model.id === "worker-b")).toHaveLength(2);
		if (api) {
			expect(physical.filter((item) => item.model.id === "worker-b").map((item) => item.options?.apiKey)).toEqual([
				AUTH_B,
				AUTH_B,
			]);
			expect(finished.attempts[transfer.successorAttemptId]?.dispatch.executionContract?.worker.authority).toEqual(
				source.dispatch.executionContract?.worker.authority,
			);
		}
		expect(reopened.session.getLastAssistantText()).toBe(answer);
		expect(finished.attempts[transfer.successorAttemptId]?.result?.usage).toMatchObject({
			costUsd: change ? 0.06 : 0,
		});
		if (change) {
			expect(finished.attempts[transfer.successorAttemptId]?.result).toMatchObject({
				status: "partial",
				reasonCode: "worker_host_findings",
				nextAction: "parent_review",
				usage: { inputTokens: 17, outputTokens: 1008, totalTokens: 1025, toolCalls: 1 },
			});
		} else expect(finished.attempts[transfer.successorAttemptId]!.result!.usage.totalTokens).toBeGreaterThan(0);
		const reviews = world.systemOne.decoded.slice(judgmentMark).filter((item) => "disposition" in item.questions);
		if (world.systemOne.enabled) {
			expect(reviews.length).toBeGreaterThanOrEqual(1);
			const adjudicatedRequest = api ? expect.stringContaining(request) : request;
			// No stop judgment is asked while the launched worker, then its successor, still runs.
			expect(reviews.map((item) => (item.state as { answer?: unknown }).answer)).not.toContain(J9_ROOT_REPLY);
			expect(reviews.at(-1)?.state).toMatchObject({
				request: adjudicatedRequest,
				answer,
				hostFacts: {
					terminalStopReason: "stop",
					finalAnswerPresent: true,
					foregroundCallsSettled: true,
					pendingBackgroundWork: "workers_reported",
				},
			});
		} else expect(reviews).toEqual([]);

		if (api) {
			const beforeControls = {
				sends: api.sent.length,
				requests: world.provider.requests.length,
				rows: restoredRows(),
				attempts: Object.keys(finished.attempts),
			};
			api.offsets.length = 0;
			const replayAcknowledged = api.nextPoll(2);
			api.deliver(ownerLegUpdate(1, OWNER_ID, request));
			await wait("replayed-update", replayAcknowledged);
			await wait("replayed-idle", reopened.session.waitForForegroundIdle());
			expect(api.sent).toHaveLength(beforeControls.sends);
			const privateFragments = [
				request,
				answer,
				preference,
				LIMITS_PATH,
				"src/limits.ts",
				"limits.ts",
				ORIGINAL_LIMITS.trim(),
				opening.openingEntryId,
				source.attemptId,
				transfer.successorAttemptId,
			];
			const baseStatus = [
				`Foreground owner turns and task commands have spent or reserved $${(change ? 0 : LATE_ANSWER_USD).toFixed(2)} of $5.00 in 24 hours ($1.00 per turn).`,
				"No turn is running. 0 message(s) wait.",
			];
			const lifecycle = world.systemOne.enabled
				? change
					? ["Request needs owner input.", "Progress requires an owner decision, information or authority."]
					: ["Request fulfilled.", "The requested deliverable is present."]
				: ["Request remains open; automatic continuation is held.", "The stop judge is unavailable."];
			const ownerSendMark = api.sent.length;
			api.deliver(ownerLegUpdate(2, OWNER_ID, "status"));
			await wait("owner-status", api.untilSent(ownerSendMark + 1));
			const ownerStatus = api.sent.at(-1)!;
			const projectNotice =
				"Waiting on you in project: A worker is waiting for your decision: the result is unverified and no independent verifier is placed automatically; verify it or accept it";
			expect(ownerStatus.body).toEqual({
				chat_id: String(OWNER_ID),
				text: [
					...baseStatus,
					"Task state recorded in this session",
					...lifecycle,
					"Automatic continuations: 0/3 spent.",
					"No held action from this chat.",
					...(change ? [projectNotice] : []),
				].join("\n"),
			});
			const otherSendMark = api.sent.length;
			api.deliver(ownerLegUpdate(3, OTHER_OWNER_ID, "status"));
			await wait("other-owner-status", api.untilSent(otherSendMark + 1));
			await wait("status-idle", reopened.session.waitForForegroundIdle());
			const otherStatus = api.sent.at(-1)!;
			expect(otherStatus.body).toEqual({
				chat_id: String(OTHER_OWNER_ID),
				text: [...baseStatus, "No held action from this chat.", ...(change ? [projectNotice] : [])].join("\n"),
			});
			for (const status of [ownerStatus, otherStatus])
				for (const fragment of privateFragments) expect(String(status.body.text)).not.toContain(fragment);
			expect(api.sent).toHaveLength(beforeControls.sends + 2);
			expect(world.provider.requests).toHaveLength(beforeControls.requests);
			expect(restoredRows()).toEqual(beforeControls.rows);
			expect(Object.keys(fresh.getTaskRuntimeSnapshot()!.attempts)).toEqual(beforeControls.attempts);
			expect(
				reopened.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(1);
			if (!change) {
				await wait(
					"close-settled-session",
					world.disposeSessionInBody(reopened.session, { ordinaryWork: "preserve" }),
				);
				reopened = undefined;
				api.offsets.length = 0;
				const nextPoll = api.nextPoll(undefined);
				reopened = await world.createRootSession("root", {
					settings,
					sessionManager: world.openSessionManager(file),
				});
				await wait("fresh-session-poll", nextPoll);
				for (const [updateId, sender, expected] of [
					[4, OWNER_ID, ownerStatus],
					[5, OTHER_OWNER_ID, otherStatus],
				] as const) {
					const mark = api.sent.length;
					api.deliver(ownerLegUpdate(updateId, sender, "status"));
					await wait("fresh-session-status", api.untilSent(mark + 1));
					expect(api.sent.at(-1)?.body).toEqual(expected.body);
				}
				expect(world.provider.requests).toHaveLength(beforeControls.requests);
				expect(restoredRows()).toEqual(beforeControls.rows);
				expect(
					reopened.sessionManager
						.getBranch()
						.filter((entry) => entry.type === "message" && entry.message.role === "user"),
				).toHaveLength(1);
			}
			expect(api.violations).toEqual([]);
		}
		world.faultMatrix.witness("restart-model-handoff", { control: true });
	} finally {
		successorGate.release();
		gate.release();
		if (!disposed) await world.disposeSessionInBody(owner.session);
		if (reopened) expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
	}
}

export async function runWorkerModelHandoffRecovery(): Promise<void> {
	for (const route of ["terminal", "channel", "channel-edit"] as const) {
		const ownerChannel = route !== "terminal";
		const change = route === "channel-edit";
		await runJourney(
			{
				name: change
					? "worker-edit-owner-channel-restart"
					: ownerChannel
						? "worker-model-handoff-owner-channel-restart"
						: "worker-model-handoff-restart",
				journey: 12,
				...(change
					? { modelOptions: { "worker-b": { cost: { input: 0, output: 60, cacheRead: 0, cacheWrite: 0 } } } }
					: {}),
				repository: { committed: { "src/limits.ts": ORIGINAL_LIMITS, "owner-settings.ts": OWNER_SETTING } },
				files: { [LIMITS_PATH]: ORIGINAL_LIMITS, [projectPath("owner-settings.ts")]: OWNER_SETTING },
			},
			async (world) => {
				if (!ownerChannel) {
					await exerciseRestartHandoff(world);
					return exerciseWorkerWaitBound(world);
				}
				seedTelegramToken(world, world.agentDir);
				const file = join(world.agentDir, "channels", "telegram.json");
				const api = new FakeBotApi(() =>
					world.io.existsSync(file)
						? (JSON.parse(String(world.io.readFileSync(file))) as { seen: { d: string }[] }).seen.map(
								(entry) => entry.d,
							)
						: [],
				);
				await withFakeBotApi(world, api, () => exerciseRestartHandoff(world, api, change));
				const journal = JSON.parse(String(world.io.readFileSync(file))) as { seen: { d: string }[] };
				expect(journal.seen.filter((entry) => entry.d === digest("tg:1"))).toHaveLength(1);
			},
		);
	}
}
