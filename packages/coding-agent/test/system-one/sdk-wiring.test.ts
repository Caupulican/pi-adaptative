import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

describe("System One SDK Session Auto-Wiring and Resume Hook (R-062, R-071)", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-system-one-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("accepts an explicit systemOneController in CreateAgentSessionOptions", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const store = new ExecutionStore({
			run_id: "sdk-explicit-test",
			objective: {
				request: "Fix bug",
				normalized_goal: "Fix bug",
				acceptance_criteria: [],
				constraints: [],
			},
			repo: { root: cwd, baseline_revision: "rev-1", current_revision: "rev-1" },
		});
		const customController = new SystemOneController({
			store,
			adapter: { evaluate: vi.fn() as any },
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
			systemOneController: customController,
		});

		expect(session.systemOneController).toBe(customController);
		expect(session.systemOneController?.store).toBe(store);

		// Verify revalidation method is callable on store
		const revalResult = session.systemOneController?.store.revalidateOnResume("rev-2");
		expect(revalResult?.revisionChanged).toBe(true);

		await session.disposeAndWait();
	});

	it("auto-wires SystemOneController when TypeSafe credentials exist in authStorage", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("typesafe", "ts-test-key-12345");

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			authStorage,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.systemOneController).toBeDefined();
		expect(session.systemOneController?.store).toBeDefined();
		expect(session.systemOneController?.adapter).toBeDefined();

		await session.disposeAndWait();
	});

	it("respects disableSystemOne flag even when TypeSafe credentials exist", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("typesafe", "ts-test-key-12345");

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			authStorage,
			disableSystemOne: true,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.systemOneController).toBeUndefined();

		await session.disposeAndWait();
	});
});
