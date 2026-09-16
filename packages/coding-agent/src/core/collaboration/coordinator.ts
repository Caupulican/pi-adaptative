import { randomUUID } from "node:crypto";
import { WorkerDirectoryAdmission } from "../delegation/worker-directory-admission.ts";
import type { ManagedLaneEvent } from "../extensions/types.ts";
import { type CollaborationBackend, CollaborationBackendError, type CollaborationPane } from "./backend.ts";
import {
	boundCollaborationEvidence,
	type CollaborationAgent,
	type CollaborationJob,
	type CollaborationJobStore,
	type CollaborationTaskCorrelation,
	collaborationLaneId,
	type NewCollaborationJob,
} from "./job-store.ts";
import { assertCollaborationReportCapability } from "./launch-profile.ts";
import { bootstrapCollaborationPeers } from "./peer-bootstrap.ts";
import { assertCollaborationNativeIdentity } from "./session-recovery.ts";
import { type CollaborationStartIntent, collaborationSpecializationKey } from "./specialist-selection.ts";
import { waitForSteeringSettlement } from "./turn-settlement.ts";

export interface CollaborationAnswer {
	text?: string;
	keys?: string[];
}
export interface CollaborationCoordinatorDeps {
	store: CollaborationJobStore;
	/** Creation is allowed only for an already-admitted new job, never recovery or cleanup. */
	backend(job: CollaborationJob, create?: boolean): Promise<CollaborationBackend>;
	launchTurn(job: CollaborationJob, agent: CollaborationAgent, answer?: CollaborationAnswer): Promise<void>;
	report(event: ManagedLaneEvent): void;
}

/** Helpers persist cleanup proof only; the owning parent publishes the durable handoff. */
export async function stopCollaborationAgent(
	store: CollaborationJobStore,
	backendFactory: CollaborationCoordinatorDeps["backend"],
	jobId: string,
	agentId: string,
	turnId?: string,
	failure?: string,
): Promise<boolean> {
	const job = store.load(jobId);
	const agent = store.beginStop(jobId, agentId, turnId);
	if (!agent) return false;
	if (agent.acquiring) {
		// The stop intent is now durable (`stopping`), which is what the outstanding acquisition's own
		// owner fences against before it starts a worker. Claiming closure here would be a cleanup
		// proof for a resource nobody has observed yet, and an absent paneId is not evidence that none
		// exists. The launch's own catch owns the rollback once the acquisition resolves.
		return false;
	}
	if (agent.paneId) {
		if (!agent.backendName || !agent.terminalId)
			throw new Error("Cannot verify collaboration agent identity before stopping.");
		const backend = await backendFactory(job, false);
		const current = await backend.getAgent(agent.backendName);
		if (current.paneId !== agent.paneId || current.terminalId !== agent.terminalId)
			throw new Error("Collaboration pane occupant identity changed; refusing to stop it.");
		await backend.closePane(agent.paneId);
	} else if (agent.helperPid || agent.status === "running") {
		throw new Error("Cannot prove collaboration worker stopped without a pane identity.");
	}
	return store.finishStop(
		jobId,
		agent.id,
		agent.turnId,
		failure ? "failed" : "stopped",
		failure ?? "Owned collaboration agent stopped.",
	);
}

interface CollaborationPlacementStrategy {
	init(): Promise<{ workspaceId: string }>;
	createNextPane(
		index: number,
		agent: CollaborationAgent,
		environment: Record<string, string>,
	): Promise<CollaborationPane>;
}

class CurrentPanePlacementStrategy implements CollaborationPlacementStrategy {
	private readonly backend: CollaborationBackend;
	private readonly job: CollaborationJob;
	private readonly store: CollaborationJobStore;
	private previousSiblingPaneId?: string;

	constructor(backend: CollaborationBackend, job: CollaborationJob, store: CollaborationJobStore) {
		this.backend = backend;
		this.job = job;
		this.store = store;
	}

