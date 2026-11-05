import { EventEmitter } from "node:events";
import { expect } from "vitest";
import type { CollaborationBackend } from "../../../../src/core/collaboration/backend.ts";
import { piCollaborationExtension } from "../../../../src/core/collaboration/extension.ts";
import { type CollaborationAgent, collaborationLaneId } from "../../../../src/core/collaboration/job-record.ts";
import { CollaborationJobStore } from "../../../../src/core/collaboration/job-store.ts";
import {
	answerTurnKnowledge,
	type CollaborationKnowledgeRelease,
	type KnowledgeChannelPort,
	requestTurnKnowledge,
	turnExpectsKnowledge,
} from "../../../../src/core/collaboration/knowledge-delivery.ts";
import { deriveWorkerLaunchProfile } from "../../../../src/core/collaboration/launch-profile.ts";
import { collaborationPaneEvidence, collaborationPrompt } from "../../../../src/core/collaboration/turn-runner.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import { type KnowledgeRecord, knowledgeId } from "../../../../src/core/memory/knowledge-record.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { icmContinuousSettings } from "./shared.ts";

/** An in-process IPC channel with the parent and helper halves the helper process and its parent use. */
function knowledgeChannelPair(): { parent: KnowledgeChannelPort; helper: KnowledgeChannelPort } {
	const toParent = new EventEmitter();
	const toHelper = new EventEmitter();
	const port = (inbox: EventEmitter, outbox: EventEmitter): KnowledgeChannelPort => ({
		send: (message, onSent) =>
			queueMicrotask(() => {
				outbox.emit("message", message);
				onSent(null);
			}),
		onMessage: (listener) => {
			inbox.on("message", listener);
			return () => inbox.off("message", listener);
		},
		onClose: (listener) => {
			inbox.on("close", listener);
			return () => inbox.off("close", listener);
		},
	});
	return { parent: port(toParent, toHelper), helper: port(toHelper, toParent) };
}

