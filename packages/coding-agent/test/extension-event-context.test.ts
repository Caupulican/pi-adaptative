import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtension, createExtensionRuntime } from "../src/core/extensions/factory-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("creates one context for an emission only after finding a handler", async () => {
	const extension = createExtension("<inline>", "<inline>");
	const cwd = process.cwd();
	const runner = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		cwd,
		SessionManager.inMemory(ownerSessionStorageRoots(cwd)),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
	const createContext = vi.spyOn(runner, "createContext");
	const event = { type: "agent_start" as const };
	await runner.emit(event);
	await runner.emitToExtension(extension, event);
	expect(createContext).not.toHaveBeenCalled();

	const contexts: unknown[] = [];
	const capture = async (_event: unknown, context: unknown) => {
		contexts.push(context);
	};
	extension.handlers.set(event.type, [capture, capture]);
	await runner.emit(event);
	expect(createContext).toHaveBeenCalledTimes(1);
	expect(contexts).toHaveLength(2);
	expect(contexts[1]).toBe(contexts[0]);
});
