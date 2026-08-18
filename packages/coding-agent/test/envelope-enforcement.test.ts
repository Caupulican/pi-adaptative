import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import {
	extractPathArguments,
	extractToolPathArguments,
	isPathWithinEnvelope,
	wrapToolWithEnvelopeScope,
} from "../src/core/autonomy/envelope-enforcement.ts";
import { createDirectoryLink, FILE_SYMLINK_TESTS_SUPPORTED } from "./helpers/filesystem-links.ts";

const envelope = (overrides: Partial<CapabilityEnvelope>): CapabilityEnvelope => ({
	id: "env-1",
	capabilities: ["filesystem.read"],
	...overrides,
});

describe("envelope path scope", () => {
	it("deny wins over allow; empty allow means no positive restriction", () => {
		const scoped = envelope({ allowedPaths: ["src"], deniedPaths: ["src/secret"] });
		expect(isPathWithinEnvelope(scoped, "src/core/a.ts", "/repo")).toBe(true);
		expect(isPathWithinEnvelope(scoped, "src/secret/key.pem", "/repo")).toBe(false);
		expect(isPathWithinEnvelope(scoped, "docs/readme.md", "/repo")).toBe(false);

		const denyOnly = envelope({ deniedPaths: ["node_modules"] });
		expect(isPathWithinEnvelope(denyOnly, "anything/else.ts", "/repo")).toBe(true);
		expect(isPathWithinEnvelope(denyOnly, "node_modules/x/index.js", "/repo")).toBe(false);
	});

	it("prefix tricks do not escape roots (src-evil is not src)", () => {
		const scoped = envelope({ allowedPaths: ["src"] });
		expect(isPathWithinEnvelope(scoped, "src-evil/a.ts", "/repo")).toBe(false);
		expect(isPathWithinEnvelope(scoped, "src/../etc/passwd", "/repo")).toBe(false);
		expect(isPathWithinEnvelope(scoped, "/etc/passwd", "/repo")).toBe(false);
	});

	describe("symlink resolution at execution time", () => {
		let base: string;

		beforeEach(() => {
			base = mkdtempSync(join(tmpdir(), "envelope-symlink-"));
			mkdirSync(join(base, "allowed"));
			mkdirSync(join(base, "outside"));
		});

		afterEach(() => {
			rmSync(base, { recursive: true, force: true });
		});

		it("denies a target whose parent segment is a directory link escaping the allowed root", () => {
			createDirectoryLink(join(base, "outside"), join(base, "allowed", "link"));
			const scoped = envelope({ allowedPaths: ["allowed"] });
			expect(isPathWithinEnvelope(scoped, "allowed/link/escape.txt", base)).toBe(false);
			expect(isPathWithinEnvelope(scoped, "allowed/real.txt", base)).toBe(true);
		});

		it.skipIf(!FILE_SYMLINK_TESTS_SUPPORTED)(
			"denies writing through a symlinked file that targets outside the allowed root",
			() => {
				writeFileSync(join(base, "outside", "target.txt"), "sensitive", "utf-8");
				symlinkSync(join(base, "outside", "target.txt"), join(base, "allowed", "evil.txt"));
				const scoped = envelope({ allowedPaths: ["allowed"] });
				expect(isPathWithinEnvelope(scoped, "allowed/evil.txt", base)).toBe(false);
			},
		);

		it("deny wins through a directory link into a denied subtree", () => {
			mkdirSync(join(base, "allowed", "secret"));
			createDirectoryLink(join(base, "allowed", "secret"), join(base, "allowed", "shortcut"));
			const scoped = envelope({ allowedPaths: ["allowed"], deniedPaths: ["allowed/secret"] });
			expect(isPathWithinEnvelope(scoped, "allowed/shortcut/key.pem", base)).toBe(false);
		});

		it("still allows targets under an allowed root that is itself a directory link", () => {
			createDirectoryLink(join(base, "allowed"), join(base, "alias"));
			const scoped = envelope({ allowedPaths: ["alias"] });
			expect(isPathWithinEnvelope(scoped, "alias/file.txt", base)).toBe(true);
			expect(isPathWithinEnvelope(scoped, join(base, "allowed", "file.txt"), base)).toBe(true);
		});

		it.skipIf(!FILE_SYMLINK_TESTS_SUPPORTED)(
			"denies a DANGLING symlink inside the allowed root whose target lives outside it (escape repro)",
			() => {
				// evil.txt is a symlink INSIDE the allowed root pointing at a file that does not exist
				// yet OUTSIDE the allowed root. existsSync follows symlinks, so for a dangling link it
				// reports false — a resolver that treats "false" as "literal non-existent path" would
				// approve this as a plain in-scope file, even though the write itself (writeFileSync)
				// follows the link and creates the file outside the sandbox.
				symlinkSync(join(base, "outside", "secret.txt"), join(base, "allowed", "evil.txt"));
				const scoped = envelope({ allowedPaths: ["allowed"] });
				expect(isPathWithinEnvelope(scoped, "allowed/evil.txt", base)).toBe(false);
			},
		);
	});

	it("extracts every conventional path argument shape", () => {
		expect(extractPathArguments({ path: "a", file_path: "b", cwd: "c", paths: ["d", "e"], other: 1 }).sort()).toEqual(
			["a", "b", "c", "d", "e"],
		);
		expect(extractPathArguments(undefined)).toEqual([]);
	});

	it("projects implicit and nested tool paths through the shared path owner", () => {
		expect(extractToolPathArguments("grep", undefined)).toEqual(["."]);
		expect(
			extractToolPathArguments("secret_store", {
				action: "migrate",
				sources: [{ path: " first.env " }, { path: "second.env" }],
			}),
		).toEqual(["first.env", "second.env"]);

		let ran = 0;
		const runCounter = { content: [{ type: "text", text: "ok" }] };
		const scoped = envelope({
			capabilities: ["filesystem.read", "credentials.use"],
			allowedPaths: ["src"],
		});
		const wrappedSearch = wrapToolWithEnvelopeScope(
			{ name: "grep", execute: (..._args: unknown[]) => runCounter },
			scoped,
			"/repo",
		);
		const implicitDenied = wrappedSearch.execute("tc-implicit", {}) as {
			isError?: boolean;
			details?: { outcome?: string; path?: string };
		};
		expect(implicitDenied.isError).toBe(true);
		expect(implicitDenied.details?.outcome).toBe("envelope_path_denied");
		expect(implicitDenied.details?.path).toBe(".");

		const wrappedStore = wrapToolWithEnvelopeScope(
			{
				name: "secret_store",
				execute: (..._args: unknown[]) => {
					ran++;
					return runCounter;
				},
			},
			scoped,
			"/repo",
		);
		const nestedDenied = wrappedStore.execute("tc-nested", {
			action: "migrate",
			sources: [{ path: "/etc/creds.env" }],
		}) as { isError?: boolean; details?: { outcome?: string; path?: string } };
		expect(nestedDenied.isError).toBe(true);
		expect(nestedDenied.details?.path).toBe("/etc/creds.env");
		expect(ran).toBe(0);

		const nestedAllowed = wrappedStore.execute("tc-nested-in-scope", {
			action: "migrate",
			sources: [{ path: "src/creds.env" }],
		}) as { isError?: boolean };
		expect(nestedAllowed.isError).toBeUndefined();
		expect(ran).toBe(1);
	});
});

