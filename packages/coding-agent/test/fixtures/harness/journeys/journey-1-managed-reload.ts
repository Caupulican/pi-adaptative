import { expect } from "vitest";
import { piCollaborationExtension } from "../../../../src/core/collaboration/extension.ts";
import { collaborationLaneId } from "../../../../src/core/collaboration/job-record.ts";
import { CollaborationJobStore } from "../../../../src/core/collaboration/job-store.ts";
import { deriveWorkerLaunchProfile } from "../../../../src/core/collaboration/launch-profile.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import { getInFlightWorkUnits } from "../../../../src/core/reload-blockers.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

/** A saved native terminal must recover dispatch before terminal publication across real runtime replacement. */
export async function runManagedReloadRecoveryInteraction(world: HarnessWorld): Promise<void> {
	for (const ordering of ["held-reload", "normal-startup"] as const) {
		const label = `h2-managed-${ordering}`;
		const agentDir = `${world.agentDir}-${label}`;
		const stateDirectory = `${agentDir}/collaboration-jobs`;
		const manager = world.createSessionManager(agentDir);
		const store = new CollaborationJobStore(stateDirectory, manager.getSessionId());
		const jobId = label;
		const memberId = "saved-worker";
		const laneId = collaborationLaneId(jobId, memberId);
		const evidence = `Saved ${label} evidence reached the parent exactly once.`;
		const handoffHeader = `- ${laneId}: succeeded`;
		const answer = `The parent received ${label}.`;
		const reached = createBarrier();
		const release = createBarrier();
		const providerReached = createBarrier();
		const providerRelease = createBarrier();
		const errors: string[] = [];
		const notifications: string[] = [];
		const warningMark = world.warnings.length;
		let enabled = ordering === "normal-startup";
		let backendCalls = 0;
		let held = false;
		let exited = false;
		const owner = await world.createRootSession("root", {
			agentDir,
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					if (!enabled) return;
					piCollaborationExtension(pi, {
						stateDirectory,
						// This saved process is positively closed. Recovery must publish its retained
						// terminal, never reconnect a native backend or replay its work.
						backend: async () => {
							backendCalls++;
							throw new Error(`${label}: closed native work must not be contacted`);
						},
					});
					pi.on("session_start", async (event) => {
						if (ordering !== "held-reload" || event.reason !== "reload") return;
						held = true;
						reached.release();
						await release.promise;
						exited = true;
					});
				},
			],
		});
		store.create({
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
					name: "Saved worker",
					provider: "pi",
					cwd: manager.getCwd(),
					args: [],
					env: {},
					profile: deriveWorkerLaunchProfile({
						identity: `${label}-profile`,
						allowedTools: ["read", "bash"],
						writePaths: [],
					}),
					notifiedDispatchTurn: 0,
				},
			],
		});
		const reserved = store.reserveTurn(jobId, memberId, `Recover ${label}.`);
		expect(store.finishTurn(jobId, memberId, reserved.turnId, "done", evidence)).toBe(true);
		store.update(jobId, (job) => {
			job.agents[0].closed = true;
		});
		const requestsBefore = world.provider.reached.length;
		world.systemOne.enterPhase(label, {});
		world.provider.enqueue("root", {
			name: `${label}-parent`,
			check: (request) => {
				if (ordering === "held-reload" && !exited)
					throw new Error(`${label}: parent provider escaped held replacement`);
				const matching = request.context.messages.filter((message) =>
					JSON.stringify(message.content).includes(handoffHeader),
				);
				if (matching.length !== 1)
					throw new Error(`${label}: parent received ${matching.length} copies of the saved terminal`);
				providerReached.release();
			},
			gate: providerRelease.promise,
			reply: { content: [{ type: "text", text: answer }] },
		});
		let replacing: Promise<void> | undefined;
		try {
			await owner.session.bindExtensions({
				uiContext: {
					askQuestions: world.humanInput.ui.askQuestions,
					notify: (message, type) => {
						const diagnostic = `${label}: ${type ?? "info"}: ${message}`;
						notifications.push(diagnostic);
						world.warnings.push(diagnostic);
					},
				} as ExtensionUIContext,
				onError: (error) => errors.push(error.error),
			});
			if (ordering === "held-reload") {
				enabled = true;
				replacing = owner.session.reload();
				await withDeadline(world.trace, `${label} reached real lifecycle`, reached.promise);
				expect(held).toBe(true);
				expect(exited).toBe(false);
				expect(store.load(jobId).agents[0], "held retry acknowledges neither dispatch nor terminal").toMatchObject({
					notifiedDispatchTurn: 0,
					notifiedTurn: 0,
				});
				expect(owner.session.getLaneRecords().filter((record) => record.laneId === laneId)).toEqual([]);
				expect(world.provider.reached.slice(requestsBefore), "no parent provider escapes the writer").toEqual([]);
				release.release();
				await withDeadline(world.trace, `${label} reload settled`, replacing);
			}
			await withDeadline(world.trace, `${label} parent receives saved terminal`, providerReached.promise);
			expect(store.load(jobId).agents[0], "production recovery acknowledges the exact saved turn").toMatchObject({
				turn: 1,
				notifiedDispatchTurn: 1,
				notifiedTurn: 1,
				notifiedClosure: true,
			});
			expect(owner.session.getLaneRecords().filter((record) => record.laneId === laneId)).toMatchObject([
				{ laneId, status: "succeeded", profileId: `${label}-profile` },
			]);
			const claims = owner.session.getWorkerClaimSnapshots().filter((claim) => claim.requestId === laneId);
			expect(claims, "the saved evidence is persisted under this terminal's managed claim").toHaveLength(1);
			expect(claims[0].summary).toContain(evidence);
			providerRelease.release();
			await withDeadline(world.trace, `${label} parent response settled`, owner.session.waitForForegroundIdle());
			expect(owner.session.getLastAssistantText()).toBe(answer);
			expect(world.provider.reached.slice(requestsBefore)).toEqual([`root:${label}-parent`]);
			expect(
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "background-worker-completion" &&
							JSON.stringify(entry.content).includes(handoffHeader),
					),
				"the recovered terminal has one durable parent handoff",
			).toHaveLength(1);
			expect(
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							JSON.stringify(entry.message.content).includes(answer),
					),
				"the saved terminal yields one durable parent response",
			).toHaveLength(1);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error(`${label}: the recovered parent response has no session file`);
			expect(
				world
					.openSessionManager(sessionFile)
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							JSON.stringify(entry.message.content).includes(answer),
					),
				"reopening the selected branch retains the parent answer exactly once",
			).toHaveLength(1);
			expect(manager.inspectSessionLifecycle().balanced).toBe(true);
			expect(backendCalls, "known closed work is never replayed or reconnected").toBe(0);
			expect(errors).toEqual([]);
			expect(getInFlightWorkUnits(agentDir), "terminal and closure release native work ownership").toEqual([]);
		} finally {
			release.release();
			providerRelease.release();
			if (replacing) await withDeadline(world.trace, `${label} replacement joined`, replacing);
			expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
		}
		expect(notifications, "managed recovery emits no UI failure before or after physical teardown").toEqual([]);
		expect(world.warnings.slice(warningMark), "saved terminal recovery discloses no lost handoff").toEqual([]);
		world.trace.mark("root", `${label}.terminal-delivered`);
	}
}
