/**
 * Always-on routines away: the owner's user service that starts the detached bot daemon at login, so event routines
 * and the timed routines of closed sessions keep running after a reboot or logout with no session opened.
 *
 * The service runs `pi --bot-daemon <agentDir>` (see `bot-daemon.ts`): that form claims the daemon lease itself, and
 * exits at once while another daemon of the same or a newer build holds it. Each manager restarts it only after a
 * failure, so an owner's `/bot daemon stop` is respected until the next login. A session that finds a daemon of an
 * older build running restarts a current install through its manager ({@link AwayService.replaceDaemon}), so the
 * replacing daemon stays supervised; without one it launches the daemon detached.
 * - Linux: a `systemd --user` unit. Lingering is reported, never enabled: without it the service starts at login and
 *   stops at logout.
 * - macOS: a launchd user agent.
 * - Windows: a Task Scheduler task at the owner's logon, in the owner's context and without elevation. Its process
 *   launches the daemon detached and hidden, as a session does, and exits.
 *
 * A definition is plain text any process of the user can read, so it names no secret: only PATH (without the installing
 * session's project entries), gh's configuration location and host, and the self-launch variables of a source launch.
 * A daemon the service started has no gh token (a session hands those over on stdin): gh runs with its own stored
 * sign-in, and without one the event routines that need it wait for their session with the existing reason. Provider
 * keys set only in a shell environment are absent too; `status` names them.
 *
 * Installing changes the machine, so it happens only under `routines.away.autostart: "on"` or the explicit command.
 * The hands-off check reads the filesystem only: the install record (`state/away-service/record.json` in the agent directory) holds
 * the digest of the definition's identity (its command, path and principal), and a current record with its definition
 * file present means nothing is run. Only an install, an uninstall, the explicit `status` and the restart that replaces
 * a daemon of an older build run the service manager.
 */
