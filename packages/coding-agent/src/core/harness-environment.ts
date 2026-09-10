import { RUNTIME_SUPERVISOR_ENV } from "../cli/runtime-channel.ts";

/**
 * Variables the runtime supervisor injects into pi's own process so the generation it launched
 * resolves its assets and TypeScript config. They describe pi's launch, not the operator's shell:
 * a tool command that inherits them resolves the harness's installed generation instead of the
 * checkout it is working in (a vitest run inside pi loaded themes from the wrong tree and turned a
 * green suite red).
 */
export const HARNESS_LAUNCH_ENV_KEYS: readonly string[] = Object.freeze([
	"PI_PACKAGE_DIR",
	"TSX_TSCONFIG_PATH",
	RUNTIME_SUPERVISOR_ENV,
]);

/** True when this process was launched by the runtime supervisor (the keys above are its). */
export function isSupervisedLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[RUNTIME_SUPERVISOR_ENV];
	return typeof value === "string" && value.length > 0;
}

/**
 * The environment a tool command inherits: the operator's shell without pi's launch variables.
 * Unsupervised launches keep them — an operator who set `PI_PACKAGE_DIR` for a Nix-style install
 * did so on purpose, and nothing marks it as pi's own.
 */
export function withoutHarnessLaunchEnv<T extends Record<string, string | undefined>>(env: T): T {
	if (!isSupervisedLaunch(env)) return env;
	const copy: Record<string, string | undefined> = { ...env };
	const launchKeys = new Set(HARNESS_LAUNCH_ENV_KEYS.map((key) => key.toUpperCase()));
	for (const key of Object.keys(copy)) if (launchKeys.has(key.toUpperCase())) delete copy[key];
	return copy as T;
}
