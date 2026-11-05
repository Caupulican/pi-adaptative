import { expect } from "vitest";
import type { CollaborationBackend } from "../../../../src/core/collaboration/backend.ts";
import { piCollaborationExtension } from "../../../../src/core/collaboration/extension.ts";
import { type CollaborationAgent, collaborationLaneId } from "../../../../src/core/collaboration/job-record.ts";
import { CollaborationJobStore } from "../../../../src/core/collaboration/job-store.ts";
import { deriveWorkerLaunchProfile } from "../../../../src/core/collaboration/launch-profile.ts";
import { collaborationPrompt } from "../../../../src/core/collaboration/turn-runner.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import { type KnowledgeRecord, knowledgeId } from "../../../../src/core/memory/knowledge-record.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { icmContinuousSettings } from "./shared.ts";

/**
 * Existing journey 1, managed leg: a persistent collaboration task granted one current, one ungranted-by-omission and
 * one forgotten record receives exactly the current granted one, through the delegated lanes' grant owner and the real
 * `pi_collaboration` send_followup, reservation, managed-lane dispatch, helper claim and turn prompt. The native CLI
 * and its helper process are the only doubles: the backend answers reattachment only, and the injected turn launcher
 * claims the turn as the helper does and composes the production turn prompt from what the claim returned.
 */
