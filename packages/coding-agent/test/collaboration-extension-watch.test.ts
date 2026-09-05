import { EventEmitter } from "node:events";
import type * as fs from "node:fs";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CollaborationControlHandoffs } from "../src/core/collaboration/control-handoffs.ts";
import { piCollaborationExtension } from "../src/core/collaboration/extension.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";
import { createDirectoryLink } from "./helpers/filesystem-links.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const callbacks: Array<(file: string | Buffer | null) => void> = [];
	const watchers: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
	const watch = (_path: string, callback: (file: string | Buffer | null) => void): fs.FSWatcher => {
		callbacks.push(callback);
		const watcher = Object.assign(new EventEmitter(), {
			close: vi.fn(),
			ref: () => watcher,
			unref: () => watcher,
		});
		watchers.push(watcher);
		return watcher;
	};
	const f = await collaborationFixture({ watch });
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "watch", task: "work", agents: [{ provider: "pi" }] });
	f.report.mockClear();
	return { ...f, callbacks, watchers };
}

it.each([null, "turn.json"])("publishes a durable terminal on a filesystem event with filename %s", async (file) => {
	const f = await fixture();
	const member = f.store.load("watch").agents[0];
	f.store.finishTurn("watch", member.id, member.turnId, "done", "verified");
	f.callbacks[0]("unrelated.tmp");
	expect(f.report).not.toHaveBeenCalled();
	f.callbacks[0](file);
	f.callbacks[0](file);
	expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: "terminal", status: "done" }));
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.backend.readAgent).not.toHaveBeenCalled();
});

it("ignores late watcher signals after disposal and after another generation binds", async () => {
	const f = await fixture();
	const controls = new CollaborationControlHandoffs(f.store, () => {});
	await f.shutdown();
	expect(f.watchers[0].close).toHaveBeenCalledOnce();
	controls.record("watch", "server", "one", "server stopped");
	f.callbacks[0]("turn.json");
	f.callbacks[0](null);
	expect(f.sendMessage).not.toHaveBeenCalled();
	await f.start();
	expect(f.sendMessage).toHaveBeenCalledTimes(1);
	controls.record("watch", "server", "two", "another stopped server");
	f.callbacks[0]("turn.json");
	expect(f.sendMessage).toHaveBeenCalledTimes(1);
	f.callbacks[1]("turn.json");
	expect(f.sendMessage).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
	"canonicalizes the state watcher target before native registration (alias=%s)",
	async (alias) => {
		const f = await collaborationFixture();
		cleanups.push(f.cleanup);
		const canonical = join(realpathSync.native(f.root), "long state directory");
		const linked = join(f.root, "state-alias");
		mkdirSync(canonical);
		if (alias) createDirectoryLink(canonical, linked);
		const stateDirectory = join(alias ? linked : canonical, "jobs");
		const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), ref: () => watcher, unref: () => watcher });
		const watch = vi.fn((_directory: string, _onChange: (file: string | Buffer | null) => void) => watcher);
		piCollaborationExtension(f.api, { stateDirectory, watch, backend: async () => f.backend });
		await f.start();
		expect(watch).toHaveBeenCalledExactlyOnceWith(realpathSync.native(stateDirectory), expect.any(Function));
		if (alias) expect(watch.mock.calls[0]?.[0]).not.toBe(stateDirectory);
		watcher.emit("error", new Error("watch signal failed"));
		expect(f.context.ui.notify).toHaveBeenCalledWith("Collaboration signal failed: watch signal failed", "error");
		await f.shutdown();
		expect(watcher.close).toHaveBeenCalledOnce();
	},
);
