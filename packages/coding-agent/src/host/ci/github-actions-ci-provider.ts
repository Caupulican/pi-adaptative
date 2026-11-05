import { execFile, spawn } from "node:child_process";
import {
	CI_TERMINAL_CONCLUSIONS,
	type CiAttemptIdentity,
	type CiAttemptTerminalEvent,
	type CiCurrentObservation,
	type CiSubject,
	createCiAttemptTerminalEvent,
} from "../../core/events/host-event-contract.ts";
import { bindChildProcessAbort } from "../../utils/child-process.ts";
import type {
	CiCommandPort,
	CiProvider,
	CiProviderCollection,
	CiRepository,
	CiRetiredRunRange,
} from "./ci-provider.ts";

const MAX_RUNS = 100;
const MAX_ATTEMPTS = 128;
const MAX_JOBS = 100;

class CiSnapshotChangedError extends Error {}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub CI object.");
	return value as Record<string, unknown>;
}

function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error("Invalid GitHub CI identifier.");
	return value;
}

function text(value: unknown, limit = 2048): string {
	if (typeof value !== "string" || !value || value.length > limit) throw new Error("Invalid GitHub CI text.");
	return value;
}

/** A command that could not start is reported as unavailable, not as a CI outcome. */
export function isCiCommandMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function createCiCommandPort(cwd: string, onDiagnostic?: (message: string) => void): CiCommandPort {
	return {
		run: (executable, args, signal) =>
			new Promise<string>((resolve, reject) => {
				signal.throwIfAborted();
				let spawned = false;
				let closed = false;
				let outcome: { error: Error | null; stdout: string } | undefined;
				const finish = () => {
					// A process that never spawned owns no pipes and emits no close.
					if (!outcome || (spawned && !closed)) return;
					if (signal.aborted) reject(signal.reason);
					else if (outcome.error) reject(outcome.error);
					else resolve(outcome.stdout);
				};
				const child = execFile(
					executable,
					[...args],
					{ cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
					(error, stdout) => {
						outcome = { error, stdout };
						finish();
					},
				);
				child.once("spawn", () => {
					spawned = true;
				});
				// An execFile error callback can precede physical close. Retain command
				// capacity and source custody until the process and its pipes have ended.
				child.once("close", () => {
					closed = true;
					finish();
				});
				bindChildProcessAbort(child, signal, onDiagnostic ? { onDiagnostic } : {});
			}),
		wait: (executable, args, signal) =>
			new Promise<void>((resolve, reject) => {
				signal.throwIfAborted();
				let spawned = false;
				let settled = false;
				let failure: Error | undefined;
				let stderr = "";
				const settle = (code: number | null, signalCode: NodeJS.Signals | null) => {
					if (settled) return;
					settled = true;
					if (signal.aborted) reject(signal.reason);
					else if (failure) reject(failure);
					else if (code === 0) resolve();
					else
						reject(
							new Error(
								`${executable} ${args.slice(0, 2).join(" ")} ended with ${code ?? signalCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
							),
						);
				};
				// Output is never buffered: a long watch cannot exhaust memory or a buffer bound.
				const child = spawn(executable, [...args], { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (chunk: string) => {
					stderr = `${stderr}${chunk}`.slice(-2048);
				});
				child.once("spawn", () => {
					spawned = true;
				});
				child.once("error", (error) => {
					failure = error;
					if (!spawned) settle(null, null);
				});
				child.once("close", (code, signalCode) => settle(code, signalCode));
				bindChildProcessAbort(child, signal, onDiagnostic ? { onDiagnostic } : {});
			}),
	};
}

/** All observations are pinned to repository/workflow/SHA and immutable run-attempt identity. */
export class GithubActionsCiProvider implements CiProvider {
	private readonly port: CiCommandPort;
	private readonly workflow: string;
	private cachedRepository?: CiRepository;

	constructor(port: CiCommandPort, workflow = "ci.yml") {
		this.port = port;
		this.workflow = workflow;
	}

	private async api(path: string, host: string, signal: AbortSignal): Promise<unknown> {
		return JSON.parse(await this.port.run("gh", ["api", "--hostname", host, path], signal));
	}

	async repository(signal: AbortSignal): Promise<CiRepository> {
		if (this.cachedRepository) return this.cachedRepository;
		const view = record(
			JSON.parse(await this.port.run("gh", ["repo", "view", "--json", "nameWithOwner,url"], signal)),
		);
		const nameWithOwner = text(view.nameWithOwner, 256);
		if (!/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) throw new Error("Invalid GitHub repository name.");
		const url = new URL(text(view.url));
		if (url.protocol !== "https:") throw new Error("GitHub repository URL must use HTTPS.");
		const host = url.host.toLowerCase();
		const repository = record(await this.api(`repos/${nameWithOwner}`, host, signal));
		const workflow = record(
			await this.api(`repos/${nameWithOwner}/actions/workflows/${encodeURIComponent(this.workflow)}`, host, signal),
		);
		const result = {
			host,
			nameWithOwner,
			repositoryId: positive(repository.id),
			workflowId: positive(workflow.id),
			workflowPath: text(workflow.path),
		};
		this.cachedRepository = result;
		return result;
	}

	async collect(
		headSha: string,
		signal: AbortSignal,
		retainedAttempts: ReadonlyMap<number, number> = new Map(),
		retiredRuns: readonly CiRetiredRunRange[] = [],
	): Promise<CiProviderCollection> {
		for (let retry = 0; ; retry++) {
			try {
				return await this.collectSnapshot(headSha, signal, retainedAttempts, retiredRuns);
			} catch (error) {
				if (!(error instanceof CiSnapshotChangedError) || retry === 2) throw error;
			}
		}
	}

	private async collectSnapshot(
		headSha: string,
		signal: AbortSignal,
		retainedAttempts: ReadonlyMap<number, number>,
		retiredRuns: readonly CiRetiredRunRange[],
	): Promise<CiProviderCollection> {
		if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(headSha)) throw new Error("Invalid CI subject SHA.");
		const repository = await this.repository(signal);
		const subject: CiSubject = {
			host: repository.host,
			repositoryId: repository.repositoryId,
			workflowId: repository.workflowId,
			headSha,
		};
		const path = `repos/${repository.nameWithOwner}/actions`;
		const listing = record(
			await this.api(
				`${path}/workflows/${repository.workflowId}/runs?head_sha=${headSha}&per_page=${MAX_RUNS}`,
				repository.host,
				signal,
			),
		);
		if (
			!Array.isArray(listing.workflow_runs) ||
			typeof listing.total_count !== "number" ||
			listing.total_count > MAX_RUNS
		)
			throw new Error("CI run discovery exceeds its complete-snapshot bound.");
		const events: CiAttemptTerminalEvent[] = [];
		const retired = (runNumber: number): boolean =>
			retiredRuns.some((range) => runNumber >= range.from && runNumber <= range.through);
		// Only dropped custody is retired. When the newest run is among it, no current attempt can be
		// proven: the subject is reported as predating retention instead of selecting an older run.
		const newest = Math.max(0, ...listing.workflow_runs.map((value) => positive(record(value).run_number)));
		const predatesRetention = newest > 0 && retired(newest);
		let current: CiCurrentObservation | undefined;
		for (const value of listing.workflow_runs) {
			const listed = record(value);
			if (retired(positive(listed.run_number))) continue;
			const runId = positive(listed.id);
			const maxAttempt = positive(listed.run_attempt);
			if (maxAttempt - (retainedAttempts.get(runId) ?? 0) > MAX_ATTEMPTS)
				throw new Error("CI attempt discovery exceeds its complete-snapshot bound.");
			for (
				let attempt = Math.min((retainedAttempts.get(runId) ?? 0) + 1, maxAttempt);
				attempt <= maxAttempt;
				attempt++
			) {
				signal.throwIfAborted();
				const run = record(await this.api(`${path}/runs/${runId}/attempts/${attempt}`, repository.host, signal));
				if (
					run.id !== runId ||
					run.run_attempt !== attempt ||
					run.head_sha !== headSha ||
					run.workflow_id !== repository.workflowId ||
					record(run.repository).id !== repository.repositoryId
				)
					throw new Error("GitHub returned a different CI attempt than requested.");
				const runNumber = positive(run.run_number);
				if (runNumber !== listed.run_number) throw new Error("GitHub CI run order changed during collection.");
				const identity: CiAttemptIdentity = {
					provider: "github-actions",
					host: repository.host,
					repositoryId: repository.repositoryId,
					workflowId: repository.workflowId,
					runId,
					runAttempt: attempt,
					runNumber,
				};
				let event: CiAttemptTerminalEvent | undefined;
				if (run.status === "completed") {
					const conclusion = CI_TERMINAL_CONCLUSIONS.find((value) => value === run.conclusion);
					if (!conclusion) throw new Error("Unknown GitHub CI terminal conclusion.");
					event = createCiAttemptTerminalEvent({
						identity,
						headSha,
						conclusion,
						workflowPath: repository.workflowPath,
						observedAt: new Date().toISOString(),
						runUrl: text(run.html_url),
					});
					events.push(event);
				}
				const observation: CiCurrentObservation = {
					subject,
					runId,
					runNumber,
					runAttempt: attempt,
					status:
						run.status === "completed" ? "completed" : run.status === "in_progress" ? "in_progress" : "queued",
					...(event ? { conclusion: event.conclusion, eventId: event.eventId } : {}),
				};
				if (
					!current ||
					runNumber > current.runNumber ||
					(runNumber === current.runNumber && attempt > current.runAttempt)
				)
					current = observation;
			}
		}
		// A rerun/new run admitted during the reads invalidates the snapshot. Never seal the
		// old failure merely because its attempt endpoint completed first.
		const after = record(
			await this.api(
				`${path}/workflows/${repository.workflowId}/runs?head_sha=${headSha}&per_page=${MAX_RUNS}`,
				repository.host,
				signal,
			),
		);
		const frontier = (value: unknown): string => {
			if (!Array.isArray(value)) throw new Error("Invalid CI run frontier.");
			return JSON.stringify(
				value
					.map(record)
					.map((run) => [run.id, run.run_number, run.run_attempt, run.status, run.conclusion])
					.sort((a, b) => Number(a[0]) - Number(b[0])),
			);
		};
		if (
			after.total_count !== listing.total_count ||
			frontier(after.workflow_runs) !== frontier(listing.workflow_runs)
		)
			throw new CiSnapshotChangedError("CI run frontier changed during collection; catch-up remains pending.");
		if (predatesRetention) return { subject, events, predatesRetention: true };
		return { subject, events, ...(current ? { current } : {}) };
	}

	async failedJobs(identity: CiAttemptIdentity, signal: AbortSignal): Promise<readonly string[]> {
		const repository = await this.repository(signal);
		const result = record(
			await this.api(
				`repos/${repository.nameWithOwner}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=${MAX_JOBS}`,
				repository.host,
				signal,
			),
		);
		if (!Array.isArray(result.jobs) || typeof result.total_count !== "number" || result.total_count > MAX_JOBS)
			throw new Error("CI job details exceed their complete-snapshot bound.");
		return result.jobs
			.map(record)
			.filter((job) => job.conclusion === "failure")
			.map((job) => text(job.name, 512));
	}

	async waitForRun(runId: number, signal: AbortSignal): Promise<void> {
		await this.port.wait("gh", ["run", "watch", String(runId), "--interval", "30"], signal);
	}
}
