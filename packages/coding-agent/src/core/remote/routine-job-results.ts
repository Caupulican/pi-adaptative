/** Resolve or stop jobs for an exact bot schedule occurrence through their authoritative placer records. */
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { RoutineDefinitionView, RoutineOccurrence } from "../routines/routine-contract.ts";
import { cleanRedactBound } from "../security/secret-text.ts";
import { endPlacedRecord } from "./job-client.ts";
import { splitRecordName } from "./job-record-name.ts";
import { endingOfCancel, JobStore, jobsDir, placedRecordName } from "./job-store.ts";
import { recentRoutineJobNames, stopRoutineJobScope } from "./routine-job-index.ts";
import { routineJobScope } from "./routine-job-origin.ts";

export function readRoutineBotJobResults(
	agentDir: string,
	occurrence: Pick<RoutineOccurrence, "target" | "occurrenceId">,
) {
	if (occurrence.target.kind !== "bot") return [];
	const scope = routineJobScope(occurrence.target.agentId, occurrence.occurrenceId);
	const store = new JobStore(agentDir);
	return recentRoutineJobNames(jobsDir(agentDir), scope).flatMap((name) => {
		const job = store.out.read(name);
		if (!job || job.routineScope !== scope || placedRecordName(job.executorId, job.jobId) !== name) return [];
		return [
			{
				jobId: job.jobId,
				machine: cleanRedactBound(job.executorName, 64),
				state: job.state,
				status: job.outcome?.status ?? job.refusal ?? job.ending,
				summary: job.outcome ? cleanRedactBound(job.outcome.summary, 240) : undefined,
			},
		];
	});
}

/** Both devices resolve the latest retained occurrence of this exact incarnation. Legacy jobs carry no fabricated association. */
export function routineJobStatusLines(
	store: PersistentBotTeamStore,
	routine: RoutineDefinitionView,
	latest?: ReadonlyMap<string, string>,
): string[] {
	if (routine.target.kind !== "bot" || routine.lastRunAt === undefined) return [];
	const occurrenceId = (latest ?? store.latestBotOccurrenceIds()).get(routine.incarnationId);
	if (!occurrenceId) return [];
	return readRoutineBotJobResults(store.getAgentDir(), { target: routine.target, occurrenceId }).map(
		(job) => `${job.machine} · ${job.jobId} · ${job.status ?? job.state}${job.summary ? ` · ${job.summary}` : ""}`,
	);
}

export function stopRoutineBotJobs(agentDir: string, bot: string, occurrenceIds: readonly string[]): number {
	const store = new JobStore(agentDir);
	let ended = 0;
	for (const id of occurrenceIds) {
		const scope = routineJobScope(bot, id);
		stopRoutineJobScope(jobsDir(agentDir), scope, (name) => {
			const job = splitRecordName(name);
			if (job && endPlacedRecord(agentDir, store, job.machineId, job.jobId, endingOfCancel("owner"), "owner", scope))
				ended++;
		});
	}
	return ended;
}
