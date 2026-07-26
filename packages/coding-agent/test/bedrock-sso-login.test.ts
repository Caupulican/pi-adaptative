import { describe, expect, it, vi } from "vitest";
import { loginBedrockSsoProfile } from "../src/core/bedrock-sso-login.ts";
import type { ExecResult } from "../src/core/exec.ts";

function result(overrides: Partial<ExecResult> = {}): ExecResult {
	return {
		stdout: "",
		stderr: "",
		code: 0,
		killed: false,
		stdoutTruncated: false,
		stderrTruncated: false,
		...overrides,
	};
}

describe("Bedrock SSO login", () => {
	it("executes the exact profile without a shell-shaped command string", async () => {
		const execute = vi.fn(async () => result());

		await loginBedrockSsoProfile("team profile; harmless", {
			execute,
			isWorker: () => false,
			cwd: "/workspace",
			env: { PATH: "/bin" },
		});

		expect(execute).toHaveBeenCalledWith(
			"aws",
			["sso", "login", "--profile", "team profile; harmless"],
			"/workspace",
			expect.objectContaining({ env: { PATH: "/bin" }, maxBuffer: 32 * 1024 }),
		);
	});

	it("shares one in-flight login per profile", async () => {
		let release: (() => void) | undefined;
		const execute = vi.fn(
			() =>
				new Promise<ExecResult>((resolve) => {
					release = () => resolve(result());
				}),
		);
		const options = { execute, isWorker: () => false, cwd: "/workspace", env: {} };

		const first = loginBedrockSsoProfile("work-sso", options);
		const second = loginBedrockSsoProfile("work-sso", options);
		expect(execute).toHaveBeenCalledOnce();
		release?.();
		await Promise.all([first, second]);
	});

	it("lets a joining request cancel without terminating the shared login", async () => {
		let release: (() => void) | undefined;
		const execute = vi.fn(
			() =>
				new Promise<ExecResult>((resolve) => {
					release = () => resolve(result());
				}),
		);
		const options = { execute, isWorker: () => false, cwd: "/workspace", env: {} };
		const first = loginBedrockSsoProfile("work-sso", options);
		const controller = new AbortController();
		controller.abort();
		const joining = loginBedrockSsoProfile("work-sso", { ...options, signal: controller.signal });

		release?.();
		await first;
		await expect(joining).rejects.toThrow("cancelled");
		expect(execute).toHaveBeenCalledOnce();
	});

	it("never starts browser-capable authentication in a worker session", async () => {
		const execute = vi.fn(async () => result());

		await expect(
			loginBedrockSsoProfile("work-sso", {
				execute,
				isWorker: () => true,
				cwd: "/workspace",
				env: {},
			}),
		).rejects.toThrow("requires a user session");
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not spawn when the owning request is already cancelled", async () => {
		const execute = vi.fn(async () => result());
		const controller = new AbortController();
		controller.abort();

		await expect(
			loginBedrockSsoProfile("work-sso", {
				execute,
				isWorker: () => false,
				cwd: "/workspace",
				env: {},
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects terminal control characters in profile names before execution", async () => {
		const execute = vi.fn(async () => result());

		await expect(
			loginBedrockSsoProfile("work\u001b]2;spoofed\u0007", {
				execute,
				isWorker: () => false,
				cwd: "/workspace",
				env: {},
			}),
		).rejects.toThrow("unsupported characters");
		expect(execute).not.toHaveBeenCalled();
	});

	it("turns a missing AWS CLI into bounded setup guidance", async () => {
		const execute = vi.fn(async () => result({ code: 1, errorMessage: "spawn aws ENOENT" }));

		await expect(
			loginBedrockSsoProfile("work-sso", {
				execute,
				isWorker: () => false,
				cwd: "/workspace",
				env: {},
			}),
		).rejects.toThrow("AWS CLI v2 is required");
	});

	it("bounds and sanitizes failed CLI output", async () => {
		const execute = vi.fn(async () =>
			result({
				code: 255,
				stderr: `\u001b[31m${"x".repeat(2_000)}\u001b[0m\n\u001b]2;spoofed\u0007final failure`,
			}),
		);

		const failure = await loginBedrockSsoProfile("work-sso", {
			execute,
			isWorker: () => false,
			cwd: "/workspace",
			env: {},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("final failure");
		expect((failure as Error).message).not.toContain("spoofed");
		expect((failure as Error).message).not.toContain("\u001b");
		expect((failure as Error).message.length).toBeLessThan(700);
	});
});
