import { realpathSync } from "node:fs";
import { type AgentTool, captureExecutionContext } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractToolPathArguments } from "../src/core/autonomy/envelope-enforcement.ts";
import {
	type CredentialExposureBoundary,
	wrapToolWithCredentialExposureGuard,
} from "../src/core/secrets/credential-exposure-guard.ts";
import type { CredentialPathProbe } from "../src/core/secrets/credential-path-policy.ts";

const parameters = Type.Record(Type.String(), Type.Unknown());
const cases = [
	{ flavor: "win32", root: "D:\\synthetic\\project", path: "D:\\synthetic\\project\\.env.local", blocked: true },
	{ flavor: "win32", root: "D:\\synthetic\\project", path: "D:\\synthetic\\project\\source.ts", blocked: false },
	{ flavor: "posix", root: "/synthetic/project", path: "/synthetic/project/ordinary\\.env.local", blocked: false },
	{ flavor: "posix", root: "/synthetic/project", path: "/synthetic/project/.env.local", blocked: true },
	{ flavor: "win32", root: "D:\\synthetic\\project", path: "D:\\synthetic\\project\\.ENV.LOCAL", blocked: true },
] as const;

afterEach(() => vi.restoreAllMocks());

function fixture(flavor: "posix" | "win32", root: string, boundary?: CredentialExposureBoundary, name = "read") {
	const execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "Synthetic only" }],
		details: {},
	}));
	const release = vi.fn();
	const context = captureExecutionContext({
		sessionId: "synthetic-session",
		generation: 1,
		cwd: root,
		attachment: {
			workspaceId: "synthetic",
			attachmentId: "synthetic-backend",
			root,
			flavor,
			caseSensitive: flavor === "posix",
		},
	});
	const tool: AgentTool<typeof parameters> = {
		name,
		label: "Read",
		description: "Synthetic reader; no filesystem access",
		parameters,
		execute,
		bindInvocation: async () => ({ executionContext: context, execute, release }),
	};
	const guarded = wrapToolWithCredentialExposureGuard(
		tool,
		"/synthetic/operator",
		boundary ?? { redactSensitiveText: (text) => text },
	);
	return {
		execute,
		release,
		context,
		async run(params: Record<string, unknown>, signal?: AbortSignal) {
			const invocation = await guarded.bindInvocation!("synthetic-call", params);
			try {
				return await invocation.execute("synthetic-call", params, signal);
			} finally {
				invocation.release();
			}
		},
	};
}