import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { configFile, stateFile } from "../agent-paths.ts";
import { daemonServiceEnvironment, environmentOnlyCredentialNames } from "../daemon-environment.ts";
import { BOT_DAEMON_COMMAND } from "../delegation/bot-daemon-command.ts";
import {
	daemonLeasePath,
	isOlderDaemonBuild,
	OWN_DAEMON_BUILD,
	type PersistentBotDaemonStatus,
} from "../delegation/bot-team-routine-helpers.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { type ExecResult, execCommand } from "../exec.ts";
import type { HarnessNoticeObservation } from "../harness-notice.ts";
import { getStableSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import type { RoutineAwayAutostart } from "../settings/settings-schema.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export type AwayServicePlatform = "linux" | "darwin" | "win32";

/** One service definition: everything its render reads, so the render is a pure function of it. */
export interface AwayServiceSpec {
	readonly platform: AwayServicePlatform;
	readonly agentDir: string;
	/** The systemd unit's base name, the launchd label or the scheduled task's name. */
	readonly name: string;
	readonly definitionPath: string;
	/** The daemon's argv, executable first. */
	readonly command: readonly string[];
	readonly workingDirectory: string;
	/** Non-secret variables only (see `daemonServiceEnvironment`); a Windows task carries none. */
	readonly environment: Readonly<Record<string, string>>;
	/** The Windows task's principal and logon trigger user (`DOMAIN\user`). */
	readonly user?: string;
	/** The launchd domain's uid. */
	readonly uid?: number;
}

/** What the module reads from the machine; the process's own values outside a scripted host. */
export interface AwayServiceHost {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	readonly user: string;
	readonly uid?: number;
}

export function processAwayServiceHost(): AwayServiceHost {
	let user: string;
	try {
		user = userInfo().username;
	} catch {
		// No passwd entry for this uid (a container): the login name variables are the only record of the user.
		user = process.env.USER ?? process.env.USERNAME ?? process.env.LOGNAME ?? "";
	}
	const uid = process.getuid?.();
	return {
		platform: process.platform,
		env: process.env,
		home: homedir(),
		user,
		...(uid !== undefined ? { uid } : {}),
	};
}

export type AwayServiceResolution =
	| { readonly ok: true; readonly spec: AwayServiceSpec }
	| { readonly ok: false; readonly reason: string };

/** The unit, label and task name of `agentDir`: one service per agent directory, as one daemon serves it. */
export function awayServiceName(agentDir: string, separator: "-" | "."): string {
	const app = APP_NAME.replace(/[^A-Za-z0-9_-]/g, "-") || "pi";
	const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
	return [app, "routines", hash].join(separator);
}

const LINE_BREAK = /[\0\r\n]/;

/**
 * The service definition this machine would install for `agentDir`, or why none can be. `projectDir` is the installing
 * session's directory: its own PATH entries never reach the daemon.
 */
export function resolveAwayServiceSpec(
	agentDir: string,
	projectDir: string,
	host: AwayServiceHost = processAwayServiceHost(),
): AwayServiceResolution {
	const { platform } = host;
	if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
		return { ok: false, reason: `no user service manager is supported on ${platform}.` };
	if (!isAbsolute(agentDir)) return { ok: false, reason: "the agent directory is not an absolute path." };
	const target = getStableSelfLaunchTarget();
	if (!target) return { ok: false, reason: "this host has no stable pi launch target." };
	const command = [target.executable, ...target.argsPrefix, BOT_DAEMON_COMMAND, agentDir];
	const launchVariables = Object.entries(target.environment ?? {}).filter(([, value]) => value.length > 0);
	if (platform === "win32") {
		if (launchVariables.length > 0)
			return {
				ok: false,
				reason: `a scheduled task cannot carry this source launch's ${launchVariables.map(([name]) => name).join(" and ")}; install from a released build.`,
			};
		if (command.some((argument) => argument.includes("%") || LINE_BREAK.test(argument)))
			return {
				ok: false,
				reason:
					"Task Scheduler expands %NAME% in a task's command, and this launch command holds a % or a line break.",
			};
		const name = awayServiceName(agentDir, "-");
		const user =
			host.env.USERDOMAIN && host.env.USERNAME ? `${host.env.USERDOMAIN}\\${host.env.USERNAME}` : host.user;
		return {
			ok: true,
			spec: {
				platform,
				agentDir,
				name,
				definitionPath: join(agentDir, `${name}.xml`),
				command,
				workingDirectory: agentDir,
				environment: {},
				user,
			},
		};
	}
	const environment: Record<string, string> = { ...daemonServiceEnvironment(host.env, projectDir) };
	for (const [name, value] of launchVariables) environment[name] = value;
	if ([...command, ...Object.values(environment)].some((value) => LINE_BREAK.test(value)))
		return {
			ok: false,
			reason: "the launch command or its environment holds a line break, which no unit can carry.",
		};
	if (platform === "darwin") {
		if (host.uid === undefined) return { ok: false, reason: "this process has no uid for the launchd user domain." };
		const name = awayServiceName(agentDir, ".");
		return {
			ok: true,
			spec: {
				platform,
				agentDir,
				name,
				definitionPath: join(host.home, "Library", "LaunchAgents", `${name}.plist`),
				command,
				workingDirectory: agentDir,
				environment,
				uid: host.uid,
			},
		};
	}
	const configHome =
		host.env.XDG_CONFIG_HOME && isAbsolute(host.env.XDG_CONFIG_HOME)
			? host.env.XDG_CONFIG_HOME
			: join(host.home, ".config");
	const name = awayServiceName(agentDir, "-");
	return {
		ok: true,
		spec: {
			platform,
			agentDir,
			name,
			definitionPath: join(configHome, "systemd", "user", `${name}.service`),
			command,
			workingDirectory: agentDir,
			environment,
		},
	};
}

/** A systemd specifier is `%x` and a variable reference `$NAME` in ExecStart: both are written doubled. */
function systemdValue(value: string): string {
	return value.replace(/%/g, "%%");
}

function systemdQuoted(value: string, expandsVariables: boolean): string {
	const escaped = systemdValue(value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
	return `"${expandsVariables ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

function xmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** One argument as `CommandLineToArgvW` reads it back. */
function windowsArgument(argument: string): string {
	if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
	let quoted = '"';
	let backslashes = 0;
	for (const character of argument) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		quoted += character === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${character}`;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function description(spec: AwayServiceSpec): string {
	return `${APP_NAME} routines away for ${spec.agentDir}`;
}

/** The definition file's text: deterministic, every path absolute and quoted for its manager. */
export function renderAwayServiceDefinition(spec: AwayServiceSpec): string {
	if (spec.platform === "linux") {
		return [
			"[Unit]",
			`Description=${systemdValue(description(spec))}`,
			"",
			"[Service]",
			"Type=simple",
			`ExecStart=${spec.command.map((argument) => systemdQuoted(argument, true)).join(" ")}`,
			`WorkingDirectory=${systemdValue(spec.workingDirectory)}`,
			...Object.entries(spec.environment)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, value]) => `Environment=${systemdQuoted(`${name}=${value}`, false)}`),
			"Restart=on-failure",
			"RestartSec=30",
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
	}
	if (spec.platform === "darwin") {
		const string = (value: string) => `\t\t<string>${xmlText(value)}</string>`;
		return [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0">',
			"<dict>",
			"\t<key>Label</key>",
			`\t<string>${xmlText(spec.name)}</string>`,
			"\t<key>ProgramArguments</key>",
			"\t<array>",
			...spec.command.map(string),
			"\t</array>",
			"\t<key>WorkingDirectory</key>",
			`\t<string>${xmlText(spec.workingDirectory)}</string>`,
			"\t<key>EnvironmentVariables</key>",
			"\t<dict>",
			...Object.entries(spec.environment)
				.sort(([left], [right]) => left.localeCompare(right))
				.flatMap(([name, value]) => [`\t\t<key>${xmlText(name)}</key>`, string(value)]),
			"\t</dict>",
			"\t<key>RunAtLoad</key>",
			"\t<true/>",
			"\t<key>KeepAlive</key>",
			"\t<dict>",
			"\t\t<key>SuccessfulExit</key>",
			"\t\t<false/>",
			"\t</dict>",
			"\t<key>ThrottleInterval</key>",
			"\t<integer>30</integer>",
			"\t<key>ProcessType</key>",
			"\t<string>Background</string>",
			"</dict>",
			"</plist>",
			"",
		].join("\n");
	}
	const [executable = "", ...args] = spec.command;
	const user = xmlText(spec.user ?? "");
	return [
		'<?xml version="1.0" encoding="UTF-16"?>',
		'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		"  <RegistrationInfo>",
		`    <Description>${xmlText(description(spec))}</Description>`,
		"  </RegistrationInfo>",
		"  <Triggers>",
		"    <LogonTrigger>",
		"      <Enabled>true</Enabled>",
		`      <UserId>${user}</UserId>`,
		"    </LogonTrigger>",
		"  </Triggers>",
		"  <Principals>",
		'    <Principal id="Author">',
		`      <UserId>${user}</UserId>`,
		"      <LogonType>InteractiveToken</LogonType>",
		"      <RunLevel>LeastPrivilege</RunLevel>",
		"    </Principal>",
		"  </Principals>",
		"  <Settings>",
		"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
		"    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
		"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
		"    <StartWhenAvailable>true</StartWhenAvailable>",
		"    <AllowStartOnDemand>true</AllowStartOnDemand>",
		"    <Enabled>true</Enabled>",
		"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"    <RestartOnFailure>",
		"      <Interval>PT1M</Interval>",
		"      <Count>3</Count>",
		"    </RestartOnFailure>",
		"  </Settings>",
		'  <Actions Context="Author">',
		"    <Exec>",
		`      <Command>${xmlText(executable)}</Command>`,
		`      <Arguments>${xmlText(args.map(windowsArgument).join(" "))}</Arguments>`,
		`      <WorkingDirectory>${xmlText(spec.workingDirectory)}</WorkingDirectory>`,
		"    </Exec>",
		"  </Actions>",
		"</Task>",
		"",
	].join("\r\n");
}

/** The identity a current install must match: what the manager runs and where; the environment is refreshed by an install. */
export function awayServiceDigest(spec: AwayServiceSpec): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				spec.platform,
				spec.name,
				spec.definitionPath,
				spec.command,
				spec.workingDirectory,
				spec.user ?? "",
				spec.uid ?? "",
			]),
		)
		.digest("hex");
}

