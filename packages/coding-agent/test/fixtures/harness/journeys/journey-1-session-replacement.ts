import "../builtin-install.ts";
import { expect } from "vitest";
import {
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "../../../../src/core/agent-session-runtime.ts";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "../../../../src/core/background-tool-task-controller.ts";
import { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { calls, createBarrier, type ScriptedRequest, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { backgroundTaskIdOf, handoffFor, requestTexts } from "./shared.ts";

/** Session switching shares the durable task branch with an executor that may still belong to the old session. */
export async function verifySessionReplacementTerminalIdentity(world: HarnessWorld): Promise<void> {
	for (const order of ["completed-before-prepare", "completed-during-prepare"] as const) {
		const label = `macro-session-${order}`;
		const agentDir = `${world.agentDir}-${label}`;
		const shellRelease = createBarrier();
		const shellReached = createBarrier();
		const prepared = createBarrier();
		const prepareRelease = createBarrier();
		const actualTerminalRead = createBarrier();
		const unavailable =
			"The session resumed after the owning process ended; the original tool completion is unavailable.";
		const command = `echo ${label}`;
		const output = `The actual executor completed for ${label}.`;
		const candidateTrack = `${label}-unavailable`;
		let taskId: string | undefined;
		let creations = 0;
		let candidate: CreateAgentSessionRuntimeResult | undefined;
		const terminalRequests: string[][] = [];
		world.systemOne.enterPhase(label, {});
		const routedWarnings: string[] = [];
		const runtime = await createAgentSessionRuntime(
			async ({ cwd, agentDir: directory, sessionManager }) => {
				const root = await world.createRootSession("worker-b", {
					agentDir: directory,
					sessionManager,
					// Host identity and persistence are independent of semantic classification; both world modes use this binding.
					systemOneEnabled: false,
					settings: { memorySystem: "okf", autoLearn: { enabled: false } },
				});
				const result: CreateAgentSessionRuntimeResult = {
					...root,
					services: {
						cwd,
						agentDir: directory,
						authStorage: world.authStorage,
						settingsManager: root.settingsManager,
						modelRegistry: world.modelRegistry,
						resourceLoader: root.session.resourceLoader,
						diagnostics: [],
					},
					diagnostics: [],
				};
				creations++;
				if (creations === 2) {
					candidate = result;
					await root.session.waitForForegroundIdle();
					prepared.release();
					await prepareRelease.promise;
				}
				return result;
			},
			{
				cwd: HARNESS_PROJECT_CWD,
				agentDir,
				sessionManager: world.createSessionManager(agentDir),
				onTerminalWarnings: (warnings) => routedWarnings.push(...warnings),
			},
		);
		const original = runtime.session;
		const originalManager = runtime.sessionManager;
		const warningMark = world.warnings.length;
		let replacement: Promise<{ cancelled: boolean }> | undefined;
		let diagnosticFailure: unknown;
		const cleanupFailures: unknown[] = [];
		try {
			world.shell.enqueue({
				name: label,
				command,
				output,
				exitCode: 0,
				gate: shellRelease.promise,
				check: () => shellReached.release(),
			});
			world.provider.enqueueTrack(
				`${label}-original`,
				"worker-b",
				(request) => !requestTexts(request).some((value) => value.includes(unavailable)),
				calls(`${label}-start`, [{ id: `${label}-call`, name: "bash", arguments: { command, background: true } }]),
				{
					...text(`${label}-started`, "The command is running in the background."),
					check: (request) => {
						taskId = backgroundTaskIdOf(request);
					},
				},
				{
					...text(`${label}-actual-terminal`, "The actual command result was received."),
					check: (request) => {
						if (!taskId || !handoffFor(request, taskId)) throw new Error(`${label}: actual terminal is absent`);
						terminalRequests.push(requestTexts(request));
						actualTerminalRead.release();
					},
				},
			);
			// If recovery invents a lost result, retain its actual provider payload so the behavioral oracle can report it.
			// Zero requests is valid; a second such request remains an unscripted failure.
			world.provider.enqueueTrack(
				candidateTrack,
				"worker-b",
				(request: ScriptedRequest) => requestTexts(request).some((value) => value.includes(unavailable)),
				{
					...text(`${label}-unavailable-terminal`, "The recovery notice was received."),
					optional: true,
					check: (request) => terminalRequests.push(requestTexts(request)),
				},
			);
			await withDeadline(
				world.trace,
				`${label}: background handoff`,
				original.prompt(`Run ${label} in the background.`),
			);
			await withDeadline(world.trace, `${label}: external executor is held`, shellReached.promise);
			await withDeadline(world.trace, `${label}: initial prompt settled`, original.waitForForegroundIdle());
			const file = originalManager.getSessionFile();
			if (!file || !taskId) throw new Error(`${label}: initial handoff has no durable identity`);
			const selectTask = (manager: SessionManager) =>
				loadBackgroundToolTaskRecordsNewestFirst(manager).find(
					(value) => typeof value === "object" && value !== null && "taskId" in value && value.taskId === taskId,
				);
			if (order === "completed-before-prepare") {
				shellRelease.release();
				await withDeadline(world.trace, `${label}: actual terminal read`, actualTerminalRead.promise);
				await withDeadline(world.trace, `${label}: actual terminal settled`, original.waitForForegroundIdle());
			}
			replacement = runtime.switchSession(file);
			// Observe the real factory after construction/recovery and before commit can retire the original session.
			await withDeadline(world.trace, `${label}: replacement preparation held`, prepared.promise);
			if (!candidate) throw new Error(`${label}: prepared runtime is absent`);
			const originalAtPrepare = original.getResourceSnapshot().backgroundToolTasks;
			const candidateAtPrepare = selectTask(candidate.sessionManager);
			if (order === "completed-during-prepare") {
				expect(originalAtPrepare.physicalExecutions, "the original executor is live during preparation").toBe(1);
				expect(originalAtPrepare.runningTaskIds).toEqual([taskId]);
				shellRelease.release();
				await withDeadline(world.trace, `${label}: actual terminal read`, actualTerminalRead.promise);
				await withDeadline(world.trace, `${label}: actual terminal settled`, original.waitForForegroundIdle());
			}
			const actual = selectTask(originalManager);
			prepareRelease.release();
			expect(await withDeadline(world.trace, `${label}: switch settles`, replacement)).toEqual({ cancelled: false });
			await withDeadline(world.trace, `${label}: active session settled`, runtime.session.waitForForegroundIdle());
			const reopened = SessionManager.open(file, agentDir);
			const observations = {
				order,
				originalAtPrepare,
				candidateAtPrepare,
				actual,
				active: selectTask(runtime.sessionManager),
				reopened: selectTask(reopened),
				originalIdentity: originalManager.getSessionId(),
				activeIdentity: runtime.sessionManager.getSessionId(),
				rawTaskSnapshots: reopened
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE),
				terminalRequests,
			};
			try {
				expect(actual).toMatchObject({ status: "completed", output: expect.stringContaining(output) });
				expect(observations.active, "same-file resume retains the actual terminal on its selected branch").toEqual(
					actual,
				);
				expect(observations.reopened, "reopening retains the same actual terminal").toEqual(actual);
				expect(observations.activeIdentity).toBe(observations.originalIdentity);
				expect(terminalRequests, "the parent receives exactly one terminal payload").toHaveLength(1);
				expect(
					terminalRequests.flat().some((value) => value.includes(unavailable)),
					"no live executor is reported lost",
				).toBe(false);
			} catch (cause) {
				throw new Error(`${label}: observations=${JSON.stringify(observations)}`, { cause });
			}
		} catch (error) {
			diagnosticFailure = error;
		} finally {
			shellRelease.release();
			prepareRelease.release();
			const settlements: PromiseSettledResult<unknown>[] = replacement
				? await Promise.allSettled([replacement])
				: [];
			settlements.push(...(await Promise.allSettled([runtime.dispose()])));
			settlements.push(...(await Promise.allSettled([world.provider.waitForProducers()])));
			cleanupFailures.push(
				...settlements.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
			);
			try {
				world.provider.retireOptional(candidateTrack);
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (cleanupFailures.length > 0) {
			throw new AggregateError(
				[...(diagnosticFailure === undefined ? [] : [diagnosticFailure]), ...cleanupFailures],
				`${label}: diagnostic or cleanup failed`,
			);
		}
		if (diagnosticFailure !== undefined) throw diagnosticFailure;
		expect(terminalRequests, "cleanup emits no additional terminal payload").toHaveLength(1);
		expect(routedWarnings).toEqual([]);
		expect(world.warnings.slice(warningMark), `${label}: no unclassified recovery warning`).toEqual([]);
		world.trace.mark("root", label);
	}
}
