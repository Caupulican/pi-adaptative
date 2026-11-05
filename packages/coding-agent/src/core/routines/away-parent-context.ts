/**
 * A parent session opened away: the worker execution context of a persisted parent whose session is not open in any
 * process, composed from paths and settings so a routine host can run that parent's saved routine runs.
 *
 * - The parent transcript is read only, through a read-only manager reopened when the file changes; every write the
 *   parent must see goes through the away write port (`createAwayParentWrites`), which records it on the attempt for the
 *   parent to import on open. Nothing here holds a session writer.
 * - The parent bundle is held with a lifetime lease (never claimed by a session), so its stores are not reclaimed
 *   while the host runs.
 * - Model calls go through ONE ephemeral in-process `AgentSession` built by the public `createAgentSession` (in-memory
 *   manager, child session, no extensions, no tools, System One off): only its `runIsolatedCompletion` is used, so
 *   credentials resolve through the existing auth storage exactly as in every other session.
 * - Policy is the foreground's with System One off: no route judge, reviews or settlement ladder, an operation gate
 *   without an engine (the deterministic gates decide, as in a session with System One off), the branch's edge grants
 *   and model-pool policy, model exhaustion from the shared provider-admission store, and no memory.
 * - The worker controller runs only the parent's routine runs (`runsAttempt`, and `runsControlMessage` for a run's
 *   mailbox turn before its attempt exists): every other attempt, mailbox turn and reply of the parent stays durable
 *   for the parent. Terminal notices stay pending for the parent's own delivery.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import {
	acquireSessionBundleLease,
	type SessionBundleLease,
	sessionBundleLeaseToken,
} from "../../kernel/session/session-bundle-lifecycle.ts";
import { type ReadonlySessionManager, SessionManager } from "../../kernel/session/session-manager.ts";
import { configFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { edgeRecordsOnBranch, sessionEdgeGrants } from "../agent-session-edge.ts";
import { AuthStorage } from "../auth-storage.ts";
import { ExhaustedProviderRegistry, expiryFromRetryAfter } from "../billing-failover-controller.ts";
import { AwayParentWriteRefusal, createAwayParentWrites } from "../delegation/away-parent-writes.ts";
import type { ParentExecutionSettingsSource } from "../delegation/parent-execution-context.ts";
import { workerAgentMessageId } from "../delegation/worker-agent-control.ts";
import { WorkerDelegationController } from "../delegation/worker-delegation-controller.ts";
import { createWorkerEdgePolicy } from "../delegation/worker-edge-policy.ts";
import { WorkerLifecycle } from "../delegation/worker-lifecycle.ts";
import { WorkerNotificationCoordinator } from "../delegation/worker-notification-coordinator.ts";
import { ModelRegistry } from "../model-registry.ts";
import { resolveModelScopeWithDiagnostics } from "../model-resolver.ts";
import {
	isModelInRouterPool,
	type RouterPoolState,
	resolveRouterCandidatePool,
} from "../model-router/candidate-pool.ts";
import { branchPoolPolicyReader, ModelPoolPolicyView } from "../model-router/owner-model-policy.ts";
import { isLocalOrManagedRouterModel } from "../model-router/tool-escalation.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { verificationSubjectAttempt } from "../orchestration/verification-identity.ts";
import { providerAdmissionDir } from "../provider-admission/ledger.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SettingsManager } from "../settings-manager.ts";
import { createSessionOperationGate } from "../system-one/operation-gate-wiring.ts";
import type { TimerSource } from "../util/timer-port.ts";

export interface AwayParentContextInput {
	readonly agentDir: string;
	readonly parentSessionId: string;
	/** The parent's persisted transcript, from its routines' pinned origin. */
	readonly sessionFile: string;
	readonly timers: TimerSource;
	/** The spend bound of one run away; every worker budget of this host is narrowed to it. */
	maxUsdPerRun(): number;
	/** The parent's routine runs this host may run: the dispatch keys of its away occurrences. */
	awayDispatchKeys(): ReadonlySet<string>;
	/** The host's diagnostics: warnings, closing warnings and every write it cannot record. */
	report(message: string): void;
	/** Shared credential owners, when the caller already has them; otherwise built as the SDK builds them. */
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
}

