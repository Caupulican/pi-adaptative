import { expect } from "vitest";
import type { KnowledgeGrantReference } from "../../../../src/core/memory/knowledge-grant.ts";
import { KNOWLEDGE_CONTEXT_CLEARED } from "../../../../src/core/memory/knowledge-projection.ts";
import { type KnowledgeRecord, knowledgeId } from "../../../../src/core/memory/knowledge-record.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { runJourney1KnowledgeManagedLeg } from "./journey-1-knowledge-managed.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, latestBatchResults, startedIdentity } from "./shared.ts";

/** Existing journey 1: exact task grants, current request projection, broker reads and revocation. */
export async function runJourney1KnowledgeWorkersPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-knowledge-workers`;
	const profiles = new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false });
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "knowledge-reader",
		description: "Read-only task-scoped knowledge reader.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "memory.query"],
		readOnly: true,
		toolNames: ["read", "memory_read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	profiles.save(profile, "global");
	profiles.save(
		{
			...profile,
			profileId: "knowledge-queued-reader",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: "harness-script", modelId: "worker-b", thinkingLevel: "off" }],
			},
		},
		"global",
	);
	profiles.save(
		{ ...profile, profileId: "knowledge-no-memory", capabilityCeiling: ["filesystem.read"], toolNames: ["read"] },
		"global",
	);
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: icmContinuousSettings("worker-c", { autoLearn: { enabled: false }, proactivity: { enabled: false } }),
	});
	const store = KnowledgeStore.open(agentDir);
	const evidenceTime = Date.now() - 3_000;
	const at = new Date(evidenceTime).toISOString();
	const correctionAt = new Date(evidenceTime + 1_000).toISOString();
	const forgettingAt = new Date(evidenceTime + 2_000).toISOString();
	const record = (key: string, value: string, kind: KnowledgeRecord["kind"] = "behavior"): KnowledgeRecord => {
		const identity = {
			kind,
			scope: { project: "", role: "", audience: "owner" },
			subject: "owner",
			key,
		};
		return {
			...identity,
			id: knowledgeId(identity),
			revision: 1,
			text: value,
			basis: "explicit",
			firstEvidencedAt: at,
			lastEvidencedAt: at,
			validFrom: at,
			citations: [{ sourceId: `fixture-${key}`, sessionId: root.session.sessionId, quote: value, at }],
		};
	};
	const selected = record("project-formatting", "Formats project examples with tabs.");
	const privateRecord = record("private-appointments", "Keeps unrelated appointment notes in a blue notebook.");
	// Seed accepted history through the canonical store; admission is exercised by the preceding knowledge phase.
	store.put(selected, 0, () => {});
	store.put(privateRecord, 0, () => {});
	const tracks: string[] = [];
	for (let size = 1; size <= 64; size *= 2)
		for (let first = 0; first + size <= 64; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const name = `knowledge-worker-compaction-${first}+${size}`;
			tracks.push(name);
			world.provider.enqueueTrack(
				name,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					name,
					optional: true,
					reply: {
						content: [
							{ type: "text", text: "Task grant requests and outcomes; consult original turns for details." },
						],
					},
				},
			);
		}
	const currentProjection = (request: ScriptedRequest): string =>
		request.context.messages
			.filter((message) => message.role === "user")
			.map((message) => JSON.stringify(message.content))
			.filter(
				(content) => content.includes("Current accepted knowledge,") || content.includes(KNOWLEDGE_CONTEXT_CLEARED),
			)
			.at(-1) ?? "";
	const report = (id: string) =>
		calls(id, [
			{
				id,
				name: "submit_report",
				arguments: { status: "completed", summary: "The task-scoped view was inspected." },
			},
		]);
	let agentId: string | undefined;
	let prompt: Promise<void> | undefined;
	let held: ReturnType<typeof createBarrier> | undefined;
	const run = async (
		label: string,
		references: readonly KnowledgeGrantReference[] | undefined,
		value?: string,
		change?: () => void,
	) => {
		const reached = createBarrier();
		const waiting = createBarrier();
		const release = createBarrier();
		held = release;
		world.systemOne.enterPhase(label, ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls(`${label}-start`, [
				{
					id: `${label}-start`,
					name: "delegate",
					arguments: {
						action: "start",
						...(agentId ? { agentId } : { profileId: profile.profileId }),
						instructions:
							"Inspect only the current task's selected knowledge through memory, then submit a report.",
						...(references ? { knowledge: references } : {}),
					},
				},
			]),
			{
				name: `${label}-wait`,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					// The start's own answer names the reader: the attempt reaches `running` on a later turn than the tool returns.
					agentId = startedIdentity(root.session, `${label}-start`).agentId;
					expect(agentId, "the real dispatch binds the reader").toBeDefined();
					waiting.release();
				},
				reply: () => ({
					content: [
						{
							type: "toolCall",
							id: `${label}-wait`,
							name: "delegate",
							arguments: { action: "wait", agentId, timeoutMs: 60_000 },
						},
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: `${label}-done`,
				check: (request) => {
					expect(latestBatchResults(request).find((entry) => entry.toolName === "delegate")?.isError).toBe(false);
				},
				reply: { content: [{ type: "text", text: "The reader has finished." }] },
			},
		);
		world.provider.enqueue("worker-a", {
			name: `${label}-first`,
			check: (request) => {
				const projection = currentProjection(request);
				expect(JSON.stringify(request.context)).not.toContain(privateRecord.text);
				expect(request.context.tools?.map((tool) => tool.name)).not.toContain("knowledge");
				expect(
					request.context.tools?.map((tool) => tool.name),
					"the reader retains its admitted memory tool",
				).toContain("memory_read");
				if (value) {
					if (root.settingsManager.getMemoryRetrievalSettings().includeInPrompt) {
						expect(projection).toContain(value);
						expect(projection, "an owner with no taste sees no taste wording").not.toContain("Taste records are");
					} else {
						expect(projection).toContain(KNOWLEDGE_CONTEXT_CLEARED);
						expect(projection).not.toContain(value);
					}
				} else {
					expect(projection).not.toContain(selected.text);
					expect(projection, "an owner with no taste and no selection sees the cleared notice").toContain(
						KNOWLEDGE_CONTEXT_CLEARED,
					);
					expect(projection).not.toContain("Current accepted knowledge,");
					reached.release();
				}
			},
			...(value ? {} : { gate: release.promise }),
			reply: value
				? calls(`${label}-read`, [
						{ id: `${label}-read`, name: "memory_read", arguments: { query: "project formatting" } },
					]).reply
				: report(`${label}-report`).reply,
		});
		if (value)
			world.provider.enqueue(
				"worker-a",
				{
					name: `${label}-broker`,
					check: (request) => {
						expect(JSON.stringify(request.context)).not.toContain(privateRecord.text);
						const read = latestBatchResults(request).find((entry) => entry.toolName === "memory_read");
						expect(read?.isError, read?.text).toBe(false);
						expect(read?.text).toContain(value);
						expect(read?.text).not.toContain(privateRecord.text);
						reached.release();
					},
					gate: release.promise,
					reply: calls(`${label}-read-current`, [
						{ id: `${label}-read-current`, name: "memory_read", arguments: { query: "project formatting" } },
					]).reply,
				},
				{
					name: `${label}-revoked`,
					check: (request) => {
						const projection = currentProjection(request);
						expect(projection, "revocation still publishes current knowledge status").not.toBe("");
						expect(projection).not.toContain(value);
						expect(projection).not.toContain("Formats project examples with spaces.");
						expect(JSON.stringify(request.context)).not.toContain(privateRecord.text);
						const read = latestBatchResults(request)
							.filter((entry) => entry.toolName === "memory_read")
							.at(-1);
						expect(read?.text).not.toContain(value);
					},
					reply: report(`${label}-report`).reply,
				},
			);
		prompt = root.session.prompt(`Run the ${label} reader task.`);
		await withDeadline(world.trace, `${label} worker reached`, reached.promise);
		await withDeadline(world.trace, `${label} parent waits`, waiting.promise);
		expect(
			Object.values(root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
				(attempt) => attempt.status === "running",
			)?.agentId,
			"the running attempt is bound to the reader the start named",
		).toBe(agentId);
		change?.();
		release.release();
		await withDeadline(world.trace, `${label} parent completed`, prompt);
		prompt = undefined;
		held = undefined;
	};
	const runQueued = async (change: "correct" | "forget") => {
		const label = `knowledge-queued-${change}`;
		const queuedRecord = record(label, `Prefers ${change} fixture examples with tabs.`);
		const replacement = `Prefers ${change} fixture examples with spaces.`;
		const references = [{ id: queuedRecord.id, revision: 1 }];
		store.put(queuedRecord, 0, () => {});
		const queued = createBarrier();
		const release = createBarrier();
		held = release;
		let attemptId: string | undefined;
		let queuedAgentId: string | undefined;
		const before = world.provider.requests.filter((request) => request.model.id === "worker-b").length;
		world.systemOne.enterPhase(label, ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls(`${label}-blocker`, [
				{
					id: `${label}-blocker`,
					name: "delegate",
					arguments: {
						action: "start",
						agentId,
						instructions: "Hold the worker slot until released, then report.",
					},
				},
			]),
			{
				name: `${label}-enqueue`,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					// The start answers once the blocker's turn is durably accepted and admitted; it reaches `running` on a later turn.
					const blocker = startedIdentity(root.session, `${label}-blocker`);
					expect(
						Object.values(root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
							.filter((attempt) => attempt.taskId === blocker.laneId)
							.map((attempt) => ["queued", "leased", "running"].includes(attempt.status)),
						"the blocker's turn is durably accepted, ahead of the selected task, before that task is started",
					).toEqual([true]);
				},
				reply: calls(`${label}-start`, [
					{
						id: `${label}-start`,
						name: "delegate",
						arguments: {
							action: "start",
							profileId: "knowledge-queued-reader",
							instructions: `Inspect the ${change} fixture preference through memory and report.`,
							knowledge: references,
							parallelWork: {
								independentOf: [agentId],
								justification: "This reader needs its own task context after the occupied slot is released.",
							},
						},
					},
				]).reply,
			},
			{
				name: `${label}-queued`,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					const attempt = Object.values(
						root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {},
					).find((candidate) =>
						candidate.dispatch.knowledgeReferences?.some((reference) => reference.id === queuedRecord.id),
					);
					expect(attempt?.status, "the selected task is durably queued before the knowledge changes").toBe(
						"queued",
					);
					expect(attempt?.dispatch.knowledgeReferences).toEqual(references);
					attemptId = attempt?.attemptId;
					queuedAgentId = attempt?.agentId ?? attempt?.dispatch.logicalLaneId ?? attempt?.taskId;
					expect(queuedAgentId).toBeDefined();
					expect(world.provider.requests.filter((entry) => entry.model.id === "worker-b")).toHaveLength(before);
					queued.release();
				},
				reply: () => ({
					content: [
						{
							type: "toolCall",
							id: `${label}-wait`,
							name: "delegate",
							arguments: { action: "wait", agentId: queuedAgentId, timeoutMs: 60_000 },
						},
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: `${label}-done`,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
				},
				reply: { content: [{ type: "text", text: "The queued reader completed." }] },
			},
		);
		world.provider.enqueue("worker-a", {
			name: `${label}-hold`,
			gate: release.promise,
			reply: report(`${label}-blocker-report`).reply,
		});
		world.provider.enqueue(
			"worker-b",
			{
				name: `${label}-resumed`,
				check: (request) => {
					const projection = currentProjection(request);
					expect(projection, "queued resumption publishes a current knowledge status").not.toBe("");
					for (const text of [queuedRecord.text, replacement, privateRecord.text])
						expect(JSON.stringify(request.context)).not.toContain(text);
				},
				reply: calls(`${label}-read`, [
					{ id: `${label}-read`, name: "memory_read", arguments: { query: `${change} fixture preference` } },
				]).reply,
			},
			{
				name: `${label}-read-current`,
				check: (request) => {
					const read = latestBatchResults(request).find((entry) => entry.toolName === "memory_read");
					expect(read?.isError, read?.text).toBe(false);
					expect(read?.text).toBeTruthy();
					for (const text of [queuedRecord.text, replacement, privateRecord.text])
						expect(read?.text).not.toContain(text);
					expect(currentProjection(request)).not.toBe("");
				},
				reply: report(`${label}-report`).reply,
			},
		);
		prompt = root.session.prompt(`Queue the ${change} fixture reader behind the held worker.`);
		await withDeadline(world.trace, `${label} durable queue reached`, queued.promise);
		const citation = {
			sourceId: `${label}-change`,
			sessionId: root.session.sessionId,
			quote: change === "correct" ? replacement : "Forget this fixture preference.",
			at: correctionAt,
		};
		if (change === "correct")
			store.put(
				{
					...queuedRecord,
					revision: 2,
					text: replacement,
					lastEvidencedAt: correctionAt,
					validFrom: correctionAt,
					citations: [citation],
				},
				1,
				() => {},
			);
		else store.forget(queuedRecord.id, 1, [citation], () => {});
		release.release();
		await withDeadline(world.trace, `${label} parent completed`, prompt);
		const persisted = Object.values(root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
			(attempt) => attempt.attemptId === attemptId,
		);
		expect(
			persisted?.dispatch.knowledgeReferences,
			"dispatch keeps its original exact selection after resumption",
		).toEqual(references);
		expect(persisted?.status, "resumption completes the originally admitted attempt").toBe("completed");
		expect(world.provider.requests.filter((request) => request.model.id === "worker-b")).toHaveLength(before + 2);
		prompt = undefined;
		held = undefined;
	};
	/** One worker on `profileId` whose first request is inspected; every start and wait is scripted like `run`. */
	const runTasteView = async (
		label: string,
		profileId: string,
		references: readonly KnowledgeGrantReference[] | undefined,
		inspect: (request: ScriptedRequest) => void,
	) => {
		let viewAgentId: string | undefined;
		world.systemOne.enterPhase(label, ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls(`${label}-start`, [
				{
					id: `${label}-start`,
					name: "delegate",
					arguments: {
						action: "start",
						profileId,
						instructions: "Inspect your knowledge view, then submit a report.",
						...(references ? { knowledge: references } : {}),
					},
				},
			]),
			{
				name: `${label}-wait`,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					viewAgentId = startedIdentity(root.session, `${label}-start`).agentId;
				},
				reply: () => ({
					content: [
						{
							type: "toolCall",
							id: `${label}-wait`,
							name: "delegate",
							arguments: { action: "wait", agentId: viewAgentId, timeoutMs: 60_000 },
						},
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: `${label}-done`,
				check: (request) => {
					expect(latestBatchResults(request).find((entry) => entry.toolName === "delegate")?.isError).toBe(false);
				},
				reply: { content: [{ type: "text", text: "The reader has finished." }] },
			},
		);
		world.provider.enqueue("worker-a", {
			name: `${label}-first`,
			check: inspect,
			reply: report(`${label}-report`).reply,
		});
		await withDeadline(world.trace, `${label} completed`, root.session.prompt(`Run the ${label} reader task.`));
	};
	try {
		await run("knowledge-no-selection", undefined);
		root.settingsManager.setMemoryRetrievalSettings({ enabled: true, includeInPrompt: false });
		await run("knowledge-selected-revision", [{ id: selected.id, revision: 1 }], selected.text, () => {
			const text = "Formats project examples with spaces.";
			store.put(
				{
					...selected,
					revision: 2,
					text,
					lastEvidencedAt: correctionAt,
					validFrom: correctionAt,
					citations: [
						{
							sourceId: "fixture-formatting-correction",
							sessionId: root.session.sessionId,
							quote: text,
							at: correctionAt,
						},
					],
				},
				1,
				() => {},
			);
		});
		expect(store.get(selected.id)?.revision).toBe(2);
		root.settingsManager.setMemoryRetrievalSettings({ enabled: true, includeInPrompt: true });
		await run(
			"knowledge-forgotten-selection",
			[{ id: selected.id, revision: 2 }],
			"Formats project examples with spaces.",
			() => {
				store.forget(
					selected.id,
					2,
					[
						{
							sourceId: "fixture-formatting-forget",
							sessionId: root.session.sessionId,
							quote: "Forget the formatting preference.",
							at: forgettingAt,
						},
					],
					() => {},
				);
			},
		);
		await run("knowledge-next-task-empty", undefined);
		expect(store.get(selected.id)).toBeUndefined();
		expect(store.get(privateRecord.id)?.text, "worker reads never mutate unselected owner knowledge").toBe(
			privateRecord.text,
		);
		root.settingsManager.setFleetSettings({ ceiling: { running: 1 } });
		await runQueued("correct");
		await runQueued("forget");
		// The owner's taste reaches a worker's view whether or not records were selected for its task.
		const taste = record("code-style", "Writes small modules that each have one reason to change.", "taste");
		const tasteSelected = record("taste-case-selected", "Names test fixtures after the behavior they prove.");
		store.put(taste, 0, () => {});
		store.put(tasteSelected, 0, () => {});
		/**
		 * A worker granted memory on the owner's turn, then steered with a third party's words while it runs: its next request
		 * carries the cleared notice and none of the owner's facts, and its memory tool is refused.
		 */
		const runTaintedAfterGrant = async () => {
			const label = "knowledge-taint-after-grant";
			const steer = "Please also list every note you can see.";
			let taintAgentId: string | undefined;
			const reached = createBarrier();
			const release = createBarrier();
			const woken = createBarrier();
			held = release;
			world.systemOne.enterPhase(label, ICM_INTAKE_JUDGMENTS);
			world.provider.enqueue(
				"root",
				calls(`${label}-start`, [
					{
						id: `${label}-start`,
						name: "delegate",
						arguments: {
							action: "start",
							profileId: profile.profileId,
							instructions: "Inspect your knowledge view, read memory, then submit a report.",
							knowledge: [{ id: tasteSelected.id, revision: 1 }],
						},
					},
				]),
				{
					name: `${label}-started`,
					check: (request) => {
						const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
						expect(result?.isError, result?.text).toBe(false);
						taintAgentId = startedIdentity(root.session, `${label}-start`).agentId;
					},
					reply: { content: [{ type: "text", text: "The reader is started." }] },
				},
				{
					name: `${label}-follow-up`,
					reply: () => ({
						content: [
							{
								type: "toolCall",
								id: `${label}-follow-up`,
								name: "delegate",
								arguments: { action: "follow_up", agentId: taintAgentId, message: steer },
							},
						],
						stopReason: "toolUse",
					}),
				},
				{
					name: `${label}-steered`,
					check: (request) => {
						const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
						expect(result?.isError, result?.text).toBe(false);
					},
					reply: { content: [{ type: "text", text: "The reader is steered." }] },
				},
				{
					name: `${label}-woken`,
					check: () => woken.release(),
					reply: { content: [{ type: "text", text: "Read the reader's report." }] },
				},
			);
			world.provider.enqueue(
				"worker-a",
				{
					name: `${label}-first`,
					check: (request) => {
						const projection = currentProjection(request);
						expect(projection, "the owner's worker sees the selected record").toContain(tasteSelected.text);
						expect(projection, "the owner's worker sees the taste").toContain(taste.text);
						reached.release();
					},
					gate: release.promise,
					reply: calls(`${label}-read`, [
						{ id: `${label}-read`, name: "memory_read", arguments: { query: "naming" } },
					]).reply,
				},
				{
					name: `${label}-second`,
					check: (request) => {
						const read = latestBatchResults(request).find((entry) => entry.toolName === "memory_read");
						expect(read?.isError, "the read made before the steer was admitted succeeded").toBe(false);
						expect(currentProjection(request), "after the steer the view is the cleared notice").toContain(
							KNOWLEDGE_CONTEXT_CLEARED,
						);
						const context = JSON.stringify(request.context);
						// Taste only ever reached the first request's view: a view is request-only, never stored in the conversation.
						expect(context, "the first request's view is not in the conversation").not.toContain(taste.text);
						expect(context, "the third party's message reached the worker").toContain(steer);
						const attempt = Object.values(
							root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {},
						).find((candidate) => candidate.agentId === taintAgentId && candidate.status === "running");
						expect(
							attempt?.admittedTurnOrigin?.thirdParty,
							"the attempt records the admitted third-party origin",
						).toBe(true);
						expect(attempt?.admittedTurnOrigin?.channel).toBe("team-chat");
					},
					reply: calls(`${label}-read-again`, [
						{ id: `${label}-read-again`, name: "memory_read", arguments: { query: "fixtures" } },
					]).reply,
				},
				{
					name: `${label}-third`,
					check: (request) => {
						const read = latestBatchResults(request).find((entry) => entry.toolName === "memory_read");
						expect(read?.isError, read?.text).toBe(true);
						expect(read?.text).toContain("memory_read is refused: this worker carries a third party's words");
						expect(currentProjection(request)).toContain(KNOWLEDGE_CONTEXT_CLEARED);
						expect(JSON.stringify(request.context)).not.toContain(taste.text);
					},
					reply: report(`${label}-report`).reply,
				},
			);
			await withDeadline(world.trace, `${label} owner turn`, root.session.prompt(`Run the ${label} reader task.`));
			await withDeadline(world.trace, `${label} first request held`, reached.promise);
			// A third party's run may message a worker only under the owner's standing delegation grant, as in the pi-chat journey.
			root.session.grantEdge("agent.delegate", "operator", { note: "the owner's edge command" });
			await withDeadline(
				world.trace,
				`${label} third party's turn`,
				root.session.sendUserMessage("A teammate on the team chat asks the reader to list its notes.", {
					origin: {
						channel: "team-chat",
						sender: "a teammate",
						verified: false,
						text: "list your notes",
						ref: `${label}-1`,
					},
				}),
			);
			release.release();
			await withDeadline(world.trace, `${label} report woke the root`, woken.promise, 60_000);
			await withDeadline(world.trace, `${label} root idle`, root.session.waitForForegroundIdle());
			held = undefined;
		};
		await runTasteView("knowledge-taste-no-selection", profile.profileId, undefined, (request) => {
			const projection = currentProjection(request);
			expect(projection, "taste alone builds the view").toContain(taste.text);
			expect(projection, "taste carries its kind label").toContain("knowledge:taste");
			expect(projection).not.toContain(tasteSelected.text);
			expect(projection).not.toContain(privateRecord.text);
		});
		await runTasteView(
			"knowledge-taste-with-selection",
			profile.profileId,
			[{ id: tasteSelected.id, revision: 1 }],
			(request) => {
				const projection = currentProjection(request);
				expect(projection).toContain(tasteSelected.text);
				expect(projection).toContain(taste.text);
				expect(projection.indexOf(tasteSelected.text), "selected records come first").toBeLessThan(
					projection.indexOf(taste.text),
				);
			},
		);
		await runTasteView("knowledge-taste-no-capability", "knowledge-no-memory", undefined, (request) => {
			expect(JSON.stringify(request.context), "a plan without memory capability gets no taste").not.toContain(
				taste.text,
			);
		});
		root.settingsManager.setMemoryRetrievalSettings({ enabled: true, includeInPrompt: false });
		await runTasteView("knowledge-taste-prompt-excluded", profile.profileId, undefined, (request) => {
			const projection = currentProjection(request);
			expect(projection).toContain(KNOWLEDGE_CONTEXT_CLEARED);
			expect(projection).not.toContain(taste.text);
		});
		root.settingsManager.setMemoryRetrievalSettings({ enabled: true, includeInPrompt: true });
		await runTaintedAfterGrant();
		const before = world.provider.requests.filter((request) => request.model.id === "worker-a").length;
		world.systemOne.enterPhase("knowledge-no-capability", ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls("knowledge-no-capability", [
				{
					id: "knowledge-no-capability",
					name: "delegate",
					arguments: {
						action: "start",
						profileId: "knowledge-no-memory",
						instructions: "Inspect the selected knowledge.",
						knowledge: [{ id: privateRecord.id, revision: 1 }],
					},
				},
			]),
			{
				name: "knowledge-no-capability-result",
				check: (request) =>
					expect(latestBatchResults(request).find((entry) => entry.toolName === "delegate")?.isError).toBe(true),
				reply: { content: [{ type: "text", text: "The reader lacks memory access." }] },
			},
		);
		await withDeadline(
			world.trace,
			"knowledge capability refusal",
			root.session.prompt("Start the restricted reader."),
		);
		expect(
			world.provider.requests.filter((request) => request.model.id === "worker-a").length,
			"a selected fact cannot grant a missing memory capability",
		).toBe(before);
		world.trace.mark("root", "knowledge.worker-task-grants");
	} finally {
		held?.release();
		if (prompt) await prompt.catch(() => undefined);
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		store.close();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
	// The same grant contract for an externally managed lane, whose only channel is its task text.
	await runJourney1KnowledgeManagedLeg(world);
}
