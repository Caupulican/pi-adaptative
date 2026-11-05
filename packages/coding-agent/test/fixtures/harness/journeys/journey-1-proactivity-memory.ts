import { createHash } from "node:crypto";
import type { Context, ToolResultMessage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { configFile } from "../../../../src/core/agent-paths.ts";
import { isTranscriptRecallWorkerRequest } from "../../../../src/core/memory/providers/transcript-recall-worker-protocol.ts";
import { calls, type ScriptStep, text } from "../scripted-provider.ts";
import { type HarnessWorld, settlementState, withDeadline } from "../session-fixture.ts";

const MEMORY_TEXT = "The release checklist still requires the migration note.\n";
const NOTE_TEXT = "The migration note recorded in memory is still unfinished.";
const OPAQUE_TEXT = "opaque-extension-memory-must-not-cross-native";

function readResult(context: Context, id: string): ToolResultMessage<unknown> {
	const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
	if (result?.role !== "toolResult") throw new Error(`Missing native memory result ${id}`);
	return result;
}

function readText(result: ToolResultMessage<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** J1's real review, memory broker and transcript worker: receipt freshness and physical cancellation. */
export async function runJourney1ProactivityMemory(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const createReview = async (label: string, opaqueControl = false) => {
		const agentDir = `${world.agentDir}-proactivity-memory-${label}`;
		const memoryPath = configFile(agentDir, "MEMORY.md");
		world.io.seed(memoryPath, MEMORY_TEXT);
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
		const prefetches: string[] = [];
		if (opaqueControl) {
			created.session.registerMemoryProvider({
				name: "proactivity-opaque-control",
				egress: "local",
				isAvailable: () => true,
				getCapabilities: () => ({ surfaces: ["context"] }),
				initialize: async () => {},
				shutdown: async () => {},
				prefetch: async (query) => {
					prefetches.push(query);
					return OPAQUE_TEXT;
				},
			});
			await created.session.initializeMemory();
		}
		created.session.setActiveToolsByName(["memory"]);
		const ownerPrompt = "Watch the release checklist recorded in my memory for unfinished work.";
		world.provider.enqueue("root", text(`memory-${label}-owner`, "Understood."));
		await withDeadline(trace, `${label} memory owner turn`, created.session.prompt(ownerPrompt));
		created.session.backgroundLanes.clearResearchLaneTimer();
		if (opaqueControl) expect(prefetches, "ordinary owner recall still admits the extension").toContain(ownerPrompt);
		prefetches.length = 0;
		const outcomes: string[] = [];
		const off = created.session.subscribe((event) => {
			if (event.type === "proactive_review") outcomes.push(event.outcome);
		});
		return {
			...created,
			memoryPath,
			prefetches,
			outcomes,
			off,
			async close() {
				off();
				expect(
					await world.disposeSessionInBody(created.session),
					`${label} memory resources settle`,
				).toBeUndefined();
			},
		};
	};
	const readStep = (label: string): ScriptStep =>
		calls(`memory-${label}-read`, [
			{
				id: `memory-${label}-read`,
				name: "memory_read",
				arguments: { query: `proactivity native standing memory ${label}` },
			},
		]);
	const noteStep = (label: string, check: ScriptStep["check"]): ScriptStep => ({
		...calls(`memory-${label}-note`, [
			{
				id: `memory-${label}-note`,
				name: "raise_note",
				arguments: {
					kind: "reminder",
					text: NOTE_TEXT,
					why: "The current native memory records the unfinished item.",
					evidenceIds: ["e1"],
				},
			},
		]),
		check,
	});
	const notes = (created: Awaited<ReturnType<typeof createReview>>) =>
		created.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "proactive-note");

	const normal = await createReview("normal", true);
	const normalIo = world.io.operations.length;
	const normalMessages = world.guard.threads.messageLog.length;
	let receivedText = "";
	world.provider.enqueue(
		"root",
		readStep("normal"),
		noteStep("normal", (request) => {
			const result = readResult(request.context, "memory-normal-read");
			expect(result.isError).toBe(false);
			receivedText = readText(result);
			expect(receivedText).toContain(MEMORY_TEXT.trim());
			expect(receivedText).toContain("[Evidence e1;");
			expect(receivedText).not.toContain(OPAQUE_TEXT);
		}),
	);
	const normalRequests = world.provider.requests.length;
	expect(
		(
			await withDeadline(
				trace,
				"native memory evidence survives the next lane request",
				normal.session.backgroundLanes.runProactiveReviewOnce(),
			)
		).delivered,
	).toEqual([expect.objectContaining({ text: NOTE_TEXT, evidenceIds: ["e1"] })]);
	expect(world.provider.requests.length - normalRequests).toBe(2);
	expect(normal.outcomes).toEqual(["raised"]);
	expect(normal.prefetches, "native-only acquisition and revalidation never call opaque extension recall").toEqual([]);
	expect(
		world.io.operations
			.slice(normalIo)
			.filter((operation) => operation.path === normal.memoryPath)
			.reduce((sum, operation) => sum + (operation.bytesRead ?? 0), 0),
		"adoption reads the managed source again rather than trusting its first projection",
	).toBeGreaterThanOrEqual(2 * Buffer.byteLength(MEMORY_TEXT));
	expect(
		world.guard.threads.messageLog
			.slice(normalMessages)
			.filter(
				(message) =>
					message.direction === "inbound" &&
					message.type === "query" &&
					message.facts.query === "proactivity native standing memory normal",
			),
		"transcript observation is acquired and revalidated through the worker",
	).toHaveLength(2);
	const note = notes(normal)[0];
	if (note?.type !== "custom_message") throw new Error("The native-memory note is missing");
	expect(notes(normal)).toHaveLength(1);
	expect(note.details).toMatchObject({
		originalDetails: {
			evidence: [
				expect.objectContaining({
					id: "e1",
					tool: "memory_read",
					workClass: "native-memory",
					sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
					deliveredDigest: createHash("sha256").update(receivedText).digest("hex"),
					sources: expect.arrayContaining([expect.objectContaining({ kind: "managed", ref: normal.memoryPath })]),
				}),
			],
		},
	});
	await normal.close();

	const stale = await createReview("changed-source");
	world.provider.enqueue(
		"root",
		readStep("changed-source"),
		noteStep("changed-source", (request) => {
			expect(readText(readResult(request.context, "memory-changed-source-read"))).toContain(MEMORY_TEXT.trim());
			world.io.writeFileSync(stale.memoryPath, "The migration note has now been completed.\n");
		}),
	);
	await expect(
		withDeadline(
			trace,
			"rewritten managed memory cannot support adoption",
			stale.session.backgroundLanes.runProactiveReviewOnce(),
		),
	).rejects.toThrow("Proactive source authority changed");
	expect(stale.outcomes).toEqual(["failed"]);
	expect(notes(stale)).toEqual([]);
	await stale.close();

	const cancelled = await createReview("cancelled");
	const query = "proactivity native standing memory cancelled";
	const held = world.guard.threads.holdNext(
		"native memory physical read",
		"query",
		(request) => isTranscriptRecallWorkerRequest(request) && request.type === "query" && request.query === query,
	);
	world.provider.enqueue("root", readStep("cancelled"));
	const cancelledRequests = world.provider.requests.length;
	const cancellation = cancelled.session.backgroundLanes.runProactiveReviewOnce();
	let disposal: ReturnType<HarnessWorld["disposeSessionInBody"]> | undefined;
	let acknowledgement: Promise<unknown> | undefined;
	try {
		const request = await withDeadline(trace, "native query reaches the real worker boundary", held.reached);
		if (!isTranscriptRecallWorkerRequest(request) || request.type !== "query")
			throw new Error("Missing held native query");
		expect(Atomics.load(request.control.cancelled, 0)).toBe(0);
		acknowledgement = world.guard.threads.onResponse(
			"native cancellation acknowledged",
			"queryFailed",
			(_response, original) =>
				isTranscriptRecallWorkerRequest(original) && original.type === "query" && original.query === query,
		);
		cancelled.settingsManager.setProactivitySettings({
			...cancelled.settingsManager.getProactivitySettings(),
			enabled: false,
		});
		await settlementState(cancellation);
		expect(
			Atomics.load(request.control.cancelled, 0),
			"last consumer cancellation reaches synchronous worker reads",
		).toBe(1);
		disposal = world.disposeSessionInBody(cancelled.session);
		expect(await settlementState(disposal), "shutdown retains physical ownership until the worker acknowledges").toBe(
			"pending",
		);
	} finally {
		held.release();
	}
	expect(await withDeadline(trace, "cancelled native review settles", cancellation)).toMatchObject({
		delivered: [],
		skipReason: "review_context_changed",
	});
	if (!acknowledgement || !disposal) throw new Error("The native cancellation did not reach shutdown");
	await withDeadline(trace, "worker acknowledges physical cancellation", acknowledgement);
	expect(await withDeadline(trace, "native source ownership drains before disposal", disposal)).toBeUndefined();
	expect(
		world.provider.requests.length - cancelledRequests,
		"cancelled source evidence never reaches another provider request",
	).toBe(1);
	expect(cancelled.outcomes).toEqual(["failed"]);
	expect(notes(cancelled)).toEqual([]);
	cancelled.off();
	trace.mark("root", "proactivity.memory.done");
}
