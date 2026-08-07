import {
	appendFileSync,
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerContextForkStore } from "../src/core/delegation/worker-context-fork-store.ts";
import { WorkerConversationOwnershipError } from "../src/core/delegation/worker-conversation-revision.ts";
import {
	WorkerConversationStore,
	type WorkerTranscriptCommitCursor,
} from "../src/core/delegation/worker-conversation-store.ts";

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

describe("worker conversation ownership protocol", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createOptions(logicalAgentId = "ownership-agent") {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-ownership-"));
		tempDirs.push(root);
		return {
			agentDir: join(root, "agent"),
			parentSessionId: "ownership-parent",
			logicalAgentId,
			cwd: join(root, "project"),
			resourceProfileNames: [],
			contextPointers: [],
		};
	}

	function replaceOnceInPlace(file: string, before: string, after: string): Buffer {
		const original = readFileSync(file);
		const beforeBytes = Buffer.from(before);
		const afterBytes = Buffer.from(after);
		expect(afterBytes).toHaveLength(beforeBytes.length);
		const offset = original.indexOf(beforeBytes);
		expect(offset).toBeGreaterThanOrEqual(0);
		const fd = openSync(file, "r+");
		try {
			expect(writeSync(fd, afterBytes, 0, afterBytes.length, offset)).toBe(afterBytes.length);
		} finally {
			closeSync(fd);
		}
		const changed = Buffer.from(original);
		afterBytes.copy(changed, offset);
		return changed;
	}

	it("rejects a structurally valid but unissued opaque cursor", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		const forged: WorkerTranscriptCommitCursor = Object.freeze({ kind: "worker-transcript-suffix-v1" });
		const before = readFileSync(conversation.getResumeContext().sessionFile!);

		expect(() => conversation.commitTranscript(forged, [userMessage("forged append")])).toThrow(
			WorkerConversationOwnershipError,
		);
		expect(readFileSync(conversation.getResumeContext().sessionFile!)).toEqual(before);
	});

	it("rejects a cursor issued by a different conversation", () => {
		const first = new WorkerConversationStore().create(createOptions("first-agent"));
		const second = new WorkerConversationStore().create(createOptions("second-agent"));
		const foreignCursor = first.captureTranscriptCommitCursor();
		const before = readFileSync(second.getResumeContext().sessionFile!);

		expect(() => second.commitTranscript(foreignCursor, [userMessage("foreign append")])).toThrow(
			/belongs to a different conversation/i,
		);
		expect(readFileSync(second.getResumeContext().sessionFile!)).toEqual(before);
	});

	it("makes an aborted cursor permanently inert", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		const cursor = conversation.captureTranscriptCommitCursor();
		conversation.abortTranscriptCommit(cursor);
		conversation.abortTranscriptCommit(cursor);
		const before = readFileSync(conversation.getResumeContext().sessionFile!);

		expect(() => conversation.commitTranscript(cursor, [userMessage("late append")])).toThrow(/no longer active/i);
		expect(readFileSync(conversation.getResumeContext().sessionFile!)).toEqual(before);
	});

	it("rejects a suffix shorter than messages already persisted after its cursor", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		const cursor = conversation.captureTranscriptCommitCursor();
		const persisted = userMessage("persisted completion");
		conversation.appendMessage(persisted);
		const before = readFileSync(conversation.getResumeContext().sessionFile!);

		expect(() => conversation.commitTranscript(cursor, [])).toThrow(/suffix is shorter/i);
		expect(readFileSync(conversation.getResumeContext().sessionFile!)).toEqual(before);
		expect(conversation.commitTranscript(cursor, [persisted])).toBe(0);
	});

	it("rejects changed suffix content while accepting exact commit and replay controls", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		const cursor = conversation.captureTranscriptCommitCursor();
		const persisted = userMessage("exact completion");
		conversation.appendMessage(persisted);
		const before = readFileSync(conversation.getResumeContext().sessionFile!);

		expect(() => conversation.commitTranscript(cursor, [userMessage("other completion")])).toThrow(
			/diverges from persisted context/i,
		);
		expect(readFileSync(conversation.getResumeContext().sessionFile!)).toEqual(before);
		expect(conversation.commitTranscript(cursor, [persisted])).toBe(0);
		expect(conversation.commitTranscript(cursor, [persisted])).toBe(0);
		expect(() => conversation.commitTranscript(cursor, [userMessage("changed replay")])).toThrow(
			/replay conflicts with its committed suffix/i,
		);
		expect(readFileSync(conversation.getResumeContext().sessionFile!)).toEqual(before);
	});

	it("rejects an ordinary stale writer but lets the idle recovery path adopt an exact append-only suffix", () => {
		const options = createOptions();
		const firstOwner = new WorkerConversationStore().create(options);
		const resumeContext = firstOwner.getResumeContext();
		const secondOwner = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		firstOwner.appendMessage(userMessage("first owner append"));
		const afterFirstOwner = readFileSync(resumeContext.sessionFile!);

		expect(() => secondOwner.appendMessage(userMessage("stale append"))).toThrow(/advanced under a different owner/i);
		expect(readFileSync(resumeContext.sessionFile!)).toEqual(afterFirstOwner);

		const missingControl = {
			messageId: "worker-message-idle-adoption",
			content: "[Worker control worker-message-idle-adoption]\nNot delivered.",
		};
		expect(secondOwner.findDeliveredWorkerControlMessageIds([missingControl])).toEqual(new Set());
		secondOwner.appendMessage(userMessage("adopted owner append"));

		expect(
			new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext }).getRawTranscript(),
		).toEqual([userMessage("first owner append"), userMessage("adopted owner append")]);
	});

	it("does not adopt an external append while a transcript cursor is active", () => {
		const options = createOptions();
		const firstOwner = new WorkerConversationStore().create(options);
		const resumeContext = firstOwner.getResumeContext();
		const secondOwner = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		const cursor = secondOwner.captureTranscriptCommitCursor();
		firstOwner.appendMessage(userMessage("external append"));
		const beforeRecovery = readFileSync(resumeContext.sessionFile!);

		expect(() =>
			secondOwner.findDeliveredWorkerControlMessageIds([
				{
					messageId: "worker-message-active-cursor",
					content: "[Worker control worker-message-active-cursor]\nMust not adopt.",
				},
			]),
		).toThrow(/advanced while a transcript commit was active/i);
		expect(readFileSync(resumeContext.sessionFile!)).toEqual(beforeRecovery);
		secondOwner.abortTranscriptCommit(cursor);
	});

	it("accepts an exact-content session timestamp touch before the next owned append", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		conversation.appendMessage(userMessage("stable prefix"));
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const content = readFileSync(sessionFile);
		const before = statSync(sessionFile);
		utimesSync(sessionFile, before.atime, new Date(before.mtimeMs + 5_000));
		expect(readFileSync(sessionFile)).toEqual(content);
		expect(statSync(sessionFile).mtimeMs).not.toBe(before.mtimeMs);

		expect(() => conversation.appendMessage(userMessage("accepted suffix"))).not.toThrow();
		expect(conversation.getRawTranscript()).toEqual([userMessage("stable prefix"), userMessage("accepted suffix")]);
	});

	it("rejects a same-count mutation between the raw scan and canonical session open", () => {
		const options = createOptions();
		const created = new WorkerConversationStore().create(options);
		created.appendMessage(userMessage("trusted"));
		const resumeContext = created.getResumeContext();
		const sessionFile = resumeContext.sessionFile!;
		const originalOpen = SessionManager.open;
		let injected = false;
		const openSession = vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
			if (!injected) {
				injected = true;
				const before = statSync(sessionFile);
				replaceOnceInPlace(sessionFile, '"content":"trusted"', '"content":"mutated"');
				utimesSync(sessionFile, before.atime, before.mtime);
			}
			return originalOpen(...args);
		});

		try {
			expect(() => new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext })).toThrow(
				/changed while its canonical session was opened/i,
			);
		} finally {
			openSession.mockRestore();
		}
		expect(injected).toBe(true);
		expect(
			new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext }).getRawTranscript(),
		).toEqual([userMessage("mutated")]);
	});

	it("refuses to evict a cached core while one transcript cursor is active", () => {
		const store = new WorkerConversationStore();
		const idleOptions = createOptions("idle-cache-agent");
		const idleConversation = store.create(idleOptions);
		const conversation = store.create(createOptions("active-cache-agent"));
		const cursor = conversation.captureTranscriptCommitCursor();
		const openSession = vi.spyOn(SessionManager, "open");

		try {
			expect(() => store.clearCache()).toThrow(/active transcript commit/i);
			store.open({ agentDir: idleOptions.agentDir, resumeContext: idleConversation.getResumeContext() });
			expect(openSession).not.toHaveBeenCalled();
		} finally {
			conversation.abortTranscriptCommit(cursor);
			openSession.mockRestore();
		}
		expect(() => store.clearCache()).not.toThrow();
	});

	it("rejects a non-linear append-only suffix instead of adopting it during recovery", () => {
		const options = createOptions();
		const owner = new WorkerConversationStore().create(options);
		owner.appendMessage(userMessage("trusted prefix"));
		const resumeContext = owner.getResumeContext();
		const recoveryOwner = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		const sessionFile = resumeContext.sessionFile!;
		const entries = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const firstEntry = JSON.parse(entries[1]!) as Record<string, unknown>;
		appendFileSync(
			sessionFile,
			`${JSON.stringify({
				...firstEntry,
				id: "externally-appended-invalid-entry",
				parentId: null,
				message: userMessage("invalid external suffix"),
			})}\n`,
		);
		const damaged = readFileSync(sessionFile);

		expect(() =>
			recoveryOwner.findDeliveredWorkerControlMessageIds([
				{
					messageId: "worker-message-linear-recovery",
					content: "[Worker control worker-message-linear-recovery]\nNo delivery.",
				},
			]),
		).toThrow(/not one linear chain/i);
		expect(readFileSync(sessionFile)).toEqual(damaged);
	});

	it("rejects duplicate durable entry ids during a cold open", () => {
		const options = createOptions();
		const owner = new WorkerConversationStore().create(options);
		owner.appendMessage(userMessage("first entry"));
		owner.appendMessage(userMessage("second entry"));
		const resumeContext = owner.getResumeContext();
		const sessionFile = resumeContext.sessionFile!;
		const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const firstEntry = JSON.parse(lines[1]!) as Record<string, unknown>;
		const secondEntry = JSON.parse(lines[2]!) as Record<string, unknown>;
		secondEntry.id = firstEntry.id;
		lines[2] = JSON.stringify(secondEntry);
		writeFileSync(sessionFile, `${lines.join("\n")}\n`);
		const damaged = readFileSync(sessionFile);

		expect(() => new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext })).toThrow(
			/duplicate entry id|parent cycle|not one linear chain/i,
		);
		expect(readFileSync(sessionFile)).toEqual(damaged);
	});

	it("rejects exact-content inode replacement without appending", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		conversation.appendMessage(userMessage("stable prefix"));
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const original = readFileSync(sessionFile);
		const originalInode = statSync(sessionFile, { bigint: true }).ino;
		const replacement = join(dirname(sessionFile), ".replacement-session.jsonl");
		writeFileSync(replacement, original);
		renameSync(replacement, sessionFile);
		expect(statSync(sessionFile, { bigint: true }).ino).not.toBe(originalInode);

		expect(() => conversation.appendMessage(userMessage("must not append"))).toThrow(/file identity changed/i);
		expect(readFileSync(sessionFile)).toEqual(original);
	});

	it("rejects a same-size early-prefix rewrite without appending", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		conversation.appendMessage(userMessage("first"));
		conversation.appendMessage(userMessage("later"));
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const beforeStats = statSync(sessionFile);
		const damaged = replaceOnceInPlace(sessionFile, '"content":"first"', '"content":"other"');
		utimesSync(sessionFile, beforeStats.atime, beforeStats.mtime);
		expect(statSync(sessionFile).size).toBe(beforeStats.size);

		expect(() => conversation.appendMessage(userMessage("must not append"))).toThrow(/durable prefix changed/i);
		expect(readFileSync(sessionFile)).toEqual(damaged);
	});

	it("rejects a truncate-regrow tail rewrite without repairing or appending", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		conversation.appendMessage(userMessage("stable prefix"));
		conversation.appendMessage(userMessage("tail-a"));
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const original = readFileSync(sessionFile);
		const beforeStats = statSync(sessionFile);
		const beforeBytes = Buffer.from('"content":"tail-a"');
		const afterBytes = Buffer.from('"content":"tail-b"');
		const offset = original.indexOf(beforeBytes);
		expect(offset).toBeGreaterThanOrEqual(0);
		const damaged = Buffer.from(original);
		afterBytes.copy(damaged, offset);
		truncateSync(sessionFile, offset);
		appendFileSync(sessionFile, damaged.subarray(offset));
		utimesSync(sessionFile, beforeStats.atime, beforeStats.mtime);
		expect(statSync(sessionFile).size).toBe(beforeStats.size);

		expect(() => conversation.appendMessage(userMessage("must not append"))).toThrow(
			/durable prefix|durable content/i,
		);
		expect(readFileSync(sessionFile)).toEqual(damaged);
	});

	it("rejects an active cached owner after external metadata mutation", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		const resumeContext = conversation.getResumeContext();
		const cursor = conversation.captureTranscriptCommitCursor();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
		writeFileSync(metadataFile, `${JSON.stringify({ ...metadata, externalOwnerMutation: true })}\n`);
		const sessionBefore = readFileSync(resumeContext.sessionFile!);

		expect(() => store.open({ agentDir: options.agentDir, resumeContext })).toThrow(
			/metadata changed while a transcript commit was active/i,
		);
		expect(() => conversation.commitTranscript(cursor, [userMessage("must not append")])).toThrow(
			/metadata changed under a different owner/i,
		);
		expect(readFileSync(resumeContext.sessionFile!)).toEqual(sessionBefore);
	});

	it("rejects a metadata replacement between a cold parse and core publication", () => {
		const options = createOptions();
		const reference = new WorkerContextForkStore({
			agentDir: options.agentDir,
			parentSessionId: options.parentSessionId,
		}).capture({ logicalAgentId: options.logicalAgentId, messages: [userMessage("immutable birth context")] });
		const created = new WorkerConversationStore().ensure({
			...options,
			birthContextForkReference: reference,
		});
		const resumeContext = created.getResumeContext();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const sessionBefore = readFileSync(resumeContext.sessionFile!);
		const originalOpen = WorkerContextForkStore.prototype.open;
		let injected = false;
		const openBirthContext = vi.spyOn(WorkerContextForkStore.prototype, "open").mockImplementation(function (
			this: WorkerContextForkStore,
			openOptions,
		) {
			const snapshot = originalOpen.call(this, openOptions);
			if (!injected) {
				injected = true;
				const before = statSync(metadataFile);
				replaceOnceInPlace(
					metadataFile,
					'"parentSessionId":"ownership-parent"',
					'"parentSessionId":"ownership-tamper"',
				);
				utimesSync(metadataFile, before.atime, before.mtime);
			}
			return snapshot;
		});

		try {
			expect(() => new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext })).toThrow(
				/metadata changed while its canonical state was opened/i,
			);
		} finally {
			openBirthContext.mockRestore();
		}
		expect(injected).toBe(true);
		expect(readFileSync(resumeContext.sessionFile!)).toEqual(sessionBefore);
	});

	it("rejects a metadata replacement while a cached first birth context is bound", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const reference = new WorkerContextForkStore({
			agentDir: options.agentDir,
			parentSessionId: options.parentSessionId,
		}).capture({ logicalAgentId: options.logicalAgentId, messages: [userMessage("cached birth context")] });
		const resumeContext = created.getResumeContext();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const originalAppendMessage = SessionManager.prototype.appendMessage;
		let injected = false;
		const appendMessage = vi.spyOn(SessionManager.prototype, "appendMessage").mockImplementation(function (
			this: SessionManager,
			message,
		) {
			if (!injected && message.role === "user" && message.content === "cached birth context") {
				injected = true;
				const before = statSync(metadataFile);
				replaceOnceInPlace(
					metadataFile,
					'"parentSessionId":"ownership-parent"',
					'"parentSessionId":"ownership-tamper"',
				);
				utimesSync(metadataFile, before.atime, before.mtime);
			}
			return originalAppendMessage.call(this, message);
		});

		try {
			expect(() => store.ensure({ ...options, birthContextForkReference: reference })).toThrow(
				/metadata changed while its birth context was bound/i,
			);
		} finally {
			appendMessage.mockRestore();
		}
		expect(injected).toBe(true);
		expect(readFileSync(metadataFile, "utf8")).toContain('"parentSessionId":"ownership-tamper"');
	});
});
