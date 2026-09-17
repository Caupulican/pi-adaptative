import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each(["expiry", "rejection"])(
	"recovers a built-in Claude %s rotation through the real OAuth adapter",
	async (trigger) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-claude-lock-recovery-"));
		directories.push(directory);
		const path = join(directory, "auth.json");
		const storage = AuthStorage.create(path);
		storage.set("anthropic", {
			type: "oauth",
			access: "original-access",
			refresh: "original-refresh",
			expires: trigger === "expiry" ? 0 : Date.now() + 60_000,
		});
		const originalLock = lockfile.lock.bind(lockfile);
		let compromise: ((error: Error) => void) | undefined;
		const locks = vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			compromise = options?.onCompromised;
			return originalLock(file, options);
		});
		// Only the remote HTTP boundary is replaced. Registry lookup, Anthropic token
		// refresh, response parsing, key projection, file locking and persistence are real.
		const request = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input, init) => {
			expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(JSON.parse(String(init?.body))).toMatchObject({
				grant_type: "refresh_token",
				refresh_token: "original-refresh",
			});
			compromise?.(new Error("ownership lost after remote rotation"));
			return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
		});
		const result =
			trigger === "expiry"
				? await storage.getOAuthApiKey("anthropic")
				: await storage.recoverRejectedOAuthApiKey("anthropic", "original-access");
		expect(result).toBe("rotated-access");
		expect(request).toHaveBeenCalledTimes(1);
		expect(locks).toHaveBeenCalledTimes(2);
		expect(JSON.parse(readFileSync(path, "utf8")).anthropic).toMatchObject({
			type: "oauth",
			access: "rotated-access",
			refresh: "rotated-refresh",
		});
		expect(await AuthStorage.create(path).getOAuthApiKey("anthropic")).toBe("rotated-access");
		expect(request).toHaveBeenCalledTimes(1);
	},
);
