import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import {
	extractPathArguments,
	isPathWithinEnvelope,
	wrapToolWithEnvelopeScope,
} from "../src/core/autonomy/envelope-enforcement.ts";

const envelope = (overrides: Partial<CapabilityEnvelope>): CapabilityEnvelope => ({
	id: "env-1",
	capabilities: ["read_files"],
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

		it("denies a target whose parent segment is a symlink escaping the allowed root", () => {
			symlinkSync(join(base, "outside"), join(base, "allowed", "link"));
			const scoped = envelope({ allowedPaths: ["allowed"] });
			expect(isPathWithinEnvelope(scoped, "allowed/link/escape.txt", base)).toBe(false);
			expect(isPathWithinEnvelope(scoped, "allowed/real.txt", base)).toBe(true);
		});

		it("denies writing through a symlinked file that targets outside the allowed root", () => {
			writeFileSync(join(base, "outside", "target.txt"), "sensitive", "utf-8");
			symlinkSync(join(base, "outside", "target.txt"), join(base, "allowed", "evil.txt"));
			const scoped = envelope({ allowedPaths: ["allowed"] });
			expect(isPathWithinEnvelope(scoped, "allowed/evil.txt", base)).toBe(false);
		});

		it("deny wins through a symlink into a denied subtree", () => {
			mkdirSync(join(base, "allowed", "secret"));
			symlinkSync(join(base, "allowed", "secret"), join(base, "allowed", "shortcut"));
			const scoped = envelope({ allowedPaths: ["allowed"], deniedPaths: ["allowed/secret"] });
			expect(isPathWithinEnvelope(scoped, "allowed/shortcut/key.pem", base)).toBe(false);
		});

		it("still allows targets under an allowed root that is itself a symlink", () => {
			symlinkSync(join(base, "allowed"), join(base, "alias"));
			const scoped = envelope({ allowedPaths: ["alias"] });
			expect(isPathWithinEnvelope(scoped, "alias/file.txt", base)).toBe(true);
			expect(isPathWithinEnvelope(scoped, join(base, "allowed", "file.txt"), base)).toBe(true);
		});

		it("denies a DANGLING symlink inside the allowed root whose target lives outside it (escape repro)", () => {
			// evil.txt is a symlink INSIDE the allowed root pointing at a file that does not exist
			// yet OUTSIDE the allowed root. existsSync follows symlinks, so for a dangling link it
			// reports false — a resolver that treats "false" as "literal non-existent path" would
			// approve this as a plain in-scope file, even though the write itself (writeFileSync)
			// follows the link and creates the file outside the sandbox.
			symlinkSync(join(base, "outside", "secret.txt"), join(base, "allowed", "evil.txt"));
			const scoped = envelope({ allowedPaths: ["allowed"] });
			expect(isPathWithinEnvelope(scoped, "allowed/evil.txt", base)).toBe(false);
		});
	});

	it("extracts every conventional path argument shape", () => {
		expect(extractPathArguments({ path: "a", file_path: "b", cwd: "c", paths: ["d", "e"], other: 1 }).sort()).toEqual(
			["a", "b", "c", "d", "e"],
		);
		expect(extractPathArguments(undefined)).toEqual([]);
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
});
