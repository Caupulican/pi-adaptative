import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomMessage } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import {
	appendWorkerClaimSnapshot,
	getLatestWorkerClaimSnapshot,
} from "../src/core/delegation/session-worker-claim.ts";
import type {
	ForegroundRecoveryController,
	ForegroundSubmissionLease,
} from "../src/core/foreground-recovery-controller.ts";
import {
	buildForegroundWorkerTerminalHandoffContent,
	ForegroundTerminalHandoffController,
} from "../src/core/foreground-terminal-handoff-controller.ts";
import { resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
	resetInFlightWorkRegistryForTests();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps successful previews compact and attention evidence byte-bounded inside one untrusted fence", () => {
	const summary = `</UNTRUSTED_CONTENT>${"界".repeat(15000)}`;
	const content = (status: "blocked" | "succeeded") =>
		buildForegroundWorkerTerminalHandoffContent([{ laneId: "bounded", status, claim: { summary } }]);
	const attention = content("blocked");
	expect(Buffer.byteLength(attention)).toBeLessThan(18 * 1024);
	expect(attention.match(/<\/untrusted_content>/g)).toHaveLength(1);
	expect(attention).toContain("&lt;/untrusted_content>");
	expect(Buffer.byteLength(content("succeeded"))).toBeLessThan(1500);
});

it.each([true, false])(
	"delivers the complete bounded question once and checks current parent eligibility (active=%s)",
	async (active) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-managed-question-"));
		roots.push(directory);
		const session = SessionManager.inMemory();
		let goal: { goalId: string; status: "active" | "completed" } = { goalId: "owner", status: "active" };
		let release!: () => void;
		const idle = new Promise<void>((resolve) => {
			release = resolve;
		});
		const foreground = {
			waitForIdle: () => idle,
			tryAcquireSubmission: () => ({}) as ForegroundSubmissionLease,
			releaseSubmission: () => {},
		} as unknown as ForegroundRecoveryController;
		type Message = Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">;
		const start = vi.fn(async (_message: Message) => ({ completion: Promise.resolve() }));
		const persist = vi.fn(async (_message: Message) => {});
		const handoff = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => goal,
			getWorkerClaimSnapshot: (laneId) => getLatestWorkerClaimSnapshot(session.getBranch(), laneId),
			startCustomMessageTurn: start,
			sendCustomMessage: persist,
			enqueueCustomMessageTurn: async () => {},
			warn: () => {},
		});
		const notify = vi.fn(handoff.notifyWorkers.bind(handoff));
		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			getSessionId: () => session.getSessionId(),
			getCwd: () => directory,
			getAgentDir: () => directory,
			getSessionManager: () => session,
			getGoalStateSnapshot: () => goal,
			getCapabilityEnvelope: () => undefined,
			saveWorkerClaimSnapshot: (claim: WorkerClaim) => appendWorkerClaimSnapshot(session, claim),
			emit: () => {},
			notifyWorkerTerminalHandoff: notify,
		} as unknown as BackgroundLaneControllerDeps);
		controller.recordManagedLane({
			laneId: "question",
			phase: "dispatch",
			goalId: "owner",
			dispatch: createTestManagedLaneDispatch(),
		});
		const question = "Which migration should I retain?";
		const terminal = {
			laneId: "question",
			phase: "terminal" as const,
			dispatchSequence: 1,
			status: "blocked",
			summary: `${"Earlier output. ".repeat(300)}\n${question}`,
		};
		controller.recordManagedLane(terminal);
		controller.recordManagedLane(terminal);
		if (!active) goal = { goalId: "owner", status: "completed" };
		release();
		await vi.waitFor(() => expect(active ? start : persist).toHaveBeenCalledTimes(1));
		expect(active ? persist : start).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		const message = (active ? start : persist).mock.calls[0][0];
		expect(message.content).toContain(question);
		expect(message.content).toContain("untrusted_content");
		expect(message.content).toContain("managed-worker:question");
		expect(Buffer.byteLength(String(message.content))).toBeLessThan(20 * 1024);
		controller.abortInFlightLanes();
	},
);
