/**
 * The environment the detached bot daemon starts with: an explicit baseline, never the starting session's whole
 * environment. The daemon serves every project of the agent directory, unattended, so nothing scoped to the shell or
 * project that happened to start it (a virtualenv, `npm run` paths, direnv variables, NODE_OPTIONS, an SSH agent socket,
 * git overrides) reaches it or the workers it runs. It keeps only:
 * - platform essentials (paths, user, locale, temp, Windows system variables), with PATH entries inside the starting
 *   session's project directory removed;
 * - pi's own `PI_*` configuration, minus the starting session's identity (the daemon is nobody's child);
 * - the provider credentials the model layer reads: every API key variable `findEnvKeys` reports for a known provider,
 *   the ambient provider families the provider clients read (AWS, Google Cloud, Azure OpenAI, Cloudflare, Fugu, Kimi),
 *   and every variable the owner's global `auth.json`/`models.json` reference as `$NAME`;
 * - the secret-manager session the credential bootstrap reads;
 * - proxy and TLS trust settings: provider requests go through them, and without them every unattended run fails on a
 *   proxied network. A proxy already sees the same provider traffic from the foreground.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { findEnvKeys, getProviders } from "@caupulican/pi-ai";
import { isPathWithinScope } from "./autonomy/path-scope.ts";
import {
	PI_ORCHESTRATION_AGENT_ID_ENV,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
} from "./process-identity.ts";
import { getConfigValueEnvVarNames } from "./resolve-config-value.ts";
import { PI_SESSION_ROLE_ENV } from "./session-role.ts";
import { PI_WORKTREE_LANE_ENV } from "./worktree-sync/lane-binding.ts";

/** The starting process's session identity: the daemon serves the agent directory and is nobody's child. */
const SESSION_IDENTITY = new Set<string>([
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
]);

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
 * The daemon's baseline environment from `source` (the starting process's environment). `projectDir` is the starting
 * session's directory; `configFiles` are the owner's global `auth.json` and `models.json`.
 */
export function daemonBaselineEnvironment(
	source: NodeJS.ProcessEnv,
	projectDir: string,
	configFiles: readonly string[],
): NodeJS.ProcessEnv {
	const providerKeys = new Set(
		getProviders()
			.flatMap((provider) => findEnvKeys(provider) ?? [])
			.map((name) => name.toUpperCase()),
	);
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
