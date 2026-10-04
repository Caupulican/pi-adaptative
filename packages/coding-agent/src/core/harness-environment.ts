import { RUNTIME_SUPERVISOR_ENV } from "../cli/runtime-channel.ts";
import { CHAT_CREDENTIAL_ENV } from "./chat/constants.ts";

/**
 * Variables the runtime supervisor injects into pi's own process so the generation it launched
 * resolves its assets and TypeScript config. They describe pi's launch, not the operator's shell:
 * a tool command that inherits them resolves the harness's installed generation instead of the
 * checkout it is working in (a vitest run inside pi loaded themes from the wrong tree and turned a
 * green suite red).
 *
 * Deliberately NOT listed (decision): the worker confinement variables `PI_WORKER_EXTENSION_TOOLS`,
 * `PI_WORKER_ALLOWED_PATHS` and `PI_WORKER_READABLE_FILES`, like `PI_SESSION_ROLE`. They are the
 * worker's confinement, not its launch: a nested `pi` started from a worker's shell must inherit them so
 * it keeps the same grants (an empty path allow-list means host-wide project access, so dropping them
 * would WIDEN the nested worker). Checked for harm to non-pi tool commands: only pi's own parsers read
 * them (`worker-session-private-scope.ts`, `worker-extension-grants.ts`), they hold absolute paths and
 * tool names and no secret, and no other program consults a `PI_WORKER_*` name. Secrets belong in
 * `SESSION_SECRET_ENV_KEYS`, never here; add a variable to either list only when code shows it harms a
 * tool command or carries a secret.
 */
export const HARNESS_LAUNCH_ENV_KEYS: readonly string[] = Object.freeze([
	"PI_PACKAGE_DIR",
	"TSX_TSCONFIG_PATH",
	RUNTIME_SUPERVISOR_ENV,
]);

/**
 * Session secrets pi exports to its own child processes. A tool command never inherits them: its output
 * reaches the transcript, so a secret in its environment would be one `env` away from the model.
 */
const SESSION_SECRET_ENV_KEYS: readonly string[] = Object.freeze([CHAT_CREDENTIAL_ENV]);

/**
 * A worker-role process drops the session secrets it inherited from its master: it never joins the mesh
 * that credential belongs to, and its own process environment is otherwise one `env` away from a command.
 */
export function dropSessionSecretsFromProcess(env: NodeJS.ProcessEnv = process.env): void {
	for (const key of Object.keys(env)) {
		if (SESSION_SECRET_ENV_KEYS.some((secret) => secret.toUpperCase() === key.toUpperCase())) delete env[key];
	}
}

/** True when this process was launched by the runtime supervisor (the keys above are its). */
export function isSupervisedLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[RUNTIME_SUPERVISOR_ENV];
	return typeof value === "string" && value.length > 0;
}

/**
 * The environment a tool command inherits: the operator's shell without pi's launch variables and
 * without pi's session secrets. Unsupervised launches keep the launch variables — an operator who set
 * `PI_PACKAGE_DIR` for a Nix-style install did so on purpose, and nothing marks it as pi's own.
 */
export function withoutHarnessLaunchEnv<T extends Record<string, string | undefined>>(env: T): T {
	const removed = new Set(SESSION_SECRET_ENV_KEYS.map((key) => key.toUpperCase()));
	if (isSupervisedLaunch(env)) for (const key of HARNESS_LAUNCH_ENV_KEYS) removed.add(key.toUpperCase());
	if (!Object.keys(env).some((key) => removed.has(key.toUpperCase()))) return env;
	const copy: Record<string, string | undefined> = { ...env };
	for (const key of Object.keys(copy)) if (removed.has(key.toUpperCase())) delete copy[key];
	return copy as T;
}
