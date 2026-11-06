import { join } from "node:path";
import { expect } from "vitest";
import { isSecretEnvironmentName } from "../../../../src/core/autonomy/worker-run-environment.ts";
import {
	type CiAttemptTerminalEvent,
	type CiSubject,
	createCiAttemptTerminalEvent,
} from "../../../../src/core/events/host-event-contract.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { actAheadEpisodeId } from "../../../../src/core/proactivity/act-ahead-controller.ts";
import {
	type ActAheadRecord,
	actAheadRecordOf,
	type CiFailureEvidence,
} from "../../../../src/core/proactivity/act-ahead-record.ts";
import { createCiHostRuntime } from "../../../../src/host/ci/ci-host-event-source.ts";
import type { CiProvider, CiProviderCollection, CiRepository } from "../../../../src/host/ci/ci-provider.ts";
import { CiSourceStore } from "../../../../src/host/ci/ci-source-store.ts";
import type { CiGitPaths } from "../../../../src/host/ci/ci-status-record.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import { calls, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { latestBatchResults } from "./shared.ts";

const PARSER = "export function parseCount(value: string): number {\n\treturn value;\n}\n";
const CHECK = "npm run check";

/**
 * Acting ahead on the checkout's own failing CI, through the production owners: the CI host source and its read-only
 * failure evidence, the host-event ledger, the worktree engine's lane at the failing revision, its process port for the
 * project check, a worker in that lane, and the harness's own validation. Four failed attempts of one run: a reproduced
 * failure yields a saved patch and one notice; the same failure again is a duplicate; a failure only the CI log names
 * starts from that log and says so; the fourth meets the rolling-day attempt bound. The owner's checkout and branch
 * stay exactly as they were, no lane outlives its episode, and the root model is never called.
 */
