import { describe, expect, it, vi } from "vitest";
import type { CollaborationCommandRunner } from "../src/core/collaboration/command-runner.ts";
import { NativeProviderRegistry, nativeCollaborationLaunchArgs } from "../src/core/collaboration/native-provider.ts";

const output = (stdout: string, code = 0) => ({ code, stdout, stderr: "", reason: "exited" as const });
describe("native collaboration provider admission", () => {
	it("uses explicit YOLO only in the three authorized collaboration providers without headless flags", () => {
		expect(nativeCollaborationLaunchArgs("codex", ["--dangerously-bypass-approvals-and-sandbox"])).toEqual([
			"--dangerously-bypass-approvals-and-sandbox",
		]);
		expect(nativeCollaborationLaunchArgs("claude", [])).toEqual(["--dangerously-skip-permissions"]);
		expect(nativeCollaborationLaunchArgs("agy", [])).toEqual(["--dangerously-skip-permissions"]);
		expect(nativeCollaborationLaunchArgs("pi", ["--model", "chosen"])).toEqual(["--model", "chosen"]);
		expect(nativeCollaborationLaunchArgs("custom", [])).toEqual([]);
		expect(() => nativeCollaborationLaunchArgs("codex", ["--sandbox", "read-only"])).toThrow("conflicts");
	});
	it("does not treat successful Pi auth exit as valid credentials and pins selected launch provider", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(output("pi 1"))
			.mockResolvedValueOnce(
				output(
					JSON.stringify({ success: true, providers: [{ provider: "xai", configured: true, status: "expired" }] }),
				),
			);
		expect(await new NativeProviderRegistry(run).inspect("pi", { provider: "xai" })).toMatchObject({
			installed: true,
			authenticated: false,
			status: "login-required",
		});
		run.mockResolvedValueOnce(output("pi 1")).mockResolvedValueOnce(
			output(JSON.stringify({ providers: [{ provider: "openai-codex", configured: true, status: "valid" }] })),
		);
		expect(await new NativeProviderRegistry(run).inspect("pi")).toMatchObject({
			authenticated: true,
			launchArgs: ["--provider", "openai-codex"],
		});
	});
	it("requires Claude loggedIn true without exposing auth metadata", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(output("claude 1"))
			.mockResolvedValueOnce(output('{"loggedIn":false,"accessToken":"secret"}'));
		const registry = new NativeProviderRegistry(run);
		expect(JSON.stringify(await registry.inspect("claude"))).not.toContain("secret");
		run.mockResolvedValueOnce(output("claude 1")).mockResolvedValueOnce(output('{"loggedIn":true}'));
		expect(await registry.inspect("claude")).toMatchObject({ authenticated: true });
	});
	it("keeps missing, unknown and failed probes distinct and does not invent Gemini support", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValue({ code: null, reason: "not_found", stdout: "", stderr: "" });
		const registry = new NativeProviderRegistry(run);
		expect(await registry.inspect("agy")).toMatchObject({ installed: false, status: "not-installed" });
		expect(await registry.inspect("gemini")).toMatchObject({ installed: false, status: "unsupported" });
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("requires a real agy model row, not a banner or login error", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(output("agy 1"))
			.mockResolvedValueOnce(output("Fetching available models..."));
		const registry = new NativeProviderRegistry(run);
		expect(await registry.inspect("agy")).toMatchObject({ authenticated: false });
		run.mockResolvedValueOnce(output("agy 1")).mockResolvedValueOnce(output("gemini-model\tGemini Model"));
		expect(await registry.inspect("agy")).toMatchObject({ authenticated: true });
	});
	it("allows an explicit additional native strategy and rejects duplicate owners", async () => {
		const run = vi.fn<CollaborationCommandRunner>().mockResolvedValue(output("installed"));
		const strategy = {
			id: "other",
			kind: "other",
			executable: "other",
			authArgs: () => ["auth", "status"],
			parseAuth: () => ({ authenticated: true, launchArgs: [] }),
		};
		const registry = new NativeProviderRegistry(run, [strategy]);
		expect(await registry.inspect("other")).toMatchObject({ authenticated: true, kind: "other" });
		expect(() => new NativeProviderRegistry(run, [strategy, strategy])).toThrow("Duplicate");
	});
	it("checks the same working directory and wrapper environment as the native pane", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(output("claude 1"))
			.mockResolvedValueOnce(output('{"loggedIn":true}'));
		const env = { CLAUDE_CONFIG_DIR: "/wrapper/credentials" };
		await new NativeProviderRegistry(run).inspect("claude", { executable: "/wrapper/claude", cwd: "/project", env });
		expect(run.mock.calls).toEqual([
			["/wrapper/claude", ["--version"], { timeoutMs: 10000, cwd: "/project", env }],
			["/wrapper/claude", ["auth", "status"], { timeoutMs: 30000, cwd: "/project", env }],
		]);
	});
	it("probes the exact stable Pi host invocation and exposes only its stable environment for launch", async () => {
		const target = {
			executable: "/runtime/node",
			argsPrefix: ["--import", "/original/loader.mjs", "/original/pi.ts"],
			environment: { PI_PACKAGE_DIR: "/original", TSX_TSCONFIG_PATH: "/original/tsconfig.json" },
		};
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(output("pi 1"))
			.mockResolvedValueOnce(
				output(JSON.stringify({ providers: [{ provider: "xai", configured: true, status: "valid" }] })),
			);
		const stable = vi.fn(() => target);
		const registry = new NativeProviderRegistry(run, [], stable);
		const readiness = await registry.inspect("pi", {
			provider: "xai",
			model: "chosen",
			cwd: "/project",
			env: {
				PI_PACKAGE_DIR: "/retired-generation",
				TSX_TSCONFIG_PATH: "/retired/tsconfig.json",
				PRIVATE_AUTH: "secret",
			},
		});
		expect(readiness).toMatchObject({
			authenticated: true,
			invocation: { ...target, lifecycle: "current-harness" },
			launchArgs: ["--provider", "xai", "--model", "chosen"],
		});
		expect(stable).toHaveBeenCalledOnce();
		expect(run.mock.calls.map(([executable, args]) => [executable, args])).toEqual([
			[target.executable, [...target.argsPrefix, "--version"]],
			[
				target.executable,
				[...target.argsPrefix, "auth", "check", "--json", "--no-refresh", "--provider", "xai", "--model", "chosen"],
			],
		]);
		for (const [, , options] of run.mock.calls)
			expect(options).toMatchObject({ cwd: "/project", env: { ...target.environment, PRIVATE_AUTH: "secret" } });
		expect(JSON.stringify(readiness)).not.toContain("secret");
	});
	it("does not fall back to PATH Pi when the running host has no durable launch target", async () => {
		const run = vi.fn<CollaborationCommandRunner>();
		const registry = new NativeProviderRegistry(run, [], () => undefined);
		expect(() => registry.resolveInvocation("pi")).toThrow(/stable.*Pi|Pi.*stable/i);
		expect(await registry.inspect("pi")).toMatchObject({ authenticated: false, status: "probe-failed" });
		expect(run).not.toHaveBeenCalled();
	});
	it("retains the inherited authentication environment when default Pi status has no explicit environment", async () => {
		vi.stubEnv("PI_TEST_NATIVE_AUTH_SCOPE", "ambient-login");
		try {
			const run = vi.fn<CollaborationCommandRunner>().mockResolvedValue(output("pi 1"));
			const registry = new NativeProviderRegistry(run, [], () => ({
				executable: "/runtime/pi",
				argsPrefix: [],
				environment: { PI_PACKAGE_DIR: "/original", TSX_TSCONFIG_PATH: "/original/tsconfig.json" },
			}));
			await registry.inspect("pi");
			for (const [, , options] of run.mock.calls)
				expect(options?.env).toMatchObject({
					PI_TEST_NATIVE_AUTH_SCOPE: "ambient-login",
					PI_PACKAGE_DIR: "/original",
				});
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("preserves an explicitly selected Pi wrapper without claiming current-host lifecycle support", async () => {
		const stable = vi.fn(() => undefined);
		const registry = new NativeProviderRegistry(vi.fn(), [], stable);
		expect(registry.resolveInvocation("pi", { executable: "/wrapper/pi" })).toEqual({
			executable: "/wrapper/pi",
			argsPrefix: [],
			lifecycle: "external-cli",
		});
		expect(stable).not.toHaveBeenCalled();
	});
});