describe("wrapToolWithEnvelopeScope", () => {
	it("refuses out-of-scope paths STRUCTURALLY at execution time and passes in-scope calls through", async () => {
		let ran = 0;
		const tool = {
			name: "read",
			execute: (..._args: unknown[]) => {
				ran++;
				return { content: [{ type: "text", text: "file body" }] };
			},
		};
		const wrapped = wrapToolWithEnvelopeScope(tool, envelope({ allowedPaths: ["src"] }), "/repo");

		const denied = wrapped.execute("tc-1", { path: "/etc/passwd" }) as {
			isError?: boolean;
			details?: { outcome?: string };
		};
		expect(denied.isError).toBe(true);
		expect(denied.details?.outcome).toBe("envelope_path_denied");
		expect(ran).toBe(0);

		const allowed = wrapped.execute("tc-2", { path: "src/main.ts" }) as { isError?: boolean };
		expect(allowed.isError).toBeUndefined();
		expect(ran).toBe(1);
	});

	it("invokes process-only tools like python with out-of-scope scriptPath and cwd, while direct read outside scope still denies", () => {
		let pythonRan = 0;
		let readRan = 0;
		const pythonTool = {
			name: "python",
			execute: (..._args: unknown[]) => {
				pythonRan++;
				return { content: [{ type: "text", text: "python output" }] };
			},
		};
		const readTool = {
			name: "read",
			execute: (..._args: unknown[]) => {
				readRan++;
				return { content: [{ type: "text", text: "file content" }] };
			},
		};

		const processOnlyEnvelope: CapabilityEnvelope = {
			id: "env-process-only",
			capabilities: ["process.exec"],
			allowedPaths: ["/repo/src"],
		};
		const readEnvelope: CapabilityEnvelope = {
			id: "env-read",
			capabilities: ["filesystem.read"],
			allowedPaths: ["/repo/src"],
		};

		const wrappedPython = wrapToolWithEnvelopeScope(pythonTool, processOnlyEnvelope, "/repo");
		const wrappedRead = wrapToolWithEnvelopeScope(readTool, readEnvelope, "/repo");

		// Python tool with out-of-scope scriptPath and cwd invokes because process tools are not path-scoped
		const pythonResult = wrappedPython.execute("tc-py-1", {
			scriptPath: "/etc/passwd",
			cwd: "/var/log",
		}) as { isError?: boolean; content?: [{ type: string; text: string }] };
		expect(pythonResult.isError).toBeUndefined();
		expect(pythonResult.content?.[0]?.text).toBe("python output");
		expect(pythonRan).toBe(1);

		// Direct read with out-of-scope path is denied
		const readResult = wrappedRead.execute("tc-read-1", {
			path: "/etc/passwd",
		}) as { isError?: boolean; details?: { outcome?: string } };
		expect(readResult.isError).toBe(true);
		expect(readResult.details?.outcome).toBe("envelope_path_denied");
		expect(readRan).toBe(0);
	});
});
