/**
 * A System One controller bound to live Jev, for scripts that measure or use Jev outside a session.
 * Needs a TypeSafe key (TYPESAFE_API_KEY or ~/.config/typesafe/.env) and network. Scripts importing
 * this run with `node --conditions=pi-source`, so workspace packages resolve to their sources, the
 * way tests resolve them, never to a stale gitignored dist.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TypeSafeReviewer } from "../packages/coding-agent/src/core/review/typesafe-reviewer.ts";
import { SystemOneJevAdapter } from "../packages/coding-agent/src/core/system-one/adapter.ts";
import { createSystemOneConfig } from "../packages/coding-agent/src/core/system-one/config.ts";
import { SystemOneController } from "../packages/coding-agent/src/core/system-one/controller.ts";
import { ExecutionStore } from "../packages/coding-agent/src/core/system-one/execution-state.ts";

export const repositoryRoot = resolve(import.meta.dirname, "..");
/** The Jev model live scripts evaluate with. */
export const JEV_LIVE_MODEL = "jev-1.13.0";

function readKey() {
	if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
	const envFile = join(homedir(), ".config", "typesafe", ".env");
	if (!existsSync(envFile)) return undefined;
	return /^TYPESAFE_API_KEY=(.*)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
}

/** The live controller, or exit 2 with a message naming the script when no key is configured. */
export function liveSystemOneController(scriptName) {
	const key = readKey();
	if (!key) {
		console.error(`${scriptName}: no TypeSafe key (TYPESAFE_API_KEY or ~/.config/typesafe/.env)`);
		process.exit(2);
	}
	const config = createSystemOneConfig({ enabled: true, provider: "typesafe", productionModel: JEV_LIVE_MODEL });
	const reviewer = new TypeSafeReviewer({ provider: "typesafe", model: JEV_LIVE_MODEL, getApiKey: async () => key });
	const adapter = new SystemOneJevAdapter(reviewer, config, { getApiKey: async () => key, getUserKeys: async () => [key] });
	const store = new ExecutionStore({
		run_id: scriptName,
		objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
		repo: { root: repositoryRoot, baseline_revision: "HEAD" },
	});
	return new SystemOneController({ store, adapter, config });
}
