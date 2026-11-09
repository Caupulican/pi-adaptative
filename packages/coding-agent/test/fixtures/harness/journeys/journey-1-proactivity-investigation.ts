import { createHash } from "node:crypto";
import type { Context, ToolResultMessage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { configFile } from "../../../../src/core/agent-paths.ts";
import type { IsolatedCompletionResult } from "../../../../src/core/agent-session.ts";
import { createLaneToolSurface } from "../../../../src/core/autonomy/lane-tool-surface.ts";
import { retainedToolInvocation } from "../../../../src/kernel/tool-invocation-receipt.ts";
import { calls, createBarrier, type ScriptStep, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { rejectionOf } from "./shared.ts";

const SOURCE_DIRECTORY = projectPath("proactivity-evidence");
const SOURCE_PATH = projectPath("proactivity-evidence", "current.txt");
const SOURCE_TEXT = "The release checklist still requires the migration note.\n";
const NOTE_TEXT = "The migration note is still missing from the release checklist.";

function resultFor(context: Context, id: string): ToolResultMessage<unknown> {
	const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
	if (result?.role !== "toolResult") throw new Error(`Missing tool result ${id}`);
	return result;
}

function resultText(result: ToolResultMessage<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Existing J1 coverage: real review admission, bounded local tools, adoption and kernel denial. */
export async function runJourney1ProactivityInvestigation(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	world.io.seed(projectPath("proactivity-evidence", ".editorconfig"), "root = true\n[*]\ncharset = utf-8\n");
	world.io.seed(SOURCE_PATH, SOURCE_TEXT);
	const createReview = async (label: string) => {
		const agentDir = `${world.agentDir}-investigation-${label}`;
		const created = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			systemOneEnabled: false,
			settings: {
				memorySystem: "okf",
				autoLearn: { enabled: false },
				proactivity: {
					enabled: true,
					minOwnerTurnsBetweenRuns: 1,
					maxRunsPerSession: 1,
					delivery: "note",
				},
			},
		});
		created.session.setActiveToolsByName(["read", "ls", "find", "repo_read"]);
		world.provider.enqueue("root", text(`investigation-${label}-owner`, "Understood."));
		await withDeadline(
			trace,
			`${label} owner turn`,
			created.session.prompt("Watch the release checklist for unfinished work."),
		);
		created.session.backgroundLanes.clearResearchLaneTimer();
		const outcomes: string[] = [];
		const off = created.session.subscribe((event) => {
			if (event.type === "proactive_review") outcomes.push(event.outcome);
		});
		return {
			...created,
			agentDir,
			outcomes,
			async close() {
				off();
				expect(await world.disposeSessionInBody(created.session), `${label} closes all owned work`).toBeUndefined();
			},
		};
	};
	const noteStep = (label: string, check?: ScriptStep["check"]): ScriptStep => ({
		...calls(`${label}-note`, [
			{
				id: `${label}-note`,
				name: "raise_note",
				arguments: {
					kind: "reminder",
					text: NOTE_TEXT,
					why: "The current checklist records the unfinished item.",
					evidenceIds: ["e1"],
				},
			},
		]),
		check,
	});
	const sourceStep = (label: string): ScriptStep =>
		calls(`${label}-read`, [{ id: `${label}-read`, name: "read", arguments: { path: SOURCE_PATH } }]);
	const readCount = (start: number, path: string) =>
		world.io.operations
			.slice(start)
			.filter((operation) => ["read", "readFile"].includes(operation.kind) && operation.path === path).length;
	const notes = (created: Awaited<ReturnType<typeof createReview>>) =>
		created.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "proactive-note");

	const normal = await createReview("normal");
	const normalIo = world.io.operations.length;
	let receivedText = "";
	world.provider.enqueue(
		"root",
		sourceStep("normal"),
		noteStep("normal", (request) => {
			const result = resultFor(request.context, "normal-read");
			expect(result.isError).toBe(false);
			receivedText = resultText(result);
			expect(receivedText).toContain(SOURCE_TEXT.trim());
			expect(receivedText).toContain("[Evidence e1;");
			expect(Buffer.byteLength(receivedText)).toBeLessThanOrEqual(8 * 1024);
		}),
	);
	const normalRequests = world.provider.requests.length;
	const raised = await withDeadline(
		trace,
		"read evidence then raise a note",
		normal.session.backgroundLanes.runProactiveReviewOnce(),
	);
	expect(world.provider.requests.length - normalRequests, "a natural read then note uses exactly two responses").toBe(
		2,
	);
	expect(raised.delivered).toEqual([expect.objectContaining({ text: NOTE_TEXT, evidenceIds: ["e1"] })]);
	expect(normal.outcomes).toEqual(["raised"]);
	expect(
		readCount(normalIo, SOURCE_PATH),
		"delivery reopens the observed source for adoption validation",
	).toBeGreaterThanOrEqual(4);
	expect(notes(normal)).toHaveLength(1);
	const normalNote = notes(normal)[0];
	if (normalNote?.type !== "custom_message") throw new Error("The accepted proactive note is missing");
	expect(normalNote.details).toMatchObject({
		originalDetails: {
			notes: [expect.objectContaining({ evidenceIds: ["e1"] })],
			evidence: [
				expect.objectContaining({
					id: "e1",
					tool: "read",
					sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
					deliveredDigest: createHash("sha256").update(receivedText).digest("hex"),
					sources: [expect.objectContaining({ ref: SOURCE_PATH })],
					workClass: "metered-source-io",
				}),
			],
		},
	});
	await normal.close();

	const quiet = await createReview("quiet");
	world.provider.enqueue(
		"root",
		calls("quiet-local-reads", [
			{ id: "quiet-ls", name: "ls", arguments: { path: SOURCE_DIRECTORY } },
			{ id: "quiet-find", name: "find", arguments: { path: SOURCE_DIRECTORY, pattern: "*.txt" } },
			{ id: "quiet-read", name: "read", arguments: { path: SOURCE_PATH, offset: 1, limit: 1 } },
		]),
		{
			...text("quiet-done", "none"),
			check: (request) => {
				for (const id of ["quiet-ls", "quiet-find", "quiet-read"]) {
					const result = resultFor(request.context, id);
					expect(result.isError, `${id} reaches its actual local owner`).toBe(false);
					expect(resultText(result)).toContain("[Evidence e");
				}
				expect(resultText(resultFor(request.context, "quiet-ls"))).toContain("current.txt");
				expect(resultText(resultFor(request.context, "quiet-find"))).toContain("current.txt");
				expect(resultText(resultFor(request.context, "quiet-read"))).toContain(SOURCE_TEXT.trim());
			},
		},
	);
	const quietRequests = world.provider.requests.length;
	expect(
		(
			await withDeadline(
				trace,
				"local investigation stays quiet",
				quiet.session.backgroundLanes.runProactiveReviewOnce(),
			)
		).delivered,
	).toEqual([]);
	expect(world.provider.requests.length - quietRequests).toBe(2);
	expect(quiet.outcomes).toEqual(["quiet"]);
	expect(notes(quiet)).toEqual([]);
	await quiet.close();

	const limited = await createReview("attempts");
	const privatePath = configFile(limited.agentDir, "auth.json");
	const privateText = "investigation-private-credential-must-not-escape";
	world.io.seed(privatePath, JSON.stringify({ private: privateText }));
	const overflowPath = projectPath("proactivity-evidence", "overflow.txt");
	world.io.seed(overflowPath, "The fourth read must never start.\n");
	const limitedIo = world.io.operations.length;
	world.provider.enqueue(
		"root",
		calls("attempt-ceiling", [
			{ id: "attempt-denied", name: "read", arguments: { path: privatePath } },
			{ id: "attempt-malformed", name: "read", arguments: {} },
			{ id: "attempt-allowed", name: "read", arguments: { path: SOURCE_PATH } },
			{ id: "attempt-overflow", name: "read", arguments: { path: overflowPath } },
		]),
		{
			...text("attempt-ceiling-done", "none"),
			check: (request) => {
				for (const id of ["attempt-denied", "attempt-malformed", "attempt-overflow"]) {
					const result = resultFor(request.context, id);
					expect(result.isError, `${id} is refused`).toBe(true);
					expect(retainedToolInvocation(result.details)?.execution, `${id} never executes`).toBe("not_started");
				}
				expect(resultFor(request.context, "attempt-allowed").isError).toBe(false);
				expect(resultText(resultFor(request.context, "attempt-allowed"))).toContain("[Evidence e1;");
				expect(JSON.stringify(request.context.messages)).not.toContain(privateText);
			},
		},
	);
	const limitedRequests = world.provider.requests.length;
	await withDeadline(
		trace,
		"denied and malformed attempts consume the finite allowance",
		limited.session.backgroundLanes.runProactiveReviewOnce(),
	);
	expect(world.provider.requests.length - limitedRequests).toBe(2);
	expect(readCount(limitedIo, privatePath)).toBe(0);
	expect(readCount(limitedIo, overflowPath)).toBe(0);
	expect(readCount(limitedIo, SOURCE_PATH)).toBeGreaterThan(0);
	expect(limited.outcomes).toEqual(["quiet"]);
	await limited.close();

	// A one-line request still has a physical source budget: the large body must never be loaded.
	const physical = await createReview("source-budget");
	const oversizedPath = projectPath("proactivity-evidence", "oversized.txt");
	const unreadTail = "oversized-body-tail-must-not-be-read";
	world.io.seed(oversizedPath, `${"x".repeat(1024 * 1024)}\n${unreadTail}`);
	const physicalIo = world.io.operations.length;
	world.provider.enqueue(
		"root",
		calls("source-budget-reads", [
			{ id: "source-budget-large", name: "read", arguments: { path: oversizedPath, limit: 1 } },
			{ id: "source-budget-control", name: "read", arguments: { path: SOURCE_PATH } },
		]),
		noteStep("source-budget", (request) => {
			const refused = resultFor(request.context, "source-budget-large");
			expect(refused.isError).toBe(true);
			expect(resultText(refused)).toContain("Read investigation limit reached: sourceBytes");
			expect(resultText(refused)).not.toContain("[Evidence e");
			expect(retainedToolInvocation(refused.details)).toMatchObject({
				execution: "completed",
				operationStatus: "error",
			});
			const control = resultFor(request.context, "source-budget-control");
			expect(control.isError, "another admitted call keeps its own physical allowance").toBe(false);
			expect(resultText(control)).toContain("[Evidence e1;");
			expect(resultText(control)).toContain(SOURCE_TEXT.trim());
			expect(JSON.stringify(request.context.messages)).not.toContain(unreadTail);
		}),
	);
	const physicalRequests = world.provider.requests.length;
	expect(
		(
			await withDeadline(
				trace,
				"oversized source refused with a working normal control",
				physical.session.backgroundLanes.runProactiveReviewOnce(),
			)
		).delivered,
	).toEqual([expect.objectContaining({ evidenceIds: ["e1"] })]);
	expect(world.provider.requests.length - physicalRequests).toBe(2);
	const oversizedReads = world.io.operations
		.slice(physicalIo)
		.filter((operation) => operation.kind === "read" && operation.path === oversizedPath);
	expect(
		oversizedReads,
		"only the image-sniff prefix is physically read; the oversized body and its revalidation are never read",
	).toHaveLength(1);
	expect(oversizedReads[0]?.bytesRead).toBe(4100);
	expect(oversizedReads.reduce((sum, operation) => sum + (operation.bytesRead ?? 0), 0)).toBeLessThanOrEqual(
		1024 * 1024,
	);
	expect(physical.outcomes).toEqual(["raised"]);
	await physical.close();
	world.io.unlinkSync(oversizedPath);

	// The deadline belongs to the whole investigation. A later response cannot start a fresh read allowance.
	const expired = await createReview("deadline");
	const afterDeadlinePath = projectPath("proactivity-evidence", "after-deadline.txt");
	world.io.seed(afterDeadlinePath, "This source may only be read by a fresh review.\n");
	const expiredIo = world.io.operations.length;
	const deadlineGate = createBarrier();
	const deadlineReached = createBarrier();
	let releaseDeadline: ReturnType<typeof setTimeout> | undefined;
	let deadlineStarted = 0;
	world.provider.enqueue("root", sourceStep("deadline"), {
		...calls("deadline-late-read", [
			{ id: "deadline-late-read", name: "read", arguments: { path: afterDeadlinePath } },
		]),
		check: (request) => {
			expect(resultText(resultFor(request.context, "deadline-read"))).toContain("[Evidence e1;");
			deadlineStarted = Date.now();
			releaseDeadline = setTimeout(() => deadlineGate.release(), 15_050);
			deadlineReached.release();
		},
		gate: deadlineGate.promise,
	});
	const expiredRequests = world.provider.requests.length;
	const expiration = expired.session.backgroundLanes.runProactiveReviewOnce().then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	try {
		await withDeadline(trace, "deadline witness reaches its second response", deadlineReached.promise);
		const settled = await withDeadline(trace, "the original read deadline expires", expiration, 25_000);
		expect("error" in settled ? String(settled.error) : settled.value).toContain("deadline expired");
		expect(
			Date.now() - deadlineStarted,
			"the real 15-second deadline elapsed after the first read",
		).toBeGreaterThanOrEqual(15_000);
		expect(world.provider.requests.length - expiredRequests).toBe(2);
		expect(readCount(expiredIo, SOURCE_PATH), "the initial source really ran before expiry").toBeGreaterThan(0);
		expect(readCount(expiredIo, afterDeadlinePath), "the late read cannot reset the investigation deadline").toBe(0);
		expect(notes(expired)).toEqual([]);
		expect(expired.outcomes).toEqual(["failed"]);
	} finally {
		clearTimeout(releaseDeadline);
		deadlineGate.release();
		await expired.close();
	}
	const fresh = await createReview("after-deadline");
	const freshIo = world.io.operations.length;
	world.provider.enqueue(
		"root",
		calls("after-deadline-read", [
			{ id: "after-deadline-read", name: "read", arguments: { path: afterDeadlinePath } },
		]),
		{
			...text("after-deadline-done", "none"),
			check: (request) => {
				const result = resultFor(request.context, "after-deadline-read");
				expect(result.isError).toBe(false);
				expect(resultText(result)).toContain("This source may only be read by a fresh review.");
				expect(resultText(result)).toContain("[Evidence e1;");
			},
		},
	);
	const freshRequests = world.provider.requests.length;
	await withDeadline(
		trace,
		"fresh investigation gets a new deadline",
		fresh.session.backgroundLanes.runProactiveReviewOnce(),
	);
	expect(world.provider.requests.length - freshRequests).toBe(2);
	expect(readCount(freshIo, afterDeadlinePath)).toBeGreaterThan(0);
	expect(fresh.outcomes).toEqual(["quiet"]);
	await fresh.close();

	const stale = await createReview("changed-source");
	world.provider.enqueue(
		"root",
		sourceStep("stale"),
		noteStep("stale", (request) => {
			expect(resultText(resultFor(request.context, "stale-read"))).toContain(SOURCE_TEXT.trim());
			world.io.writeFileSync(SOURCE_PATH, "The release checklist is now complete.\n");
		}),
	);
	expect(
		(
			await rejectionOf(
				withDeadline(
					trace,
					"changed source cannot support delivery",
					stale.session.backgroundLanes.runProactiveReviewOnce(),
				),
			)
		)?.message,
	).toContain("changed before delivery");
	expect(stale.outcomes).toEqual(["failed"]);
	expect(notes(stale)).toEqual([]);
	await stale.close();
	world.io.writeFileSync(SOURCE_PATH, SOURCE_TEXT);

	const cancelled = await createReview("cancelled");
	const reached = createBarrier();
	const release = createBarrier();
	world.provider.enqueue("root", sourceStep("cancelled"), {
		...noteStep("cancelled"),
		check: (request) => {
			expect(resultText(resultFor(request.context, "cancelled-read"))).toContain("[Evidence e1;");
			reached.release();
		},
		gate: release.promise,
	});
	const cancellation = cancelled.session.backgroundLanes.runProactiveReviewOnce();
	try {
		await withDeadline(trace, "cancellation reaches the second response after a read", reached.promise);
		cancelled.settingsManager.setProactivitySettings({
			...cancelled.settingsManager.getProactivitySettings(),
			enabled: false,
		});
	} finally {
		release.release();
	}
	expect(await withDeadline(trace, "cancelled investigation settles", cancellation)).toMatchObject({
		delivered: [],
		skipReason: "review_context_changed",
	});
	expect(cancelled.outcomes).toEqual(["failed"]);
	expect(notes(cancelled)).toEqual([]);
	await cancelled.close();

	const git = await createReview("git");
	world.git.initialize("main", { "proactivity-evidence/current.txt": SOURCE_TEXT });
	const gitStart = world.processes.gitCalls.length;
	world.provider.enqueue(
		"root",
		calls("git-subtree-denials", [
			{ id: "git-directory", name: "repo_read", arguments: { action: "diff", paths: ["."] } },
			{ id: "git-unscoped-log", name: "repo_read", arguments: { action: "log", options: ["--name-status"] } },
		]),
		{
			...calls("git-allowed-file", [
				{
					id: "git-file",
					name: "repo_read",
					arguments: { action: "show", paths: ["proactivity-evidence/current.txt"], revisions: ["HEAD"] },
				},
			]),
			check: (request) => {
				for (const id of ["git-directory", "git-unscoped-log"])
					expect(resultFor(request.context, id).isError).toBe(true);
				expect(
					world.processes.gitCalls.slice(gitStart),
					"subtree denial precedes every native Git command",
				).toEqual([]);
			},
		},
	);
	const gitRequests = world.provider.requests.length;
	const gitCompletionIndex = world.isolatedCompletions.length;
	await withDeadline(
		trace,
		"native Git stays within approved file targets",
		git.session.backgroundLanes.runProactiveReviewOnce(),
	);
	expect(world.provider.requests.length - gitRequests).toBe(2);
	const gitCompletion = (await world.isolatedCompletions[gitCompletionIndex]) as IsolatedCompletionResult;
	const gitResult = resultFor({ messages: gitCompletion.messages ?? [] }, "git-file");
	expect(gitResult.isError, "the allowed native Git control returns content").toBe(false);
	expect(resultText(gitResult)).toContain(SOURCE_TEXT.trim());
	expect(resultText(gitResult)).toContain("[Evidence e1;");
	expect(resultText(gitResult)).toContain("internal Git I/O is not metered");
	const gitCalls = world.processes.gitCalls.slice(gitStart);
	expect(gitCalls.length, "the allowed control actually runs native Git").toBeGreaterThan(0);
	expect(gitCalls.every((call) => call.file === world.git.executable)).toBe(true);
	const show = gitCalls.find((call) => call.args.includes("show"));
	expect(show?.args).toEqual(
		expect.arrayContaining([
			"--no-pager",
			"--literal-pathspecs",
			"--no-ext-diff",
			"--no-textconv",
			"--",
			"proactivity-evidence/current.txt",
		]),
	);
	expect(
		show?.args.some((argument) => /^[a-f0-9]{40}$/.test(argument)),
		"the native content command uses a pinned commit",
	).toBe(true);
	expect(show?.env).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" });
	expect(git.outcomes).toEqual(["quiet"]);
	await git.close();

	// Deliberately omit the advisory beforeToolCall hook: admission at execute remains mandatory.
	const kernel = await createReview("kernel");
	const denied = configFile(kernel.agentDir, "auth.json");
	world.io.seed(denied, JSON.stringify({ secret: "kernel-denied-content" }));
	const surface = createLaneToolSurface({ cwd: HARNESS_PROJECT_CWD, readOnly: true, deniedPaths: [denied] });
	const read = surface.tools.find((tool) => tool.name === "read");
	if (!read) throw new Error("The production lane did not materialize read");
	const afterCalls: string[] = [];
	const kernelIo = world.io.operations.length;
	world.provider.enqueue(
		"root",
		calls("mandatory-kernel-admission", [
			{ id: "kernel-denied", name: "read", arguments: { path: denied } },
			{ id: "kernel-allowed", name: "read", arguments: { path: SOURCE_PATH } },
		]),
		{
			...text("mandatory-kernel-admission-done", "none"),
			check: (request) => {
				const refused = resultFor(request.context, "kernel-denied");
				expect(refused.isError).toBe(true);
				expect(retainedToolInvocation(refused.details)?.execution).toBe("not_started");
				const allowed = resultFor(request.context, "kernel-allowed");
				expect(allowed.isError).toBe(false);
				expect(resultText(allowed)).toContain(SOURCE_TEXT.trim());
				expect(retainedToolInvocation(allowed.details)).toMatchObject({
					execution: "completed",
					operationStatus: "success",
				});
				expect(JSON.stringify(request.context.messages)).not.toContain("kernel-denied-content");
			},
		},
	);
	try {
		await withDeadline(
			trace,
			"mandatory admission reaches the real kernel",
			kernel.session.runIsolatedCompletion({
				systemPrompt: "Read the requested current checklist.",
				messages: [{ role: "user", content: "Inspect the supplied files.", timestamp: Date.now() }],
				tools: [read],
				maxTurns: 2,
				cacheRetention: "short",
				afterToolCall: async (context) => {
					afterCalls.push(context.toolCall.id);
					return undefined;
				},
			}),
		);
		expect(afterCalls, "policy denial skips the after hook while the allowed control reaches it").toEqual([
			"kernel-allowed",
		]);
		expect(readCount(kernelIo, denied)).toBe(0);
	} finally {
		await surface.dispose();
		await kernel.close();
	}
	trace.mark("root", "proactivity.investigation.done");
}
