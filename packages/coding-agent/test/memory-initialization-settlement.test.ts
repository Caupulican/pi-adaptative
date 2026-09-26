// @isolated: replaces one provider instance's private initializer with controlled promises
// @guards src/core/memory/memory-manager.ts src/core/memory/providers/file-store.ts

import { describe, expect, it } from "vitest";
import { MemoryManager } from "../src/core/memory/memory-manager.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider, type ManagedMemoryTarget } from "../src/core/memory/providers/file-store.ts";
import { tempDir } from "./temp-dir.ts";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

type FileStoreInternals = {
	initializeManagedFile(target: ManagedMemoryTarget, filePath: string, statePath: string): Promise<string>;
};

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function context(): MemoryLifecycleContext {
	const root = tempDir("memory-initialization-settlement-");
	return { agentDir: root, cwd: root, isChildSession: false };
}

function downstreamProvider(onInitialize: () => void): MemoryProvider {
	return {
		name: "downstream",
		egress: "local",
		isAvailable: () => true,
		getCapabilities: () => ({ surfaces: ["context"] }),
		initialize: async () => onInitialize(),
		shutdown: async () => {},
	};
}

describe("memory initialization settlement", () => {
	it("settles every admitted file initialization before advancing to a later provider", async () => {
		const manager = new MemoryManager();
		const fileStore = new FileStoreProvider();
		const internals = fileStore as unknown as FileStoreInternals;
		const allStarted = deferred();
		const failMemory = deferred();
		const releaseUser = deferred();
		const releaseProject = deferred();
		let started = 0;
		let downstreamStarted = false;

		internals.initializeManagedFile = async (target) => {
			started += 1;
			if (started === 3) allStarted.resolve();
			if (target === "memory") {
				await failMemory.promise;
				throw new Error("general memory initialization failed");
			}
			await (target === "user" ? releaseUser.promise : releaseProject.promise);
			return target;
		};
		manager.registerProvider(fileStore);
		manager.registerProvider(
			downstreamProvider(() => {
				downstreamStarted = true;
			}),
		);

		let settled = false;
		const terminal = manager.initializeAll("session", context()).finally(() => {
			settled = true;
		});
		await allStarted.promise;
		failMemory.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));

		try {
			expect(settled).toBe(false);
			expect(downstreamStarted).toBe(false);
		} finally {
			releaseUser.resolve();
			releaseProject.resolve();
			await terminal;
		}
		expect(downstreamStarted).toBe(true);
		expect(manager.isProviderActive("file-store")).toBe(false);
		expect(manager.isProviderActive("downstream")).toBe(true);
	});

	it("publishes all three managed snapshots after successful initialization", async () => {
		const manager = new MemoryManager();
		const fileStore = new FileStoreProvider();
		const internals = fileStore as unknown as FileStoreInternals;
		internals.initializeManagedFile = async (target) => `${target}-snapshot`;
		manager.registerProvider(fileStore);

		await manager.initializeAll("session", context());

		expect(manager.isProviderActive("file-store")).toBe(true);
		const block = manager.buildSystemPromptBlockFresh();
		expect(block).toContain("memory-snapshot");
		expect(block).toContain("project-snapshot");
		expect(block).toContain("user-snapshot");
	});

	it("waits for every initializer before aggregating multiple failures", async () => {
		const fileStore = new FileStoreProvider();
		const internals = fileStore as unknown as FileStoreInternals;
		const allStarted = deferred();
		const failMemory = deferred();
		const failUser = deferred();
		const releaseProject = deferred();
		const memoryFailure = new Error("general memory initialization failed");
		const userFailure = new Error("user memory initialization failed");
		let started = 0;

		internals.initializeManagedFile = async (target) => {
			started += 1;
			if (started === 3) allStarted.resolve();
			if (target === "memory") {
				await failMemory.promise;
				throw memoryFailure;
			}
			if (target === "user") {
				await failUser.promise;
				throw userFailure;
			}
			await releaseProject.promise;
			return target;
		};

		let settled = false;
		let rejection: unknown;
		const terminal = fileStore
			.initialize("session", context())
			.catch((error: unknown) => {
				rejection = error;
			})
			.finally(() => {
				settled = true;
			});
		await allStarted.promise;
		failUser.resolve();
		failMemory.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(settled).toBe(false);
		releaseProject.resolve();
		await terminal;
		expect(rejection).toBeInstanceOf(AggregateError);
		expect((rejection as AggregateError).errors).toEqual([memoryFailure, userFailure]);
	});
});