export async function runJourney1KnowledgeManagedLeg(world: HarnessWorld): Promise<void> {
	const label = "knowledge-managed";
	const agentDir = `${world.agentDir}-${label}`;
	const stateDirectory = `${agentDir}/collaboration-jobs`;
	const manager = world.createSessionManager(agentDir);
	const jobId = label;
	const memberId = "external-reader";
	const laneId = collaborationLaneId(jobId, memberId);
	const backendName = `${label}-reader`;
	const paneId = `${label}-pane`;
	const terminalId = `${label}-terminal`;
	const evidence = "The managed reader used only its granted knowledge.";
	const answer = "The managed reader finished.";
	const composed: string[] = [];
	const claims: Array<{ knowledge?: string; record?: CollaborationAgent; finished: boolean }> = [];
	const errors: string[] = [];
	const notices: string[] = [];
	const refuse = async (): Promise<never> => {
		throw new Error(`${label}: the scripted native session is never contacted beyond reattachment`);
	};
	const native = {
		name: backendName,
		kind: "pi",
		paneId,
		terminalId,
		workspaceId: `${label}-workspace`,
		tabId: `${label}-tab`,
		status: "idle" as const,
		interactiveReady: true,
		launchPending: false,
		stateChangeSequence: 0,
		revision: 0,
	};
	const backend: CollaborationBackend = {
		id: label,
		session: label,
		createWorkspace: refuse,
		splitPane: refuse,
		getPane: refuse,
		startAgent: refuse,
		getAgent: refuse,
		listAgents: async () => [native],
		prompt: refuse,
		answerQuestion: refuse,
		readAgent: refuse,
		closePane: refuse,
		closeWorkspace: refuse,
		stopSession: refuse,
		notify: refuse,
		reportMetadata: refuse,
	};
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: icmContinuousSettings("worker-c", { autoLearn: { enabled: false }, proactivity: { enabled: false } }),
		extensionFactories: [
			(pi) =>
				piCollaborationExtension(pi, {
					stateDirectory,
					backend: async () => backend,
					launchTurn: async (_store, job, agent) => {
						// The helper's own sequence: a turn-role claim, then the turn prompt from the claimed record.
						const helper = new CollaborationJobStore(stateDirectory, job.parentSessionId, { role: "turn" });
						const claim = helper.claimTurn(job.id, agent.id, agent.turnId, process.pid);
						if (!claim) throw new Error(`${label}: the reserved turn was not claimable`);
						const record = helper.load(job.id).agents.find((member) => member.id === agent.id);
						composed.push(
							collaborationPrompt({
								target: backendName,
								terminalId,
								turnId: agent.turnId,
								reportCommand: `${label}-report`,
								text: record?.prompt ?? "",
								timeoutMs: 60_000,
								...(claim.knowledge ? { knowledge: claim.knowledge } : {}),
							}),
						);
						claims.push({
							...claim,
							record,
							finished: helper.finishTurn(job.id, agent.id, agent.turnId, "done", evidence),
						});
					},
				}),
		],
	});
	const { session, settingsManager } = created;
	const store = KnowledgeStore.open(agentDir);
	const evidenceTime = Date.now() - 2_000;
	const at = new Date(evidenceTime).toISOString();
	const forgettingAt = new Date(evidenceTime + 1_000).toISOString();
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
			citations: [{ sourceId: `fixture-${key}`, sessionId: session.sessionId, quote: value, at }],
		};
	};
	const granted = record("managed-granted", "Keeps managed reader summaries under five lines.");
	const ungranted = record("managed-ungranted", "Keeps unrelated travel plans in a green folder.");
	const forgotten = record("managed-forgotten", "Prefers managed examples in the retired layout.");
	for (const item of [granted, ungranted, forgotten]) store.put(item, 0, () => {});
	store.forget(
		forgotten.id,
		1,
		[
			{
				sourceId: "fixture-managed-forget",
				sessionId: session.sessionId,
				quote: "Forget that layout.",
				at: forgettingAt,
			},
		],
		() => {},
	);
	const grantedRef = { id: granted.id, revision: 1 };
	const forgottenRef = { id: forgotten.id, revision: 1 };
	const tracks: string[] = [];
	for (let size = 1; size <= 16; size *= 2)
		for (let first = 0; first + size <= 16; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const name = `${label}-compaction-${first}+${size}`;
			tracks.push(name);
			world.provider.enqueueTrack(
				name,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{ name, optional: true, reply: { content: [{ type: "text", text: "Managed knowledge grant handoff." }] } },
			);
		}
	try {
		settingsManager.setMemoryRetrievalSettings({ enabled: true, includeInPrompt: true });
		const jobs = new CollaborationJobStore(stateDirectory, manager.getSessionId());
		jobs.create({
			id: jobId,
			parentSessionId: manager.getSessionId(),
			parentSessionFile: manager.getSessionFile(),
			sessionName: label,
			cwd: manager.getCwd(),
			title: label,
			createdAt: Date.now(),
			deadlineSeconds: 60,
			agents: [
				{
					id: memberId,
					name: "External reader",
					provider: "pi",
					cwd: manager.getCwd(),
					args: [],
					env: {},
					backendName,
					paneId,
					terminalId,
					profile: deriveWorkerLaunchProfile({
						identity: `${label}-profile`,
						allowedTools: ["read", "bash"],
						writePaths: [],
					}),
					notifiedDispatchTurn: 0,
				},
			],
		});
		await session.bindExtensions({
			uiContext: {
				askQuestions: world.humanInput.ui.askQuestions,
				notify: (message: string) => void notices.push(message),
			} as unknown as ExtensionUIContext,
			onError: (error) => errors.push(`${error.event}: ${error.error}`),
		});
		const handoff = createBarrier();
		let parentContext = "";
		// The tool runs outside any owner turn, and the parent's only turn is the managed terminal's tool-free wake:
		// no owner turn is judged, so this phase declares nothing and any judgment request here is unscripted.
		world.systemOne.enterPhase(label, {});
		world.provider.enqueue("root", {
			name: `${label}-handoff`,
			check: (request) => {
				parentContext = JSON.stringify(request.context.messages);
				handoff.release();
			},
			reply: { content: [{ type: "text", text: answer }] },
		});
		const tool = session.getToolDefinition("pi_collaboration");
		if (!tool) throw new Error(`${label}: the session offers no pi_collaboration tool`);
		const result = await tool.execute(
			`${label}-followup`,
			{
				action: "send_followup",
				jobId,
				agentId: memberId,
				task: "Summarize the reader's findings for the owner.",
				knowledge: [grantedRef, forgottenRef],
			} as never,
			undefined,
			undefined,
			created.getExtensionRunner().createContext(),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(JSON.parse(text).knowledge, "the parent learns exactly what was projected and what was not").toEqual({
			projected: [grantedRef],
			unavailable: [forgottenRef],
			omitted: [],
		});
		for (const value of [granted.text, ungranted.text, forgotten.text])
			expect(text, "the parent's tool result names references, never values").not.toContain(value);
		expect(claims, "one helper claim delivered the turn").toHaveLength(1);
		expect(claims[0].finished, "the claimed turn settles").toBe(true);
		expect(claims[0].knowledge, "the claim returns the granted projection").toContain(granted.text);
		expect(claims[0].record?.knowledgeContext, "the claim removes the projection from the job record").toBe(
			undefined,
		);
		expect(claims[0].record?.knowledgeReferences, "the record keeps the granted versions").toEqual([grantedRef]);
		expect(composed[0], "the turn prompt carries the granted record as labeled data").toContain(
			"Owner knowledge granted for this task",
		);
		expect(composed[0]).toContain(granted.text);
		expect(composed[0], "an ungranted record never reaches the lane").not.toContain(ungranted.text);
		expect(composed[0], "a forgotten record never reaches the lane").not.toContain(forgotten.text);
		const attempt = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
			(candidate) => candidate.dispatch.logicalLaneId === laneId,
		);
		expect(attempt?.dispatch.knowledgeReferences, "the managed-lane ledger records the granted versions").toEqual([
			grantedRef,
		]);
		expect(JSON.stringify(attempt), "the durable dispatch holds no projected value").not.toContain(granted.text);
		expect(
			String(world.io.readFileSync(jobs.path(jobId))),
			"the settled job record holds no projected value",
		).not.toContain(granted.text);
		await withDeadline(world.trace, `${label} parent receives the managed terminal`, handoff.promise);
		await withDeadline(world.trace, `${label} parent response settled`, session.waitForForegroundIdle());
		expect(parentContext, "the parent receives the lane's terminal").toContain(`- ${laneId}: succeeded`);
		expect(session.getLastAssistantText()).toBe(answer);
		expect(errors, "the managed leg reports no extension error").toEqual([]);
		expect(notices, "the managed leg emits no collaboration failure notice").toEqual([]);
		world.trace.mark("root", "knowledge.managed-task-grant");
	} finally {
		expect(await world.disposeSessionInBody(session)).toBeUndefined();
		store.close();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}
