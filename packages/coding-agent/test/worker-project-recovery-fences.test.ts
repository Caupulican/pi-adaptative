import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createLocalWorkerProcessOwnerId, isLocalProcessAlive } from "../src/core/delegation/worker-process-owner.ts";
import { WorkerProjectDirectory } from "../src/core/delegation/worker-project-directory.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-recovery-fences-"));
	roots.push(agentDir);
	const processResult = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
	expect(processResult.status).toBe(0);
	const pid = Number(processResult.stdout.trim());
	expect(isLocalProcessAlive(pid)).toBe(false);
	const owner = { parentSessionId: "birth", incarnation: createLocalWorkerProcessOwnerId(pid, randomUUID()) };
	const conversations = new WorkerConversationStore();
	const directory = new WorkerProjectDirectory(agentDir, conversations);
	const request = { specializationKey: "a".repeat(64), owner, independent: false, isCompatible: () => true };
	const allocation = directory.admit(request);
	if (allocation.kind !== "allocated") throw new Error("Expected new setup allocation");
	const conversation = conversations.create({
		agentDir,
		parentSessionId: "birth",
		logicalAgentId: "worker-1",
		cwd: agentDir,
		resourceProfileNames: [],
		contextPointers: [],
	});
	const resumeContext = conversation.getResumeContext();
	const reference = { parentSessionId: "birth", logicalAgentId: "worker-1", resumeContext };
	directory.bindAllocation(allocation.allocation, reference);
	const open = {
		agentDir,
		resumeContext,
		expectedLogicalAgentId: "worker-1",
		specializationKey: request.specializationKey,
	};
	const owned = conversations.claimProjectContext({ ...open, owner });
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "birth" });
	const runtime = lifecycle.ledger.runtime;
	runtime.createObjective({ objectiveId: "objective", title: "Setup", description: "Interrupted setup" });
	const { attempt } = runtime.prepareTaskAttempt(
		{
			taskId: "worker-1",
			objectiveId: "objective",
			title: "Setup",
			description: "Interrupted setup",
			role: "implementer",
		},
		{ taskId: "worker-1", profileId: "test-worker", instructions: "Interrupted task", resourcePointerIds: [] },
	);
	const lease = () => {
		runtime.bindAttemptGrant(
			attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: "objective",
				taskId: "worker-1",
				attemptId: attempt.attemptId,
				role: "implementer",
			}),
		);
		runtime.leaseAttempt(attempt.attemptId, owner.incarnation, 60000);
	};
	const admit = (parentSessionId: string) =>
		directory.admit({
			...request,
			owner: { parentSessionId, incarnation: createLocalWorkerProcessOwnerId(process.pid, randomUUID()) },
		});
	return { agentDir, conversations, directory, open, owned, lifecycle, runtime, attempt, lease, admit };
}

it("recovered context remains reusable through subsequent parent generations", () => {
	const f = fixture();
	const second = f.admit("second");
	if (second.kind !== "claimed") throw new Error(`Recovery did not claim: ${second.kind}`);
	expect(second.conversation.getResumeContext()).toEqual(f.open.resumeContext);
	f.conversations.releaseProjectContext(second.conversation);
	const third = f.admit("third");
	expect(third.kind).toBe("claimed");
	if (third.kind === "claimed") {
		expect(third.conversation.getResumeContext()).toEqual(f.open.resumeContext);
		expect(third.conversation.getProjectClaim()?.generation).toBe(3);
	}
});

it.each(["leased", "registered", "mailbox", "active-commit", "foreign-claim"])(
	"dead setup owner does not authorize recovery across %s obligations",
	(obligation) => {
		const f = fixture();
		let release: (() => void) | undefined;
		if (obligation === "leased") f.lease();
		if (obligation === "registered")
			f.lifecycle.ensureAgent({
				agentId: "worker-1",
				role: "implementer",
				resumeContext: f.open.resumeContext,
			});
		if (obligation === "mailbox")
			new WorkerAgentMailbox({
				agentDir: f.agentDir,
				parentSessionId: "birth",
				agentId: "worker-1",
				projectClaim: f.owned.getProjectClaim(),
			}).enqueue({ kind: "follow_up", content: "Pending task" });
		if (obligation === "active-commit") {
			const { cursor } = f.owned.beginTranscriptCommit();
			release = () => f.owned.abortTranscriptCommit(cursor);
		}
		if (obligation === "foreign-claim") {
			f.conversations.releaseProjectContext(f.owned);
			f.conversations.claimProjectContext({
				...f.open,
				owner: { parentSessionId: "foreign", incarnation: "foreign" },
			});
		}
		const before = f.runtime.getSnapshot();
		const transcript = readFileSync(f.open.resumeContext.sessionFile!);
		const metadata = readFileSync(`${f.open.resumeContext.sessionFile}.worker.json`);
		try {
			expect(f.admit("second").kind).toBe("unavailable");
			expect(f.runtime.getSnapshot()).toEqual(before);
			expect(readFileSync(f.open.resumeContext.sessionFile!)).toEqual(transcript);
			expect(readFileSync(`${f.open.resumeContext.sessionFile}.worker.json`)).toEqual(metadata);
		} finally {
			release?.();
		}
	},
);

it("a lease acquired during recovery prevents cancellation and transcript release", () => {
	const f = fixture();
	const cancel = DurableTaskRuntime.prototype.cancelAttempt;
	let injected = false;
	vi.spyOn(DurableTaskRuntime.prototype, "cancelAttempt").mockImplementation(function (
		this: DurableTaskRuntime,
		...args
	) {
		injected = true;
		f.lease();
		return cancel.apply(this, args);
	});
	const metadata = readFileSync(`${f.open.resumeContext.sessionFile}.worker.json`);
	expect(f.admit("second").kind).toBe("unavailable");
	expect(injected).toBe(true);
	expect(f.runtime.getSnapshot().attempts[f.attempt.attemptId].status).toBe("leased");
	expect(readFileSync(`${f.open.resumeContext.sessionFile}.worker.json`)).toEqual(metadata);
});