export interface AwayParentContext {
	readonly parentSessionId: string;
	readonly lifecycle: WorkerLifecycle;
	readonly workers: WorkerDelegationController;
	/** The token of this context's own hold on the parent bundle; every other live holder means the parent is open. */
	readonly holdToken: string;
	/** The parent transcript as last read; reopened when the file changed. */
	reader(): ReadonlySessionManager;
	/** Every orchestration ledger event this context records (worker admission, progress and terminals). */
	subscribeExecution(listener: () => void): () => void;
	/** Whether an attempt of a run this context runs is queued, leased or running: closing now would interrupt it. */
	hasLiveRun(): boolean;
	isClosed(): boolean;
	/** Stops worker execution, the ephemeral model-call session and the bundle hold. Idempotent. */
	close(): Promise<void>;
}

/** Why the parent cannot be opened away; reported once on its due routines, never thrown past the host. */
export class AwayParentUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AwayParentUnavailable";
	}
}

/** The settings worker execution reads, narrowed to what a run away may do: no memory, no System One, its spend bound. */
function awaySettingsSource(settings: SettingsManager, maxUsdPerRun: () => number): ParentExecutionSettingsSource {
	return {
		getCompactionSettings: () => settings.getCompactionSettings(),
		getEdgeSettings: () => settings.getEdgeSettings(),
		getMemoryRetrievalSettings: () => ({ ...settings.getMemoryRetrievalSettings(), enabled: false }),
		getModelCapabilitySettings: () => settings.getModelCapabilitySettings(),
		getModelFavorites: () => settings.getModelFavorites(),
		getModelRouterSettings: () => settings.getModelRouterSettings(),
		getProfileRegistry: () => settings.getProfileRegistry(),
		getProjectContextFiles: () => settings.getProjectContextFiles(),
		getSystemOneSettings: () => ({ ...settings.getSystemOneSettings(), enabled: false }),
		getToolkitScripts: () => settings.getToolkitScripts(),
		getWorkerAccountRouting: () => settings.getWorkerAccountRouting(),
		getWorkerDelegationSettings: () => {
			const configured = settings.getWorkerDelegationSettings();
			const perRun = maxUsdPerRun();
			return { ...configured, maxUsd: configured.maxUsd > 0 ? Math.min(configured.maxUsd, perRun) : perRun };
		},
		getWorkerModelPinPolicy: () => settings.getWorkerModelPinPolicy(),
		getWorkerThinkingPolicy: () => settings.getWorkerThinkingPolicy(),
		isProjectTrusted: () => settings.isProjectTrusted(),
	};
}

function fileStamp(path: string): string {
	const stat = statSync(path);
	return `${stat.size}:${stat.mtimeMs}`;
}

/**
 * Opens the parent away. Throws {@link AwayParentUnavailable} when its transcript cannot be read or is not this
 * parent's; any other failure releases what was acquired and propagates.
 */