/** The agent directory's install record and the notice marker. */
export interface AwayServiceRecord {
	readonly version: 1;
	/** When the `notify` notice was kept for the owner; it is given once per agent directory. */
	readonly noticeToldAt?: number;
	readonly install?: {
		readonly platform: AwayServicePlatform;
		readonly name: string;
		readonly definitionPath: string;
		readonly digest: string;
		readonly installedAt: number;
	};
}

/** The install record: machine-written state, so it lives under `state/` (the agent root holds only user-authored files). */
export function awayServiceRecordPath(agentDir: string): string {
	return stateFile(agentDir, "away-service", "record.json");
}

/**
 * The record, or undefined when there is none. One that cannot be read is no record: the service then counts as not
 * installed (an install under `on` rewrites it idempotently) and the notice may be given again.
 */
export function readAwayServiceRecord(agentDir: string): AwayServiceRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(awayServiceRecordPath(agentDir), "utf8"));
	} catch {
		return undefined;
	}
	if (!isPlainRecord(parsed) || parsed.version !== 1) return undefined;
	const noticeToldAt = typeof parsed.noticeToldAt === "number" ? parsed.noticeToldAt : undefined;
	const install = isPlainRecord(parsed.install) ? parsed.install : undefined;
	const valid =
		install &&
		(install.platform === "linux" || install.platform === "darwin" || install.platform === "win32") &&
		typeof install.name === "string" &&
		typeof install.definitionPath === "string" &&
		typeof install.digest === "string" &&
		typeof install.installedAt === "number";
	return {
		version: 1,
		...(noticeToldAt !== undefined ? { noticeToldAt } : {}),
		...(valid
			? {
					install: {
						platform: install.platform as AwayServicePlatform,
						name: install.name as string,
						definitionPath: install.definitionPath as string,
						digest: install.digest as string,
						installedAt: install.installedAt as number,
					},
				}
			: {}),
	};
}

function writeAwayServiceRecord(agentDir: string, record: AwayServiceRecord): void {
	writeFileAtomicSync(awayServiceRecordPath(agentDir), `${JSON.stringify(record, null, 2)}\n`);
}

export function isAwayServiceCurrent(record: AwayServiceRecord | undefined, spec: AwayServiceSpec): boolean {
	return record?.install?.digest === awayServiceDigest(spec) && existsSync(spec.definitionPath);
}

const SYSTEMD_RUNTIME = "/run/systemd/system";
const LAUNCHCTL = "/bin/launchctl";

function schtasksPath(host: AwayServiceHost): string {
	return join(host.env.SystemRoot ?? host.env.SYSTEMROOT ?? "C:\\Windows", "System32", "schtasks.exe");
}

function isWsl(host: AwayServiceHost): boolean {
	return Boolean(host.env.WSL_DISTRO_NAME) || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
}

