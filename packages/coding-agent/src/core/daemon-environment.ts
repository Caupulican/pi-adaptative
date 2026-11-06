/**
 * The environment the detached bot daemon starts with: an explicit baseline, never the starting session's whole
 * environment. The daemon serves every project of the agent directory, unattended, so nothing scoped to the shell or
 * project that happened to start it (a virtualenv, `npm run` paths, direnv variables, NODE_OPTIONS, an SSH agent socket,
 * git overrides) reaches it or the workers it runs. It keeps only:
 * - platform essentials (paths, user, locale, temp, Windows system variables), with PATH entries inside the starting
 *   session's project directory removed;
 * - pi's own `PI_*` configuration and launch variables, minus the starting session's identity (the daemon is nobody's
 *   child);
 * - the provider credentials the model layer reads: every API key variable `findEnvKeys` reports for a known provider,
 *   the ambient provider families the provider clients read (AWS, Google Cloud, Azure OpenAI, Cloudflare, Fugu, Kimi),
 *   and every variable the owner's global `auth.json`/`models.json` reference as `$NAME`;
 * - the secret-manager session the credential bootstrap reads;
 * - proxy and TLS trust settings: provider requests go through them, and without them every unattended run fails on a
 *   proxied network. A proxy already sees the same provider traffic from the foreground;
 * - gh's configuration location and host (`GH_CONFIG_DIR`, `GH_HOST`), which name no secret, so the CI source the
 *   daemon follows for a closed session finds the owner's gh sign-in.
 *
 * gh's tokens are not added to the daemon's environment (only an owner model or credential file referencing one as a
 * provider key keeps it, as for every provider key). A process environment is readable by every command the daemon's
 * workers start (`/proc/<pid>/environ` for the same user, whatever a shell strips), so the starting session writes
 * them once to the daemon's stdin instead (`daemonGhCredentialPayload`), and the daemon hands them only to the `gh`
 * processes its CI source runs. A keyring sign-in is not reachable away (no desktop bus is kept): such a source is
 * reported once on its routines as waiting for the session.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { findEnvKeys, getProviders } from "@caupulican/pi-ai";
import { isPathWithinScope } from "./autonomy/path-scope.ts";
import { HARNESS_LAUNCH_ENV_KEYS, RUNTIME_SUPERVISOR_ENV } from "./harness-environment.ts";
import {
	PI_ORCHESTRATION_AGENT_ID_ENV,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
} from "./process-identity.ts";
import { getConfigValueEnvVarNames } from "./resolve-config-value.ts";
import { PI_SESSION_ROLE_ENV } from "./session-role.ts";
import { PI_WORKTREE_LANE_ENV } from "./worktree-sync/lane-binding.ts";

/**
 * The starting process's session identity: the daemon serves the agent directory and is nobody's child. A runtime
 * supervisor marker is its generation's channel, which an inheriting process refuses at startup.
 */
const SESSION_IDENTITY = new Set<string>([
	RUNTIME_SUPERVISOR_ENV,
	PI_SESSION_ROLE_ENV,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_ORCHESTRATION_AGENT_ID_ENV,
	PI_TASK_REF_ENV,
	PI_WORKTREE_LANE_ENV,
]);

/** Compared upper-cased: Windows variable names are case-insensitive. */
const PLATFORM_NAMES = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"LANGUAGE",
	"TZ",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"PSMODULEPATH",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMW6432",
	"TEMP",
	"TMP",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"NUMBER_OF_PROCESSORS",
	"COMPUTERNAME",
	"USERNAME",
	"USERDOMAIN",
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
	"WSLENV",
	// The secret-manager session the credential bootstrap reads (credential-machine-session.ts).
	"BWS_ACCESS_TOKEN",
	"BW_SESSION",
	"BW_SESSION_FILE",
	// Proxy and TLS trust for provider requests.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	// How pi itself was launched (its package and TypeScript config); a supervised target sets them again.
	...HARNESS_LAUNCH_ENV_KEYS.map((name) => name.toUpperCase()),
	// gh's configuration directory and host; neither is a secret.
	"GH_CONFIG_DIR",
	"GH_HOST",
]);

/** gh's token variables: carried to the daemon on its stdin, never in its environment. */
export const GH_CREDENTIAL_NAMES: readonly string[] = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
];
/** Bound on the credential payload a daemon reads from its stdin. */
export const MAX_DAEMON_CREDENTIAL_BYTES = 64 * 1024;

/** The gh tokens of `source`, as the payload the starting session writes to the daemon's stdin. */
export function daemonGhCredentialPayload(source: NodeJS.ProcessEnv): string {
	const credentials: Record<string, string> = {};
	for (const name of GH_CREDENTIAL_NAMES) {
		const value = source[name];
		if (value) credentials[name] = value;
	}
	return JSON.stringify(credentials);
}

/**
 * The gh tokens a daemon read from its stdin: an empty payload (a starter that sent none) holds none. Throws on a
 * payload that is not the starter's object of gh token names.
 */
