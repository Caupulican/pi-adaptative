import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import { assessPathWithinEnvelopeAsync, wrapToolWithEnvelopeScope } from "../src/core/autonomy/envelope-enforcement.ts";
import { isPathWithinScopeWithDialect } from "../src/core/autonomy/path-scope.ts";
import {
	credentialToolBlockReasonAsync,
	wrapToolWithCredentialExposureGuard,
} from "../src/core/secrets/credential-exposure-guard.ts";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { FILE_SYMLINK_TESTS_SUPPORTED } from "./helpers/filesystem-links.ts";

const root = "/synthetic/project";
const context = {
	sessionId: "review-session",
	generation: 1,
	cwd: root,
	attachment: {
		workspaceId: "review",
		attachmentId: "review-backend",
		root,
		flavor: "posix" as const,
		caseSensitive: true,
	},
};
const envelope: CapabilityEnvelope = {
	id: "review-grant",
	capabilities: ["filesystem.read", "filesystem.write"],
	allowedPaths: [root],
	deniedPaths: [`${root}/private`],
};
const boundary = { redactSensitiveText: (text: string) => text };
const canonical = (path: string) => (path === `${root}/alias.txt` ? `${root}/.env` : path);
const syncAuthority = { flavor: "posix" as const, caseSensitive: true, canonicalPath: canonical, isFile: () => true };
const asyncAuthority = { ...syncAuthority, canonicalPath: async (path: string) => canonical(path) };

