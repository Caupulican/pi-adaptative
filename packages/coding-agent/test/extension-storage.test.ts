import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	disposeExtensionEventSubscriptions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";
import type { ExtensionStorage } from "../src/core/extensions/types.ts";
import { hasActiveWorkRunLease } from "../src/utils/work-directory.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-extension-storage-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension storage", () => {
	it("returns canonical namespaced paths without writing to the agent directory", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		let storage: ExtensionStorage | undefined;

		await loadExtensionFromFactory(
			(pi) => {
				storage = pi.getStorage("sample-extension");
				expect(pi.getStorage("sample-extension")).toBe(storage);
			},
			root,
			createEventBus(),
			createExtensionRuntime(),
			"sample-extension",
			{ agentDir },
		);

		expect(storage?.stateDir).toBe(join(agentDir, "state", "extensions", "sample-extension"));
		expect(storage?.cacheDir).toBe(join(agentDir, "cache", "extensions", "sample-extension"));
		expect(existsSync(agentDir)).toBe(false);
		expect(existsSync(join(root, ".pi"))).toBe(false);
	});

	it("allows one portable namespace per extension generation", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.getStorage("first");
					pi.getStorage("second");
				},
				root,
				createEventBus(),
				createExtensionRuntime(),
				"multi-storage-extension",
				{ agentDir },
			),
		).rejects.toThrow("already owns storage namespace first");
		expect(existsSync(agentDir)).toBe(false);

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.getStorage("../escape");
				},
				root,
				createEventBus(),
				createExtensionRuntime(),
				"invalid-storage-extension",
				{ agentDir },
			),
		).rejects.toThrow("portable path segment");
		expect(existsSync(agentDir)).toBe(false);
	});

	it("rejects namespace collisions between unrelated extensions and releases ownership on unload", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const runtime = createExtensionRuntime();
		const first = await loadExtensionFromFactory(
			(pi) => {
				pi.getStorage("shared-name");
			},
			root,
			createEventBus(),
			runtime,
			"first-extension",
			{ agentDir },
		);

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.getStorage("shared-name");
				},
				root,
				createEventBus(),
				runtime,
				"second-extension",
				{ agentDir },
			),
		).rejects.toThrow("already owned by first-extension");

		await disposeExtensionEventSubscriptions([first]);
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.getStorage("shared-name");
				},
				root,
				createEventBus(),
				runtime,
				"second-extension",
				{ agentDir },
			),
		).resolves.toBeDefined();
	});

	it("transfers ownership across same-path reload and restores it after a failed replacement", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const runtime = createExtensionRuntime();
		const load = (fail = false) =>
			loadExtensionFromFactory(
				(pi) => {
					pi.getStorage("reloadable");
					if (fail) throw new Error("reload failed");
				},
				root,
				createEventBus(),
				runtime,
				"reloadable-extension",
				{ agentDir },
			);

		const first = await load();
		await expect(load(true)).rejects.toThrow("reload failed");
		expect(runtime.extensionStorageOwners.get("reloadable")).toBe(first);

		const replacement = await load();
		expect(runtime.extensionStorageOwners.get("reloadable")).toBe(replacement);
		await disposeExtensionEventSubscriptions([first]);
		expect(runtime.extensionStorageOwners.get("reloadable")).toBe(replacement);
		await disposeExtensionEventSubscriptions([replacement]);
		expect(runtime.extensionStorageOwners.has("reloadable")).toBe(false);
	});

	it("leases bounded work and releases it automatically on unload", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		let storage: ExtensionStorage | undefined;
		let workPath = "";
		const extension = await loadExtensionFromFactory(
			(pi) => {
				storage = pi.getStorage("worker-extension");
				workPath = storage.acquireWorkRun({ runId: "job-1" }).path;
			},
			root,
			createEventBus(),
			createExtensionRuntime(),
			"worker-extension",
			{ agentDir },
		);

		expect(workPath).toBe(join(agentDir, "work", "extensions", "worker-extension", "job-1"));
		expect(hasActiveWorkRunLease(workPath)).toBe(true);

		await disposeExtensionEventSubscriptions([extension]);

		expect(hasActiveWorkRunLease(workPath)).toBe(false);
		expect(() => storage?.acquireWorkRun({ runId: "late-job" })).toThrow("Extension generation is no longer active");
	});

	it("releases work acquired before a factory failure", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		let workPath = "";

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					workPath = pi.getStorage("failing-extension").acquireWorkRun({ runId: "failed-job" }).path;
					throw new Error("factory failed");
				},
				root,
				createEventBus(),
				createExtensionRuntime(),
				"failing-extension",
				{ agentDir },
			),
		).rejects.toThrow("factory failed");

		expect(hasActiveWorkRunLease(workPath)).toBe(false);
	});
});
