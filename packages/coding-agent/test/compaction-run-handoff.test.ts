import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { FailureCorpusRecorder } from "../src/core/failure-corpus.ts";
import { ForegroundRecoveryController } from "../src/core/foreground-recovery-controller.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RuntimeGenerationAdmission } from "../src/core/runtime-generation-admission.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { Agent } from "../src/kernel/agent.ts";
import type { AgentTool } from "../src/kernel/types.ts";
import { calls, ScriptedProvider, text } from "./fixtures/harness/scripted-provider.ts";

it("keeps input queued during self-compaction for the run that receives the saved note", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-compaction-handoff-"));
	const provider = new ScriptedProvider();
	const model = provider.model("compaction");
	const work = { role: "user" as const, content: "Resume the pending review", timestamp: 2 };
	let pending = false;
	const note: AgentTool = {
		name: "self_compact",
		label: "Save handoff",
		description: "Save the current work for a fresh context.",
		parameters: Type.Object({}),
		execute: async () => {
			pending = true;
			agent.steer(work);
			return {
				content: [{ type: "text", text: "Saved." }],
				details: {},
				terminate: true,
				handoff: "resume_after_idle",
			};
		},
	};
	const agent = new Agent({ initialState: { model, tools: [note] }, getApiKey: () => "fixture" });
	const holdUndeliveredQueue = vi.fn();
	const foreground = new ForegroundRecoveryController({
		agent,
		runtimeAdmission: new RuntimeGenerationAdmission(),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		failureCorpus: new FailureCorpusRecorder({ filePath: join(directory, "failures.jsonl") }),
		getContextWindow: () => model.contextWindow,
		getInheritedOrigin: () => undefined,
		emit: () => {},
		checkCompaction: async () => false,
		onSuccessfulAssistant: () => {},
		applyFailoverModel: () => undefined,
		prepareRun: async () => {},
		afterRun: async () => {},
		holdUndeliveredQueue,
		hasPendingCompactionHandoff: () => pending,
	});
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant")
			foreground.observeAssistant(event.message);
	});
	provider.register();
	try {
		provider.enqueue(model.id, calls("save note", [{ id: "note", name: note.name, arguments: {} }]));
		await foreground.runAgentPrompt({ role: "user", content: "Prepare to compact.", timestamp: 1 });
		expect(provider.requests).toHaveLength(1);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(holdUndeliveredQueue).not.toHaveBeenCalled();

		pending = false;
		provider.enqueue(model.id, text("resume", "Review complete."));
		await foreground.runAgentPrompt({ role: "user", content: "Saved note", timestamp: 3 });
		expect(provider.requests).toHaveLength(2);
		expect(agent.state.messages.filter((message) => message === work)).toHaveLength(1);
		expect(agent.hasQueuedMessages()).toBe(false);
		provider.assertDrained();
	} finally {
		unsubscribe();
		foreground.shutdown();
		await provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