describe("backend-owned credential paths", () => {
	it.each(cases)("uses $flavor semantics for $path", async ({ flavor, root, path, blocked }) => {
		const test = fixture(flavor, root);
		if (blocked) await expect(test.run({ path })).rejects.toThrow("model-blind");
		else await test.run({ path });
		expect(test.execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
		expect(test.release).toHaveBeenCalledOnce();
	});

	it.each(["file.txt ", " file.txt", " ", "chapter\u202f1.txt"])(
		"preserves literal path bytes in the shared permission projection: %j",
		(path) => {
			expect(extractToolPathArguments("read", { path })).toEqual([path]);
			expect(extractToolPathArguments("read", { paths: [path] })).toEqual([path]);
		},
	);

	it("keeps a protected trailing-space filename distinct from its ordinary namesake", async () => {
		const test = fixture("posix", "/synthetic/project", {
			redactSensitiveText: (text) => text,
			protectedFiles: ["/synthetic/project/private.json "],
		});
		await expect(test.run({ path: "private.json " })).rejects.toThrow("model-blind");
		await test.run({ path: "private.json" });
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it("uses explicit backend facts, including their method receiver, without probing native namesakes", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const flavor = process.platform === "win32" ? "win32" : "posix";
		const root = flavor === "win32" ? "D:\\synthetic\\project" : "/synthetic/project";
		const separator = flavor === "win32" ? "\\" : "/";
		class Probe implements CredentialPathProbe {
			#aliases = new Map([[`${root}${separator}alias`, `${root}${separator}.env.local`]]);
			canonicalPath(path: string) {
				return this.#aliases.get(path);
			}
			isFile() {
				return true;
			}
		}
		const probe = new Probe();
		const getPathProbe = vi.fn(() => probe);
		const test = fixture(flavor, root, { redactSensitiveText: (text) => text, getPathProbe });
		await expect(test.run({ path: "alias" })).rejects.toThrow("model-blind");
		await test.run({ path: "source.ts" });
		expect(getPathProbe).toHaveBeenCalledWith(test.context);
		expect(native).not.toHaveBeenCalled();
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it("does not replace a failed backend file-kind probe with suffix-based permission", async () => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text.replaceAll("SYNTHETIC_PRIVATE", "[redacted]"),
				getPathProbe: () => ({
					canonicalPath: () => undefined,
					isFile: () => {
						throw Object.assign(new Error("SYNTHETIC_PRIVATE backend denied"), { code: "EACCES" });
					},
				}),
			},
			"run_process",
		);
		await expect(test.run({ executable: "rg", args: ["needle", "source.ts"] })).rejects.toThrow(
			"[redacted] backend denied",
		);
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("redacts backend canonicalization failures and never falls back to the operator filesystem", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const test = fixture("posix", "/synthetic/project", {
			redactSensitiveText: (text) => text.replaceAll("SYNTHETIC_PRIVATE", "[redacted]"),
			getPathProbe: () => ({
				canonicalPath: () => {
					throw new Error("SYNTHETIC_PRIVATE backend unavailable");
				},
				isFile: () => true,
			}),
		});
		await expect(test.run({ path: "source.ts" })).rejects.toThrow("[redacted] backend unavailable");
		expect(native).not.toHaveBeenCalled();
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("does not acquire probe facts or execute after cancellation", async () => {
		const getPathProbe = vi.fn(() => ({ canonicalPath: () => undefined, isFile: () => true }));
		const test = fixture("posix", "/synthetic/project", { redactSensitiveText: (text) => text, getPathProbe });
		await expect(
			test.run({ path: "source.ts" }, AbortSignal.abort(new Error("synthetic cancellation"))),
		).rejects.toThrow("synthetic cancellation");
		expect(getPathProbe).not.toHaveBeenCalled();
		expect(test.execute).not.toHaveBeenCalled();
		expect(test.release).toHaveBeenCalledOnce();
	});

	it.each(["ENOENT", "ENOTDIR"])("retains explicit missing-file recovery for %s", async (code) => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text,
				getPathProbe: () => ({
					canonicalPath: () => undefined,
					isFile: () => {
						throw Object.assign(new Error("synthetic missing path"), { code });
					},
				}),
			},
			"run_process",
		);
		await test.run({ executable: "rg", args: ["needle", "source.ts"] });
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it("does not treat a directory with a filename suffix as a missing file", async () => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text,
				getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => false }),
			},
			"run_process",
		);
		await expect(test.run({ executable: "rg", args: ["needle", "source.ts"] })).rejects.toThrow("narrow non-dotenv");
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("checks cancellation again when probe acquisition cancels the invocation", async () => {
		const abort = new AbortController();
		const test = fixture("posix", "/synthetic/project", {
			redactSensitiveText: (text) => text,
			getPathProbe: () => {
				abort.abort(new Error("synthetic cancellation"));
				return { canonicalPath: () => undefined, isFile: () => true };
			},
		});
		await expect(test.run({ path: "source.ts" }, abort.signal)).rejects.toThrow("synthetic cancellation");
		expect(test.execute).not.toHaveBeenCalled();
		expect(test.release).toHaveBeenCalledOnce();
	});

	it.each([
		{ name: "run_process", params: { executable: "printf", args: ["x:y"] } },
		{ name: "run_process", params: { executable: "rg", args: ["x:y", "source.ts"] } },
		{ name: "python", params: { code: "print('x:y'); open('source.ts').read()" } },
		{ name: "powershell", params: { command: "Get-Content source.ts | Select-String 'x:y'" } },
	])("does not turn opaque $name text into a drive-relative file request", async ({ name, params }) => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text,
				getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => true }),
			},
			name,
		);
		await test.run(params);
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it.each(["D:.env.local", "D:private.json", "D:private\\file.txt"])(
		"retains conservative credential screening for opaque %s",
		async (path) => {
			const test = fixture(
				"win32",
				"D:\\synthetic\\project",
				{
					redactSensitiveText: (text) => text,
					protectedFiles: ["D:\\synthetic\\project\\private.json"],
					protectedDirectories: ["D:\\synthetic\\project\\private"],
					getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => true }),
				},
				"run_process",
			);
			await expect(test.run({ executable: "cat", args: [path] })).rejects.toThrow("credential files");
			expect(test.execute).not.toHaveBeenCalled();
		},
	);

	it("still rejects ambiguous direct file requests", async () => {
		const test = fixture("win32", "D:\\synthetic\\project");
		await expect(test.run({ path: "D:source.ts" })).rejects.toThrow("drive-relative");
		expect(test.execute).not.toHaveBeenCalled();
	});
});