export async function openAwayParentContext(input: AwayParentContextInput): Promise<AwayParentContext> {
	const { agentDir, parentSessionId, sessionFile } = input;
	let current: { reader: ReadonlySessionManager; stamp: string };
	try {
		const stamp = fileStamp(sessionFile);
		current = { reader: SessionManager.openReadOnly(sessionFile, agentDir), stamp };
	} catch (error) {
		throw new AwayParentUnavailable(
			`its session file cannot be read (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	if (current.reader.getSessionId() !== parentSessionId)
		throw new AwayParentUnavailable("its pinned session file belongs to another session.");
	const cwd = current.reader.getCwd();
	const readerNow = (): ReadonlySessionManager => {
		let stamp: string;
		try {
			stamp = fileStamp(sessionFile);
		} catch {
			return current.reader;
		}
		if (stamp === current.stamp) return current.reader;
		try {
			current = { reader: SessionManager.openReadOnly(sessionFile, agentDir), stamp };
		} catch (error) {
			// A file caught mid-replacement is read again on its next change; the last whole read stays current.
			input.report(
				`The parent transcript could not be read again: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return current.reader;
	};

	const hold: SessionBundleLease = acquireSessionBundleLease(agentDir, parentSessionId);
	const holdToken = sessionBundleLeaseToken(hold);
	let ephemeral: AgentSession | undefined;
	let closed = false;
	try {
		const authStorage = input.authStorage ?? AuthStorage.create(configFile(agentDir, "auth.json"));
		const modelRegistry =
			input.modelRegistry ?? ModelRegistry.create(authStorage, configFile(agentDir, "models.json"));
		// An unattended run applies only the owner's global settings and installs nothing: no project's settings (edge mode,
		// worker delegation, model policy, packages), trusted or not, can loosen a run nobody is watching.
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			installMissingPackages: false,
		});
		await resourceLoader.reload();

		// The parent's own model, restored as the SDK restores a session's model.
		const savedModel = current.reader.buildSessionContext().model;
		const restored = savedModel ? modelRegistry.find(savedModel.provider, savedModel.modelId) : undefined;
		const parentModel = restored && modelRegistry.hasConfiguredAuth(restored) ? restored : undefined;

		// The model-call vehicle: its own settings and minimal loader, so building it changes nothing this context reads.
		const ephemeralSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const ephemeralLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: ephemeralSettings,
			noExtensions: true,
			installMissingPackages: false,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await ephemeralLoader.reload();
		ephemeral = (
			await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				settingsManager: ephemeralSettings,
				resourceLoader: ephemeralLoader,
				sessionManager: SessionManager.inMemory(cwd),
				isChildSession: true,
				disableSystemOne: true,
				noTools: "all",
				...(parentModel ? { model: parentModel } : {}),
				timers: input.timers,
				onClosingWarnings: (warnings) => {
					for (const warning of warnings) input.report(warning);
				},
			})
		).session;
		const modelCalls = ephemeral;

		// The router pool as the foreground derives it from the owner's enabled models (main.ts).
		const patterns = settings.getEnabledModels();
		let routerPool: RouterPoolState | undefined;
		if (patterns !== undefined) {
			const scope = await resolveModelScopeWithDiagnostics(patterns, modelRegistry);
			for (const diagnostic of scope.diagnostics) input.report(diagnostic.message);
			routerPool = { source: "enabled_models", models: scope.scopedModels.map((scoped) => scoped.model) };
		}
		const isAllocatable = (model: Model<Api>): boolean =>
			!settings.getModelRouterSettings().enabled ||
			isModelInRouterPool(
				resolveRouterCandidatePool(routerPool, modelRegistry, {
					favorites: settings.getModelFavorites(),
					isRuntimeDisabled: (runtime) => !settings.isLocalRuntimeEnabled(runtime),
				}),
				model,
			);

		const admissionClock = input.timers.port("provider-admission");
		const exhausted = new ExhaustedProviderRegistry(join(providerAdmissionDir(agentDir), "exhausted"), () =>
			admissionClock.now(),
		);
		const getEdgeGrants = () =>
			sessionEdgeGrants({
				getEdgeRecords: () => edgeRecordsOnBranch(readerNow()),
				getSettingsAllow: () => settings.getEdgeSettings().allow,
			});
		const operationGate = createSessionOperationGate({
			getEngine: () => undefined,
			// Never read without an engine; a run away carries no owner request.
			getRequest: () => "",
			getTurnKey: () => "away",
			notify: (message) => input.report(message),
			getCwd: () => cwd,
			getSessionId: () => parentSessionId,
			getLedger: () => undefined,
			getEdgeGrants,
		});
		const modelPolicy = new ModelPoolPolicyView(
			{
				isSubscription: (model) => modelRegistry.isUsingSubscription(model),
				isLocal: (model) => isLocalOrManagedRouterModel(model),
			},
			branchPoolPolicyReader(() => readerNow()),
		);

		const orchestrationClock = input.timers.port("orchestration");
		const store = new OrchestrationEventStore({
			agentDir,
			sessionId: parentSessionId,
			now: () => new Date(orchestrationClock.now()).toISOString(),
			sleepSync: (delayMs) => input.timers.sleepSync(delayMs),
		});
		const lifecycle = new WorkerLifecycle({
			agentDir,
			sessionId: parentSessionId,
			store,
			now: () => orchestrationClock.now(),
		});
		const writes = createAwayParentWrites({
			getRuntime: () => lifecycle.ledger.runtime,
			getAgentDir: () => agentDir,
			getParentSessionId: () => parentSessionId,
			now: () => orchestrationClock.now(),
			report: (message) => input.report(message),
		});
		// Every terminal stays pending in the durable outbox: the parent's own coordinator delivers it when it opens.
		const notifications = new WorkerNotificationCoordinator({
			timers: input.timers.port("worker-notification"),
			getWorkerRecords: () => lifecycle.getAllRecords(),
			emitStatus: () => {},
			deliveryOwner: () => "separate",
			notify: (records) => writes.notifyWorkerTerminalHandoff(records),
			warn: (message) => input.report(message),
			markDurableDelivered: () => {},
		});
		// The routine run a worker control message dispatches. The keys are read at each call, so a run marked dispatching
		// a moment ago is already this host's, and so is its mailbox turn before any attempt carries it.
		const awayRunKeyOf = (controlMessageId: string | undefined): string | undefined => {
			if (controlMessageId === undefined) return undefined;
			for (const dispatchKey of input.awayDispatchKeys())
				if (workerAgentMessageId(parentSessionId, dispatchKey) === controlMessageId) return dispatchKey;
			return undefined;
		};
		// The routine run an attempt serves: its own dispatch, or for a verifier its subject's.
		const awayRunKey = (attempt: AttemptRuntimeState, snapshot: TaskRuntimeProjection): string | undefined => {
			const task = snapshot.tasks[attempt.taskId]?.task;
			const subject = task?.verificationOfTaskId ? verificationSubjectAttempt(snapshot, task) : attempt;
			return awayRunKeyOf(subject?.dispatch.controlMessageId);
		};
		const runsAttempt = (attempt: AttemptRuntimeState, snapshot: TaskRuntimeProjection): boolean =>
			awayRunKey(attempt, snapshot) !== undefined;
		// One run's subject, retries and verifier share the run's spend bound, as the away spend gate reserves it.
		const runCostBound = (attempt: AttemptRuntimeState, snapshot: TaskRuntimeProjection) => {
			const runId = awayRunKey(attempt, snapshot);
			return runId === undefined ? undefined : { runId, maxCostUsd: input.maxUsdPerRun() };
		};
		const settingsSource = awaySettingsSource(settings, () => input.maxUsdPerRun());
		const workers = new WorkerDelegationController(
			{
				...writes,
				isDisposed: () => closed,
				getSessionId: () => parentSessionId,
				getCwd: () => cwd,
				getAgentDir: () => agentDir,
				getSessionManager: () => readerNow(),
				getSettingsManager: () => settingsSource,
				getResourceLoader: () => resourceLoader,
				getModelRegistry: () => modelRegistry,
				getTimers: () => input.timers,
				modelUnusableCause: (model) =>
					exhausted.isExhausted(`${model.provider}/${model.id}`) ? "model_quota_exhausted" : undefined,
				markModelExhausted: (model, retryAfterMs) =>
					exhausted.markExhausted(
						`${model.provider}/${model.id}`,
						expiryFromRetryAfter(retryAfterMs, exhausted.now()),
					),
				// System One is off away: no route judge, reviews or settlement, and no fitness gate.
				isSystemOneEnabled: () => false,
				createLaneMemoryBroker: () => {
					throw new AwayParentWriteRefusal(
						"A parent opened away has no memory: a run that needs it waits for its session.",
					);
				},
				runIsolatedCompletion: (options) => modelCalls.runIsolatedCompletion(options),
				...createWorkerEdgePolicy({
					getEdgeGrants,
					getOperationGate: () => operationGate,
					getModelPolicy: () => modelPolicy,
					isAllocatable,
					// The delivery binding is owner-word state of the open session; a run away commits nothing.
					localCommitBranch: () => undefined,
				}),
				runsAttempt,
				runsControlMessage: (controlMessageId) => awayRunKeyOf(controlMessageId) !== undefined,
				runCostBound,
				getModel: () => parentModel ?? modelCalls.model,
				isDelegateToolActive: () => true,
				getCapabilityEnvelope: () => undefined,
				getGoalStateSnapshot: () => undefined,
			},
			notifications,
			lifecycle,
		);
		const vehicle = ephemeral;
		return {
			parentSessionId,
			lifecycle,
			workers,
			holdToken,
			reader: () => readerNow(),
			subscribeExecution: (listener) => store.subscribe(() => listener()),
			hasLiveRun: () => {
				const snapshot = lifecycle.getTaskRuntimeSnapshot();
				return Object.values(snapshot.attempts).some(
					(attempt) =>
						(attempt.status === "queued" || attempt.status === "leased" || attempt.status === "running") &&
						runsAttempt(attempt, snapshot),
				);
			},
			isClosed: () => closed,
			close: async () => {
				if (closed) return;
				closed = true;
				const failures: unknown[] = [];
				for (const step of [
					() => workers.abort(),
					async () => notifications.dispose(),
					() => vehicle.disposeAndWait(),
					async () => hold.release(),
				]) {
					try {
						await step();
					} catch (error) {
						failures.push(error);
					}
				}
				if (failures.length > 0)
					throw new AggregateError(failures, "The parent opened away did not close cleanly.");
			},
		};
	} catch (error) {
		closed = true;
		try {
			await ephemeral?.disposeAndWait();
		} finally {
			hold.release();
		}
		throw error;
	}
}
