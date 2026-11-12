import { expect } from "vitest";
import { ContinuousChatStore } from "../../../../src/core/memory/continuous-chat-store.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	ICM_INTAKE_JUDGMENTS,
	icmContinuousStore,
	icmEndForegroundQuiet,
	icmLatestResult,
	icmReadContinuousNodes,
	icmReadContinuousRecords,
	icmReadScheduler,
	latestBatchResults,
} from "./shared.ts";

/** A real root and granted worker navigate a sparse live chat while its compactor is held by configuration. */
export async function verifyRangeJourney(
	world: HarnessWorld,
	root: Awaited<ReturnType<HarnessWorld["createRootSession"]>>,
	agentDir: string,
	summaryWarning: string,
): Promise<void> {
	const trace = world.trace;
	const store = icmContinuousStore(agentDir);
	const warningMark = world.warnings.length;
	const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=";
	for (let i = 0; i < 5; i++) {
		world.provider.enqueue("root", text(`range-seed-${i}`, `Seed reply ${i}.`));
		// The initial turn screens the preceding owner message; later seed turns do not request that screen.
		world.systemOne.enterPhase(`range-seed-${i}`, {
			...ICM_INTAKE_JUDGMENTS,
			...(i === 0 ? { carries_0: { kind: "noul" as const, probability: 0.02 } } : {}),
		});
		await withDeadline(
			trace,
			`range seed ${i}`,
			root.session.prompt(
				`Range seed ${i}: ${"r".repeat(1800)}`,
				i === 4 ? { images: [{ type: "image", mimeType: "image/png", data: imageData }] } : undefined,
			),
		);
		await withDeadline(
			trace,
			`range seed ${i} persisted`,
			world.io.waitForMutation(() => icmReadContinuousRecords(world, store).length >= 4 + i * 2),
		);
	}
	const before = icmReadContinuousRecords(world, store);
	expect(before.length).toBeGreaterThanOrEqual(12);
	expect(before[10]?.images).toHaveLength(1);
	expect(icmReadContinuousNodes(world, store).some((node) => node.level === 0 && node.ordinal === 0)).toBe(false);
	let rootRange = "";
	world.provider.enqueue(
		"root",
		calls("range-root-call", [{ id: "range-root-zoom", name: "zoom", arguments: { id: 0, n: 9 } }]),
		{
			name: "range-root-reply",
			check: (request) => {
				rootRange = icmLatestResult(request, "zoom").text;
			},
			reply: { content: [{ type: "text", text: "Read the sparse range." }] },
		},
	);
	world.systemOne.enterPhase("range-root", ICM_INTAKE_JUDGMENTS);
	await withDeadline(trace, "range root turn", root.session.prompt("Inspect messages zero through eight."));
	expect(rootRange).toContain("0+1|user:");
	expect(rootRange).toContain("8+1|user:");
	expect(rootRange).not.toContain("not merged yet");
	expect(Buffer.byteLength(rootRange, "utf8")).toBeLessThanOrEqual(32_768);

	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "j1-range-reader",
		description: "Read a bounded continuous-chat range.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "memory.query"],
		readOnly: true,
		toolNames: ["read", "zoom", "date"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(profile, "global");
	const workerDone = createBarrier();
	const wake = createBarrier();
	const firstSeen = createBarrier();
	const releaseContinuation = createBarrier();
	const covered: number[] = [];
	let imagePointer = false;
	let cursor = 0;
	let pageCount = 0;
	let continuation: { id: number; n: number } | undefined;
	world.provider.enqueue(
		"worker-a",
		{
			name: "range-worker-first",
			reply: {
				content: [{ type: "toolCall", id: "range-worker-zoom", name: "zoom", arguments: { id: 0, n: 12 } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "range-worker-continue",
			maxRequests: 12,
			gate: releaseContinuation.promise,
			check: (request) => {
				const result = icmLatestResult(request, "zoom");
				if (result.text.includes("zoom({id:10,n:1,page:0})")) imagePointer = true;
				if (result.isError) throw new Error(`Worker range was refused: ${result.text}`);
				expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(4096);
				const spans = [...result.text.matchAll(/^(\d+)\+(\d+)\|/gm)].map((match) => ({
					start: Number(match[1]),
					count: Number(match[2]),
				}));
				const message = /^message (\d+) \([^\n]+\) page 1\/1/m.exec(result.text);
				if (message) spans.push({ start: Number(message[1]), count: 1 });
				if (spans.length === 0) throw new Error(`Worker range returned no coverage: ${result.text.slice(0, 160)}`);
				for (const span of spans) {
					const start = span.start;
					const length = span.count;
					expect(start, "each span starts after the previous one").toBe(cursor);
					for (let id = start; id < start + length; id++) covered.push(id);
					cursor += length;
				}
				const match = /Continue: zoom\(\{id:(\d+),n:(\d+)\}\)/.exec(result.text);
				continuation = match ? { id: Number(match[1]), n: Number(match[2]) } : undefined;
				if (continuation) expect(continuation).toEqual({ id: cursor, n: 12 - cursor });
				else expect(cursor).toBe(12);
				if (++pageCount === 1) {
					if (!continuation) throw new Error("Worker range did not exercise continuation.");
					firstSeen.release();
				}
			},
			until: () => continuation === undefined,
			reply: () => {
				if (!continuation) {
					workerDone.release();
					return {
						content: [
							{
								type: "toolCall",
								id: "range-worker-report-call",
								name: "submit_report",
								arguments: { status: "completed", summary: "Read the sparse range and its continuation." },
							},
						],
						stopReason: "toolUse",
					};
				}
				return {
					content: [
						{ type: "toolCall", id: `range-worker-next-${pageCount}`, name: "zoom", arguments: continuation },
					],
					stopReason: "toolUse",
				};
			},
		},
	);
	world.provider.enqueue(
		"root",
		calls("range-worker-start", [
			{
				id: "range-worker-start-call",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "j1-range-reader",
					instructions: "Read the bounded continuous-chat range and report.",
				},
			},
		]),
		{
			name: "range-worker-start-reply",
			check: (request) => {
				const result = latestBatchResults(request).find((item) => item.toolName === "delegate");
				if (result?.isError || !result?.text.includes("delegate started (running)"))
					throw new Error(`Range worker not started: ${result?.text}`);
			},
			reply: { content: [{ type: "text", text: "Range reader started." }] },
		},
		{
			name: "range-append-reply",
			reply: { content: [{ type: "text", text: "Range append recorded." }] },
		},
		{
			name: "range-worker-wake",
			maxRequests: 8,
			until: (request) => {
				const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
				if (done) wake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Range reader settling." }] },
		},
	);
	world.systemOne.enterPhase("range-worker", ICM_INTAKE_JUDGMENTS);
	await withDeadline(trace, "range worker start", root.session.prompt("Start the range reader worker."));
	await withDeadline(trace, "range worker first page", firstSeen.promise);
	const priorNodes = new Set(icmReadContinuousNodes(world, store).map((node) => `${node.level}:${node.ordinal}`));
	const remainingStart = continuation!.id;
	const recordsBeforeAppend = icmReadContinuousRecords(world, store).length;
	world.systemOne.enterPhase("range-append", ICM_INTAKE_JUDGMENTS);
	await withDeadline(trace, "range append turn", root.session.prompt("Append a note while the range is open."));
	await withDeadline(
		trace,
		"range append persisted",
		world.io.waitForMutation(() => icmReadContinuousRecords(world, store).length > recordsBeforeAppend),
	);
	await icmEndForegroundQuiet(world);
	await withDeadline(
		trace,
		"range background publication",
		world.io.waitForMutation(() =>
			icmReadContinuousNodes(world, store).some((node) => {
				const first = node.ordinal * 2 ** node.level;
				return !priorNodes.has(`${node.level}:${node.ordinal}`) && first >= remainingStart && first < 12;
			}),
		),
	);
	await withDeadline(
		trace,
		"range summary queue settles",
		world.io.waitForMutation(() => {
			const state = icmReadScheduler(world, store);
			return state !== undefined && state.running === 0 && state.readyLeaves === 0 && state.readyParents === 0;
		}),
	);
	const blocked = world.guard.peekSqlite(store.queueDatabase, "SELECT level, ordinal, status, reason FROM work") ?? [];
	for (let index = world.warnings.length - 1; index >= warningMark; index--) {
		const match = /^Continuous-chat compaction (\d+)\+(\d+) failed: (.+)$/.exec(world.warnings[index]!);
		if (!match || match[3] !== summaryWarning) continue;
		const first = Number(match[1]);
		const count = Number(match[2]);
		const level = Math.log2(count);
		expect(
			blocked.some(
				(row) =>
					row.status === "blocked" &&
					row.reason === summaryWarning &&
					row.level === level &&
					row.ordinal === first / count,
			),
		).toBe(true);
		world.warnings.splice(index, 1);
	}
	releaseContinuation.release();
	await withDeadline(trace, "range worker continuation", workerDone.promise);
	await withDeadline(trace, "range worker handoff", wake.promise, 60_000);
	await withDeadline(trace, "range root idle", root.session.waitForForegroundIdle());
	expect(pageCount).toBeGreaterThan(1);
	expect(covered).toEqual(Array.from({ length: 12 }, (_, id) => id));
	expect(imagePointer, "the worker's range retains a route to the original image").toBe(true);
	let imageDelivered = false;
	world.provider.enqueue(
		"root",
		calls("range-image-call", [{ id: "range-image-zoom", name: "zoom", arguments: { id: 10, n: 1, page: 0 } }]),
		{
			name: "range-image-reply",
			check: (request) => {
				imageDelivered = request.context.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === "range-image-zoom" &&
						message.content.some(
							(part) => part.type === "image" && part.mimeType === "image/png" && part.data === imageData,
						),
				);
			},
			reply: { content: [{ type: "text", text: "Observed the attached image." }] },
		},
	);
	world.systemOne.enterPhase("range-image", ICM_INTAKE_JUDGMENTS);
	await withDeadline(trace, "range image turn", root.session.prompt("Open the image from message ten."));
	expect(imageDelivered, "the next provider request receives the persisted image attachment").toBe(true);
	const readReached = createBarrier();
	const releaseRead = createBarrier();
	const originalRead = ContinuousChatStore.prototype.readMessageById;
	let intercepted = false;
	ContinuousChatStore.prototype.readMessageById = async function (id, context) {
		const record = await originalRead.call(this, id, context);
		if (!intercepted && id === 0 && context?.signal) {
			intercepted = true;
			readReached.release();
			await releaseRead.promise;
		}
		return record;
	};
	try {
		const requestMark = world.provider.requests.length;
		const entryMark = root.sessionManager.getEntries().length;
		world.provider.enqueue(
			"root",
			calls("range-cancel-call", [{ id: "range-cancel-zoom", name: "zoom", arguments: { id: 0, n: 9 } }]),
		);
		world.systemOne.enterPhase("range-cancel", ICM_INTAKE_JUDGMENTS);
		const turn = root.session.prompt("Open the range, then stop.");
		await withDeadline(trace, "range read held", readReached.promise);
		const stopping = root.session.abort("range read cancellation witness");
		releaseRead.release();
		await withDeadline(trace, "range cancellation", Promise.all([turn, stopping]));
		expect(world.provider.requests.slice(requestMark).filter((request) => request.model.id === "root")).toHaveLength(
			1,
		);
		expect(
			root.sessionManager
				.getEntriesSince(entryMark)
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "range-cancel-zoom" &&
						!entry.message.isError,
				),
			"a cancelled range read cannot persist a successful tool result",
		).toBe(false);
	} finally {
		releaseRead.release();
		ContinuousChatStore.prototype.readMessageById = originalRead;
	}
	trace.mark("root", "icm.range-navigation");
}