	async init(): Promise<{ workspaceId: string }> {
		if (!this.job.callerPaneId) throw new Error("Missing caller pane handle for current-pane placement.");
		const caller = await this.backend.getPane(this.job.callerPaneId);
		if (
			caller.paneId !== this.job.callerPaneId ||
			(this.job.callerWorkspaceId && caller.workspaceId !== this.job.callerWorkspaceId) ||
			(this.job.callerTabId && caller.tabId !== this.job.callerTabId)
		)
			throw new Error("Caller pane handle is stale, moved or replaced; refusing to mutate shared session.");
		if (this.job.callerTerminalId && caller.terminalId !== this.job.callerTerminalId)
			throw new Error("Caller terminal handle changed; refusing to mutate shared session.");

		this.store.update(this.job.id, (current) => {
			current.workspaceId = caller.workspaceId;
			current.callerTerminalId = caller.terminalId;
		});
		this.previousSiblingPaneId = caller.paneId;
		return { workspaceId: caller.workspaceId };
	}

	async createNextPane(
		index: number,
		agent: CollaborationAgent,
		environment: Record<string, string>,
	): Promise<CollaborationPane> {
		const defaultDirection = index === 0 ? "right" : index === 1 ? "down" : index === 2 ? "right" : "down";
		const direction = agent.direction ?? defaultDirection;
		const splitTarget = index === 0 ? this.job.callerPaneId! : this.previousSiblingPaneId!;
		const pane = await this.backend.splitPane({
			paneId: splitTarget,
			direction,
			cwd: agent.cwd,
			env: environment,
		});
		this.previousSiblingPaneId = pane.paneId;
		return pane;
	}
}

class ManagedWorkspacePlacementStrategy implements CollaborationPlacementStrategy {
	private readonly backend: CollaborationBackend;
	private readonly job: CollaborationJob;
	private readonly store: CollaborationJobStore;
	private readonly environments: readonly Record<string, string>[];
	private rootPane?: CollaborationPane;

	constructor(
		backend: CollaborationBackend,
		job: CollaborationJob,
		store: CollaborationJobStore,
		environments: readonly Record<string, string>[],
	) {
		this.backend = backend;
		this.job = job;
		this.store = store;
		this.environments = environments;
	}

	async init(): Promise<{ workspaceId: string }> {
		const first = this.job.agents[0];
		const workspace = await this.backend.createWorkspace({
			cwd: first.cwd,
			env: this.environments[0],
			label: this.job.title,
		});
		this.rootPane = workspace.rootPane;
		this.store.update(this.job.id, (current) => {
			current.workspaceId = workspace.workspaceId;
		});
		return { workspaceId: workspace.workspaceId };
	}

	async createNextPane(
		index: number,
		agent: CollaborationAgent,
		environment: Record<string, string>,
	): Promise<CollaborationPane> {
		if (index === 0 && this.rootPane) return this.rootPane;
		return this.backend.splitPane({
			paneId: this.rootPane!.paneId,
			cwd: agent.cwd,
			env: environment,
		});
	}
}