export function parseDaemonGhCredentials(text: string): Readonly<Record<string, string>> {
	if (text.trim() === "") return {};
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("the gh credential payload is not an object.");
	const credentials: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (!GH_CREDENTIAL_NAMES.includes(name) || typeof value !== "string" || value.length === 0)
			throw new Error(`the gh credential payload holds an unexpected entry (${name.slice(0, 64)}).`);
		credentials[name] = value;
	}
	return credentials;
}

const KEPT_PREFIXES = [
	"LC_",
	"XDG_",
	"PROGRAMFILES",
	"COMMONPROGRAMFILES",
	"PI_",
	// Ambient provider configuration the provider clients read (packages/ai providers).
	"AWS_",
	"GOOGLE_",
	"GCLOUD_",
	"AZURE_OPENAI_",
	"CLOUDFLARE_",
	"FUGU_",
	"KIMI_",
];

/** Bound on an owner config file read only for the variable names it references. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

function collectReferencedNames(value: unknown, names: Set<string>): void {
	if (typeof value === "string") {
		for (const name of getConfigValueEnvVarNames(value)) names.add(name.toUpperCase());
	} else if (Array.isArray(value)) {
		for (const entry of value) collectReferencedNames(entry, names);
	} else if (value !== null && typeof value === "object") {
		for (const entry of Object.values(value)) collectReferencedNames(entry, names);
	}
}

/**
 * Variables the owner's global credential and model files reference. A file that is absent, too large or not JSON
 * references nothing here; the daemon's own load of that file reports it.
 */
function ownerConfigReferencedNames(configFiles: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const file of configFiles) {
		let parsed: unknown;
		try {
			const text = readFileSync(file, "utf8");
			if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) continue;
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		collectReferencedNames(parsed, names);
	}
	return names;
}

/** Every API key variable `findEnvKeys` reports for a known provider, upper-cased. */
function providerKeyNames(): string[] {
	return getProviders()
		.flatMap((provider) => findEnvKeys(provider) ?? [])
		.map((name) => name.toUpperCase());
}

/**
 * PATH without the entries inside `projectDir`: a virtualenv or `node_modules/.bin` belongs to that project. A
 * directory holding the owner's home (the home itself, or above it) is no project: its entries are the owner's tools.
 */
function machinePath(value: string, projectDir: string): string {
	if (isPathWithinScope(homedir(), projectDir)) return value;
	return value
		.split(delimiter)
		.filter((entry) => entry.length > 0 && !isPathWithinScope(entry, projectDir))
		.join(delimiter);
}

/**
 * The variables a user service definition names for the daemon it starts at login (see `away-service.ts`). A unit,
 * plist or task file is plain text any process of the user can read, so it names no secret: only PATH without the
 * installing session's project entries, and gh's configuration location and host. Provider keys, secret-manager
 * sessions and gh tokens stay out; such a daemon reads its credentials from the owner's `auth.json`, gh's own stored
 * sign-in, or the service manager's own environment.
 */
export function daemonServiceEnvironment(source: NodeJS.ProcessEnv, projectDir: string): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (!value) continue;
		const upper = name.toUpperCase();
		if (upper === "PATH") environment.PATH = machinePath(value, projectDir);
		else if (upper === "GH_CONFIG_DIR" || upper === "GH_HOST") environment[upper] = value;
	}
	return environment;
}

/**
 * Names (never values) of the provider credentials `source` holds that a daemon started by a user service does not
 * get from its definition: every provider API key variable and every variable the owner's `auth.json`/`models.json`
 * reference, set in `source`.
 */
export function environmentOnlyCredentialNames(source: NodeJS.ProcessEnv, configFiles: readonly string[]): string[] {
	const wanted = new Set([...providerKeyNames(), ...ownerConfigReferencedNames(configFiles)]);
	return Object.entries(source)
		.filter(([name, value]) => Boolean(value) && wanted.has(name.toUpperCase()))
		.map(([name]) => name)
		.sort();
}

/**
 * The daemon's baseline environment from `source` (the starting process's environment). `projectDir` is the starting
 * session's directory; `configFiles` are the owner's global `auth.json` and `models.json`.
 */
export function daemonBaselineEnvironment(
	source: NodeJS.ProcessEnv,
	projectDir: string,
	configFiles: readonly string[],
): NodeJS.ProcessEnv {
	const providerKeys = new Set(providerKeyNames());
	const referenced = ownerConfigReferencedNames(configFiles);
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined || SESSION_IDENTITY.has(name)) continue;
		const upper = name.toUpperCase();
		if (upper === "PATH") {
			environment[name] = machinePath(value, projectDir);
			continue;
		}
		if (
			PLATFORM_NAMES.has(upper) ||
			providerKeys.has(upper) ||
			referenced.has(upper) ||
			KEPT_PREFIXES.some((prefix) => upper.startsWith(prefix))
		)
			environment[name] = value;
	}
	return environment;
}
