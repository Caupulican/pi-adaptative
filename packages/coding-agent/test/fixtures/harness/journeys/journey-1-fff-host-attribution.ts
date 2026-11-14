import "../builtin-install.ts";
import { join, relative, resolve } from "node:path";
import { expect } from "vitest";
import { configFile, hostTransitionsFile } from "../../../../src/core/agent-paths.ts";
import { getTamperWatchedPaths } from "../../../../src/core/autonomy/protected-path-watch.ts";
import { SettingsManager } from "../../../../src/core/settings-manager.ts";
import { createHarnessFileLister } from "../../../../src/core/system-one/code-duplicates.ts";
import {
	DefaultFffSearchBackend,
	type FffFileFinder,
	type FffFinderDeps,
	type FffModule,
} from "../../../../src/core/tools/fff-search-backend.ts";
import {
	ensureFffNodePackage,
	FFF_NODE_VERSION,
	type FffManagedInstallIo,
} from "../../../../src/utils/fff-node-install.ts";
import { publishHostFile } from "../../../../src/utils/host-tree-publication.ts";
import { hostFileIdentity, hostWatchedPathIdentity } from "../../../../src/utils/host-write-transition.ts";
import { calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { FILES_CHANGED_CLAIMS, ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

const FFF_BASE_JUDGMENTS = {
	...ICM_INTAKE_JUDGMENTS,
	...FILES_CHANGED_CLAIMS,
} as const;
const FFF_FORCE_JUDGMENTS = {
	...FFF_BASE_JUDGMENTS,
	leaves_machine: { kind: "noul", probability: 0.02 },
	cannot_be_undone: { kind: "noul", probability: 0.02 },
	touches_outside_task: { kind: "noul", probability: 0.02 },
	acquires_external_code: { kind: "noul", probability: 0.02 },
	request_authorizes: { kind: "noul", probability: 0.02 },
} as const;
const HOST_TRANSITION_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

const SOURCE_SCOPE = "src/features/retry";
const CANDIDATE_PATH = join(HARNESS_PROJECT_CWD, SOURCE_SCOPE, "normalize-existing.ts");
const WORKER_RELATIVE_PATH = join(SOURCE_SCOPE, "normalize-new.ts");
const WORKER_PATH = join(HARNESS_PROJECT_CWD, WORKER_RELATIVE_PATH);
const FORCE_WORKER_RELATIVE_PATH = join(SOURCE_SCOPE, "normalize-force.ts");
const FORCE_WORKER_PATH = join(HARNESS_PROJECT_CWD, FORCE_WORKER_RELATIVE_PATH);
const CANDIDATE = `export function normalizeValue(value: string): string {
	const normalized = value.normalize("NFKC");
	const lower = normalized.toLocaleLowerCase("en-US");
	const parts = lower.split(/\\s+/);
	const cleaned = parts.map((part) => part.replace(/[^\\p{L}\\p{N}_-]/gu, ""));
	const nonempty = cleaned.filter((part) => part.length > 0);
	const unique = Array.from(new Set(nonempty));
	const sorted = unique.sort((left, right) => left.localeCompare(right));
	return sorted.join(" ").trim();
}
`;
const ORIGINAL = `export function normalizeInput(value: string): string {
	return value.trim();
}
`;
const UPDATED = CANDIDATE.replace("normalizeValue", "normalizeInput");

/** Read the actual parent-facing handoff text without JSON-escaping native paths. */
function latestWorkerHandoff(request: ScriptedRequest): string | undefined {
	return request.context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
		)
		.findLast((text) => text.includes("Background worker terminal handoff"));
}

/** Real worker review, managed publication and durable claim; only npm/module I/O is scripted. */
export async function runJourney1FffHostAttributionPhase(world: HarnessWorld): Promise<void> {
	if (!world.systemOne.enabled) {
		await runSystemOneOffWorker(world);
		return;
	}
	const trace = world.trace;
	const managedToolsDir = join(world.agentDir, "bin");
	const managedFffDir = join(managedToolsDir, "fff-node");
	const concurrentPath = join(managedToolsDir, "during-forced-install");
	const commandPath = join(managedToolsDir, "worker-command-write");
	const detachedPath = join(managedToolsDir, "worker-detached-write");
	const rollbackPath = join(managedToolsDir, "publisher-rollback-control");
	const racePath = join(managedToolsDir, "publisher-race-control");
	const unrelatedPublishPath = join(managedToolsDir, "publisher-unrelated-target");
	const publicationSource = join(world.agentDir, "npm", "publisher-control-source");
	const settingsPath = configFile(world.agentDir, "settings.json");
	expect(
		hostWatchedPathIdentity(detachedPath),
		"detached-write control starts absent at the worker watch baseline",
	).toBe("absent");
	expect(
		getTamperWatchedPaths(HARNESS_PROJECT_CWD, world.agentDir).some(
			(path) => resolve(path) === resolve(managedToolsDir),
		),
		"managed FFF publication is inside this worker's protected watch roots",
	).toBe(true);
	expect(
		getTamperWatchedPaths(HARNESS_PROJECT_CWD, world.agentDir).some(
			(path) => resolve(path) === resolve(settingsPath),
		),
		"the settings file written during worker B is part of this worker's protected watch",
	).toBe(true);
	world.io.seed(CANDIDATE_PATH, CANDIDATE);
	world.io.seed(WORKER_PATH, ORIGINAL);
	world.io.mkdirSync(join(world.agentDir, "npm"), { recursive: true });
	world.io.seed(publicationSource, "new managed generation\n");
	const installStarted = createBarrier();
	const releaseInstall = createBarrier();
	const forceInstallStarted = createBarrier();
	const releaseForceInstall = createBarrier();
	const published = createBarrier();
	const shellReached = createBarrier();
	const shellRelease = createBarrier();
	const handoffSeen = createBarrier();
	let installCalls = 0;
	let installReleased = false;
	let managedPackagePublished = false;

	let finderDestroyed = false;
	const fakeFinder: FffFileFinder = {
		get isDestroyed() {
			return finderDestroyed;
		},
		destroy() {
			finderDestroyed = true;
		},
		fileSearch: () => ({ ok: true as const, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } }),
		glob: () => ({
			ok: true as const,
			value: {
				items: [
					{
						relativePath: "src/features/retry/normalize-existing.ts",
						fileName: "normalize-existing.ts",
						size: CANDIDATE.length,
						modified: 0,
						gitStatus: "",
					},
				],
				scores: [],
				totalMatched: 1,
				totalFiles: 1,
			},
		}),
		grep: () => ({
			ok: true as const,
			value: {
				items: [],
				totalMatched: 0,
				totalFilesSearched: 0,
				totalFiles: 0,
				filteredFileCount: 0,
				nextCursor: null,
			},
		}),
		waitForScan: async () => ({ ok: true as const, value: true }),
	};
	const fakeModule: FffModule = {
		FileFinder: {
			isAvailable: () => true,
			create: () => ({ ok: true, value: fakeFinder }),
		},
	};
	const platformPackages: Record<string, string> = {
		"darwin/arm64": "@ff-labs/fff-bin-darwin-arm64",
		"darwin/x64": "@ff-labs/fff-bin-darwin-x64",
		"linux/arm64": "@ff-labs/fff-bin-linux-arm64-gnu",
		"linux/x64": "@ff-labs/fff-bin-linux-x64-gnu",
		"win32/arm64": "@ff-labs/fff-bin-win32-arm64",
		"win32/x64": "@ff-labs/fff-bin-win32-x64",
	};
	const platformPackage = platformPackages[`${process.platform}/${process.arch}`];
	if (!platformPackage) throw new Error(`FFF attribution journey does not define ${process.platform}/${process.arch}`);
	const packageIo: FffManagedInstallIo = {
		runNpmInstall: async (args, cwd) => {
			installCalls += 1;
			for (const required of [
				"install",
				"--ignore-scripts",
				"--omit=dev",
				"--include=optional",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
				`@ff-labs/fff-node@${FFF_NODE_VERSION}`,
				`${platformPackage}@${FFF_NODE_VERSION}`,
			]) {
				if (!args.includes(required)) throw new Error(`FFF installer omitted ${required}`);
			}
			if (!world.io.existsSync(join(cwd, "package.json"))) throw new Error("npm staging directory has no manifest");
			installStarted.release();
			if (installCalls === 1) await releaseInstall.promise;
			if (installCalls === 2) {
				forceInstallStarted.release();
				await releaseForceInstall.promise;
			}
			const staged = join(cwd, "node_modules");
			world.io.mkdirSync(join(staged, "@ff-labs", "fff-node", "dist"), { recursive: true });
			world.io.mkdirSync(join(staged, "ffi-rs"), { recursive: true });
			world.io.mkdirSync(join(staged, "@yuuang", "ffi-rs-linux-x64-gnu"), { recursive: true });
			world.io.writeFileSync(
				join(staged, "@ff-labs", "fff-node", "package.json"),
				JSON.stringify({ name: "@ff-labs/fff-node", version: FFF_NODE_VERSION, main: "dist/index.cjs" }),
			);
			world.io.writeFileSync(
				join(staged, "@ff-labs", "fff-node", "dist", "index.cjs"),
				`module.exports = {}; // generation ${installCalls}\n`,
			);
			world.io.writeFileSync(join(staged, "ffi-rs", "index.js"), "module.exports = {};\n");
			world.io.writeFileSync(
				join(staged, "@yuuang", "ffi-rs-linux-x64-gnu", "binding.node"),
				"fixture-native-binding",
			);
			return { code: 0, stderr: "" };
		},
		loadManagedPackage: (directory) => {
			if (!world.io.existsSync(join(directory, "node_modules", "ffi-rs", "binding.node"))) {
				throw new Error("native binding was not staged into the package before load");
			}
			managedPackagePublished = true;
			published.release();
			return fakeModule;
		},
	};
	const target = { agentDir: world.agentDir, managedDirectory: managedFffDir, platformPackage };
	const install = (silent: boolean, force = false) =>
		ensureFffNodePackage(silent, force, [], () => {}, packageIo, target);
	const deps: FffFinderDeps = {
		ensureFffModule: async () => {
			const module = await install(true);
			return (module as FffModule | undefined) ?? null;
		},
		ensureFffNodePackage: (silent, force) => install(silent, force),
		isInstallRetryable: () => false,
	};
	const backend = new DefaultFffSearchBackend(deps);
	const lister = createHarnessFileLister(backend, {
		resolveRg: async () => "fixture-rg",
		execFiles: (_command, _args, _options, callback) => callback(null, "src/features/retry/normalize-existing.ts\n"),
	});
	const initialWatchedBinExists = world.io.existsSync(managedToolsDir);
	expect(initialWatchedBinExists, "the first FFF worker begins with no managed bin parent").toBe(false);
	const coldDecodedStart = world.systemOne.decoded.length;
	world.systemOne.enterPhase("fff-cold-host-attribution", FFF_BASE_JUDGMENTS, {
		families: { same_responsibility_u: { kind: "noul", probability: 0.02 } },
	});
	const coldRoot = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		codeDuplicateFileLister: lister,
		settings: { orchestrator: { delegationGate: true } },
	});
	const coldHandoffSeen = createBarrier();
	let coldPrompt: Promise<void> | undefined;
	let coldProviderRequestStart = 0;
	world.provider.enqueue(
		"worker-a",
		calls("fff-cold-worker-edit", [
			{
				id: "fff-cold-edit",
				name: "edit",
				arguments: { path: WORKER_PATH, edits: [{ oldText: ORIGINAL, newText: UPDATED }] },
			},
		]),
		{
			name: "fff-cold-worker-report",
			gate: published.promise,
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError || world.io.readFileSync(WORKER_PATH, "utf8") !== UPDATED)
					throw new Error(`cold-install worker edit did not complete: ${edit?.text ?? "no result"}`);
			},
			reply: () => {
				if (!managedPackagePublished)
					throw new Error("cold worker report ran before managed publication completed");
				return {
					content: [
						{
							type: "toolCall",
							id: "fff-cold-report",
							name: "submit_report",
							arguments: {
								status: "completed",
								summary:
									"Updated normalizeInput using the same Unicode normalization and token cleanup behavior as the existing helper.",
								changes: [
									{
										file: relative(HARNESS_PROJECT_CWD, WORKER_PATH),
										what: "Implements Unicode normalization, case folding, punctuation cleanup, deduplication, and stable token ordering.",
									},
								],
							},
						},
					],
					stopReason: "toolUse" as const,
				};
			},
		},
	);
	world.provider.enqueue(
		"root",
		calls("fff-cold-root-delegate", [
			{
				id: "fff-cold-delegate",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [SOURCE_SCOPE],
					instructions: `Edit ${WORKER_PATH} to normalize values like ${CANDIDATE_PATH}, then report.`,
				},
			},
		]),
		{
			name: "fff-cold-root-started",
			reply: { content: [{ type: "text", text: "The cold-install work is delegated." }] },
		},
		{
			name: "fff-cold-root-handoff",
			maxRequests: 8,
			until: (request) => {
				const found = latestWorkerHandoff(request) !== undefined;
				if (found) coldHandoffSeen.release();
				return found;
			},
			reply: (request) => {
				const text = latestWorkerHandoff(request);
				if (text === undefined)
					return { content: [{ type: "text", text: "I am waiting for the cold-install worker handoff." }] };
				if (text.includes(managedFffDir))
					throw new Error("clean cold FFF publication was attributed to its worker");
				return { content: [{ type: "text", text: "The cold-install worker claim is clean." }] };
			},
		},
	);
	let coldDisposed = false;
	try {
		await withDeadline(
			trace,
			"cold FFF worker starts and publishes",
			(async () => {
				coldProviderRequestStart = world.provider.requests.length;
				coldPrompt = coldRoot.session.prompt("Implement the normalizer with a worker, then review its report.");
				await installStarted.promise;
				releaseInstall.release();
				installReleased = true;
				await published.promise;
				await coldPrompt;
			})(),
		);
		await withDeadline(trace, "cold FFF worker reaches parent handoff", coldHandoffSeen.promise);
		await coldRoot.session.waitForForegroundIdle();
		const coldClaim = coldRoot.session.getWorkerClaimSnapshots().at(-1);
		const coldWorkerRequests = world.provider.requests
			.slice(coldProviderRequestStart)
			.filter((request) => request.model.id === "worker-a");
		const lastColdRequest = coldWorkerRequests.at(-1);
		const lastColdMessage = lastColdRequest?.context.messages.at(-1);
		const lastColdReceipts = lastColdRequest ? latestBatchResults(lastColdRequest) : [];
		const coldDiagnostic = JSON.stringify({
			requests: coldWorkerRequests.map((request) => request.sequence),
			lastRequest: lastColdRequest?.sequence,
			lastMessage: lastColdMessage ? JSON.stringify(lastColdMessage).slice(0, 900) : undefined,
			lastReceipts: lastColdReceipts.map((receipt) => ({ ...receipt, text: receipt.text.slice(0, 300) })),
			pendingWorkerSteps: world.provider.getPendingStepNames("worker-a"),
			reachedWorkerSteps: world.provider.reached.filter((step) => step.startsWith("worker-a:")),
		});
		expect(coldClaim?.status, `cold FFF worker completes an accepted claim; request trail: ${coldDiagnostic}`).toBe(
			"completed",
		);
		expect(coldClaim?.hostVerdict?.verdict, "host accepts the cold report for its changed file").toBe("accepted");
		expect(coldClaim?.parentReviewRequired ?? false, "exact cold publication does not block the worker claim").toBe(
			false,
		);
		expect(coldClaim?.hostFindings ?? [], "exact cold publication leaves no protected findings").toEqual([]);
		expect(
			world.systemOne.decoded
				.slice(coldDecodedStart)
				.some((request) => Object.keys(request.questions).some((id) => id.startsWith("same_responsibility_u"))),
			"the cold worker passed through semantic duplicate judgment",
		).toBe(true);
		expect(world.io.existsSync(managedToolsDir), "publisher created the watched bin parent itself").toBe(true);
		expect(installCalls, "one cold package install ran through the explicit adapter").toBe(1);
		expect(world.io.existsSync(join(managedFffDir, "node_modules", "ffi-rs", "binding.node"))).toBe(true);
		expect(
			await world.disposeSessionInBody(coldRoot.session),
			"cold worker session settles before next watch lifetime",
		).toBeUndefined();
		coldDisposed = true;
		world.io.seed(FORCE_WORKER_PATH, ORIGINAL);
	} finally {
		if (!installReleased) releaseInstall.release();
		published.release();
		if (!coldDisposed) await world.disposeSessionInBody(coldRoot.session);
		if (coldPrompt) await coldPrompt.catch(() => {});
		if (!coldDisposed) await backend.dispose();
	}
	await world.provider.waitForProducers();
	world.io.seed(rollbackPath, "old rollback generation\n");
	world.io.seed(racePath, "old competing generation\n");
	const settingsManager = await prepareNearLimitHostJournal(world, managedFffDir, settingsPath);

	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		codeDuplicateFileLister: lister,
		settings: { orchestrator: { delegationGate: true } },
	});
	const session = created.session;
	let sessionDisposed = false;
	const forceDecodedStart = world.systemOne.decoded.length;
	world.systemOne.enterPhase("fff-host-attribution", FFF_FORCE_JUDGMENTS, {
		families: { same_responsibility_u: { kind: "noul", probability: 0.02 } },
	});
	world.shell.enqueue({
		name: "fff-worker-write-control",
		command: "echo fff-worker-process",
		cwd: HARNESS_PROJECT_CWD,
		output: "fff-worker-process\n",
		exitCode: 0,
		gate: shellRelease.promise,
		check: () => shellReached.release(),
		effect: () => world.io.writeFileSync(commandPath, "worker process write\n"),
	});
	world.provider.enqueue(
		"worker-b",
		calls("fff-worker-edit", [
			{
				id: "fff-edit-1",
				name: "edit",
				arguments: { path: FORCE_WORKER_PATH, edits: [{ oldText: ORIGINAL, newText: UPDATED }] },
			},
		]),
		{
			name: "fff-worker-bash",
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError || world.io.readFileSync(FORCE_WORKER_PATH, "utf8") !== UPDATED)
					throw new Error(`worker edit did not complete before process control: ${edit?.text ?? "no result"}`);
			},
			reply: {
				content: [
					{ type: "toolCall", id: "fff-bash-1", name: "bash", arguments: { command: "echo fff-worker-process" } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "fff-worker-report",
			check: (request) => {
				const bash = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (bash?.isError || !bash?.text.includes("fff-worker-process"))
					throw new Error("worker shell control did not run");
				world.io.writeFileSync(detachedPath, "worker detached write\n");
				const detachedAfter = hostWatchedPathIdentity(detachedPath);
				if (detachedAfter === undefined || detachedAfter === "absent")
					throw new Error("detached-write control has no exact watched-path identity");
				world.io.appendFileSync(
					hostTransitionsFile(world.agentDir),
					`${JSON.stringify({
						kind: "host-path-transition-batch",
						fixture: "malformed-detached-batch",
						path: detachedPath,
						before: "absent",
						after: detachedAfter,
						at: Date.now(),
						transitions: [
							{ path: detachedPath, before: "absent", after: detachedAfter, at: Date.now() },
							{ path: detachedPath, before: null, after: detachedAfter, at: Date.now() },
						],
					})}\n`,
				);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "fff-report-1",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Updated normalizeInput and ran the worker process control.",
							changes: [
								{
									file: relative(HARNESS_PROJECT_CWD, FORCE_WORKER_PATH),
									what: "Adds the normalized and de-duplicated input behavior to the new worker-owned module.",
								},
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.provider.enqueue(
		"root",
		calls("fff-root-delegate", [
			{
				id: "fff-delegate-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-b" },
					writePaths: [SOURCE_SCOPE],
					instructions: `Edit ${FORCE_WORKER_PATH} to normalize values like ${CANDIDATE_PATH}; run the worker process control and report.`,
				},
			},
		]),
		{ name: "fff-root-started", reply: { content: [{ type: "text", text: "The normalizer work is delegated." }] } },
		{
			name: "fff-root-handoff",
			maxRequests: 8,
			until: (request) => {
				const found = latestWorkerHandoff(request) !== undefined;
				if (found) handoffSeen.release();
				return found;
			},
			reply: (request) => {
				const text = latestWorkerHandoff(request);
				if (text === undefined) {
					return { content: [{ type: "text", text: "I am waiting for the worker handoff." }] };
				}
				for (const path of [concurrentPath, commandPath, detachedPath, rollbackPath, racePath]) {
					if (!text.includes(path)) throw new Error(`parent handoff omitted protected finding ${path}`);
				}
				if (!text.includes(join(managedFffDir, "node_modules", "@ff-labs", "fff-node")))
					throw new Error("parent handoff omitted the unjournaled forced FFF rollback finding");
				return {
					content: [
						{
							type: "text",
							text: "The FFF publication and unrelated protected writes are in the durable claim.",
						},
					],
				};
			},
		},
	);

	let activeForceAttempt: Promise<unknown | undefined> | undefined;
	try {
		const prompt = session.prompt("Implement the normalizer with a worker, then review its report.");
		await withDeadline(trace, "worker shell command remains guarded during forced publication", shellReached.promise);
		activeForceAttempt = install(true, true);
		await withDeadline(trace, "forced npm adapter enters while worker is active", forceInstallStarted.promise);
		world.io.writeFileSync(concurrentPath, "independent same-run write during force install\n");
		releaseForceInstall.release();
		const forcedModule = await activeForceAttempt;
		activeForceAttempt = undefined;
		expect(forcedModule, "forced replacement follows the managed FFF install owner").toBe(fakeModule);
		const journalBeforeSettings = world.io.readFileSync(hostTransitionsFile(world.agentDir), "utf8").toString();
		const forcedEntry = join(managedFffDir, "node_modules", "@ff-labs", "fff-node", "dist", "index.cjs");
		const forcedIdentity = hostWatchedPathIdentity(forcedEntry);
		const forcedBatchLine = journalBeforeSettings
			.split("\n")
			.findLast((line) =>
				parseHostJournalRows(line).some(
					(row) =>
						row.kind === "host-path-transition-batch" &&
						row.transitions?.some(
							(transition) => transition.path === forcedEntry && transition.after === forcedIdentity,
						),
				),
			);
		if (!forcedIdentity || !forcedBatchLine) throw new Error("forced publication has no exact committed batch");
		expect(
			Buffer.byteLength(journalBeforeSettings),
			"forced FFF batch remains within its journal byte bound",
		).toBeLessThanOrEqual(HOST_TRANSITION_JOURNAL_MAX_BYTES);
		expect(journalBeforeSettings, "real FFF publication fits without evicting the seeded history").toContain(
			"fff-near-limit-history",
		);
		let crossedByteBound = false;
		const settingsTransitions: HostJournalTransition[] = [];
		let journalAfterSettings = journalBeforeSettings;
		for (let index = 0; index < 64; index++) {
			const journalBeforeWrite = journalAfterSettings;
			const beforeBytes = Buffer.byteLength(journalBeforeWrite);
			const beforeLineCount = journalBeforeWrite.split("\n").filter(Boolean).length;
			const settingsBefore = hostFileIdentity(settingsPath);
			if (settingsBefore === undefined)
				throw new Error("persistent settings file has no bounded pre-write identity");
			settingsManager.setPlain("theme", index % 2 === 0 ? "dark" : "light");
			await flushPersistentSettings(settingsManager, `active-watch settings transition ${index}`);
			const settingsAfter = hostFileIdentity(settingsPath);
			if (settingsAfter === undefined)
				throw new Error("persistent settings file has no bounded post-write identity");
			journalAfterSettings = world.io.readFileSync(hostTransitionsFile(world.agentDir), "utf8").toString();
			const transitionLine = journalAfterSettings.split("\n").find((line) => {
				try {
					const row = JSON.parse(line) as HostJournalTransition;
					return row.path === settingsPath && row.before === settingsBefore && row.after === settingsAfter;
				} catch {
					return false;
				}
			});
			if (transitionLine === undefined)
				throw new Error("real persistent settings write was not retained in its journal");
			const transition = JSON.parse(transitionLine) as HostJournalTransition;
			settingsTransitions.push(transition);
			const actualRowBytes = Buffer.byteLength(transitionLine) + 1;
			if (beforeBytes + actualRowBytes > HOST_TRANSITION_JOURNAL_MAX_BYTES && beforeLineCount + 1 < 512) {
				crossedByteBound = true;
				break;
			}
		}
		expect(crossedByteBound, "actual settings writes cross the byte bound before reaching the line bound").toBe(true);
		expect(
			Buffer.byteLength(journalAfterSettings),
			"real settings append atomically compacts under the byte bound",
		).toBeLessThanOrEqual(HOST_TRANSITION_JOURNAL_MAX_BYTES);
		expect(
			journalAfterSettings.split("\n").filter(Boolean).length,
			"mixed journal remains under the line bound",
		).toBeLessThanOrEqual(512);
		expect(journalAfterSettings, "pressure compaction evicts the synthetic oldest history row").not.toContain(
			"fff-near-limit-history",
		);
		const pressureRows = parseHostJournalRows(journalAfterSettings);
		for (const transition of settingsTransitions) {
			expect(
				pressureRows.some(
					(row) =>
						row.path === transition.path && row.before === transition.before && row.after === transition.after,
				),
				"canonical compaction retains every real settings transition",
			).toBe(true);
		}
		expect(
			journalAfterSettings.split("\n"),
			"canonical compaction retains the exact complete forced-publication batch",
		).toContain(forcedBatchLine);
		world.io.failNext({
			name: "managed-FFF-tree-journal-failure",
			kind: "rename",
			code: "EIO",
			matches: (operation) => operation.destination === hostTransitionsFile(world.agentDir),
		});
		const failedForcedModule = await install(true, true);
		expect(failedForcedModule, "tree publication without durable attribution fails closed").toBeUndefined();
		expect(
			world.io.consumedFaults,
			"the FFF rollback control reached the atomic journal replacement boundary",
		).toContain("managed-FFF-tree-journal-failure");
		expect(
			world.io.readFileSync(
				join(managedFffDir, "node_modules", "@ff-labs", "fff-node", "dist", "index.cjs"),
				"utf8",
			),
			"failed forced generation retains the previous usable package",
		).toBe("module.exports = {}; // generation 2\n");
		world.io.failNext({
			name: "managed-file-replacement-failure",
			kind: "link",
			code: "EIO",
			matches: (operation) => operation.destination === rollbackPath,
		});
		const rollback = publishHostFile(
			publicationSource,
			rollbackPath,
			join(world.agentDir, "npm"),
			hostTransitionsFile(world.agentDir),
			{ replaceExisting: true },
		);
		expect(rollback.status, "failed replacement reports its failed publication").toBe("failed");
		expect(world.io.readFileSync(rollbackPath, "utf8"), "failed replacement restores the previous bytes").toBe(
			"old rollback generation\n",
		);
		world.io.observeNext({
			name: "managed-file-concurrent-replacement",
			kind: "link",
			matches: (operation) => operation.destination === racePath,
			onMatch: () => world.io.writeFileSync(racePath, "concurrent writer generation\n"),
		});
		const raced = publishHostFile(
			publicationSource,
			racePath,
			join(world.agentDir, "npm"),
			hostTransitionsFile(world.agentDir),
			{ replaceExisting: true },
		);
		expect(raced.status, "concurrent same-path writer is not overwritten").toBe("failed");
		if (raced.status === "failed") expect(raced.reason).toContain("Previous generation retained at");
		expect(world.io.readFileSync(racePath, "utf8"), "competing bytes survive failed publication").toBe(
			"concurrent writer generation\n",
		);
		const blockedRetry = publishHostFile(
			publicationSource,
			racePath,
			join(world.agentDir, "npm"),
			hostTransitionsFile(world.agentDir),
			{ replaceExisting: true },
		);
		expect(blockedRetry.status, "unresolved backup gates only its exact target").toBe("failed");
		if (blockedRetry.status === "failed") expect(blockedRetry.reason).toContain("requires recovery at");
		const unrelatedPublication = publishHostFile(
			publicationSource,
			unrelatedPublishPath,
			join(world.agentDir, "npm"),
			hostTransitionsFile(world.agentDir),
		);
		expect(unrelatedPublication.status, "a retained backup does not block another managed target").toBe("published");
		shellRelease.release();
		await withDeadline(trace, "FFF attribution root delegation", prompt);
		await withDeadline(trace, "FFF worker host handoff", handoffSeen.promise, 90_000);
		await session.waitForForegroundIdle();
		const claim = session.getWorkerClaimSnapshots().at(-1);
		expect(claim?.parentReviewRequired, "protected changes remain a parent review blocker").toBe(true);
		expect(claim?.hostVerdict?.verdict, "host accepts the force-control report for its changed file").toBe(
			"accepted",
		);
		const findingText = (claim?.hostFindings ?? []).map((finding) => finding.text).join("\n");
		for (const path of [concurrentPath, commandPath, detachedPath, rollbackPath, racePath])
			expect(findingText).toContain(path);
		expect(findingText).toContain(managedFffDir);
		expect(findingText, "persistent settings transition is explained during the active worker watch").not.toContain(
			settingsPath,
		);
		expect(findingText).not.toContain(unrelatedPublishPath);
		expect(
			world.systemOne.decoded
				.slice(forceDecodedStart)
				.some((request) => Object.keys(request.questions).some((id) => id.startsWith("same_responsibility_u"))),
			"the worker edit passed through semantic duplicate judgment",
		).toBe(true);
		expect(installCalls, "cold install plus two force attempts used the explicit adapter").toBe(3);
		expect(
			world.io.existsSync(join(managedFffDir, "node_modules", "@ff-labs", "fff-node", "dist", "index.cjs")),
		).toBe(true);
		expect(world.io.existsSync(join(managedFffDir, "node_modules", "ffi-rs", "binding.node"))).toBe(true);
		const journal = world.io.readFileSync(hostTransitionsFile(world.agentDir), "utf8").toString();
		expect(journal).toContain("host-path-transition-batch");
		expect(journal).toContain("malformed-detached-batch");
		expect(
			parseHostJournalRows(journal).some(
				(row) =>
					row.kind === "host-path-transition-batch" &&
					row.transitions?.some(
						(transition) =>
							transition.path ===
							join(managedFffDir, "node_modules", "@ff-labs", "fff-node", "dist", "index.cjs"),
					),
			),
			"the durable journal retains the managed module's native path",
		).toBe(true);
		const disposal = await world.disposeSessionInBody(session);
		sessionDisposed = true;
		expect(disposal, "FFF attribution root settles its session and phase ownership").toBeUndefined();
		await world.provider.waitForProducers();
	} finally {
		if (!installReleased) releaseInstall.release();
		releaseForceInstall.release();
		shellRelease.release();
		if (activeForceAttempt) await activeForceAttempt.catch(() => undefined);
		if (!sessionDisposed) await world.disposeSessionInBody(session);
		await backend.dispose();
	}
}

/** Seed a valid near-cap history before worker B opens its watch, preserving the cold install and a real settings row. */
async function prepareNearLimitHostJournal(
	world: HarnessWorld,
	managedFffDir: string,
	settingsPath: string,
): Promise<SettingsManager> {
	const journalPath = hostTransitionsFile(world.agentDir);
	const manager = SettingsManager.create(HARNESS_PROJECT_CWD, world.agentDir);
	manager.setPlain("theme", "dark");
	await flushPersistentSettings(manager, "initial settings journal seed");
	let existing = world.io.readFileSync(journalPath, "utf8").toString();
	const initialLines = existing.split("\n").filter(Boolean);
	const coldBatchLine = initialLines.find((line) => {
		try {
			const row = JSON.parse(line) as HostJournalRow;
			return row.kind === "host-path-transition-batch" &&
				row.transitions?.some((item) => item.path === managedFffDir)
				? line
				: false;
		} catch {
			return false;
		}
	});
	if (coldBatchLine === undefined)
		throw new Error(
			"near-limit journal fixture requires the cold FFF batch and a real persistent settings transition",
		);
	const oversizedHistoricalLine = makeHistoricalTransitionLine(
		HOST_TRANSITION_JOURNAL_MAX_BYTES - Math.floor(Buffer.byteLength(existing) / 2),
		"fff-near-limit-history",
	);
	if (Buffer.byteLength(oversizedHistoricalLine) + 1 > HOST_TRANSITION_JOURNAL_MAX_BYTES)
		throw new Error("oversized-journal recovery row exceeds the complete-row bound");
	const oversizedJournal = `${oversizedHistoricalLine}\n${existing}`;
	if (Buffer.byteLength(oversizedJournal) <= HOST_TRANSITION_JOURNAL_MAX_BYTES)
		throw new Error("oversized-journal recovery precondition did not exceed the byte bound");
	if (oversizedJournal.split("\n").filter(Boolean).length >= 512)
		throw new Error("oversized-journal recovery precondition must stay below the line bound");
	world.io.writeFileSync(journalPath, oversizedJournal);
	const recoveredSettingsBefore = hostFileIdentity(settingsPath);
	if (recoveredSettingsBefore === undefined) throw new Error("settings recovery probe has no pre-write identity");
	manager.setPlain("theme", "light");
	await flushPersistentSettings(manager, "oversized-journal recovery settings write");
	const recoveredSettingsAfter = hostFileIdentity(settingsPath);
	if (recoveredSettingsAfter === undefined) throw new Error("settings recovery probe has no post-write identity");
	existing = world.io.readFileSync(journalPath, "utf8").toString();
	const recoveredRows = parseHostJournalRows(existing);
	if (Buffer.byteLength(existing) > HOST_TRANSITION_JOURNAL_MAX_BYTES)
		throw new Error("real settings write did not recover the oversized historical journal");
	if (existing.includes("fff-near-limit-history"))
		throw new Error("bounded historical recovery retained the oversized first journal row");
	if (
		!recoveredRows.some(
			(row) =>
				row.path === settingsPath && row.before === recoveredSettingsBefore && row.after === recoveredSettingsAfter,
		)
	)
		throw new Error("oversized-journal recovery omitted the actual settings transition");
	if (
		!recoveredRows.some(
			(row) =>
				row.kind === "host-path-transition-batch" && row.transitions?.some((item) => item.path === managedFffDir),
		)
	)
		throw new Error("oversized-journal recovery discarded the complete cold FFF batch");
	const coldBatchBytes = Buffer.byteLength(coldBatchLine) + 1;
	const targetBytes = HOST_TRANSITION_JOURNAL_MAX_BYTES - coldBatchBytes - 1_024;
	const paddingLineBytes = targetBytes - Buffer.byteLength(existing) - 1;
	const paddingLine = makeHistoricalTransitionLine(paddingLineBytes, "fff-near-limit-history");
	const seeded = `${paddingLine}\n${existing}`;
	if (Buffer.byteLength(seeded) !== targetBytes)
		throw new Error("near-limit journal seed did not match its calculated byte pressure");
	world.io.writeFileSync(journalPath, seeded);
	return manager;
}

async function flushPersistentSettings(manager: SettingsManager, label: string): Promise<void> {
	await manager.flush();
	const errors = manager.drainErrors();
	if (errors.length > 0)
		throw new AggregateError(
			errors.map((entry) => entry.error),
			`${label} failed in persistent settings storage`,
		);
}

function makeHistoricalTransitionLine(byteLength: number, marker: string): string {
	const fields = {
		path: `/history/${marker}`,
		before: "historical-before",
		after: "historical-after",
		at: 1,
		padding: "",
	};
	const paddingLength = byteLength - Buffer.byteLength(JSON.stringify(fields));
	if (paddingLength < 0) throw new Error("historical journal row cannot fit its requested byte length");
	const line = JSON.stringify({ ...fields, padding: "x".repeat(paddingLength) });
	if (Buffer.byteLength(line) !== byteLength)
		throw new Error("historical journal row did not match its exact byte length");
	return line;
}

interface HostJournalTransition {
	readonly path: string;
	readonly before: string;
	readonly after: string;
	readonly at: number;
}

interface HostJournalRow extends Partial<HostJournalTransition> {
	readonly kind?: string;
	readonly transitions?: readonly HostJournalTransition[];
}

function parseHostJournalRows(content: string): HostJournalRow[] {
	const rows: HostJournalRow[] = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		try {
			rows.push(JSON.parse(line) as HostJournalRow);
		} catch {
			// The pressure assertion counts complete persisted records only.
		}
	}
	return rows;
}

async function runSystemOneOffWorker(world: HarnessWorld): Promise<void> {
	const path = join(HARNESS_PROJECT_CWD, SOURCE_SCOPE, "normalize-off.ts");
	const original = "export function normalizeOff(value: string): string { return value; }\n";
	const updated = "export function normalizeOff(value: string): string { return value.trim(); }\n";
	world.io.seed(path, original);
	let fileListerCalls = 0;
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		systemOneEnabled: false,
		codeDuplicateFileLister: async () => {
			fileListerCalls += 1;
			return [];
		},
		settings: { orchestrator: { delegationGate: true } },
	});
	let disposed = false;
	const handoffSeen = createBarrier();
	world.provider.enqueue(
		"worker-a",
		calls("fff-off-worker-edit", [
			{ id: "fff-off-edit", name: "edit", arguments: { path, edits: [{ oldText: original, newText: updated }] } },
		]),
		{
			name: "fff-off-worker-report",
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError || world.io.readFileSync(path, "utf8") !== updated)
					throw new Error(`System One off worker edit did not complete: ${edit?.text ?? "no result"}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "fff-off-report",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Updated normalizeOff to trim surrounding whitespace.",
							changes: [
								{
									file: relative(HARNESS_PROJECT_CWD, path),
									what: "Trims the input value before returning it.",
								},
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.provider.enqueue(
		"root",
		calls("fff-off-delegate", [
			{
				id: "fff-off-delegate",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [SOURCE_SCOPE],
					instructions: `Update ${path} to trim its input.`,
				},
			},
		]),
		{ name: "fff-off-started", reply: { content: [{ type: "text", text: "The change is delegated." }] } },
		{
			name: "fff-off-handoff",
			maxRequests: 8,
			until: (request) => {
				const found = latestWorkerHandoff(request) !== undefined;
				if (found) handoffSeen.release();
				return found;
			},
			reply: (request) => {
				const text = latestWorkerHandoff(request);
				if (text === undefined)
					return { content: [{ type: "text", text: "I am waiting for the worker handoff." }] };
				if (!text.includes("normalize-off.ts"))
					throw new Error("System One off parent handoff omitted the completed worker claim");
				return { content: [{ type: "text", text: "The worker claim is received." }] };
			},
		},
	);
	try {
		await created.session.prompt("Update the normalizer with a worker, then review its report.");
		await withDeadline(world.trace, "System One off worker reaches parent handoff", handoffSeen.promise);
		await created.session.waitForForegroundIdle();
		const claim = created.session.getWorkerClaimSnapshots().at(-1);
		expect(claim?.status, "System One off still runs the worker through terminal handoff").toBe("completed");
		expect(claim?.hostVerdict?.verdict, "host accepts the off-mode report for its changed file").toBe("accepted");
		expect(claim?.parentReviewRequired ?? false, "System One off does not create protected-path review work").toBe(
			false,
		);
		expect(claim?.hostFindings ?? [], "System One off has no host findings").toEqual([]);
		expect(world.systemOne.decoded, "System One off does not invoke semantic review or FFF provisioning").toEqual([]);
		expect(fileListerCalls, "System One off skips the semantic duplicate file listing path").toBe(0);
		expect(world.io.readFileSync(path, "utf8")).toBe(updated);
		expect(await world.disposeSessionInBody(created.session)).toBeUndefined();
		disposed = true;
		await world.provider.waitForProducers();
	} finally {
		if (!disposed) await world.disposeSessionInBody(created.session);
	}
}
