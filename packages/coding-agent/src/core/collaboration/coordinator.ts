import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { assertCollaborationNativeIdentity, classifyPaneOwnership } from "./session-recovery.ts";
import { type CollaborationStartIntent, collaborationSpecializationKey } from "./specialist-selection.ts";
import { waitForSteeringSettlement } from "./turn-settlement.ts";

export interface CollaborationAnswer {
	text?: string;
	keys?: string[];
}
/**
 * A member that fails to start is recycled on its own; healthy members keep running. This bounds the
 * recycle to one retry (two total attempts) — the codebase has no existing retry bound for
 * collaboration LAUNCHES to reuse (the closest relative, `CollaborationDeadlines`'s cleanup ladder in
 * deadlines.ts, bounds retrying a STOP after a turn deadline, a different operation, with a timed
 * backoff of its own); inventing a cooldown here is against doctrine, so a retry is immediate.
 */
const MEMBER_LAUNCH_RETRY_LIMIT = 1;
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
	/**
	 * Confirms a member's pane as the strategy's new placement anchor. Called only once that member's
	 * FULL launch (pane, startAgent, readiness) has succeeded — never speculatively inside
	 * `createNextPane` — so a member whose launch fails and is recycled never becomes the sibling the
	 * next member split from, and a retry of the same member re-splits from the correct predecessor.
	 */
	markPlaced(paneId: string): void;
}

class CurrentPanePlacementStrategy implements CollaborationPlacementStrategy {
	private readonly backend: CollaborationBackend;
	private readonly job: CollaborationJob;
	private readonly store: CollaborationJobStore;
	private lastPlacedPaneId?: string;

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
		this.lastPlacedPaneId = caller.paneId;
		return { workspaceId: caller.workspaceId };
	}

	async createNextPane(
		index: number,
		agent: CollaborationAgent,
		environment: Record<string, string>,
	): Promise<CollaborationPane> {
		const defaultDirection = index === 0 ? "right" : index === 1 ? "down" : index === 2 ? "right" : "down";
		const direction = agent.direction ?? defaultDirection;
		const splitTarget = index === 0 ? this.job.callerPaneId! : this.lastPlacedPaneId!;
		return this.backend.splitPane({
			paneId: splitTarget,
			direction,
			cwd: agent.cwd,
			env: environment,
		});
	}

	markPlaced(paneId: string): void {
		this.lastPlacedPaneId = paneId;
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

	/** No-op: every sibling split always targets the fixed root pane, never a prior member's pane. */
	markPlaced(): void {}
}

