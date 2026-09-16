/**
 * Shared fixture for the specialist-reuse suites.
 *
 * One real `AgentSession` (suite harness) with its real execution-plane controller, real
 * `WorkerLifecycle`, real `WorkerConversationStore` and real durable ledger. The only determinism is
 * the provider: every worker turn is a scripted faux reply, and every provider request is captured so
 * a test can assert what context the worker actually received rather than what disk retained.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import type { LaneRecord } from "../../src/core/autonomy/lane-tracker.ts";
import type { BackgroundLaneController } from "../../src/core/background-lane-controller.ts";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import type { AgentBindingContract } from "../../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../../src/core/orchestration/task-runtime.ts";
import { createHarness, type Harness, type HarnessOptions } from "../suite/harness.ts";

/** One provider request exactly as the model saw it. */
export interface CapturedRequest {
	sessionId: string | undefined;
	isWorker: boolean;
	text: string;
	roles: string[];
}

export interface ReuseHarness {
	harness: Harness;
	/** Provider requests in call order; worker requests are the ones on a `lane:worker:` session. */
	requests: CapturedRequest[];
	workerRequests(): CapturedRequest[];
	/** The session's own execution-plane controller (`AgentSession` owns and routes through it). */
	lanes(): BackgroundLaneController;
	/** Durable agent bindings replayed from the same on-disk ledger the session writes. */
	agents(): Record<string, AgentBindingContract>;
	attempts(): AttemptRuntimeState[];
	/** Durable objective a task belongs to, replayed from the ledger. */
	taskObjectiveId(taskId: string): string | undefined;
	laneRecords(): LaneRecord[];
	/** Persisted worker transcript files under this session's conversation directory. */
	transcriptFiles(): string[];
	/** Start every capacity-eligible queued lane and wait until none is queued or running. */
	settleLanes(): Promise<void>;
	/** Script one further worker reply; the script is consumed in request order. */
	appendWorkerReply(summary: string): void;
	/**
	 * Script one worker turn that BLOCKS inside the provider call, so its lane stays genuinely
	 * `running` until the returned release is called. `entered` resolves once the worker is in it.
	 */
	appendWorkerHold(summary: string): { entered: Promise<void>; release: () => void };
}

type WorkerStep = { kind: "reply"; summary: string } | { kind: "hold"; summary: string; gate: HoldGate };

interface HoldGate {
	announce: () => void;
	entered: Promise<void>;
	blocked: Promise<void>;
	release: () => void;
}

function createHoldGate(): HoldGate {
	let announce!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { announce, entered, blocked, release };
}

function messageText(message: { role?: string; content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("\n");
}

function capture(context: Context, options: SimpleStreamOptions | undefined): CapturedRequest {
	const messages = (context.messages ?? []) as Array<{ role?: string; content?: unknown }>;
	return {
		sessionId: options?.sessionId,
		isWorker: options?.sessionId?.startsWith("lane:worker:") === true,
		text: [context.systemPrompt ?? "", ...messages.map(messageText)].join("\n"),
		roles: messages.map((message) => message.role ?? "unknown"),
	};
}

export function workerClaim(summary: string): AssistantMessage {
	return fauxAssistantMessage(`{"summary":${JSON.stringify(summary)},"status":"completed"}`) as AssistantMessage;
}

/**
 * A harness whose worker turns answer from a scripted queue and whose foreground turns acknowledge.
 * Both are recorded, so a test can prove which context reached the provider.
 */
export async function createReuseHarness(options: HarnessOptions = {}): Promise<ReuseHarness> {
	const harness = await createHarness({
		...options,
		settings: { workerDelegation: { enabled: true }, ...options.settings },
	});
	const requests: CapturedRequest[] = [];
	const workerScript: WorkerStep[] = [];
	let workerIndex = 0;
	harness.setResponses(
		Array.from({ length: 64 }, () => async (context: Context, streamOptions: SimpleStreamOptions | undefined) => {
			const request = capture(context, streamOptions);
			requests.push(request);
			if (!request.isWorker) return fauxAssistantMessage("Foreground acknowledged.") as AssistantMessage;
			const step = workerScript[workerIndex++];
			if (!step) return workerClaim(`worker turn ${workerIndex} complete`);
			if (step.kind === "hold") {
				step.gate.announce();
				await step.gate.blocked;
			}
			return workerClaim(step.summary);
		}),
	);

	const lanes = (): BackgroundLaneController =>
		(harness.session as unknown as { _backgroundLanes: BackgroundLaneController })._backgroundLanes;
	const replay = (): WorkerLifecycle =>
		new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.sessionManager.getSessionId() });

	const transcriptFiles = (): string[] => {
		const found: string[] = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith(".jsonl") && path.includes("worker-conversations")) found.push(path);
			}
		};
		walk(harness.tempDir);
		return found.sort();
	};

	const settleLanes = async (): Promise<void> => {
		for (let attempt = 0; attempt < 2_000; attempt++) {
			lanes().drainQueuedWorkerDelegations();
			if (lanes().getActiveLaneCount() === 0) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
		throw new Error(
			`Timed out settling lanes: ${lanes()
				.getLaneRecords()
				.map((record) => `${record.laneId}:${record.status}`)
				.join(", ")}`,
		);
	};

	return {
		harness,
		requests,
		workerRequests: () => requests.filter((request) => request.isWorker),
		lanes,
		agents: () => replay().getTaskRuntimeSnapshot().agents as Record<string, AgentBindingContract>,
		attempts: () => Object.values(replay().getTaskRuntimeSnapshot().attempts),
		taskObjectiveId: (taskId: string) => replay().getTaskRuntimeSnapshot().tasks[taskId]?.task.objectiveId,
		laneRecords: () => lanes().getLaneRecords(),
		transcriptFiles,
		settleLanes,
		appendWorkerReply: (summary: string) => {
			workerScript.push({ kind: "reply", summary });
		},
		appendWorkerHold: (summary: string) => {
			const gate = createHoldGate();
			workerScript.push({ kind: "hold", summary, gate });
			return { entered: gate.entered, release: gate.release };
		},
	};
}