/** Why this machine's service manager cannot take the definition, read from the filesystem only; undefined when it can. */
export function awayServiceManagerAbsence(spec: AwayServiceSpec, host: AwayServiceHost): string | undefined {
	if (spec.platform === "linux") {
		if (existsSync(SYSTEMD_RUNTIME)) return undefined;
		return isWsl(host)
			? "systemd does not run in this WSL distribution: set `systemd=true` under `[boot]` in /etc/wsl.conf and restart the distribution (`wsl --shutdown`). A WSL distribution starts only when it is opened after Windows starts."
			: `systemd is not this machine's service manager (${SYSTEMD_RUNTIME} is absent), so no user service can be installed.`;
	}
	if (spec.platform === "darwin") return existsSync(LAUNCHCTL) ? undefined : `launchctl is missing at ${LAUNCHCTL}.`;
	const schtasks = schtasksPath(host);
	return existsSync(schtasks) ? undefined : `Task Scheduler's schtasks.exe is missing at ${schtasks}.`;
}

function lingerPath(host: AwayServiceHost): string {
	return `/var/lib/systemd/linger/${host.user}`;
}

interface ManagerCommand {
	readonly file: string;
	readonly args: readonly string[];
	/** A failure is reported, and the steps after it still run. */
	readonly tolerated?: boolean;
}

function systemctl(...args: string[]): ManagerCommand {
	return { file: "systemctl", args: ["--user", ...args] };
}

function unitName(spec: AwayServiceSpec): string {
	return `${spec.name}.service`;
}

function launchdDomain(spec: AwayServiceSpec): string {
	return `gui/${spec.uid ?? ""}`;
}

function installCommands(spec: AwayServiceSpec, host: AwayServiceHost, existed: boolean): ManagerCommand[] {
	if (spec.platform === "linux")
		return [systemctl("daemon-reload"), systemctl("enable", unitName(spec)), systemctl("restart", unitName(spec))];
	if (spec.platform === "darwin")
		return [
			...(existed
				? [{ file: LAUNCHCTL, args: ["bootout", `${launchdDomain(spec)}/${spec.name}`], tolerated: true }]
				: []),
			{ file: LAUNCHCTL, args: ["enable", `${launchdDomain(spec)}/${spec.name}`] },
			{ file: LAUNCHCTL, args: ["bootstrap", launchdDomain(spec), spec.definitionPath] },
		];
	const schtasks = schtasksPath(host);
	return [
		{ file: schtasks, args: ["/Create", "/TN", spec.name, "/XML", spec.definitionPath, "/F"] },
		{ file: schtasks, args: ["/Run", "/TN", spec.name] },
	];
}

function uninstallCommands(spec: AwayServiceSpec, host: AwayServiceHost): ManagerCommand[] {
	if (spec.platform === "linux") return [{ ...systemctl("disable", "--now", unitName(spec)), tolerated: true }];
	if (spec.platform === "darwin")
		return [{ file: LAUNCHCTL, args: ["bootout", `${launchdDomain(spec)}/${spec.name}`], tolerated: true }];
	return [{ file: schtasksPath(host), args: ["/Delete", "/TN", spec.name, "/F"], tolerated: true }];
}

const MANAGER_COMMAND_TIMEOUT_MS = 30_000;
/** How long an install waits for a daemon to hold the lease after the manager started it. */
const LEASE_WAIT_MS = 20_000;
const MAX_MANAGER_TEXT = 400;

function commandText(command: ManagerCommand): string {
	return [basename(command.file), ...command.args].join(" ");
}

function resultText(result: ExecResult): string {
	const text = (result.errorMessage ?? (result.stderr.trim() || result.stdout.trim())) || `exit code ${result.code}`;
	return text.length > MAX_MANAGER_TEXT ? `${text.slice(0, MAX_MANAGER_TEXT)}...` : text;
}