/** Single owner of persistent-agent lifecycle; backend adapters never publish parent messages. */
export class CollaborationCoordinator {
	private readonly deps: CollaborationCoordinatorDeps;
	private disposed = false;
	private readonly directories = new WorkerDirectoryAdmission();
	private readonly pendingAdmissions = new Map<string, { controller: AbortController; agents: ReadonlySet<string> }>();
	constructor(deps: CollaborationCoordinatorDeps) {
		this.deps = deps;
	}
	/** Native sessions and admitted finite helpers survive a parent reload; its callbacks do not. */
	dispose(): void {
		this.disposed = true;
		for (const pending of this.pendingAdmissions.values())
			pending.controller.abort(new Error("Collaboration coordinator is disposed."));
	}
	private assertActive(signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("Collaboration coordinator is disposed.");
	}
	private dispatch(job: CollaborationJob, agent: CollaborationAgent): void {
		if (this.disposed) return;
		const current = this.deps.store.load(job.id).agents.find((member) => member.id === agent.id);
		if (!current || current.turnId !== agent.turnId || (current.notifiedDispatchTurn ?? 0) >= agent.turn) return;
		if (current.notifiedDispatchTurn === undefined)
			this.deps.store.update(job.id, (latest) => {
				const member = latest.agents.find((item) => item.id === agent.id);
				if (member?.turnId === agent.turnId) member.notifiedDispatchTurn = 0;
			});
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
		this.deps.store.update(job.id, (latest) => {
			const member = latest.agents.find((item) => item.id === agent.id);
			if (member?.turnId === agent.turnId) member.notifiedDispatchTurn = agent.turn;
		});
	}
	async launch(
		input: NewCollaborationJob,
		task?: string,
		signal?: AbortSignal,
		intent: CollaborationStartIntent = {},
	): Promise<CollaborationJob> {
		this.assertActive(signal);
		if (this.pendingAdmissions.has(input.id)) throw new Error("Collaboration launch admission is already pending.");
		const pending = { controller: new AbortController(), agents: new Set(input.agents.map((agent) => agent.id)) };
		this.pendingAdmissions.set(input.id, pending);
		try {
			return await this.launchAdmitted(
				input,
				task,
				signal ? AbortSignal.any([signal, pending.controller.signal]) : pending.controller.signal,
				intent,
			);
		} finally {
			if (this.pendingAdmissions.get(input.id) === pending) this.pendingAdmissions.delete(input.id);
		}
	}
	/** Cancellation before admission creates no durable task and proves no native resource closure. */
	stopPendingAdmission(jobId: string, agentId?: string, dryRun = false): boolean {
		const pending = this.pendingAdmissions.get(jobId);
		if (
			!pending ||
			(agentId !== undefined && !pending.agents.has(agentId)) ||
			existsSync(this.deps.store.path(jobId))
		)
			return false;
		if (!dryRun) pending.controller.abort(new Error("Collaboration launch stopped during admission."));
		return true;
	}
	/**
	 * A managed workspace's first member's pane IS the workspace's root pane, created once by
	 * `strategy.init()` — there is no way to acquire a fresh pane for it short of recreating the whole
	 * workspace, which every other member's pane was split from (directly, or via the sibling chain).
	 * Its failure is team-scoped. Every other member's pane — an ordinary current-pane split, or a
	 * managed-workspace sibling split off the still-live root — is safe to close and recreate alone.
	 */
	private memberLaunchIsRecyclable(job: CollaborationJob, index: number): boolean {
		return !(job.placement === "managed-workspace" && index === 0);
	}
	/** Best-effort pane close between recycle attempts; no durable claim is made here. */
	private async courtesyClosePane(backend: CollaborationBackend, paneId: string): Promise<void> {
		try {
			await backend.closePane(paneId);
		} catch {
			// The stale pane may already be gone or unreachable; the retry below acquires a fresh one
			// regardless, so a failed courtesy close never blocks recycling.
		}
	}
	/** Drops a member's pane identity between recycle attempts so the next placement starts clean. */
	private clearMemberPane(store: CollaborationJobStore, jobId: string, agentId: string): void {
		store.update(jobId, (current) => {
			const member = current.agents.find((candidate) => candidate.id === agentId);
			if (member) {
				delete member.paneId;
				delete member.terminalId;
				delete member.backendName;
			}
		});
	}
	/** Frees a member's stale pane between recycle attempts so its next placement starts clean. */
	private async recycleReset(
		store: CollaborationJobStore,
		backend: CollaborationBackend,
		jobId: string,
		agentId: string,
		paneId: string | undefined,
	): Promise<void> {
		if (paneId) await this.courtesyClosePane(backend, paneId);
		this.clearMemberPane(store, jobId, agentId);
	}
	/**
	 * Acquires one member's pane, starts its agent and verifies readiness — the same sequence the
	 * launch loop always ran inline, extracted so a recycle attempt can rerun it from scratch. Throws
	 * on any failure; the caller decides whether that failure is team-scoped or recyclable.
	 */
	private async placeMember(
		store: CollaborationJobStore,
		backend: CollaborationBackend,
		strategy: CollaborationPlacementStrategy,
		job: CollaborationJob,
		index: number,
		signal: AbortSignal,
		environment: Record<string, string>,
	): Promise<CollaborationJob> {
		this.assertActive(signal);
		const agent = store.load(job.id).agents[index];
		if (agent.stopping || agent.closed) throw new Error("Collaboration launch was stopped.");
		// Durable before the request is issued: a lost reply must not read as "no resource".
		store.beginAcquisition(job.id, agent.id);
		const pane = await strategy.createNextPane(index, agent, environment);
		const name = `a-${agent.id.slice(0, 12)}-${randomUUID().slice(0, 12)}`;
		store.finishAcquisition(job.id, agent.id, {
			paneId: pane.paneId,
			terminalId: pane.terminalId,
			backendName: name,
		});
		// Pane creation is a real round trip, so a cancellation or an explicit stop can land while it is
		// in flight. Re-check only AFTER the pane is recorded above: cleanup finds owned panes through
		// the store, so checking any earlier would abandon the one just acquired.
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
		const updated = store.update(job.id, (current) => {
			const member = current.agents[index];
			if (member.stopping || member.closed) throw new Error("Collaboration launch was stopped.");
			member.paneId = started.paneId;
			member.terminalId = started.terminalId;
			member.backendName = name;
		});
		strategy.markPlaced(started.paneId);
		return updated;
	}
	/**
	 * Verified pane close: only closes when the backend proves the pane still holds this exact agent
	 * identity, mirroring session reconciliation's own verification (`classifyPaneOwnership`, shared
	 * so the two can never drift apart — never closes on the record's word alone). Returns whether the
	 * close is now provably clean: a confirmed different occupant needs no close but is just as
	 * conclusive as one, so it counts as clean too.
	 */
	private async verifiedClosePane(
		backend: CollaborationBackend,
		agent: { paneId?: string; terminalId?: string; backendName?: string },
	): Promise<boolean> {
		if (!agent.paneId) return true;
		const paneId = agent.paneId;
		let registered: { paneId: string; terminalId: string } | undefined;
		if (agent.backendName) {
			try {
				const current = await backend.getAgent(agent.backendName);
				registered = { paneId: current.paneId, terminalId: current.terminalId };
			} catch {
				// Agent name not registered in backend (e.g. failed during startAgent)
			}
		}
		try {
			const status = await classifyPaneOwnership(backend, { paneId, terminalId: agent.terminalId }, registered);
			if (status === "unverifiable") return false;
			if (status === "ours") await backend.closePane(paneId);
			return true;
		} catch {
			return false;
		}
	}
	/**
	 * Durable resolution once a member's stop intent (`beginStop`) is settled: a verified-clean close
	 * resolves the acquisition and finishes the stop as failed; an unresolved one is left uncertain,
	 * durably marked without ever claiming closure. Shared by the team-wide launch rollback and the
	 * per-member recycle-exhaustion path — the two places a launch failure is durably resolved.
	 */
	private resolveStoppedAgent(
		store: CollaborationJobStore,
		jobId: string,
		agent: CollaborationAgent,
		cleaned: boolean,
		detail: string,
	): void {
		if (cleaned) {
			store.finishAcquisition(jobId, agent.id);
			store.finishStop(jobId, agent.id, agent.turnId, "failed", detail);
		} else {
			store.update(jobId, (current) => {
				const member = current.agents.find((candidate) => candidate.id === agent.id);
				if (member) {
					member.status = "failed";
					member.evidence = `Launch cleanup uncertain: ${detail}; live work may remain active.`;
				}
			});
		}
	}
	/**
	 * Durable per-member launch failure resolution once its recycle budget is exhausted: the same
	 * verified-close-or-uncertain distinction the team-wide launch rollback uses (a `not-submitted`
	 * backend error proves no resource exists; anything else leaves the acquisition unresolved),
	 * scoped to one member. Never closes a workspace — recycling a member never tears down the team.
	 */
	private async resolveMemberLaunchFailure(
		store: CollaborationJobStore,
		backend: CollaborationBackend,
		job: CollaborationJob,
		agentId: string,
		error: unknown,
	): Promise<void> {
		const detail = error instanceof Error ? error.message : String(error);
		const acquisitionOutcomeUnknown =
			!(error instanceof CollaborationBackendError) || error.delivery !== "not-submitted";
		const before = store.load(job.id).agents.find((candidate) => candidate.id === agentId);
		const agent = store.beginStop(job.id, agentId, before?.turnId);
		if (!agent) return;
		const cleaned = agent.paneId
			? await this.verifiedClosePane(backend, agent)
			: !(agent.acquiring && acquisitionOutcomeUnknown);
		this.resolveStoppedAgent(store, job.id, agent, cleaned, detail);
	}
	private async launchAdmitted(
		input: NewCollaborationJob,
		task: string | undefined,
		signal: AbortSignal,
		intent: CollaborationStartIntent,
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
		this.assertActive(signal);
		// No asynchronous gap between ending preflight ownership and durable admission. Stops after
		// this point use the store's acquisition/turn fences, never the transient launch intent.
		this.pendingAdmissions.delete(input.id);
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

			// A member-scoped failure (its own pane acquisition, startAgent, readiness check, or its
			// launchTurn) never rolls back the whole team: it is recycled — cleaned up and retried up to
			// MEMBER_LAUNCH_RETRY_LIMIT extra times — and, if still failing, that member alone ends
			// failed while the rest of the team keeps running. A team-scoped failure (an external
			// cancel/dispose, an explicit stop racing the launch, or the unrecyclable managed-workspace
			// root member) is never recycled and falls straight through to the catch below.
			const recycledFailures = new Set<string>();
			for (let index = 0; index < job.agents.length; index++) {
				this.assertActive(signal);
				const agent = store.load(job.id).agents[index];
				if (agent.stopping || agent.closed) throw new Error("Collaboration launch was stopped.");
				const recyclable = this.memberLaunchIsRecyclable(job, index);
				for (let attempt = 1; ; attempt++) {
					try {
						job = await this.placeMember(store, backend, strategy, job, index, signal, peers.environments[index]);
						break;
					} catch (error) {
						if (signal.aborted || this.disposed) throw error;
						const current = store.load(job.id).agents[index];
						if (current.stopping || current.closed) throw error;
						if (!recyclable) throw error;
						if (attempt <= MEMBER_LAUNCH_RETRY_LIMIT) {
							await this.recycleReset(store, backend, job.id, current.id, current.paneId);
							continue;
						}
						await this.resolveMemberLaunchFailure(store, backend, job, current.id, error);
						recycledFailures.add(current.id);
						job = store.load(job.id);
						break;
					}
				}
			}
			this.assertActive(signal);
			if (task)
				for (let index = 0; index < job.agents.length; index++) {
					const memberId = job.agents[index].id;
					if (recycledFailures.has(memberId)) continue;
					const recyclable = this.memberLaunchIsRecyclable(job, index);
					for (let attempt = 1; ; attempt++) {
						this.assertActive(signal);
						const agent = store.load(job.id).agents.find((candidate) => candidate.id === memberId)!;
						if (agent.stopping || agent.closed) throw new Error("Collaboration launch was stopped.");
						try {
							await this.deps.launchTurn(job, agent);
							break;
						} catch (error) {
							if (signal.aborted || this.disposed) throw error;
							const current = store.load(job.id).agents.find((candidate) => candidate.id === memberId)!;
							if (current.stopping || current.closed) throw error;
							if (!recyclable) throw error;
							if (attempt <= MEMBER_LAUNCH_RETRY_LIMIT) {
								await this.recycleReset(store, backend, job.id, memberId, current.paneId);
								try {
									// A turn failure cannot trust the process behind it: recycling here redoes the
									// whole member launch, not just the turn delivery.
									job = await this.placeMember(
										store,
										backend,
										strategy,
										job,
										index,
										signal,
										peers.environments[index],
									);
								} catch (relaunchError) {
									if (signal.aborted || this.disposed) throw relaunchError;
									const afterRelaunch = store
										.load(job.id)
										.agents.find((candidate) => candidate.id === memberId)!;
									if (afterRelaunch.stopping || afterRelaunch.closed) throw relaunchError;
									await this.resolveMemberLaunchFailure(store, backend, job, memberId, relaunchError);
									recycledFailures.add(memberId);
									job = store.load(job.id);
									break;
								}
								continue;
							}
							await this.resolveMemberLaunchFailure(store, backend, job, memberId, error);
							recycledFailures.add(memberId);
							job = store.load(job.id);
							break;
						}
					}
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
							if (await this.verifiedClosePane(backend, agent)) cleanedAgentIds.add(agent.id);
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
			// Membership in `cleanedAgentIds` IS the evidence about the member's resource: a verified
			// pane close, a positively closed owned workspace, or a failure proven `not-submitted`.
			for (const agent of stopping) {
				if (!agent) continue;
				this.resolveStoppedAgent(store, job.id, agent, cleanedAgentIds.has(agent.id), detail);
			}
			this.refresh();
			throw error;
		}
	}
	private async resumeTeam(job: CollaborationJob, hasTask: boolean, signal?: AbortSignal): Promise<CollaborationJob> {
		const submitted = new Set<string>();
		try {
			// Capture host ownership at acceptance, before any asynchronous readiness callback. The
			// same durable publication receipt suppresses the ordinary launch path's second observation.
			if (hasTask) for (const agent of job.agents) this.dispatch(job, agent);
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
		// A reload may recover a terminal whose dispatch publication failed. Preserve ordering using
		// the same owner and durable receipt; never rerun the native prompt to recover a handoff.
		if (agent.notifiedDispatchTurn !== undefined) this.dispatch(job, agent);
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
		if (turnId === undefined && this.stopPendingAdmission(jobId, agentId)) return false;
		const stopped = await stopCollaborationAgent(this.deps.store, this.deps.backend, jobId, agentId, turnId, failure);
		this.refresh();
		return stopped;
	}
	async stop(jobId: string, dismiss = false): Promise<void> {
		if (this.stopPendingAdmission(jobId)) return;
		const store = this.deps.store;
		const job = store.load(jobId);
		if (dismiss) store.dismiss(jobId);
		else for (const agent of job.agents) await this.stopAgent(jobId, agent.id, agent.turnId);
		this.refresh();
	}
}
