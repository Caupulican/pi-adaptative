import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PI_ORCHESTRATION_AGENT_ID_ENV } from "../process-identity.ts";
import { type CollaborationJob, collaborationLaneId, type NewCollaborationJob } from "./job-store.ts";
import { buildLaunchProfileFlags } from "./launch-profile.ts";

function digest(value: unknown): string {
	return createHash("sha256")
		.update(
			JSON.stringify(value, (_key, item: unknown) =>
				item && typeof item === "object" && !Array.isArray(item)
					? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
					: item,
			),
		)
		.digest("hex");
}

/** Compare compiled execution semantics, not request ids or generated launch provenance. */
export function collaborationSpecializationKey(input: NewCollaborationJob, workspaceKeys: readonly string[]): string {
	return digest({
		kind: "managed-native-team-v1",
		cwd: input.cwd,
		workspaceKeys,
		placement: input.placement ?? "managed-workspace",
		socketPath: input.socketPath,
		binPath: input.binPath,
		callerWorkspaceId: input.callerWorkspaceId,
		callerTabId: input.callerTabId,
		deadlineSeconds: input.deadlineSeconds,
		agents: input.agents.map((agent) => {
			const {
				identity: _identity,
				parentPid: _pid,
				parentSession: _parent,
				taskRef: _birthTask,
				...scope
			} = agent.profile;
			const generated =
				agent.provider === "pi"
					? buildLaunchProfileFlags(agent.profile).flatMap(({ flag, value }) =>
							value === undefined ? [flag] : [flag, value],
						)
					: [];
			// Strip only the exact compiler-owned suffix. Caller-supplied CLI arguments remain part of
			// the identity, even if they use the same flag names as generated arguments.
			const args =
				generated.length > 0 && isDeepStrictEqual(agent.args.slice(-generated.length), generated)
					? agent.args.slice(0, -generated.length)
					: agent.args;
			const env = { ...agent.env };
			if (env[PI_ORCHESTRATION_AGENT_ID_ENV] === collaborationLaneId(input.id, agent.id))
				delete env[PI_ORCHESTRATION_AGENT_ID_ENV];
			return {
				id: agent.id,
				name: agent.name,
				provider: agent.provider,
				cwd: agent.cwd,
				executable: agent.executable,
				args,
				env,
				profile: {
					...scope,
					allowedTools: [...scope.allowedTools].sort(),
					writePaths: [...scope.writePaths].sort(),
				},
			};
		}),
	});
}

export interface CollaborationStartIntent {
	jobId?: string;
	parallelWork?: { independent: true; justification: string };
}

export function collaborationStartDigest(
	input: NewCollaborationJob,
	task: string | undefined,
	intent: CollaborationStartIntent,
): string {
	return digest({
		key: input.specializationKey,
		task,
		goalId: input.goalId,
		responsibilities: input.agents.map((agent) => agent.task),
		...intent,
	});
}

/** The store calls this under its admission lock; actual turn reservation uses the job lock too. */
export function selectCollaborationSpecialist(
	jobs: readonly CollaborationJob[],
	input: NewCollaborationJob,
	intent: CollaborationStartIntent,
): CollaborationJob | undefined {
	if (intent.parallelWork) {
		if (
			intent.jobId ||
			intent.parallelWork.independent !== true ||
			!intent.parallelWork.justification?.trim() ||
			intent.parallelWork.justification.length > 4096
		)
			throw new Error("Invalid independent parallel work intent.");
		return undefined;
	}
	const matches = jobs.filter(
		(job) => job.specializationKey === input.specializationKey && (!intent.jobId || job.id === intent.jobId),
	);
	if (intent.jobId && matches.length === 0)
		throw new Error("Named collaboration specialist is unavailable or incompatible.");
	const idle = matches.filter(
		(job) =>
			!job.dismissed &&
			!job.mailbox.messages.length &&
			job.agents.every(
				(agent) =>
					!agent.closed &&
					!agent.stopping &&
					!agent.acquiring &&
					!agent.steering &&
					!agent.helperPid &&
					!agent.pendingQuestion &&
					["idle", "done"].includes(agent.status) &&
					agent.notifiedTurn >= agent.turn &&
					agent.turn < 128 &&
					agent.backendName &&
					agent.paneId &&
					agent.terminalId,
			),
	);
	if (idle.length > 1)
		throw new Error(`Collaboration specialist choice required: ${idle.map((job) => job.id).join(", ")}.`);
	if (idle.length === 1) return idle[0];
	if (matches.length)
		throw new Error("Collaboration specialist busy or unavailable; settle its pending work or question first.");
	return undefined;
}

export function collaborationAssignment(task: string, responsibility?: string): string {
	return responsibility && task !== responsibility
		? `Team objective:\n${task}\n\nYour assigned responsibility:\n${responsibility}`
		: task;
}