/** Single owner of persistent-agent lifecycle; backend adapters never publish parent messages. */
export class CollaborationCoordinator {
	private readonly deps: CollaborationCoordinatorDeps;
	private disposed = false;
	private readonly directories = new WorkerDirectoryAdmission();
	constructor(deps: CollaborationCoordinatorDeps) {
		this.deps = deps;
	}
	/** Native sessions and admitted finite helpers survive a parent reload; its callbacks do not. */
	dispose(): void {
		this.disposed = true;
	}
	private assertActive(signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("Collaboration coordinator is disposed.");
	}
	private dispatch(job: CollaborationJob, agent: CollaborationAgent): void {
		this.deps.report({
			laneId: collaborationLaneId(job.id, agent.id),
			phase: "dispatch",
			goalId: agent.taskCorrelation?.goalId,
			worktreeLaneKey: agent.profile.worktreeLane,
			dispatch: {
				sequence: agent.turn,
				instructions: agent.prompt,
				profileId: agent.profile.identity,
				provider: agent.provider,
				authorizationId: agent.profile.identity,
				authorizationKind: "profile-derived",
				allowedTools: agent.profile.allowedTools,
				writePaths: agent.profile.writePaths,
				leaseTtlMs: job.deadlineSeconds * 1000,
			},
		});
	}
	async launch(
		input: NewCollaborationJob,
		task?: string,
		signal?: AbortSignal,
		intent: CollaborationStartIntent = {},
	): Promise<CollaborationJob> {
		this.assertActive(signal);
		if (task && input.agents.length > 1) {
			const tasks = input.agents.map((agent) => agent.task?.trim());
			if (tasks.some((responsibility) => !responsibility) || new Set(tasks).size !== tasks.length)
				throw new Error("A multi-agent task requires distinct per-agent task responsibilities.");
		}
		if (task) for (const agent of input.agents) assertCollaborationReportCapability(agent.provider, agent.profile);
		const workspaceKeys = await Promise.all(
			[input.cwd, ...input.agents.map((agent) => agent.cwd)].map((cwd) =>
				this.directories.namespaceKey(cwd, signal),
			),
		);
		this.assertActive(signal);
		const peers = bootstrapCollaborationPeers(
			{ ...input, specializationKey: collaborationSpecializationKey(input, workspaceKeys) },
			this.deps.store.directory,
		);
		const store = this.deps.store;
		this.refresh();
		const admission = store.admit(peers.job, task, intent);
		if (admission.kind === "replay") return admission.job;
		if (admission.kind === "reuse") return this.resumeTeam(admission.job, !!task, signal);
		let job = admission.job;
		let workspaceId: string | undefined;
		let backend: CollaborationBackend | undefined;
		try {
			backend = await this.deps.backend(job, true);
			this.assertActive(signal);
			if (task) {
				for (const agent of job.agents) {
					this.dispatch(job, agent);
				}
			}
			this.assertActive(signal);
			const strategy: CollaborationPlacementStrategy =
				job.placement === "current-pane"
					? new CurrentPanePlacementStrategy(backend, job, store)
					: new ManagedWorkspacePlacementStrategy(backend, job, store, peers.environments);

			// A managed workspace is created by `init()`, before any member reaches the per-member
			// acquisition below. Without a durable marker, a lost or late reply leaves every member
			// with no paneId and no outstanding acquisition, which the cleanup below would read as
			// proof that nothing was created. Current-pane placement only reads the caller's existing
			// pane, so it creates nothing here.
			if (job.placement === "managed-workspace")
				for (const agent of job.agents) store.beginAcquisition(job.id, agent.id);

			const init = await strategy.init();
			workspaceId = init.workspaceId;

			for (let index = 0; index < job.agents.length; index++) {
				this.assertActive(signal);
				const agent = store.load(job.id).agents[index];
				if (agent.stopping || agent.closed) throw new Error("Collaboration launch was stopped.");
				// Durable before the request is issued: a lost reply must not read as "no resource".
				store.beginAcquisition(job.id, agent.id);
				const pane = await strategy.createNextPane(index, agent, peers.environments[index]);
				const name = `a-${agent.id.slice(0, 12)}-${randomUUID().slice(0, 12)}`;
				store.finishAcquisition(job.id, agent.id, {
					paneId: pane.paneId,
					terminalId: pane.terminalId,
					backendName: name,
				});
				// Pane creation is a real round trip, so a cancellation or an explicit stop can land while
				// it is in flight. Re-check only AFTER the pane is recorded above: the catch block's
				// cleanup finds owned panes through the store, so checking any earlier would abandon the
				// one just acquired.
				this.assertActive(signal);
				const acquired = store.load(job.id).agents[index];
				if (acquired.stopping || acquired.closed) throw new Error("Collaboration launch was stopped.");
				const started = await backend.startAgent({
					name,
					kind: agent.provider,
					paneId: pane.paneId,
					args: agent.args,
					executable: agent.executable,
				});
				if (
					!started.interactiveReady ||
					started.launchPending ||
					started.paneId !== pane.paneId ||
					started.terminalId !== pane.terminalId
				)
					throw new Error(`Agent ${agent.name} is not interactively ready on the expected pane.`);
				job = store.update(job.id, (current) => {
					const member = current.agents[index];
					if (member.stopping || member.closed) throw new Error("Collaboration launch was stopped.");
					member.paneId = started.paneId;
					member.terminalId = started.terminalId;
					member.backendName = name;
				});
			}
			this.assertActive(signal);
			if (task)
				for (const member of job.agents) {
					this.assertActive(signal);
					const agent = store.load(job.id).agents.find((candidate) => candidate.id === member.id)!;
					if (agent.stopping || agent.closed) throw new Error("Collaboration launch was stopped.");
					await this.deps.launchTurn(job, agent);
				}
			return store.load(job.id);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// `unknown` delivery means the backend may have created the resource before the reply was
			// lost. Only `not-submitted` proves nothing was created; anything else leaves an outstanding
			// acquisition uncertain rather than cleanly closed.
			const acquisitionOutcomeUnknown =
				!(error instanceof CollaborationBackendError) || error.delivery !== "not-submitted";
			const loaded = store.load(job.id);
			const stopping = loaded.agents.map((agent) => store.beginStop(job.id, agent.id, agent.turnId));
			const cleanedAgentIds = new Set<string>();
			if (job.placement === "current-pane") {
				if (backend) {
					for (const agent of loaded.agents) {
						if (agent.paneId && agent.paneId !== job.callerPaneId) {
							try {
								let verified = false;
								if (agent.backendName) {
									try {
										const current = await backend.getAgent(agent.backendName);
										if (
											current.paneId === agent.paneId &&
											(!agent.terminalId || current.terminalId === agent.terminalId)
										) {
											verified = true;
										}
									} catch {
										// Agent name not registered in backend (e.g. failed during startAgent)
									}
								}
								if (!verified && agent.terminalId) {
									const currentPane = await backend.getPane(agent.paneId);
									if (currentPane.terminalId === agent.terminalId) {
										verified = true;
									}
								}
								if (verified) {
									await backend.closePane(agent.paneId);
									cleanedAgentIds.add(agent.id);
								}
							} catch {
								// Cleanup failed; pane remains live or uncertain
							}
						} else if (!agent.paneId && !(agent.acquiring && acquisitionOutcomeUnknown)) {
							cleanedAgentIds.add(agent.id);
						}
					}
				} else {
					for (const agent of loaded.agents) {
						if (!agent.paneId && !(agent.acquiring && acquisitionOutcomeUnknown)) cleanedAgentIds.add(agent.id);
					}
				}
			} else if (workspaceId && backend) {
				try {
					await backend.closeWorkspace(workspaceId);
					for (const agent of loaded.agents) cleanedAgentIds.add(agent.id);
				} catch {
					// closeWorkspace failed
				}
			} else {
				for (const agent of loaded.agents) {
					if (!agent.paneId && !(agent.acquiring && acquisitionOutcomeUnknown)) cleanedAgentIds.add(agent.id);
				}
			}
			for (const agent of stopping) {
				if (!agent) continue;
				if (cleanedAgentIds.has(agent.id)) {
					// Membership in this set IS the evidence about the member's resource: a verified pane
					// close, a positively closed owned workspace, or a failure proven `not-submitted`.
					// Resolving the acquisition here is what lets the store record durable closure; the
					// store itself never resolves one on the caller's word.
					store.finishAcquisition(job.id, agent.id);
					store.finishStop(job.id, agent.id, agent.turnId, "failed", detail);
				} else {
					store.update(job.id, (current) => {
						const member = current.agents.find((m) => m.id === agent.id);
						if (member) {
							member.status = "failed";
							member.evidence = `Launch cleanup uncertain: ${detail}; live work may remain active.`;
						}
					});
				}
			}
			this.refresh();
			throw error;
		}
	}
	private async resumeTeam(job: CollaborationJob, hasTask: boolean, signal?: AbortSignal): Promise<CollaborationJob> {
		const submitted = new Set<string>();
		try {
			const backend = await this.deps.backend(job, false);
			this.assertActive(signal);
			// Verify every member before delivering any new prompt; team membership and peer credentials
			// stay immutable. This is identity/readiness preflight, never output-based completion polling.
			for (const agent of job.agents) {
				const actual = await backend.getAgent(agent.backendName!);
				this.assertActive(signal);
				assertCollaborationNativeIdentity(agent, actual);
				if (!actual.interactiveReady || actual.launchPending || !["idle", "done"].includes(actual.status))
					throw new Error(`Collaboration specialist ${agent.id} is unavailable in its native session.`);
			}
			if (hasTask)
				for (const agent of job.agents) {
					this.assertActive(signal);
					submitted.add(agent.id);
					await this.launchReservedTurn(job, agent);
				}
			return this.deps.store.load(job.id);
		} catch (error) {
			// An unsubmitted member has no native work to cancel. Persist and publish its failed task
			// without closing a possibly replaced pane or resubmitting an uncertain earlier delivery.
			if (hasTask)
				for (const agent of job.agents) {
					if (submitted.has(agent.id)) continue;
					this.deps.store.finishTurn(
						job.id,
						agent.id,
						agent.turnId,
						"failed",
						`Specialist reuse refused: ${String(error).slice(0, 1000)}`,
					);
					this.dispatch(job, agent);
				}
			this.refresh();
			throw error;
		}
	}
	async followup(
		jobId: string,
		agentId: string | undefined,
		text: string,
		answer?: CollaborationAnswer,
		options?: { steer?: boolean; newTask?: CollaborationTaskCorrelation },
	): Promise<CollaborationAgent> {
		this.assertActive();
		this.refresh();
		const store = this.deps.store;
		const job = store.load(jobId);
		const target = job.agents.find((agent) => agent.id === (agentId ?? job.agents[0].id));
		if (!target?.backendName || !target.terminalId || !target.paneId)
			throw new Error("Persistent agent has no live launch identity.");

		const isStoreActive = ["reserved", "running"].includes(target.status);

		if (target.provider === "agy") {
			const backend = await this.deps.backend(job, false);
			const live = await backend.getAgent(target.backendName);
			if (live.paneId !== target.paneId || live.terminalId !== target.terminalId)
				throw new Error("Collaboration pane occupant changed before follow-up.");

			const isRunning = isStoreActive || live.status === "working";
			if (isRunning) {
				if (!isStoreActive) {
					throw new Error(
						`Collaboration agent ${target.id} is working without an active turn in the store (status: ${target.status}, native: ${live.status}); refusing to interrupt untracked work.`,
					);
				}
				if (options?.steer === false) {
					throw new Error(
						"Cannot queue follow-up to running agent without steering interrupt; pass steer: true or await current turn completion.",
					);
				}
				if (!backend.sendKeys) {
					throw new Error("Backend does not support key transmission for steering.");
				}
				if (!backend.subscribeEvents) {
					throw new Error("Backend does not support event-driven steering notification; refusing to steer.");
				}

				let committed = false;
				const steering = store.beginSteering(job.id, target.id, target.turnId, text, !!answer);
				try {
					this.assertActive();
					await backend.sendKeys(target.backendName, ["esc"]);
					await waitForSteeringSettlement({
						backend,
						target: target.backendName,
						terminalId: target.terminalId,
						paneId: target.paneId,
					});
					this.assertActive();
					store.commitSteering(job.id, target.id, steering.requestId);
					committed = true;
					this.refresh();
				} catch (error) {
					if (!committed) {
						store.abortSteering(job.id, target.id, steering.requestId, String(error));
					}
					throw error;
				}
			}
		} else if (isStoreActive) {
			if (options?.steer === false) {
				throw new Error(
					"Cannot queue follow-up to running agent without steering interrupt; pass steer: true or await current turn completion.",
				);
			}
			throw new Error(
				`Cannot steer running agent for provider "${target.provider}"; only agy supports interactive steering.`,
			);
		}

		this.assertActive();
		this.refresh();
		const agent = store.reserveTurn(jobId, target.id, text, !!answer, options?.newTask);
		await this.launchReservedTurn(job, agent, answer);
		return agent;
	}
	private async launchReservedTurn(
		job: CollaborationJob,
		agent: CollaborationAgent,
		answer?: CollaborationAnswer,
	): Promise<void> {
		try {
			this.assertActive();
			this.dispatch(job, agent);
			await this.deps.launchTurn(job, agent, answer);
		} catch (error) {
			await this.stopAgent(
				job.id,
				agent.id,
				agent.turnId,
				`Follow-up failed; delivery is uncertain and will not be replayed. ${String(error).slice(0, 1000)}`,
			);
			throw error;
		}
	}
	/** Call only on a persisted-state event or startup reconciliation. Reservation fences concurrent drains. */
	async drainPeerMessages(availableJobs?: ReadonlySet<string>): Promise<void> {
		if (this.disposed) return;
		this.refresh();
		for (const job of this.deps.store.list()) {
			if ((availableJobs && !availableJobs.has(job.id)) || !job.mailbox.messages.length || job.dismissed) continue;
			for (const agentId of new Set(job.mailbox.messages.map((message) => message.recipientId))) {
				if (this.disposed) return;
				const agent = this.deps.store.reservePeerTurn(job.id, agentId);
				if (agent) await this.launchReservedTurn(job, agent);
			}
		}
	}
	/** Called by a durable-state filesystem event or one restoration reconciliation, never a poll. */
	refresh(): void {
		if (this.disposed) return;
		const store = this.deps.store;
		for (const job of store.list()) {
			for (const agent of job.agents) {
				this.publishTurnTerminal(job, agent);
				this.publishAgentClosure(job, agent.id);
			}
		}
	}
	/** One durable turn terminal, published at most once per turn. */
	private publishTurnTerminal(job: CollaborationJob, agent: CollaborationAgent): void {
		const store = this.deps.store;
		if (
			agent.stopping ||
			agent.turn === 0 ||
			agent.notifiedTurn >= agent.turn ||
			["idle", "reserved", "running"].includes(agent.status)
		)
			return;
		this.deps.report({
			laneId: collaborationLaneId(job.id, agent.id),
			phase: "terminal",
			status: agent.status,
			dispatchSequence: agent.turn,
			summary: boundCollaborationEvidence(agent.evidence),
			usage: agent.usage,
			reasonCode: agent.status === "blocked" ? "collaboration_question_or_blocker" : "collaboration_terminal",
		});
		// The host persisted its terminal/outbox before returning. This is only duplicate suppression.
		store.update(job.id, (current) => {
			const member = current.agents.find((item) => item.id === agent.id);
			if (member?.turnId === agent.turnId) member.notifiedTurn = agent.turn;
		});
	}
	/**
	 * The persistent CLI's own closure. A turn reaching terminal does not close the agent behind it,
	 * and closing the agent does not advance its turn, so this is published as a distinct lifetime
	 * statement -- never by re-finishing a completed turn -- and only once the member's last turn has
	 * already been published, so the work's terminal always precedes the process's closure.
	 */
	private publishAgentClosure(job: CollaborationJob, agentId: string): void {
		const store = this.deps.store;
		const agent = store.load(job.id).agents.find((member) => member.id === agentId);
		if (!agent?.closed || agent.notifiedClosure || agent.notifiedTurn < agent.turn) return;
		this.deps.report({
			laneId: collaborationLaneId(job.id, agent.id),
			phase: "lifecycle",
			...(agent.turn > 0 ? { dispatchSequence: agent.turn } : {}),
			agentLifecycle: "retired",
		});
		store.update(job.id, (current) => {
			const member = current.agents.find((item) => item.id === agent.id);
			if (member) member.notifiedClosure = true;
		});
	}
	async stopAgent(jobId: string, agentId: string, turnId?: string, failure?: string): Promise<boolean> {
		const stopped = await stopCollaborationAgent(this.deps.store, this.deps.backend, jobId, agentId, turnId, failure);
		this.refresh();
		return stopped;
	}
	async stop(jobId: string, dismiss = false): Promise<void> {
		const store = this.deps.store;
		const job = store.load(jobId);
		if (dismiss) store.dismiss(jobId);
		else for (const agent of job.agents) await this.stopAgent(jobId, agent.id, agent.turnId);
		this.refresh();
	}
}
