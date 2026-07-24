import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionImageDirectory, SessionImageStore } from "../src/core/session-image-store.ts";

describe("SessionImageStore", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createRoot(): string {
		const root = join(tmpdir(), `pi-session-images-${process.pid}-${Date.now()}-${tempDirs.length}`);
		mkdirSync(root, { recursive: true });
		tempDirs.push(root);
		return root;
	}

	it("defaults to organized agent state and resolves configured relative paths from cwd", () => {
		const root = createRoot();
		expect(resolveSessionImageDirectory({ agentDir: join(root, "agent"), cwd: root, sessionId: "session-a" })).toBe(
			join(root, "agent", "state", "attachments"),
		);
		expect(
			resolveSessionImageDirectory({
				agentDir: join(root, "agent"),
				cwd: root,
				sessionId: "session-a",
				directory: "captures",
			}),
		).toBe(join(root, "captures"));
	});

	it("stores stable session sequences and resolves explicit and latest references", () => {
		const root = createRoot();
		const store = new SessionImageStore({ agentDir: root, cwd: root, sessionId: "session-a" });
		const first = store.write(new Uint8Array([1, 2, 3]), "image/png");
		const second = store.write(new Uint8Array([4, 5, 6]), "image/jpeg");
		const resumedStore = new SessionImageStore({ agentDir: root, cwd: root, sessionId: "session-a" });

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(readFileSync(second.path)).toEqual(Buffer.from([4, 5, 6]));
		expect(store.resolveReferences("compare image #1 and image 2").map((image) => image.mimeType)).toEqual([
			"image/png",
			"image/jpeg",
		]);
		expect(resumedStore.resolveReferences("look at the image")).toEqual([
			{ type: "image", data: Buffer.from([4, 5, 6]).toString("base64"), mimeType: "image/jpeg" },
		]);
		expect(resumedStore.write(new Uint8Array([7]), "image/png").sequence).toBe(3);
	});

	it("retains RPC image content idempotently only when the claimed sequence matches", () => {
		const root = createRoot();
		const store = new SessionImageStore({ agentDir: root, cwd: root, sessionId: "session-rpc" });
		const content = {
			type: "image" as const,
			data: Buffer.from([1, 2, 3]).toString("base64"),
			mimeType: "image/png",
		};
		const first = store.retainContent(content);
		const reused = store.retainContent(content, first.sequence);
		const changed = store.retainContent(
			{ ...content, data: Buffer.from([4, 5, 6]).toString("base64") },
			first.sequence,
		);

		expect(reused.path).toBe(first.path);
		expect(changed.sequence).toBe(first.sequence + 1);
		expect(() => store.retainContent({ ...content, data: "not base64" })).toThrow("valid base64");
		expect(() => store.retainContent({ ...content, mimeType: "text/plain" })).toThrow("Unsupported image MIME");
	});

	it("isolates sessions and rejects modified stored payloads", () => {
		const root = createRoot();
		const firstStore = new SessionImageStore({ agentDir: root, cwd: root, sessionId: "session-a" });
		const otherStore = new SessionImageStore({ agentDir: root, cwd: root, sessionId: "session-b" });
		const stored = firstStore.write(new Uint8Array([1, 2, 3]), "image/png");

		expect(otherStore.resolveReferences("look at the image")).toEqual([]);
		writeFileSync(stored.path, Buffer.from([9, 9, 9]));
		expect(firstStore.resolveReferences("image #1")).toEqual([]);
	});

	it("prunes expired Pi attachments without touching unrelated files", () => {
		const root = createRoot();
		const now = Date.now();
		const store = new SessionImageStore({ agentDir: root, cwd: root, sessionId: "session-a", now: () => now });
		const expired = store.write(new Uint8Array([1]), "image/png");
		const oldTime = new Date(now - 31 * 24 * 60 * 60 * 1000);
		utimesSync(expired.path, oldTime, oldTime);
		const unrelatedPath = join(store.directory, "keep-me.png");
		writeFileSync(unrelatedPath, Buffer.from([2]));

		store.write(new Uint8Array([3]), "image/png");

		expect(existsSync(expired.path)).toBe(false);
		expect(existsSync(unrelatedPath)).toBe(true);
	});

	it("fails closed when a configured attachment directory is invalid", () => {
		const root = createRoot();
		const invalidDirectory = join(root, "attachment-file");
		writeFileSync(invalidDirectory, Buffer.from([1]));
		const store = new SessionImageStore({
			agentDir: root,
			cwd: root,
			sessionId: "session-a",
			directory: invalidDirectory,
		});

		expect(store.resolveReferences("look at the image")).toEqual([]);
	});
});