/**
 * Existing journey 1, managed leg: a persistent collaboration task granted one current, one ungranted-by-omission and
 * one forgotten record receives exactly the current granted one, through the delegated lanes' grant owner (gated by
 * the owner's default delegated worker profile) and the real `pi_collaboration` send_followup, reservation,
 * managed-lane dispatch, helper claim, IPC knowledge handoff, turn prompt and pane evidence. A record forgotten
 * between a later reservation and its helper's ask is withdrawn. The native CLI and its helper process are the only
 * doubles: the backend answers reattachment only, and the injected turn launcher runs the helper's sequence.
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
	const withdrawnAnswer = "The managed reader finished without the withdrawn knowledge.";
	const composed: string[] = [];
	const claims: Array<{
		release: CollaborationKnowledgeRelease;
		record?: CollaborationAgent;
		evidence: string;
		finished: boolean;
	}> = [];
	// Every state of the job file a turn passes through: reserved, claimed, settled.
	const jobFiles: string[] = [];
	// Runs between the reservation and the helper's ask: the owner's change that withdraws a grant.
	let beforeAsk: (() => void) | undefined;
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
	// The owner's default delegated worker reads memory, so a managed member (no profile of its own) may be granted
	// knowledge by the same rule `delegate` applies.
	const defaultProfileId = `${label}-default-reader`;
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
		{
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: defaultProfileId,
			description: "Default read-only delegated worker that reads granted knowledge.",
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
		},
		"global",
	);
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: icmContinuousSettings("worker-c", {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			workerDelegation: { orchestrationProfile: defaultProfileId },
		}),
		extensionFactories: [
			(pi) =>
				piCollaborationExtension(pi, {
					stateDirectory,
					backend: async () => backend,
					launchTurn: async (_store, job, agent, turnAnswer, knowledge) => {
						// The helper's own sequence: a turn-role claim, the knowledge ask over the production IPC halves
						// right before the prompt, the production turn prompt, and the production pane evidence.
						const helper = new CollaborationJobStore(stateDirectory, job.parentSessionId, { role: "turn" });
						const readJobFile = () => jobFiles.push(String(world.io.readFileSync(helper.path(job.id))));
						readJobFile();
						if (!helper.claimTurn(job.id, agent.id, agent.turnId, process.pid))
							throw new Error(`${label}: the reserved turn was not claimable`);
						readJobFile();
						const record = helper.load(job.id).agents.find((member) => member.id === agent.id);
						if (!record || !turnExpectsKnowledge(record, turnAnswer !== undefined))
							throw new Error(`${label}: a granted task's turn asks for its knowledge`);
						beforeAsk?.();
						beforeAsk = undefined;
						const channel = knowledgeChannelPair();
						const [, release] = await Promise.all([
							answerTurnKnowledge(channel.parent, agent.turnId, () => knowledge?.deliver(agent.id)),
							requestTurnKnowledge(channel.helper, agent.turnId),
						]);
						const prompt = collaborationPrompt(
							{ text: record.prompt, turnId: agent.turnId, reportCommand: `${label}-report` },
							release,
						);
						composed.push(prompt);
						const block = release.kind === "delivered" ? release.text : undefined;
						// A native CLI's stopped pane: the echoed prompt, a re-rendered copy of the block, then its own output.
						const pane = `${prompt}\n${block ?? ""}\n${evidence}`;
						const paneEvidence = collaborationPaneEvidence(pane, agent.turnId, block);
						const finished = helper.finishTurn(job.id, agent.id, agent.turnId, "done", paneEvidence);
						readJobFile();
						claims.push({ release, record, evidence: paneEvidence, finished });
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
	const late = record("managed-late", "Keeps late managed notes in a sealed ledger.");
	for (const item of [granted, ungranted, forgotten, late]) store.put(item, 0, () => {});
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
	const lateRef = { id: late.id, revision: 1 };
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
		const resultText = (content: typeof result.content) =>
			content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(
			JSON.parse(text).knowledge,
			"the leading block reports exactly what was delivered and what was not",
		).toEqual({
			projected: [grantedRef],
			unavailable: [forgottenRef],
			omitted: [],
		});
		for (const value of [granted.text, ungranted.text, forgotten.text])
			expect(resultText(result.content), "the parent's tool result names references, never values").not.toContain(
				value,
			);
		expect(claims, "one helper claim delivered the turn").toHaveLength(1);
		expect(claims[0].finished, "the claimed turn settles").toBe(true);
		expect(claims[0].release.kind, "the parent hands the block over IPC at the helper's ask").toBe("delivered");
		expect(claims[0].record?.knowledgeReferences, "the record keeps the granted versions").toEqual([grantedRef]);
		expect(jobFiles, "the job file was read reserved, claimed and settled").toHaveLength(3);
		for (const file of jobFiles)
			expect(file, "no state of the job file holds a granted value").not.toContain(granted.text);
		expect(claims[0].evidence, "the pane evidence keeps the worker's own output").toContain(evidence);
		expect(claims[0].evidence, "the pane evidence holds no echoed granted value").not.toContain(granted.text);
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
		expect(parentContext, "the parent's context holds no granted value").not.toContain(granted.text);
		expect(session.getLastAssistantText()).toBe(answer);

		// A record forgotten after the next task's reservation and before its helper's ask is never delivered.
		const withdrawnHandoff = createBarrier();
		world.provider.enqueue("root", {
			name: `${label}-withdrawn-handoff`,
			check: (request) => {
				parentContext = JSON.stringify(request.context.messages);
				withdrawnHandoff.release();
			},
			reply: { content: [{ type: "text", text: withdrawnAnswer }] },
		});
		beforeAsk = () =>
			store.forget(
				late.id,
				1,
				[
					{
						sourceId: "fixture-managed-late-forget",
						sessionId: session.sessionId,
						quote: "Forget the sealed ledger.",
						at: new Date().toISOString(),
					},
				],
				() => {},
			);
		const withdrawn = await tool.execute(
			`${label}-withdrawn-followup`,
			{
				action: "send_followup",
				jobId,
				agentId: memberId,
				task: "Summarize the late notes for the owner.",
				knowledge: [lateRef],
			} as never,
			undefined,
			undefined,
			created.getExtensionRunner().createContext(),
		);
		const withdrawnText = withdrawn.content[0]?.type === "text" ? withdrawn.content[0].text : "";
		expect(JSON.parse(withdrawnText).knowledge, "the parent learns the grant was withdrawn before delivery").toEqual({
			projected: [],
			unavailable: [],
			omitted: [],
			withdrawnBeforeDeliveryFrom: [memberId],
		});
		expect(claims, "the second task was claimed once").toHaveLength(2);
		expect(claims[1].release.kind, "the helper is told the grant was withdrawn").toBe("withdrawn");
		expect(composed[1], "the turn prompt says no knowledge is provided").toContain("none is provided");
		for (const text of [composed[1], claims[1].evidence, resultText(withdrawn.content), ...jobFiles])
			expect(text, "a withdrawn record reaches neither the lane nor any record").not.toContain(late.text);
		await withDeadline(world.trace, `${label} parent receives the withdrawn terminal`, withdrawnHandoff.promise);
		await withDeadline(world.trace, `${label} withdrawn response settled`, session.waitForForegroundIdle());
		expect(session.getLastAssistantText()).toBe(withdrawnAnswer);
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