async function runManagerCommand(
	command: ManagerCommand,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<ExecResult> {
	try {
		return await execCommand(command.file, [...command.args], cwd, {
			timeout: MANAGER_COMMAND_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: "",
			code: 1,
			killed: false,
			stdoutTruncated: false,
			stderrTruncated: false,
			errorMessage: message,
		};
	}
}

export interface AwayServiceOutcome {
	readonly ok: boolean;
	readonly detail: string;
}

export interface AwayServiceManagerDeps {
	readonly store: PersistentBotTeamStore;
	readonly clock: TimerPort;
	readonly host: AwayServiceHost;
	readonly signal?: AbortSignal;
}

const REFUSAL = "Routines away cannot start at login:";

/** Waits for a daemon `accepts` to hold the lease: a watch on the lease directory, ended by the deadline. */
function awaitDaemonLease(
	deps: AwayServiceManagerDeps,
	accepts: (status: PersistentBotDaemonStatus) => boolean = (status) => status.running,
): Promise<PersistentBotDaemonStatus> {
	const { store, clock, signal } = deps;
	const read = () => store.getDaemonStatus(clock.now());
	const first = read();
	if (accepts(first)) return Promise.resolve(first);
	return new Promise((resolve) => {
		let watcher: FSWatcher | undefined;
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			watcher?.close();
			clock.clearTimeout(deadline);
			signal?.removeEventListener("abort", finish);
			resolve(read());
		};
		const deadline = clock.setTimeout(finish, LEASE_WAIT_MS);
		signal?.addEventListener("abort", finish, { once: true });
		const leaseFile = daemonLeasePath(store.getStoreFilePath());
		try {
			watcher = watch(dirname(leaseFile), { persistent: false }, (_event, filename) => {
				if (filename !== null && filename.toString() !== basename(leaseFile)) return;
				if (accepts(read())) finish();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
			});
		} catch {
			// No watch on this filesystem: the deadline still reads the lease once more and settles the wait.
			watcher = undefined;
		}
	});
}

function writeDefinition(spec: AwayServiceSpec): void {
	const text = renderAwayServiceDefinition(spec);
	if (spec.platform === "win32") {
		// Task Scheduler reads a task file as UTF-16; schtasks takes it and keeps its own copy, so no atomic swap is needed.
		mkdirSync(dirname(spec.definitionPath), { recursive: true });
		writeFileSync(spec.definitionPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
		return;
	}
	writeFileAtomicSync(spec.definitionPath, text);
}

/** Runs the manager's install commands in order: what failed, or undefined once every required one succeeded. */
async function runInstallCommands(
	spec: AwayServiceSpec,
	deps: AwayServiceManagerDeps,
	existed: boolean,
): Promise<string | undefined> {
	for (const command of installCommands(spec, deps.host, existed)) {
		if (deps.signal?.aborted) return "the install was stopped.";
		const result = await runManagerCommand(command, spec.workingDirectory, deps.signal);
		if (result.code !== 0 && !command.tolerated) return `\`${commandText(command)}\` failed: ${resultText(result)}`;
	}
	return undefined;
}

/**
 * Restarts a current install through its manager with the install's own commands (the definition is not rewritten),
 * so the service's daemon runs this machine's installed build under the manager: it claims the lease, replacing a
 * daemon of an older build. Succeeds once a daemon of `build` or a newer one holds the lease. Never rejects.
 */
async function restartAwayService(
	spec: AwayServiceSpec,
	deps: AwayServiceManagerDeps,
	build: string | undefined,
): Promise<AwayServiceOutcome> {
	try {
		const failed = await runInstallCommands(spec, deps, true);
		if (failed) return { ok: false, detail: `The always-on service was not restarted: ${failed}` };
		const lease = await awaitDaemonLease(
			deps,
			(status) => status.running && !isOlderDaemonBuild(status.build, build),
		);
		if (!lease.running || isOlderDaemonBuild(lease.build, build))
			return {
				ok: false,
				detail: `The always-on service restarted, but no daemon of build ${build ?? "unknown"} or newer held the routine lease within ${LEASE_WAIT_MS / 1000} s.`,
			};
		return {
			ok: true,
			detail: `The always-on service restarted; its daemon holds the routine lease (build ${lease.build ?? "unstamped"}).`,
		};
	} catch (error) {
		return {
			ok: false,
			detail: `The always-on service was not restarted: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Writes the definition, enables and starts it, records the install and waits for a daemon to hold the lease.
 * Idempotent: an install over a current one rewrites the same definition and restarts it. Never rejects.
 */
export async function installAwayService(
	spec: AwayServiceSpec,
	deps: AwayServiceManagerDeps,
): Promise<AwayServiceOutcome> {
	const absence = awayServiceManagerAbsence(spec, deps.host);
	if (absence) return { ok: false, detail: `${REFUSAL} ${absence}` };
	try {
		const existed = existsSync(spec.definitionPath);
		writeDefinition(spec);
		const failed = await runInstallCommands(spec, deps, existed);
		if (failed) return { ok: false, detail: `${REFUSAL} ${failed}` };
		const record = readAwayServiceRecord(spec.agentDir);
		writeAwayServiceRecord(spec.agentDir, {
			...record,
			version: 1,
			install: {
				platform: spec.platform,
				name: spec.name,
				definitionPath: spec.definitionPath,
				digest: awayServiceDigest(spec),
				installedAt: deps.clock.now(),
			},
		});
		const lease = await awaitDaemonLease(deps);
		if (!lease.running)
			return {
				ok: false,
				detail: `${REFUSAL} the service is installed at ${spec.definitionPath}, but no daemon held the routine lease within ${LEASE_WAIT_MS / 1000} s; \`/bot daemon service status\` shows why.`,
			};
		return {
			ok: true,
			detail: `Always-on routines installed at ${spec.definitionPath}; the daemon holds the routine lease${lease.pid !== undefined ? ` (pid ${lease.pid})` : ""}.`,
		};
	} catch (error) {
		return { ok: false, detail: `${REFUSAL} ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Disables and removes the service and its record; the notice marker is kept. Never rejects. */
export async function uninstallAwayService(
	spec: AwayServiceSpec,
	deps: AwayServiceManagerDeps,
): Promise<AwayServiceOutcome> {
	const problems: string[] = [];
	try {
		const record = readAwayServiceRecord(spec.agentDir);
		const installedPath = record?.install?.definitionPath ?? spec.definitionPath;
		if (!awayServiceManagerAbsence(spec, deps.host)) {
			for (const command of uninstallCommands(spec, deps.host)) {
				const result = await runManagerCommand(command, spec.workingDirectory, deps.signal);
				if (result.code !== 0) problems.push(`\`${commandText(command)}\`: ${resultText(result)}`);
			}
		}
		rmSync(installedPath, { force: true });
		if (spec.platform === "linux" && !awayServiceManagerAbsence(spec, deps.host)) {
			const reload = systemctl("daemon-reload");
			const result = await runManagerCommand(reload, spec.workingDirectory, deps.signal);
			if (result.code !== 0) problems.push(`\`${commandText(reload)}\`: ${resultText(result)}`);
		}
		writeAwayServiceRecord(spec.agentDir, {
			version: 1,
			...(record?.noticeToldAt !== undefined ? { noticeToldAt: record.noticeToldAt } : {}),
		});
	} catch (error) {
		return {
			ok: false,
			detail: `The always-on service was not removed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const running =
		spec.platform === "win32"
			? "A daemon the task launched keeps running until `/bot daemon stop`."
			: "A daemon the service ran stops with it; one a session started keeps running until `/bot daemon stop`.";
	return {
		ok: true,
		detail: `Always-on routines removed (${spec.definitionPath}). ${running}${problems.length ? ` Reported: ${problems.join("; ")}` : ""}`,
	};
}

/** The read-only view of the service: filesystem reads only, for `/bot daemon status` and the status snapshot. */
export interface AwayServiceInspection {
	readonly autostart: RoutineAwayAutostart;
	/** Why no service can be installed here; absent when one can. */
	readonly unavailable?: string;
	readonly installed: boolean;
	/** The record matches what this machine would install now. */
	readonly current: boolean;
	readonly definitionPath?: string;
	readonly installedAt?: number;
	/** Linux only: whether the owner's user manager lingers (runs without a login). */
	readonly lingering?: boolean;
	readonly lease: {
		readonly running: boolean;
		readonly pid?: number;
		/** Milliseconds since the holder last renewed, while one holds the lease. */
		readonly heartbeatAgeMs?: number;
	};
}

export function inspectAwayService(input: {
	readonly store: PersistentBotTeamStore;
	readonly projectDir: string;
	readonly clock: TimerPort;
	readonly autostart: RoutineAwayAutostart;
	readonly host?: AwayServiceHost;
}): AwayServiceInspection {
	const host = input.host ?? processAwayServiceHost();
	const agentDir = input.store.getAgentDir();
	const resolution = resolveAwayServiceSpec(agentDir, input.projectDir, host);
	const record = readAwayServiceRecord(agentDir);
	const now = input.clock.now();
	const status = input.store.getDaemonStatus(now);
	const unavailable = resolution.ok ? awayServiceManagerAbsence(resolution.spec, host) : resolution.reason;
	const definitionPath =
		record?.install?.definitionPath ?? (resolution.ok ? resolution.spec.definitionPath : undefined);
	return {
		autostart: input.autostart,
		...(unavailable !== undefined ? { unavailable } : {}),
		installed: record?.install !== undefined && existsSync(record.install.definitionPath),
		current: resolution.ok && isAwayServiceCurrent(record, resolution.spec),
		...(definitionPath !== undefined ? { definitionPath } : {}),
		...(record?.install ? { installedAt: record.install.installedAt } : {}),
		...(host.platform === "linux" ? { lingering: existsSync(lingerPath(host)) } : {}),
		lease: {
			running: status.running,
			...(status.pid !== undefined ? { pid: status.pid } : {}),
			...(status.running && status.lastHeartbeatAt !== undefined
				? { heartbeatAgeMs: Math.max(0, now - status.lastHeartbeatAt) }
				: {}),
		},
	};
}

/** One line for `/bot daemon status`. */
export function describeAwayServiceInspection(inspection: AwayServiceInspection): string {
	const mode = `routines.away.autostart is ${inspection.autostart}`;
	if (!inspection.installed)
		return inspection.unavailable
			? `Always-on: not installed (${mode}); it cannot be installed here: ${inspection.unavailable}`
			: `Always-on: not installed (${mode}); \`/bot daemon service install\` installs it.`;
	const linger = inspection.lingering === false ? " Lingering is off: the service runs from login to logout." : "";
	return `Always-on: installed at ${inspection.definitionPath}${inspection.current ? "" : " (an older definition; the next install replaces it)"} (${mode}).${linger}`;
}

function keyValues(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const index = line.indexOf("=");
		if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
	}
	return values;
}

function ageText(ms: number): string {
	return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/** The explicit status: the inspection plus the manager's own state, and why an installed service runs no daemon. */
export async function awayServiceStatus(
	inspection: AwayServiceInspection,
	spec: AwayServiceSpec | undefined,
	deps: AwayServiceManagerDeps,
): Promise<string[]> {
	const lines = [describeAwayServiceInspection(inspection)];
	const { lease } = inspection;
	lines.push(
		lease.running
			? `Routine lease: held${lease.pid !== undefined ? ` by pid ${lease.pid}` : ""}${lease.heartbeatAgeMs !== undefined ? `, renewed ${ageText(lease.heartbeatAgeMs)} ago` : ", starting"}.`
			: "Routine lease: no daemon holds it.",
	);
	if (spec && inspection.installed && !inspection.unavailable) {
		let managerState: string | undefined;
		let why: string | undefined;
		if (spec.platform === "linux") {
			const command = systemctl(
				"show",
				unitName(spec),
				"--property=LoadState,UnitFileState,ActiveState,SubState,Result,ExecMainStatus",
			);
			const result = await runManagerCommand(command, spec.workingDirectory, deps.signal);
			if (result.code === 0) {
				const values = keyValues(result.stdout);
				managerState = `systemd: ${values.get("UnitFileState") ?? "unknown"}, ${values.get("ActiveState") ?? "unknown"} (${values.get("SubState") ?? "unknown"})`;
				if (values.get("ActiveState") === "failed")
					why = `the service failed (${values.get("Result") ?? "unknown"}, exit status ${values.get("ExecMainStatus") ?? "unknown"}); \`journalctl --user -u ${unitName(spec)}\` shows its output.`;
				else if (values.get("ActiveState") === "inactive")
					why =
						"the service's daemon exited normally: another daemon held the lease, a session of a newer build replaced it, or `/bot daemon stop` released it. It starts again at the next login or service start.";
			} else managerState = `systemd did not answer: ${resultText(result)}`;
		} else if (spec.platform === "darwin") {
			const command = { file: LAUNCHCTL, args: ["print", `${launchdDomain(spec)}/${spec.name}`] };
			const result = await runManagerCommand(command, spec.workingDirectory, deps.signal);
			if (result.code === 0) {
				const state = /\bstate = (\S+)/.exec(result.stdout)?.[1] ?? "unknown";
				const lastExit = /\blast exit code = ([^\n]+)/.exec(result.stdout)?.[1]?.trim();
				managerState = `launchd: loaded, ${state}${lastExit ? `, last exit ${lastExit}` : ""}`;
				if (state !== "running")
					why =
						"the agent's daemon is not running: another daemon held the lease, a session of a newer build replaced it, `/bot daemon stop` released it, or it failed (its last exit says which).";
			} else managerState = "launchd: the agent is not loaded; it loads at the next login";
		} else {
			const command = { file: schtasksPath(deps.host), args: ["/Query", "/TN", spec.name] };
			const result = await runManagerCommand(command, spec.workingDirectory, deps.signal);
			managerState =
				result.code === 0
					? "Task Scheduler: the task is registered; it launches the daemon at logon and exits"
					: `Task Scheduler: the task is not registered (${resultText(result)})`;
			why = "the task launches the daemon only at logon; a session start or `/bot daemon start` launches it now.";
		}
		lines.push(`${managerState}.`);
		if (!lease.running && why) lines.push(`Why no daemon runs: ${why}`);
	}
	const shellOnly = environmentOnlyCredentialNames(deps.host.env, [
		configFile(deps.store.getAgentDir(), "auth.json"),
		configFile(deps.store.getAgentDir(), "models.json"),
	]);
	if (shellOnly.length > 0)
		lines.push(
			`A daemon the service starts does not get these variables from this shell: ${shellOnly.join(", ")}. Keep those credentials in auth.json for routines away after a reboot.`,
		);
	lines.push(
		"gh: a daemon the service starts uses gh's own stored sign-in; without one, event routines that need GitHub wait for their session.",
	);
	return lines;
}

const NOTICE_AVAILABLE =
	'Routines and channels served while no session is open keep running after reboot only if you enable always-on: set `routines.away.autostart` to "on" in your global settings, or run `/bot daemon service install`.';

export interface AwayServiceDeps {
	readonly store: () => PersistentBotTeamStore;
	/** The session's directory: its own PATH entries never reach a service definition. */
	readonly projectDir: () => string;
	readonly clock: TimerPort;
	readonly autostart: () => RoutineAwayAutostart;
	/** Keeps one owner notice (`routine-away-service`); true when the owner is told. */
	readonly observeNotice: (read: () => HarnessNoticeObservation | undefined) => boolean;
	readonly warn: (message: string) => void;
	readonly host?: AwayServiceHost;
}

/**
 * The session runtime's owner of the always-on service: the hands-off reconcile at session start and routine save,
 * the restart that replaces a daemon of an older build under the manager, and the explicit install, uninstall, status
 * and inspection. One manager operation runs at a time; `close` stops and joins it.
 */
export class AwayService {
	private readonly deps: AwayServiceDeps;
	private readonly abort = new AbortController();
	private managing: Promise<AwayServiceOutcome> | undefined;
	/** The identity whose hands-off install was refused or failed in this runtime: reported once, never retried. */
	private refused: string | undefined;
	/** The install whose restart for a replacement failed in this runtime: later replacements launch detached. */
	private restartFailed: string | undefined;
	private closed = false;

	constructor(deps: AwayServiceDeps) {
		this.deps = deps;
	}

	private host(): AwayServiceHost {
		return this.deps.host ?? processAwayServiceHost();
	}

	private managerDeps(): AwayServiceManagerDeps {
		return { store: this.deps.store(), clock: this.deps.clock, host: this.host(), signal: this.abort.signal };
	}

	/**
	 * Applies `routines.away.autostart` while the daemon has work (`awayWork`: enabled routines plus channels served
	 * while no session is open): `notify` gives its notice once per agent directory, `on` installs a service that is
	 * missing or not current, `off` does nothing. Filesystem reads only, unless an install is due.
	 */
	reconcile(awayWork: number): void {
		if (this.closed || awayWork === 0) return;
		const mode = this.deps.autostart();
		if (mode === "off") return;
		const host = this.host();
		const agentDir = this.deps.store().getAgentDir();
		const resolution = resolveAwayServiceSpec(agentDir, this.deps.projectDir(), host);
		const record = readAwayServiceRecord(agentDir);
		if (resolution.ok && isAwayServiceCurrent(record, resolution.spec)) return;
		const unavailable = resolution.ok ? awayServiceManagerAbsence(resolution.spec, host) : resolution.reason;
		if (mode === "notify") {
			if (record?.noticeToldAt !== undefined) return;
			const told = this.deps.observeNotice(() =>
				unavailable === undefined
					? { reason: "always-on-available", text: NOTICE_AVAILABLE }
					: {
							reason: "always-on-unavailable",
							text: `Routines of closed sessions and channels served while no session is open stop at reboot, and always-on cannot be enabled here: ${unavailable}`,
						},
			);
			if (told) writeAwayServiceRecord(agentDir, { ...record, version: 1, noticeToldAt: this.deps.clock.now() });
			return;
		}
		if (this.managing) return;
		const key = resolution.ok ? awayServiceDigest(resolution.spec) : `unresolved:${resolution.reason}`;
		if (this.refused === key) return;
		if (!resolution.ok || unavailable !== undefined) {
			this.refused = key;
			this.deps.warn(`${REFUSAL} ${unavailable}`);
			return;
		}
		void this.runInstall(resolution.spec).then((outcome) => {
			if (outcome.ok || this.closed) return;
			this.refused = key;
			this.deps.warn(outcome.detail);
		});
	}

	/** One manager operation (an install or a restart) at a time; `close` joins it. */
	private track(operation: Promise<AwayServiceOutcome>): Promise<AwayServiceOutcome> {
		const running = operation.finally(() => {
			if (this.managing === running) this.managing = undefined;
		});
		this.managing = running;
		return running;
	}

	private runInstall(spec: AwayServiceSpec): Promise<AwayServiceOutcome> {
		return this.track(installAwayService(spec, this.managerDeps()));
	}

	/**
	 * Replaces a running daemon of an older build through the installed service, so this machine's installed build runs
	 * under the manager: only while the install is current and its manager is present, and not again in this runtime
	 * after a restart for the same install failed. False when the service cannot take it (the caller launches the
	 * daemon detached); `fallback` runs, once, with why a restart did not bring a daemon of this build up. An install or
	 * restart in flight already restarts the service, so it is joined (true).
	 */
	replaceDaemon(fallback: (reason: string) => void): boolean {
		if (this.closed) return false;
		if (this.managing) return true;
		const host = this.host();
		const resolution = this.resolve();
		if (
			!resolution.ok ||
			!isAwayServiceCurrent(readAwayServiceRecord(resolution.spec.agentDir), resolution.spec) ||
			awayServiceManagerAbsence(resolution.spec, host) !== undefined
		)
			return false;
		const key = awayServiceDigest(resolution.spec);
		if (this.restartFailed === key) return false;
		void this.track(restartAwayService(resolution.spec, this.managerDeps(), OWN_DAEMON_BUILD)).then((outcome) => {
			if (outcome.ok || this.closed) return;
			this.restartFailed = key;
			fallback(outcome.detail);
		});
		return true;
	}

	private resolve(): AwayServiceResolution {
		return resolveAwayServiceSpec(this.deps.store().getAgentDir(), this.deps.projectDir(), this.host());
	}

	/** The explicit install: whatever `routines.away.autostart` says. */
	async install(): Promise<AwayServiceOutcome> {
		if (this.closed) return { ok: false, detail: `${REFUSAL} this session is closing.` };
		const resolution = this.resolve();
		if (!resolution.ok) return { ok: false, detail: `${REFUSAL} ${resolution.reason}` };
		await this.managing;
		const outcome = await this.runInstall(resolution.spec);
		if (outcome.ok) this.refused = undefined;
		return outcome;
	}

	async uninstall(): Promise<AwayServiceOutcome> {
		const resolution = this.resolve();
		if (!resolution.ok) return { ok: false, detail: `No always-on service applies here: ${resolution.reason}` };
		await this.managing;
		return uninstallAwayService(resolution.spec, this.managerDeps());
	}

	inspect(): AwayServiceInspection {
		return inspectAwayService({
			store: this.deps.store(),
			projectDir: this.deps.projectDir(),
			clock: this.deps.clock,
			autostart: this.deps.autostart(),
			host: this.host(),
		});
	}

	async status(): Promise<string[]> {
		const resolution = this.resolve();
		return awayServiceStatus(this.inspect(), resolution.ok ? resolution.spec : undefined, this.managerDeps());
	}

	/** Stops an install or restart in flight (its manager command is aborted) and joins it. */
	async close(): Promise<void> {
		this.closed = true;
		this.abort.abort();
		await this.managing;
	}
}
