/**
 * Retiring detached bot daemons started by earlier builds, without ever signalling an unproven pid.
 *
 * Two earlier daemon generations can still be running against the current store:
 * - The inline-script daemon (builds before `pi --bot-daemon`): `<runtime> -e <script>`, where the script embeds this
 *   store's path. Every 10s it rewrites `bot-daemon-lease.json` with its own pid and no token (plain `writeFileSync`,
 *   no lock), and when a routine is due it rewrites the store from a read of it, also unlocked and non-atomic. It
 *   only acts on a store whose top level holds a `routines` array; the current store keeps routines under
 *   `routineSchedules`, so once the store is sealed ({@link PersistentBotTeamStore.sealRoutinesAgainstLegacyWriters})
 *   that daemon reads and returns: it can no longer touch the store on any platform. It ends on SIGTERM.
 * - The first `pi --bot-daemon` build renewed a token lease in `bot-daemon-lease.json` under its lock. Releasing that
 *   lease is its protocol stop: it exits once it observes the release, no signal needed.
 *
 * The current daemon's lease lives in its own file, which neither generation writes, so neither can displace it.
 *
 * Termination of an inline-script daemon is cleanup, not the safety mechanism, and needs proof. On Linux a process
 * is proven to be one when `/proc/<pid>/cmdline` is exactly `-e <script for this store>` after the executable, its
 * real uid is ours, and its start time is the same before and after that read. The pid is then sent SIGTERM, which
 * the script handles by exiting. Elsewhere no bounded probe gives that proof, so nothing is signalled: the sealed
 * daemon stays as an idle process that keeps rewriting its own heartbeat until it is killed, the user logs out or the
 * host restarts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseLinuxProcessStat } from "../../kernel/reliability/process-termination-protection.ts";
import { isPositiveSafePid } from "../../kernel/reliability/process-tree.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** The exact `-e` script the inline-script start passed for `storeFile` (unchanged across every build that used it). */
function legacyDaemonScript(storeFile: string): string {
	return [
		'const fs = require("node:fs");',
		'const path = require("node:path");',
		`const storeFile = ${JSON.stringify(storeFile)};`,
		'const leaseFile = path.join(path.dirname(storeFile), "bot-daemon-lease.json");',
		"const startedAt = new Date().toISOString();",
		"function writeHeartbeat(lastTickAt) {",
		"  try {",
		"    fs.mkdirSync(path.dirname(leaseFile), { recursive: true });",
		"    fs.writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, startedAt, lastHeartbeatAt: Date.now(), ...(lastTickAt ? { lastTickAt } : {}) }, null, 2));",
		"  } catch {}",
		"}",
		"function tickStore() {",
		"  const now = Date.now();",
		"  writeHeartbeat(now);",
		"  try {",
		"    if (!fs.existsSync(storeFile)) return;",
		'    const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));',
		"    if (!data || !Array.isArray(data.routines)) return;",
		"    let mutated = false;",
		"    for (const r of data.routines) {",
		"      if (!r || !r.enabled || typeof r.nextRunAt !== 'number' || r.nextRunAt > now) continue;",
		"      r.lastRunAt = now;",
		"      r.nextRunAt = now + Math.max(10000, Number(r.intervalMs) || 60000);",
		"      r.lastStatus = 'queued';",
		"      r.lastSummary = '[Daemon ' + new Date(now).toISOString() + '] Routine queued across TUI session: ' + String(r.prompt || '').slice(0, 160);",
		"      r.updatedAt = new Date(now).toISOString();",
		"      if (r.target && r.target.kind === 'bot' && Array.isArray(data.bots)) {",
		"        const bot = data.bots.find((b) => b && b.agentId === r.target.agentId);",
		"        if (bot) { bot.lastMessageAt = now; bot.lastSummary = r.lastSummary; bot.updatedAt = r.updatedAt; }",
		"      } else if (r.target && r.target.kind === 'team' && data.teamMessages && typeof data.teamMessages === 'object') {",
		"        const tid = r.target.teamId;",
		"        const list = Array.isArray(data.teamMessages[tid]) ? data.teamMessages[tid] : (data.teamMessages[tid] = []);",
		"        list.push({ messageId: 'daemon-' + r.routineId + '-' + now, teamId: tid, sender: { kind: 'brain' }, text: '[Scheduled routine ' + r.routineId + ']: ' + r.prompt, timestamp: now, targetAgentIds: [], deliveries: [] });",
		"        if (Array.isArray(data.teams)) {",
		"          const team = data.teams.find((t) => t && t.teamId === tid);",
		"          if (team) { team.lastMessageAt = now; team.updatedAt = r.updatedAt; }",
		"        }",
		"      }",
		"      mutated = true;",
		"    }",
		"    if (mutated) fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));",
		"  } catch {}",
		"}",
		"tickStore();",
		"const timer = setInterval(tickStore, 10000);",
		'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
	].join("\n");
}

