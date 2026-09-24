import { SessionManager } from "@caupulican/pi-agent-core/session";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionTaskProfileStore } from "../src/core/orchestration/session-task-profile-store.ts";
import { TaskProfileWriter } from "../src/core/orchestration/task-profile-writer.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";

/**
 * A task profile that asks for a tool whose output is packed (grep, find) is written with
 * artifact_retrieve beside it, as the root's surface carries it, so the profile's large outputs are
 * packed and stay retrievable. It is added only when the base already holds it: never new authority.
 */
function writer(baseTools: readonly string[]) {
	const store = new SessionTaskProfileStore(SessionManager.inMemory());
	const base = createTestWorkerOrchestrationProfile({
		profileId: "inherited-foreground",
		model: { provider: "faux", id: "worker" },
		toolNames: baseTools,
	});
	return {
		store,
		writer: new TaskProfileWriter({
			agentDir: "/unused",
			cwd: "/repo",
			store,
			getSettingsManager: () => SettingsManager.inMemory(),
			getModelRegistry: () => ({ find: () => undefined }) as unknown as ModelRegistry,
			isModelExhausted: () => false,
			getActiveOrchestrationProfile: () => undefined,
			getInheritedBaseProfile: () => base,
		}),
	};
}

describe("task profile packing companion", () => {
	it("writes artifact_retrieve beside a packed-output tool when the base holds it, and says so", () => {
		const { writer: profiles, store } = writer(["read", "grep", "artifact_retrieve"]);
		const result = profiles.createTaskProfile({ task: "Search the code", toolNames: ["grep", "read"] });
		expect(result).toMatchObject({ created: true, addedTools: ["artifact_retrieve"] });
		const stored = store.load().registry.get(result.profileId!);
		expect(stored?.profile.toolNames).toEqual(["grep", "read", "artifact_retrieve"]);
	});

	it("never adds a companion the base lacks, or one a profile without packed-output tools needs", () => {
		const lacking = writer(["read", "grep"]).writer.createTaskProfile({ task: "Search", toolNames: ["grep"] });
		expect(lacking).toMatchObject({ created: true });
		expect(lacking.addedTools).toBeUndefined();
		const unpacked = writer(["read", "grep", "artifact_retrieve"]).writer.createTaskProfile({
			task: "Read",
			toolNames: ["read"],
		});
		expect(unpacked.addedTools).toBeUndefined();
	});
});
