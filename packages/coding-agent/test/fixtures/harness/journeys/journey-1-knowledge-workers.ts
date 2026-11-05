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
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, latestBatchResults } from "./shared.ts";

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
	const record = (key: string, value: string): KnowledgeRecord => {
		const identity = {
			kind: "behavior" as const,
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
	for (let size = 1; size <= 40; size *= 2)
		for (let first = 0; first + size <= 40; first += size) {
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
					const attempts = Object.values(root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
					agentId = attempts.find((attempt) => attempt.status === "running")?.agentId;
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
				if (value) {
					if (root.settingsManager.getMemoryRetrievalSettings().includeInPrompt)
						expect(projection).toContain(value);
					else {
						expect(projection).toContain(KNOWLEDGE_CONTEXT_CLEARED);
						expect(projection).not.toContain(value);
					}
				} else {
					expect(projection).not.toContain(selected.text);
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
		change?.();
		release.release();
		await withDeadline(world.trace, `${label} parent completed`, prompt);
		prompt = undefined;
		held = undefined;
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
}
