// @isolated: spies on process-wide console diagnostics while resolving CLI model patterns.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveModelScope } from "../src/core/model-resolver.ts";
import { resolveRouterCandidatePool } from "../src/core/model-router/candidate-pool.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main.ts";
import { tempDir } from "./temp-dir.ts";

describe("CLI router scope preservation", () => {
	it.each(["cli", "settings", "empty", "unspecified"] as const)(
		"preserves %s scope without expanding to unrelated favorites",
		async (scope) => {
			const cwd = tempDir("pi-cli-router-scope-");
			const settings = SettingsManager.create(cwd, join(cwd, "agent"));
			const auth = AuthStorage.inMemory();
			auth.setRuntimeApiKey("anthropic", "test-key");
			const registry = ModelRegistry.create(auth, join(cwd, "models.json"));
			settings.toggleModelFavorite("anthropic", "claude-haiku-4-5");
			if (scope === "settings") settings.setEnabledModels(["missing-provider/unavailable-model"]);
			if (scope === "empty") settings.setEnabledModels([]);
			const parsed = parseArgs(scope === "cli" ? ["--models", "missing-provider/unavailable-model"] : []);
			const patterns = parsed.models ?? settings.getEnabledModels();
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const resolved = patterns?.length ? await resolveModelScope(patterns, registry) : [];
				expect(resolved).toEqual([]);
				const { options } = buildSessionOptions(parsed, resolved, false, registry, settings, cwd);
				const pool = resolveRouterCandidatePool(
					options.routerPool
						? { source: options.routerPool.source, models: options.routerPool.models.map((entry) => entry.model) }
						: undefined,
					registry,
					{ favorites: settings.getModelFavorites() },
				);
				if (scope === "unspecified") {
					expect(pool.customized).toBe(false);
					expect(pool.models.map((model) => model.id)).toEqual(["claude-haiku-4-5"]);
				} else {
					expect(pool.customized).toBe(true);
					expect(pool.source).toBe(scope === "cli" ? "cli_models" : "enabled_models");
					expect(pool.models).toEqual([]);
				}
			} finally {
				warning.mockRestore();
			}
		},
	);
});