describe("backend path authority review regressions", () => {
	for (const [name, args] of [
		["bash", { command: "cat alias.txt" }],
		["powershell", { command: "Get-Content alias.txt" }],
		["python", { code: "open('alias.txt').read()" }],
		["run_process", { executable: "cat", args: ["alias.txt"] }],
	] as const) {
		it(`${name}: async backend must deny the same credential alias as sync backend`, async () => {
			expect(await credentialToolBlockReasonAsync(name, args, root, boundary, context, syncAuthority)).toBeTruthy();
			const benign =
				name === "bash"
					? { command: "cat source.txt" }
					: name === "powershell"
						? { command: "Get-Content source.txt" }
						: name === "python"
							? { code: "open('source.txt').read()" }
							: { executable: "cat", args: ["source.txt"] };
			expect(
				await credentialToolBlockReasonAsync(name, benign, root, boundary, context, asyncAuthority),
			).toBeUndefined();
			expect(await credentialToolBlockReasonAsync(name, args, root, boundary, context, asyncAuthority)).toBeTruthy();
		});
	}

	it("credential wrapper: native-shaped async authority must prevent executor entry", async () => {
		let executed = 0;
		let released = 0;
		const execute = async (..._args: unknown[]) => {
			executed++;
			return { content: [], details: {} };
		};
		const tool = {
			name: "bash",
			label: "Bash",
			description: "fixture",
			parameters: Type.Object({ command: Type.String() }),
			execute,
			bindInvocation: async (..._args: unknown[]) => ({
				executionContext: context,
				pathAuthority: asyncAuthority,
				execute,
				release: () => released++,
			}),
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, root, boundary);
		const invocation = await guarded.bindInvocation!("review-call", { command: "cat alias.txt" });
		try {
			await invocation.execute("review-call", { command: "cat alias.txt" });
		} catch {
		} finally {
			invocation.release();
		}
		expect(released).toBe(1);
		expect(executed).toBe(0);
	});

	it("envelope wrapper: must await async canonicalization before executor entry", async () => {
		let executed = 0;
		const authority = {
			flavor: "posix" as const,
			canonicalPath: async (path: string) => (path === `${root}/alias.txt` ? `${root}/private/key.txt` : path),
		};
		expect(
			(await assessPathWithinEnvelopeAsync(envelope, "alias.txt", { cwd: root, pathAuthority: authority })).allowed,
		).toBe(false);
		const execute = async (..._args: unknown[]) => {
			executed++;
			return { content: [], details: {} };
		};
		const tool = {
			name: "read",
			execute,
			bindInvocation: async (..._args: unknown[]) => ({
				executionContext: context,
				pathAuthority: authority,
				execute,
				release() {},
			}),
		};
		const scoped = wrapToolWithEnvelopeScope(tool, envelope, root);
		const invocation = await scoped.bindInvocation!("review-call", { path: "alias.txt" });
		try {
			await invocation.execute("review-call", { path: "alias.txt" });
		} finally {
			invocation.release();
		}
		expect(executed).toBe(0);
	});

	it("async envelope: failed denied-root canonicalization must not grant its alias", async () => {
		const deniedRoot = `${root}/private-alias`;
		const grant: CapabilityEnvelope = { ...envelope, deniedPaths: [deniedRoot] };
		const authority = {
			flavor: "posix" as const,
			canonicalPath: async (path: string) => (path === deniedRoot ? `${root}/private` : path),
		};
		expect(
			(await assessPathWithinEnvelopeAsync(grant, "private/key.txt", { cwd: root, pathAuthority: authority }))
				.allowed,
		).toBe(false);
		const broken = {
			...authority,
			canonicalPath: async (path: string) => {
				if (path === deniedRoot) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
				return path;
			},
		};
		expect(
			(await assessPathWithinEnvelopeAsync(grant, "private/key.txt", { cwd: root, pathAuthority: broken })).allowed,
		).toBe(false);
	});

	it("foreground gate forwards its cancellation signal to backend preflight", async () => {
		const abort = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		const authority = {
			flavor: "posix" as const,
			canonicalPath: async (path: string, signal?: AbortSignal) => {
				seen.push(signal);
				return path;
			},
		};
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => root,
			getCapabilityEnvelope: () => envelope,
			recordGateOutcome() {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
		});
		await gate.beforeToolCall(
			{
				toolCall: { type: "toolCall", id: "review-call", name: "read", arguments: { path: "source.txt" } },
				args: { path: "source.txt" },
				executionContext: context,
				pathAuthority: authority,
				assistantMessage: fauxAssistantMessage("fixture done"),
				context: { systemPrompt: "test", messages: [], tools: [] },
			},
			abort.signal,
		);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((signal) => signal === abort.signal)).toBe(true);
	});

	it("direct-file credential guard still blocks async aliases (control)", async () => {
		expect(
			await credentialToolBlockReasonAsync("read", { path: "alias.txt" }, root, boundary, context, asyncAuthority),
		).toBeTruthy();
		expect(
			await credentialToolBlockReasonAsync("read", { path: "source.txt" }, root, boundary, context, asyncAuthority),
		).toBeUndefined();
	});

	it.skipIf(!FILE_SYMLINK_TESTS_SUPPORTED)(
		"real native backend: shell must block a synthetic symlink into a dotenv file",
		async () => {
			const scratch = mkdtempSync(join(tmpdir(), "pi-review-alias-"));
			try {
				writeFileSync(join(scratch, ".env"), "SYNTHETIC_FIXTURE=not-a-secret\n");
				symlinkSync(join(scratch, ".env"), join(scratch, "alias.txt"));
				const platformFlavor: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix";
				const nativeContext = {
					...context,
					cwd: scratch,
					attachment: {
						...context.attachment,
						attachmentId: "native:review-fixture",
						root: scratch,
						flavor: platformFlavor,
						caseSensitive: platformFlavor === "posix",
					},
				};
				const args = { command: "cat alias.txt" };
				expect(await credentialToolBlockReasonAsync("bash", args, scratch, boundary, nativeContext)).toBeTruthy();
				expect(
					await credentialToolBlockReasonAsync(
						"bash",
						args,
						scratch,
						boundary,
						nativeContext,
						createNativeTaskDirectoryBackend(),
					),
				).toBeTruthy();
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
	);

	it("native file-kind probe must not flatten EACCES into missing-file recovery", async () => {
		const originalStat = fsPromises.stat;
		let code = "ENOENT";
		fsPromises.stat = (async () => {
			throw Object.assign(new Error(`synthetic ${code}`), { code });
		}) as never;
		syncBuiltinESMExports();
		try {
			const authority = createNativeTaskDirectoryBackend();
			const args = { executable: "rg", args: ["needle", "source.ts"] };
			expect(
				await credentialToolBlockReasonAsync("run_process", args, root, boundary, context, authority),
			).toBeUndefined();
			code = "EACCES";
			await expect(() =>
				credentialToolBlockReasonAsync("run_process", args, root, boundary, context, authority),
			).rejects.toMatchObject({ code: "EACCES" });
		} finally {
			fsPromises.stat = originalStat;
			syncBuiltinESMExports();
		}
	});

	it("explicit case-sensitive Windows backend must not grant differently cased siblings", () => {
		expect(isPathWithinScopeWithDialect("D:\\repo\\Private\\key.txt", "D:\\repo\\private", "win32", false)).toBe(
			true,
		);
		expect(isPathWithinScopeWithDialect("D:\\repo\\private\\key.txt", "D:\\repo\\private", "win32", true)).toBe(true);
		expect(isPathWithinScopeWithDialect("D:\\repo\\Private\\key.txt", "D:\\repo\\private", "win32", true)).toBe(
			false,
		);
	});

	it.skipIf(!FILE_SYMLINK_TESTS_SUPPORTED)(
		"real native envelope wrapper must not follow a symlink into a denied directory",
		async () => {
			const scratch = mkdtempSync(join(tmpdir(), "pi-review-envelope-"));
			try {
				mkdirSync(join(scratch, "private"));
				writeFileSync(join(scratch, "private", "key.txt"), "synthetic\n");
				symlinkSync(join(scratch, "private", "key.txt"), join(scratch, "alias.txt"));
				const grant: CapabilityEnvelope = {
					...envelope,
					allowedPaths: [scratch],
					deniedPaths: [join(scratch, "private")],
				};
				const platformFlavor: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix";
				const nativeContext = {
					...context,
					cwd: scratch,
					attachment: {
						...context.attachment,
						root: scratch,
						flavor: platformFlavor,
						caseSensitive: platformFlavor === "posix",
					},
				};
				let executed = 0;
				const execute = async (..._args: unknown[]) => {
					executed++;
					return { content: [], details: {} };
				};
				const control = wrapToolWithEnvelopeScope({ name: "read", execute }, grant, scratch);
				await (control.execute as (...args: unknown[]) => Promise<unknown>)("control", { path: "alias.txt" });
				expect(executed).toBe(0);
				const scoped = wrapToolWithEnvelopeScope(
					{
						name: "read",
						execute,
						bindInvocation: async (..._args: unknown[]) => ({
							executionContext: nativeContext,
							pathAuthority: createNativeTaskDirectoryBackend(),
							execute,
							release() {},
						}),
					},
					grant,
					scratch,
				);
				const invocation = await scoped.bindInvocation!("review-call", { path: "alias.txt" });
				try {
					await invocation.execute("review-call", { path: "alias.txt" });
				} finally {
					invocation.release();
				}
				expect(executed).toBe(0);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
	);

	it("foreground backend preflight must settle when the caller cancels", async () => {
		const abort = new AbortController();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let settled = false;
		const authority = {
			flavor: "posix" as const,
			canonicalPath: async (path: string, signal?: AbortSignal) => {
				started.resolve();
				if (signal?.aborted) throw signal.reason;
				signal?.addEventListener("abort", () => finish.reject(signal.reason), { once: true });
				await finish.promise;
				return path;
			},
		};
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => root,
			getCapabilityEnvelope: () => envelope,
			recordGateOutcome() {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
		});
		const run = gate
			.beforeToolCall(
				{
					toolCall: { type: "toolCall", id: "cancel-review", name: "read", arguments: { path: "source.txt" } },
					args: { path: "source.txt" },
					executionContext: context,
					pathAuthority: authority,
					assistantMessage: fauxAssistantMessage("fixture done"),
					context: { systemPrompt: "test", messages: [], tools: [] },
				},
				abort.signal,
			)
			.catch(() => {})
			.finally(() => {
				settled = true;
			});
		await started.promise;
		abort.abort(new Error("synthetic cancellation"));
		await new Promise((resolve) => setImmediate(resolve));
		const settledOnAbort = settled;
		finish.resolve();
		await run;
		expect(settledOnAbort).toBe(true);
	});
});