export async function runJourney3ActAheadPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-act-ahead`;
	// The owner's repository gains a project check and a parser with a type error; this is the revision CI ran.
	world.io.seed(projectPath("package.json"), `${JSON.stringify({ scripts: { check: "node scripts/check.mjs" } })}\n`);
	world.io.seed(projectPath("src", "parse.ts"), PARSER);
	for (const args of [
		["add", "--", "package.json", "src/parse.ts"],
		["commit", "-m", "Add the count parser"],
	])
		expect(world.git.run(args, HARNESS_PROJECT_CWD).code).toBe(0);
	const sha = world.git.refSha("refs/heads/main")!;
	const ownerStatus = world.git.run(["status", "--porcelain"], HARNESS_PROJECT_CWD).stdout;
	const repository: CiRepository = {
		host: "github.com",
		repositoryId: 901,
		nameWithOwner: "harness/act-ahead",
		workflowId: 902,
		workflowPath: ".github/workflows/ci.yml",
	};
	const subject: CiSubject = { host: repository.host, repositoryId: 901, workflowId: 902, headSha: sha };
	const gitDir = join(agentDir, "checkout", ".git");
	const paths: CiGitPaths = { root: HARNESS_PROJECT_CWD, gitDir, commonDir: gitDir, statusDir: join(gitDir, "pi-ci") };
	world.io.seed(join(gitDir, "HEAD"), `${sha}\n`);
	const start = Date.now() - 60_000;
	const attempt = (runAttempt: number): CiAttemptTerminalEvent =>
		createCiAttemptTerminalEvent({
			identity: {
				provider: "github-actions",
				host: repository.host,
				repositoryId: 901,
				workflowId: 902,
				runId: 903,
				runNumber: 1,
				runAttempt,
			},
			headSha: sha,
			conclusion: "failure",
			workflowPath: repository.workflowPath,
			observedAt: new Date(start + runAttempt * 1000).toISOString(),
			runUrl: "https://github.com/harness/act-ahead/actions/runs/903",
		});
	const typeError = "src/parse.ts:2 error TS2322 Type string is not assignable to type number";
	const journeyFailure = "parse.ts:2 expected 12 but received 1 and 2 joined";
	// Attempts 1 and 2 fail the same step (the second is a duplicate); attempt 3 fails a step only the CI log names.
	const evidenceFor = (runAttempt: number): CiFailureEvidence =>
		runAttempt <= 2
			? { jobs: [{ name: "build", failedSteps: ["Type check"] }], logJob: "build", logTail: typeError }
			: { jobs: [{ name: "journeys", failedSteps: ["Run journeys"] }], logJob: "journeys", logTail: journeyFailure };
	let events = [attempt(1)];
	const evidenceReads: number[] = [];
	const provider: CiProvider = {
		repository: async () => repository,
		collect: async (requestedSha, signal): Promise<CiProviderCollection> => {
			signal.throwIfAborted();
			expect(requestedSha).toBe(sha);
			const latest = events.at(-1)!;
			return {
				subject,
				events,
				current: {
					subject,
					runId: 903,
					runNumber: 1,
					runAttempt: latest.identity.runAttempt,
					status: "completed",
					conclusion: "failure",
					eventId: latest.eventId,
				},
			};
		},
		failedJobs: async () => ["build"],
		failureEvidence: async (identity) => {
			evidenceReads.push(identity.runAttempt);
			return evidenceFor(identity.runAttempt);
		},
		waitForRun: (_runId, signal) =>
			new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
	};
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: {
			autoLearn: { enabled: false },
			// Turns stay the owner's: a CI failure never wakes the root; acting ahead works on its own.
			proactivity: { enabled: false, actAhead: { maxAttemptsPerDay: 2 } },
			workerDelegation: {
				modelPins: { default: { provider: HARNESS_PROVIDER, modelId: "worker-a", thinkingLevel: "off" } },
			},
			// The owner's lane ceiling leaves room for these episodes beside any lane the earlier phases still hold.
			worktreeSync: { maxLanes: 32 },
		},
	});
	const manager = root.sessionManager;
	const records = (): ActAheadRecord[] =>
		manager.getEntries().flatMap((entry) => {
			const record = actAheadRecordOf(entry);
			return record ? [record] : [];
		});
	const episodeOf = (event: CiAttemptTerminalEvent) => {
		const episode = actAheadEpisodeId(event.eventId);
		return records().filter((record) => record.episode === episode);
	};
	const notices = () =>
		manager.getEntries().filter((entry) => {
			const details = parentInputOriginalDetails(entry);
			return (
				entry.type === "custom_message" &&
				entry.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
				typeof details === "object" &&
				details !== null &&
				"kind" in details &&
				details.kind === "act-ahead"
			);
		});
	const until = (label: string, done: () => boolean) =>
		withDeadline(
			world.trace,
			label,
			new Promise<void>((resolve) => {
				const check = () => {
					if (!done()) return;
					off();
					resolve();
				};
				const off = manager.onEntriesPersisted(() => queueMicrotask(check));
				check();
			}),
			60_000,
		);
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const lanePathOf = (event: CiAttemptTerminalEvent) => {
		const laneKey = `act-ahead-${actAheadEpisodeId(event.eventId).slice(3, 15)}`;
		return (request: { readonly cwd: string; readonly environmentNames: readonly string[] }) => {
			// The check runs in the episode's own lane, never in the owner's checkout, and without any credential.
			expect(request.cwd).not.toBe(HARNESS_PROJECT_CWD);
			expect(request.cwd.endsWith(laneKey)).toBe(true);
			expect(request.environmentNames.filter(isSecretEnvironmentName)).toEqual([]);
		};
	};
	const worker = (name: string, event: CiAttemptTerminalEvent, newText: string, inspect: (messages: string) => void) =>
		world.provider.enqueue(
			"worker-a",
			{
				name: `${name}-edit`,
				check: (request: ScriptedRequest) => {
					const messages = JSON.stringify(request.context.messages);
					expect(messages).toContain(event.headSha);
					expect(messages).toContain("ci-log");
					inspect(messages);
					const tools = request.context.tools?.map((tool) => tool.name) ?? [];
					expect(tools).toContain("edit");
					expect(tools).not.toContain("delegate");
				},
				reply: calls(`${name}-edit`, [
					{
						id: `${name}-edit`,
						name: "edit",
						arguments: { path: "src/parse.ts", edits: [{ oldText: "return value;", newText }] },
					},
				]).reply,
			},
			{
				name: `${name}-report`,
				check: (request: ScriptedRequest) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "edit");
					expect(result?.isError, result?.text).toBe(false);
				},
				reply: calls(`${name}-report`, [
					{
						id: `${name}-report`,
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "The parser returned its string input as a number; it converts the string now.",
							changes: [{ file: "src/parse.ts", what: "Converts the string before returning it." }],
						},
					},
				]).reply,
			},
		);
	const abort = new AbortController();
	const binding = root.session.backgroundLanes.openHostEventSession(abort.signal);
	const diagnostics: string[] = [];
	const source = await createCiHostRuntime({
		cwd: HARNESS_PROJECT_CWD,
		paths,
		provider,
		store: new CiSourceStore(paths.statusDir),
		onDiagnostic: (message) => diagnostics.push(message),
		getSubscribedSubjects: () => root.session.backgroundLanes.getHostEventSubjects(),
		subscribeSubjects: (listener) => root.session.backgroundLanes.subscribeOrchestrationStore(listener),
		provideFailureEvidence: (reader) => root.session.backgroundLanes.provideCiFailureEvidence(reader),
	});
	if (!source) throw new Error("The act-ahead CI source did not open.");
	const deliver = async (next: readonly CiAttemptTerminalEvent[]) => {
		await source.source.stop();
		events = [...next];
		await source.source.start(binding.sink);
	};
	try {
		// The session exists on disk before any failure: episodes are durable records of a persisted session.
		world.provider.enqueue("root", text("act-ahead-open", "Ready."));
		await withDeadline(world.trace, "act-ahead root session opened", root.session.prompt("Open the session."));
		const rootBefore = rootRequests();

		// 1. Reproduced: the check fails in the lane, the worker edits the lane, the check passes, the patch is saved.
		const first = attempt(1);
		world.shell.enqueue(
			{ name: "act-ahead-1-check", command: CHECK, output: typeError, exitCode: 1, check: lanePathOf(first) },
			{ name: "act-ahead-1-validate", command: CHECK, output: "ok", exitCode: 0, check: lanePathOf(first) },
		);
		worker("act-ahead-1", first, "return Number(value);", (messages) => {
			expect(messages).toContain("check-output");
			expect(messages).toContain(typeError);
		});
		await source.source.start(binding.sink);
		await until("a reproduced CI failure ends in a saved patch", () =>
			episodeOf(first).some((record) => record.phase === "settled"),
		);
		const firstRecords = episodeOf(first);
		expect(firstRecords.map((record) => record.phase)).toEqual(["armed", "admitted", "working", "ready", "settled"]);
		const ready = firstRecords.find((record) => record.phase === "ready")!;
		expect(ready).toMatchObject({ basis: "reproduced", check: CHECK, files: ["src/parse.ts"] });
		const patch = String(world.io.readFileSync(ready.patchPath!, "utf8"));
		expect(patch).toContain("src/parse.ts");
		expect(patch).toContain("return Number(value);");
		// The lane is discarded once the episode settles; the owner's checkout and branch are untouched.
		expect(world.io.existsSync(firstRecords[0]!.lanePath!)).toBe(false);
		await until("the reproduced fix is told once", () => notices().length === 1);
		expect(JSON.stringify(notices()[0])).toContain("reproduced locally");

		// 2. The same failure on a new attempt is a duplicate: no lane, no check, no worker.
		const second = attempt(2);
		await deliver([first, second]);
		await until("the same failure again is a duplicate", () => episodeOf(second).length > 0);
		expect(episodeOf(second)).toMatchObject([{ phase: "abandoned", reason: "duplicate" }]);

		// 3. A failure only the CI log names: the check passes in the lane, the worker starts from the fenced log.
		const third = attempt(3);
		world.shell.enqueue(
			{ name: "act-ahead-3-check", command: CHECK, output: "ok", exitCode: 0, check: lanePathOf(third) },
			{ name: "act-ahead-3-validate", command: CHECK, output: "ok", exitCode: 0, check: lanePathOf(third) },
		);
		worker("act-ahead-3", third, "return Number.parseInt(value, 10);", (messages) => {
			expect(messages).toContain(journeyFailure);
			expect(messages).toContain("not re-run here");
			expect(messages).not.toContain("check-output");
		});
		await deliver([first, second, third]);
		await until("a log-named failure ends in a saved patch", () =>
			episodeOf(third).some((record) => record.phase === "settled"),
		);
		expect(episodeOf(third).find((record) => record.phase === "ready")).toMatchObject({ basis: "ci-log" });
		await until("the log-diagnosed fix is told once", () => notices().length === 2);
		expect(JSON.stringify(notices()[1])).toContain("diagnosed from the CI log");
		expect(JSON.stringify(notices()[1])).toContain("not re-run locally");

		// 4. Two admitted attempts reach the rolling-day bound: the next failure is capped before any evidence is read.
		const fourth = attempt(4);
		await deliver([first, second, third, fourth]);
		await until("the day's attempt bound caps the next failure", () => episodeOf(fourth).length > 0);
		expect(episodeOf(fourth)).toMatchObject([{ phase: "capped", reason: "day_bound" }]);
		expect(evidenceReads).toEqual([1, 2, 3]);

		expect(world.shell.reached.filter((name) => name.startsWith("act-ahead-"))).toEqual([
			"act-ahead-1-check",
			"act-ahead-1-validate",
			"act-ahead-3-check",
			"act-ahead-3-validate",
		]);
		expect(world.git.run(["status", "--porcelain"], HARNESS_PROJECT_CWD).stdout).toBe(ownerStatus);
		expect(world.git.refSha("refs/heads/main")).toBe(sha);
		expect(String(world.io.readFileSync(projectPath("src", "parse.ts"), "utf8"))).toBe(PARSER);
		expect(world.git.run(["worktree", "list"], HARNESS_PROJECT_CWD).stdout).not.toContain("act-ahead-");
		expect(notices()).toHaveLength(2);
		expect(rootRequests()).toBe(rootBefore);
		expect(diagnostics).toEqual([]);
	} finally {
		abort.abort();
		await source.source.stop();
		await binding.close();
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		await world.provider.waitForProducers();
	}
	world.trace.mark("root", "act-ahead.done");
}
