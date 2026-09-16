import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["corrupt-metadata", "enrolled", "enrolled-no-header", "enrollment-only", "active-commit"])(
	"failed setup retains project exclusion for %s evidence",
	async (fault) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-project-setup-ownership-"));
		const provider = registerFauxProvider();
		let requests = 0;
		provider.setResponses(
			Array.from({ length: 8 }, () => (_context: Context, options?: SimpleStreamOptions) => {
				if (options?.sessionId?.startsWith("lane:worker:")) requests++;
				return fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "Finished" }));
			}),
		);
		const options = {
			agentDir,
			cwd: agentDir,
			sharedFauxProvider: provider,
			settings: { workerDelegation: { enabled: true } },
		};
		const first = await createHarness(options);
		const second = await createHarness(options);
		const ensure = WorkerConversationStore.prototype.ensure;
		let transcript = "";
		let metadata = "";
		let injected = false;
		let releaseCommit: (() => void) | undefined;
		const spy = vi.spyOn(WorkerConversationStore.prototype, "ensure").mockImplementation(function (
			this: WorkerConversationStore,
			input,
		) {
			const conversation = ensure.call(this, input);
			const context = conversation.getResumeContext();
			transcript = context.sessionFile!;
			metadata = `${transcript}.worker.json`;
			const originalMetadata = readFileSync(metadata);
			if (fault === "corrupt-metadata") writeFileSync(metadata, "{broken");
			else if (fault === "active-commit") {
				const { cursor } = conversation.beginTranscriptCommit();
				releaseCommit = () => conversation.abortTranscriptCommit(cursor);
			} else {
				this.claimProjectContext({
					agentDir,
					resumeContext: context,
					expectedLogicalAgentId: input.logicalAgentId,
					specializationKey: "f".repeat(64),
					owner: { parentSessionId: input.parentSessionId, incarnation: "setup-owner" },
				});
				if (fault === "enrolled-no-header") rmSync(transcript);
				if (fault === "enrollment-only") writeFileSync(metadata, originalMetadata);
			}
			injected = true;
			throw new Error("Injected uncertain setup ownership");
		});
		try {
			const initial = await first.session.runWorkerDelegationOnce({ instructions: "First project task" });
			expect(injected).toBe(true);
			expect(initial.started).toBe(false);
			spy.mockRestore();
			const retainedMetadata = readFileSync(metadata);
			const retainedTranscript = existsSync(transcript) ? readFileSync(transcript) : undefined;
			const next = await second.session.runWorkerDelegationOnce({ instructions: "Next project task" });
			expect(next.started).toBe(false);
			expect(requests).toBe(0);
			expect(readFileSync(metadata)).toEqual(retainedMetadata);
			expect(existsSync(transcript) ? readFileSync(transcript) : undefined).toEqual(retainedTranscript);
		} finally {
			spy.mockRestore();
			releaseCommit?.();
			await second.cleanup();
			await first.cleanup();
			provider.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);
