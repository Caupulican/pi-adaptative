import { join } from "node:path";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { APP_NAME } from "../../../../src/config.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import type { OrchestrationProfile } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import {
	type AwayServiceSpec,
	awayServiceName,
	awayServiceRecordPath,
	processAwayServiceHost,
	renderAwayServiceDefinition,
	resolveAwayServiceSpec,
} from "../../../../src/core/routines/away-service.ts";
import type { RoutineAwayAutostart } from "../../../../src/core/settings/settings-schema.ts";
import type { SessionManager } from "../../../../src/kernel/node.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import { createBarrier } from "../scripted-provider.ts";
import {
	HARNESS_PROJECT_CWD,
	type HarnessServiceManagerAnswer,
	type HarnessWorld,
	withDeadline,
} from "../session-fixture.ts";

const REFUSAL = /^Routines away cannot start at login: /;

/**
 * Always-on routines away (`routines.away.autostart`): the user service definitions render exactly for each platform;
 * `on` with no service manager is refused once and not retried; `notify` tells the owner once per agent directory and
 * runs nothing; `on` with the manager present installs at session start with exactly the manager's commands in order,
 * and a later save finds it current and runs none.
 */
export async function runJourney1AwayService(world: HarnessWorld, profile: OrchestrationProfile): Promise<void> {
	renderWitness();
	const onDir = `${world.agentDir}-away-service-on`;
	const notifyDir = `${world.agentDir}-away-service-notify`;
	for (const agentDir of [onDir, notifyDir])
		new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
			profile,
			"global",
		);
	const host = processAwayServiceHost();
	const at = () => world.timers.port("routines").now() + 86_400_000;
	const open = (agentDir: string, autostart: RoutineAwayAutostart) =>
		world.createRootSession("root", {
			agentDir,
			sessionManager: flushedSessionManager(world, agentDir),
			systemOneEnabled: false,
			settings: {
				memorySystem: "okf",
				autoLearn: { enabled: false },
				proactivity: { enabled: false },
				routines: { away: { autostart } },
			},
		});
	const save = async (session: Awaited<ReturnType<typeof open>>["session"], routineId: string) => {
		const saved = await session.backgroundLanes.createRoutine({
			routineId,
			prompt: "Look over the open review notes and summarize them.",
			schedule: { kind: "once", at: at() },
			profileId: profile.profileId,
		});
		expect(saved.routineId).toBe(routineId);
	};
	const refusals = () => world.warnings.filter((warning) => REFUSAL.test(warning));
	const managerCalls = () => world.processes.serviceManagerCalls.length;
	const managerMarker =
		host.platform === "win32"
			? join(host.env.SystemRoot ?? host.env.SYSTEMROOT ?? "C:\\Windows", "System32", "schtasks.exe")
			: "/run/systemd/system";

	// `on` with no service manager on the machine: the save that needs the service is refused once, with its reason;
	// the next save neither retries nor repeats it, and no manager command runs.
	const refusedBefore = refusals().length;
	const refused = await open(onDir, "on");
	await save(refused.session, "away-service-first");
	expect(refusals().slice(refusedBefore), "the missing manager is reported once").toHaveLength(1);
	await save(refused.session, "away-service-second");
	expect(refusals().slice(refusedBefore), "a later save does not retry or repeat it").toHaveLength(1);
	expect(managerCalls(), "nothing runs without a manager").toBe(0);
	expect(await world.disposeSessionInBody(refused.session)).toBeUndefined();

	if (host.platform === "win32") world.io.seed(managerMarker, "");
	else world.io.mkdirSync(managerMarker, { recursive: true });
	try {
		// `notify`: one owner notice, given once per agent directory, and nothing is installed.
		const told = await open(notifyDir, "notify");
		const notices = () =>
			told.sessionManager.getEntries().filter((entry) => {
				const details = parentInputOriginalDetails(entry);
				return (
					entry.type === "custom_message" &&
					entry.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
					typeof details === "object" &&
					details !== null &&
					"kind" in details &&
					details.kind === "routine-away-service"
				);
			});
		const noticed = createBarrier();
		const stopObserving = told.sessionManager.onEntriesPersisted(() => {
			if (notices().length > 0) noticed.release();
		});
		try {
			await save(told.session, "away-service-notified");
			await withDeadline(world.trace, "the always-on notice is saved", noticed.promise);
		} finally {
			stopObserving();
		}
		const noticeText =
			'Routines and channels served while no session is open keep running after reboot only if you enable always-on: set `routines.away.autostart` to "on" in your global settings, or run `/bot daemon service install`.';
		expect(JSON.stringify(notices()[0]), "the notice says how to enable always-on").toContain(
			JSON.stringify(noticeText).slice(1, -1),
		);
		const record = () => JSON.parse(world.io.peekFile(awayServiceRecordPath(notifyDir)) ?? "{}");
		expect(record().noticeToldAt, "the notice is marked for the agent directory").toEqual(expect.any(Number));
		expect(record().install, "notify installs nothing").toBeUndefined();
		await save(told.session, "away-service-notified-again");
		expect(notices(), "a later save repeats no notice").toHaveLength(1);
		expect(managerCalls(), "notify runs no manager command").toBe(0);
		expect(await world.disposeSessionInBody(told.session)).toBeUndefined();

		// `on` with the manager present: the session start installs, with exactly the manager's commands in order.
		const resolution = resolveAwayServiceSpec(onDir, HARNESS_PROJECT_CWD, host);
		if (!resolution.ok) throw new Error(`The harness host resolves no service definition: ${resolution.reason}`);
		const { spec } = resolution;
		const expected: HarnessServiceManagerAnswer[] =
			host.platform === "win32"
				? [
						{
							file: managerMarker,
							args: ["/Create", "/TN", spec.name, "/XML", spec.definitionPath, "/F"],
							code: 0,
						},
						{ file: managerMarker, args: ["/Run", "/TN", spec.name], code: 0 },
					]
				: [
						{ file: "systemctl", args: ["--user", "daemon-reload"], code: 0 },
						{ file: "systemctl", args: ["--user", "enable", `${spec.name}.service`], code: 0 },
						{ file: "systemctl", args: ["--user", "restart", `${spec.name}.service`], code: 0 },
					];
		const answered = world.processes.scriptServiceManager(expected);
		const recordPath = awayServiceRecordPath(onDir);
		const installed = world.io.waitForMutation(() => world.io.peekFile(recordPath)?.includes('"install"') === true);
		const installer = await open(onDir, "on");
		await withDeadline(world.trace, "the manager ran every install command", answered);
		await withDeadline(world.trace, "the install is recorded", installed);
		expect(world.processes.serviceManagerCalls).toEqual(expected.map(({ file, args }) => ({ file, args })));
		const rendered = renderAwayServiceDefinition(spec);
		expect(world.io.peekFile(spec.definitionPath), "the definition written is the render").toBe(
			host.platform === "win32"
				? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rendered, "utf16le")]).toString()
				: rendered,
		);
		const inspection = installer.session.backgroundLanes.getAwayService().inspect();
		expect(inspection).toMatchObject({ autostart: "on", installed: true, current: true });
		expect(inspection.unavailable).toBeUndefined();
		expect(inspection.lease.running, "the routine lease is held, which the install waited for").toBe(true);
		// Idempotent: the next save finds the install current and runs no manager command (one would be unscripted).
		await save(installer.session, "away-service-installed");
		expect(managerCalls()).toBe(expected.length);
		expect(refusals().slice(refusedBefore), "the install is not refused").toHaveLength(1);
		expect(await world.disposeSessionInBody(installer.session)).toBeUndefined();
	} finally {
		world.io.rmSync(managerMarker, { recursive: true, force: true });
	}
}