/**
 * Reads one procfs fact of `pid`. A process that exited, or whose entry this user cannot read, yields undefined:
 * the fact is unproven, which every caller treats as "do not signal".
 */
function readProcFile(pid: number, name: "cmdline" | "stat" | "status"): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/${name}`, "utf8");
	} catch {
		return undefined;
	}
}

function readArgvAfterExecutable(pid: number): string[] | undefined {
	const cmdline = readProcFile(pid, "cmdline");
	if (cmdline === undefined || !cmdline.endsWith("\0")) return undefined;
	return cmdline.slice(0, -1).split("\0").slice(1);
}

function readStartTime(pid: number): string | undefined {
	const stat = readProcFile(pid, "stat");
	return stat === undefined ? undefined : parseLinuxProcessStat(pid, stat)?.startTime;
}

function readRealUid(pid: number): number | undefined {
	const uid = /^Uid:\s+(\d+)\s/m.exec(readProcFile(pid, "status") ?? "")?.[1];
	return uid === undefined ? undefined : Number(uid);
}

function isLegacyDaemonArgv(argv: readonly string[] | undefined, script: string): boolean {
	return argv !== undefined && argv.length === 2 && argv[0] === "-e" && argv[1] === script;
}

/** Linux only: whether `pid` is proven to be an inline-script daemon of the store whose script is `script`. */
function isProvenLegacyDaemon(pid: number, script: string, uid: number): boolean {
	if (pid === process.pid || pid === process.ppid) return false;
	const startTime = readStartTime(pid);
	if (startTime === undefined) return false;
	if (!isLegacyDaemonArgv(readArgvAfterExecutable(pid), script) || readRealUid(pid) !== uid) return false;
	return readStartTime(pid) === startTime;
}

/**
 * @deprecated Serves earlier-build bot daemons; replaced by the current daemon lease. Remove with retireLegacyBotDaemons once no host can still run a daemon from an earlier build.
 */
export interface LegacyDaemonSweep {
	/** Whether this host can prove a legacy daemon's identity at all (Linux with a readable procfs). */
	readonly provable: boolean;
	/** Proven inline-script daemons that were sent SIGTERM. */
	readonly signalled: readonly number[];
	/** Proven inline-script daemons whose SIGTERM could not be delivered (not ESRCH: those had already exited). */
	readonly unsignalled: readonly number[];
}

/** Linux: finds every proven inline-script daemon of `storeFile` among this user's processes and sends it SIGTERM. */
function terminateProvenLegacyDaemons(storeFile: string): LegacyDaemonSweep {
	const unprovable: LegacyDaemonSweep = { provable: false, signalled: [], unsignalled: [] };
	if (process.platform !== "linux" || typeof process.getuid !== "function") return unprovable;
	const uid = process.getuid();
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return unprovable;
	}
	const script = legacyDaemonScript(storeFile);
	const signalled: number[] = [];
	const unsignalled: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (!isPositiveSafePid(pid) || !isLegacyDaemonArgv(readArgvAfterExecutable(pid), script)) continue;
		if (!isProvenLegacyDaemon(pid, script, uid)) continue;
		try {
			process.kill(pid, "SIGTERM");
			signalled.push(pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") unsignalled.push(pid);
		}
	}
	return { provable: true, signalled, unsignalled };
}

/**
 * @deprecated Serves earlier-build bot daemons; replaced by the current daemon lease. Remove with retireLegacyBotDaemons once no host can still run a daemon from an earlier build.
 */
export interface LegacyDaemonRetirement {
	/** The store was rewritten without the `routines` key an inline-script daemon acts on. */
	readonly sealed: boolean;
	/** A first-generation `pi --bot-daemon` lease was released; that daemon exits on observing it. */
	readonly releasedTokenDaemon?: { readonly held: boolean; readonly pid?: number };
	readonly sweep: LegacyDaemonSweep;
	/** An inline-script daemon still renewing the old heartbeat that was not proven and signalled here. */
	readonly sealedOutPid?: number;
}

/**
 * Resolves every earlier-generation daemon claim on `store`: seal the store first (the guarantee on every platform),
 * release a first-generation token lease, then terminate the inline-script daemons this host can prove.
 *
 * @deprecated Serves earlier-build bot daemons; replaced by the current daemon lease. Remove with retireLegacyBotDaemons once no host can still run a daemon from an earlier build.
 */
export function retireLegacyBotDaemons(store: PersistentBotTeamStore): LegacyDaemonRetirement {
	const sealed = store.sealRoutinesAgainstLegacyWriters();
	const release = store.releaseLegacyTokenDaemonLease();
	const sweep = terminateProvenLegacyDaemons(store.getStoreFilePath());
	const legacy = store.getDaemonStatus().legacy;
	const sealedOutPid =
		legacy?.kind === "inline-script" && legacy.pid !== undefined && !sweep.signalled.includes(legacy.pid)
			? legacy.pid
			: undefined;
	const releasedTokenDaemon = release.released
		? { held: release.held, ...(release.pid !== undefined ? { pid: release.pid } : {}) }
		: undefined;
	return {
		sealed,
		...(releasedTokenDaemon ? { releasedTokenDaemon } : {}),
		sweep,
		...(sealedOutPid !== undefined ? { sealedOutPid } : {}),
	};
}

/**
 * One sentence per earlier-generation outcome worth telling the operator; empty when there was none.
 *
 * @deprecated Operator wording for retireLegacyBotDaemons; remove with it.
 */
export function describeLegacyDaemonRetirement(retirement: LegacyDaemonRetirement): string {
	const parts: string[] = [];
	if (retirement.releasedTokenDaemon?.held)
		parts.push(
			`Released an earlier build's daemon lease${retirement.releasedTokenDaemon.pid ? ` (pid ${retirement.releasedTokenDaemon.pid})` : ""}; it exits on observing the release.`,
		);
	if (retirement.sweep.signalled.length > 0)
		parts.push(`Stopped an earlier build's inline-script daemon (pid ${retirement.sweep.signalled.join(", ")}).`);
	if (retirement.sweep.unsignalled.length > 0)
		parts.push(
			`An earlier build's inline-script daemon (pid ${retirement.sweep.unsignalled.join(", ")}) could not be signalled; it is sealed out of the store.`,
		);
	if (retirement.sealedOutPid !== undefined)
		parts.push(
			`An earlier build's inline-script daemon (pid ${retirement.sealedOutPid}) is still running; its identity was not proven${retirement.sweep.provable ? "" : " (no identity probe on this host)"}, so it was not signalled. It is sealed out of the store and idles until it is killed, the user logs out or the host restarts.`,
		);
	return parts.join(" ");
}
