import { describe, expect, it } from "vitest";
import { normalizeNativeProviderSelection } from "../src/core/collaboration/native-selection.ts";

describe("native launch and authentication selection identity", () => {
	it("extracts Pi provider/model exactly once before the native probe and preserves unrelated arguments", () => {
		const selection = normalizeNativeProviderSelection(
			"pi",
			["--provider", "openai-codex", "--model=gpt-6-astra", "--thinking", "ultra", "--provider=openai-codex"],
			{ provider: "openai-codex", executable: "/wrapper/pi" },
		);
		expect(selection).toEqual({
			selection: { provider: "openai-codex", model: "gpt-6-astra", executable: "/wrapper/pi" },
			args: ["--thinking", "ultra"],
		});
	});
	it.each([
		["--provider", "anthropic"],
		["--provider="],
		["--model"],
		["--model", "--thinking"],
		["--provider=openai-codex", "--provider=anthropic"],
	])("rejects conflicting or malformed Pi selector %j", (...args) => {
		expect(() => normalizeNativeProviderSelection("pi", args, { provider: "openai-codex" })).toThrow();
	});
	it.each([
		["codex", "--config", "model_provider=other"],
		["codex", "-cmodel_provider=other"],
		["codex", "-pprofile"],
		["codex", "--profile=other"],
		["codex", "--oss"],
		["codex", "--remote=ws://elsewhere"],
		["claude", "--settings", "different.json"],
		["claude", "--setting-sources=project"],
		["claude", "--bare"],
		["pi", "--api-key", "do-not-echo-secret"],
		["pi", "--models", "different"],
	])("refuses an unprobed authentication context for %s", (kind, ...args) => {
		expect(() => normalizeNativeProviderSelection(kind, args)).toThrow("authentication");
		try {
			normalizeNativeProviderSelection(kind, args);
		} catch (error) {
			expect(String(error)).not.toContain("do-not-echo-secret");
		}
	});
	it("keeps native model options for foreign providers and wrapper environments unchanged", () => {
		const env = { CLAUDE_CONFIG_DIR: "/other/login" };
		expect(normalizeNativeProviderSelection("claude", ["--model", "opus"], { env })).toEqual({
			selection: { env, model: "opus" },
			args: ["--model", "opus"],
		});
	});
	it.each(["claude", "codex", "agy"])(
		"honors structured models for %s and rejects conflicting raw models and non-Pi providers",
		(kind) => {
			expect(normalizeNativeProviderSelection(kind, [], { model: "chosen" }).args).toEqual(["--model", "chosen"]);
			expect(normalizeNativeProviderSelection(kind, ["--model=chosen"], { model: "chosen" }).args).toEqual([
				"--model",
				"chosen",
			]);
			expect(() => normalizeNativeProviderSelection(kind, ["--model", "other"], { model: "chosen" })).toThrow(
				"conflicts",
			);
			expect(() => normalizeNativeProviderSelection(kind, [], { provider: "unprobed" })).toThrow("only");
		},
	);
	it("recognizes Codex short model flags but never forwards its working-directory override after the probe", () => {
		expect(normalizeNativeProviderSelection("codex", ["-mchosen"]).args).toEqual(["--model", "chosen"]);
		expect(() => normalizeNativeProviderSelection("codex", ["-m", "other"], { model: "chosen" })).toThrow(
			"conflicts",
		);
		expect(() => normalizeNativeProviderSelection("codex", ["--cd=/other/project"])).toThrow("authentication");
	});
	it.each([
		["pi", "--mode", "rpc"],
		["pi", "--print"],
		["pi", "-p"],
		["claude", "--print"],
		["claude", "-phello"],
		["claude", "--background"],
		["agy", "--prompt", "hello"],
		["agy", "-p"],
		["codex", "exec", "hello"],
		["codex", "e", "hello"],
		["codex", "--model", "chosen", "exec", "hello"],
		["codex", "--search", "exec", "hello"],
	])("rejects noninteractive %s launch before any native probe", (kind, ...args) => {
		expect(() => normalizeNativeProviderSelection(kind, args)).toThrow("interactive");
	});
	it("distinguishes a native option value from the first Codex subcommand", () => {
		expect(normalizeNativeProviderSelection("codex", ["--add-dir", "exec", "--model", "exec"]).args).toEqual([
			"--add-dir",
			"exec",
			"--model",
			"exec",
		]);
		expect(() => normalizeNativeProviderSelection("codex", ["--add-dir", "exec", "exec", "hello"])).toThrow(
			"interactive",
		);
	});
});