/** A session file that is already written, so a notice is saved when it is observed. */
function flushedSessionManager(world: HarnessWorld, agentDir: string): SessionManager {
	const manager = world.createSessionManager(agentDir);
	const model = world.provider.model("root");
	manager.appendMessage({ role: "user", content: "Hello.", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "Hello." }],
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return manager;
}

/** Each platform's definition from explicit inputs: absolute paths with a space, `%` and `$`, quoted for its manager. */
function renderWitness(): void {
	const agentDir = "/home/owner/pi agent/100% $HOME";
	const common = {
		agentDir,
		command: ["/opt/pi tools/bin/pi", "--bot-daemon", agentDir],
		workingDirectory: agentDir,
		environment: { PATH: "/usr/bin:/home/owner/.local/bin", GH_CONFIG_DIR: "/home/owner/.config/gh" },
	};
	const linux: AwayServiceSpec = {
		...common,
		platform: "linux",
		name: awayServiceName(agentDir, "-"),
		definitionPath: `/home/owner/.config/systemd/user/${awayServiceName(agentDir, "-")}.service`,
	};
	expect(renderAwayServiceDefinition(linux).split("\n")).toEqual([
		"[Unit]",
		`Description=${APP_NAME} routines away for /home/owner/pi agent/100%% $HOME`,
		"",
		"[Service]",
		"Type=simple",
		'ExecStart="/opt/pi tools/bin/pi" "--bot-daemon" "/home/owner/pi agent/100%% $$HOME"',
		"WorkingDirectory=/home/owner/pi agent/100%% $HOME",
		'Environment="GH_CONFIG_DIR=/home/owner/.config/gh"',
		'Environment="PATH=/usr/bin:/home/owner/.local/bin"',
		"Restart=on-failure",
		"RestartSec=30",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	]);
	const darwin: AwayServiceSpec = {
		...common,
		platform: "darwin",
		name: awayServiceName(agentDir, "."),
		definitionPath: `/Users/owner/Library/LaunchAgents/${awayServiceName(agentDir, ".")}.plist`,
		uid: 501,
	};
	const plist = renderAwayServiceDefinition(darwin).split("\n");
	expect(plist.slice(0, 3)).toEqual([
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
	]);
	expect(plist.slice(4, 29)).toEqual([
		"\t<key>Label</key>",
		`\t<string>${awayServiceName(agentDir, ".")}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		"\t\t<string>/opt/pi tools/bin/pi</string>",
		"\t\t<string>--bot-daemon</string>",
		"\t\t<string>/home/owner/pi agent/100% $HOME</string>",
		"\t</array>",
		"\t<key>WorkingDirectory</key>",
		"\t<string>/home/owner/pi agent/100% $HOME</string>",
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		"\t\t<key>GH_CONFIG_DIR</key>",
		"\t\t<string>/home/owner/.config/gh</string>",
		"\t\t<key>PATH</key>",
		"\t\t<string>/usr/bin:/home/owner/.local/bin</string>",
		"\t</dict>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<dict>",
		"\t\t<key>SuccessfulExit</key>",
		"\t\t<false/>",
		"\t</dict>",
		"\t<key>ThrottleInterval</key>",
	]);
	const windowsDir = "C:\\Users\\owner\\pi agent\\a&b";
	const win32: AwayServiceSpec = {
		platform: "win32",
		agentDir: windowsDir,
		name: awayServiceName(windowsDir, "-"),
		definitionPath: `${windowsDir}\\${awayServiceName(windowsDir, "-")}.xml`,
		command: ["C:\\Program Files\\pi\\pi.exe", "--bot-daemon", windowsDir],
		workingDirectory: windowsDir,
		environment: {},
		user: "OWNER-PC\\owner",
	};
	const task = renderAwayServiceDefinition(win32).split("\r\n");
	expect(task[0]).toBe('<?xml version="1.0" encoding="UTF-16"?>');
	for (const line of [
		"      <UserId>OWNER-PC\\owner</UserId>",
		"      <LogonType>InteractiveToken</LogonType>",
		"      <RunLevel>LeastPrivilege</RunLevel>",
		"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
		"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
		"      <Command>C:\\Program Files\\pi\\pi.exe</Command>",
		"      <Arguments>--bot-daemon &quot;C:\\Users\\owner\\pi agent\\a&amp;b&quot;</Arguments>",
		"      <WorkingDirectory>C:\\Users\\owner\\pi agent\\a&amp;b</WorkingDirectory>",
	])
		expect(task, `the task holds ${line.trim()}`).toContain(line);
	expect(
		task.filter((line) => line.includes("<UserId>")),
		"the logon trigger and the principal are the owner",
	).toEqual(["      <UserId>OWNER-PC\\owner</UserId>", "      <UserId>OWNER-PC\\owner</UserId>"]);
	// No definition carries a credential: only the non-secret names the inputs gave.
	for (const definition of [linux, darwin, win32].map(renderAwayServiceDefinition))
		expect(definition).not.toMatch(/TOKEN|API_KEY|BW_SESSION|BWS_ACCESS_TOKEN/);
}
