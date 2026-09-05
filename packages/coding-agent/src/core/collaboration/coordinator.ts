import { randomUUID } from "node:crypto";
import type { ManagedLaneEvent } from "../extensions/types.ts";
import type { CollaborationBackend } from "./backend.ts";
import {
	boundCollaborationEvidence,
	type CollaborationAgent,
	type CollaborationJob,
	type CollaborationJobStore,
	collaborationLaneId,
	type NewCollaborationJob,
} from "./job-store.ts";
import { assertCollaborationReportCapability } from "./launch-profile.ts";
import { bootstrapCollaborationPeers } from "./peer-bootstrap.ts";

export interface CollaborationAnswer {
	text?: string;
	keys?: string[];
}
export interface CollaborationCoordinatorDeps {
	store: CollaborationJobStore;
	/** Creation is allowed only for an already-admitted new job, never recovery or cleanup. */
	backend(session: string, create?: boolean): Promise<CollaborationBackend>;
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
	if (agent.paneId) {
		if (!agent.backendName || !agent.terminalId)
			throw new Error("Cannot verify collaboration agent identity before stopping.");
		const backend = await backendFactory(job.sessionName, false);
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

/** Single owner of persistent-agent lifecycle; backend adapters never publish parent messages. */
export class CollaborationCoordinator {
	private readonly deps: CollaborationCoordinatorDeps;
	private disposed = false;
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
			goalId: job.goalId,
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
	async launch(input: NewCollaborationJob, task?: string, signal?: AbortSignal): Promise<CollaborationJob> {
		this.assertActive(signal);
		if (task && input.agents.length > 1) {
			const tasks = input.agents.map((agent) => agent.task?.trim());
			if (tasks.some((responsibility) => !responsibility) || new Set(tasks).size !== tasks.length)
				throw new Error("A multi-agent task requires distinct per-agent task responsibilities.");
		}
		if (task) for (const agent of input.agents) assertCollaborationReportCapability(agent.provider, agent.profile);
		const peers = bootstrapCollaborationPeers(input, this.deps.store.directory);
		const store = this.deps.store;
		let job = store.create(peers.job);
		let workspaceId: string | undefined;
		let backend: CollaborationBackend | undefined;
		try {
			backend = await this.deps.backend(input.sessionName, true);
			this.assertActive(signal);
			if (task) {
				for (const agent of job.agents) {
					const turn = store.reserveTurn(
						job.id,
						agent.id,
						agent.task ? `Team objective:\n${task}\n\nYour assigned responsibility:\n${agent.task}` : task,
					);
					this.dispatch(job, turn);
				}
			}
			this.assertActive(signal);
			const first = job.agents[0];
			const workspace = await backend.createWorkspace({
				cwd: first.cwd,
				env: peers.environments[0],
				label: job.title,
			});
			workspaceId = workspace.workspaceId;
			store.update(job.id, (current) => {
				current.workspaceId = workspace.workspaceId;
			});
			for (let index = 0; index < job.agents.length; index++) {
				this.assertActive(signal);
				const agent = store.load(job.id).agents[index];
				if (agent.stopping || agent.closed) throw new Error("Collaboration launch was stopped.");
				const pane =
					index === 0
						? workspace.rootPane
						: await backend.splitPane({
								paneId: workspace.rootPane.paneId,
								cwd: agent.cwd,
								env: peers.environments[index],
							});
				const name = `a-${agent.id.slice(0, 12)}-${randomUUID().slice(0, 12)}`;
				store.update(job.id, (current) => {
					const member = current.agents[index];
					member.paneId = pane.paneId;
					member.terminalId = pane.terminalId;
					member.backendName = name;
				});
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
			const stopping = store.load(job.id).agents.map((agent) => store.beginStop(job.id, agent.id, agent.turnId));
			if (workspaceId && backend) await backend.closeWorkspace(workspaceId);
			for (const agent of stopping) if (agent) store.finishStop(job.id, agent.id, agent.turnId, "failed", detail);
			this.refresh();
			throw error;
		}
	}
	async followup(
		jobId: string,
		agentId: string | undefined,
		text: string,
		answer?: CollaborationAnswer,
	): Promise<CollaborationAgent> {
		this.assertActive();
		this.refresh();
		const store = this.deps.store;
		const job = store.load(jobId);
		const target = job.agents.find((agent) => agent.id === (agentId ?? job.agents[0].id));
		if (!target?.backendName || !target.terminalId) throw new Error("Persistent agent has no live launch identity.");
		const agent = store.reserveTurn(jobId, target.id, text, !!answer);
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
				if (
					agent.stopping ||
					agent.turn === 0 ||
					agent.notifiedTurn >= agent.turn ||
					["idle", "reserved", "running"].includes(agent.status)
				)
					continue;
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
		}
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
