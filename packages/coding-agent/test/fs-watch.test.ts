import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { watchSpy } = vi.hoisted(() => ({
	watchSpy: vi.fn((_path: string, _listener: unknown) => {
		const emitter = new EventEmitter() as EventEmitter & { close: () => void };
		emitter.close = () => {};
		return emitter;
	}),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, watch: watchSpy };
});

const { canonicalizeWatchDir, watchWithErrorHandler } = await import("../src/utils/fs-watch.ts");

const cleanups: Array<() => void> = [];

afterEach(() => {
	watchSpy.mockClear();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe.skipIf(process.platform === "win32")("canonicalizeWatchDir", () => {
	it("resolves a symlinked directory to its realpath", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fs-watch-canon-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const realDir = join(dir, "real");
		mkdirSync(realDir, { recursive: true });
		const linkDir = join(dir, "alias");
		symlinkSync(realDir, linkDir);

		expect(canonicalizeWatchDir(linkDir)).toBe(realpathSync.native(realDir));
		expect(canonicalizeWatchDir(linkDir)).not.toBe(linkDir);
	});

	it("falls back to the original path when realpath resolution fails", () => {
		const missing = join(tmpdir(), "pi-fs-watch-does-not-exist", "nested");
		expect(canonicalizeWatchDir(missing)).toBe(missing);
	});
});

describe.skipIf(process.platform === "win32")("watchWithErrorHandler", () => {
	it("passes fs.watch the realpath of the intended dir, not a symlinked alias", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fs-watch-target-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const realDir = join(dir, "real");
		mkdirSync(realDir, { recursive: true });
		const linkDir = join(dir, "alias");
		symlinkSync(realDir, linkDir);

		const watcher = watchWithErrorHandler(
			linkDir,
			() => {},
			() => {},
		);
		cleanups.push(() => watcher?.close());

		expect(watchSpy).toHaveBeenCalledTimes(1);
		expect(watchSpy.mock.calls[0]?.[0]).toBe(realpathSync.native(realDir));
		expect(watchSpy.mock.calls[0]?.[0]).not.toBe(linkDir);
	});
});
