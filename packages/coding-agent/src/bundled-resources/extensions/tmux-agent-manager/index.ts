import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getProcessWorkRun } from "@caupulican/pi-adaptative";
import type { AgentToolResult } from "@caupulican/pi-agent-core";
import { Type } from "typebox";

export const piConfig = { tools: ["tmux_agent_manager"] };

type Action =
	| "status"
	| "setup_help"
	| "guard"
	| "notify"
	| "set_status"
	| "clear_status"
	| "workspace_plan"
	| "launch_workspace"
	| "fire_task"
	| "job_status"
	| "list_jobs"
	| "set_variable"
	| "list_variables"
	| "list_templates"
	| "show_template"
	| "stop_job"
	| "stop_session";
type Provider = "pi" | "codex" | "agy" | "claude" | "opencode" | "custom";

type AgentSpec = { provider?: Provider; name?: string; command?: string; cwd?: string; tools?: string[] };
type TeamTemplate = {
	name: string;
	description: string;
	agents: AgentSpec[];
	deadlineSeconds?: number;
	notes?: string[];
};
type Params = {
	action?: Action;
	title?: string;
	body?: string;
	subtitle?: string;
	statusKey?: string;
	status?: string;
	icon?: string;
	color?: string;
	workspaceName?: string;
	cwd?: string;
	agents?: AgentSpec[];
	teamTemplate?: string;
	task?: string;
	jobId?: string;
	variableName?: string;
	variableValue?: string;
	deadlineSeconds?: number;
	dryRun?: boolean;
	force?: boolean;
	confirm?: string;
};

type RunResult = { ok: boolean; status: number | null; stdout: string; stderr: string; error?: string; args: string[] };
type TmuxDetection = {
	insideTmux: boolean;
	tmuxBin?: string;
	cliAvailable: boolean;
	version?: string;
	currentSession?: string;
	sessions: string[];
	env: { tmux?: string; term?: string };
	errors: string[];
};
type AgentResult = {
	status: string;
	marker?: string;
	detectedAt?: string;
	reason?: string;
};
type VariableState = { updatedAt: string | null; variables: Record<string, unknown> };
type FireAgentPlan = {
	id: string;
	name: string;
	provider: Provider;
	command?: string;
	cwd: string;
	doneMarker: string;
	blockedMarker: string;
	promptPath: string;
	logPath: string;
	resultPath: string;
	paneId?: string;
	result?: AgentResult;
};
type FireTaskPlan = {
	id: string;
	createdAt: string;
	notifiedAt?: string;
	parentSessionFile?: string;
	workspaceName: string;
	sessionName: string;
	cwd: string;
	task: string;
	teamTemplate?: string;
	deadlineSeconds: number;
	jobDir: string;
	jobPath: string;
	varsPath: string;
	watcherPath: string;
	agents: FireAgentPlan[];
	launchCommands: string[];
	variables?: VariableState;
};

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));
export function getTmuxAgentManagerDataRoot(): string {
	const agentDir =
		process.env.PI_ADAPTATIVE_CODING_AGENT_DIR ||
		process.env["PI-ADAPTATIVE_CODING_AGENT_DIR"] ||
		process.env.PI_CODING_AGENT_DIR ||
		process.env.PI_AGENT_DIR ||
		path.join(homedir(), ".pi", "agent");
	return getProcessWorkRun(agentDir, "background", "tmux-agent-manager", "state").path;
}
function jobsRoot(): string {
	return path.join(getTmuxAgentManagerDataRoot(), "jobs");
}
function archiveRoot(): string {
	return path.join(getTmuxAgentManagerDataRoot(), "archives");
}
function templateDirs(): string[] {
	return [path.join(EXTENSION_ROOT, "templates"), path.join(getTmuxAgentManagerDataRoot(), "templates")];
}
const MAX_OUTPUT = 12_000;
const DEFAULT_AGENT_PROVIDERS: Provider[] = ["pi", "agy", "codex"];
const PROVIDER_COMMANDS: Record<Provider, string> = {
	pi: "pi",
	codex: "codex",
	agy: "agy",
	claude: "claude",
	opencode: "opencode",
	custom: "",
};
const DEFAULT_DEADLINE_SECONDS = 20 * 60;
const MAX_DEADLINE_SECONDS = 24 * 60 * 60;
const TEAM_TEMPLATES: TeamTemplate[] = [
	{
		name: "provider-prompt-smoke",
		description:
			"Real minimal interactive prompt smoke for native Claude, Agy, and Pi. Consumes provider/model tokens.",
		deadlineSeconds: 10 * 60,
		agents: [
			{ provider: "claude", name: "claude-prompt-smoke" },
			{ provider: "agy", name: "agy-prompt-smoke" },
			{ provider: "pi", name: "pi-prompt-smoke" },
		],
		notes: [
			"Use only when model-token/auth validation is intended.",
			"The manager opens each CLI in tmux, injects the prompt, captures pane output, and watches DONE/BLOCKED markers.",
		],
	},
	{
		name: "full-provider-review",
		description:
			"Interactive native-provider review team: Pi lead, Claude reviewer, Agy validator, Agy reviewer. Consumes provider/model tokens.",
		deadlineSeconds: 30 * 60,
		agents: [
			{ provider: "pi", name: "pi-lead" },
			{ provider: "claude", name: "claude-reviewer" },
			{ provider: "agy", name: "agy-validator" },
			{ provider: "agy", name: "agy-reviewer" },
		],
		notes: [
			"Best for non-trivial review/QA where independent native CLIs help.",
			"Keep the task objective bounded; inspect captured panes/result files before accepting PASS.",
		],
	},
	{
		name: "builder-validator",
		description:
			"Interactive implementation loop: Agy builder, Claude reviewer, Agy validator, Pi coordinator. Good default for scoped code work.",
		deadlineSeconds: 25 * 60,
		agents: [
			{ provider: "agy", name: "builder" },
			{ provider: "claude", name: "code-reviewer" },
			{ provider: "agy", name: "validator" },
			{ provider: "pi", name: "coordinator" },
		],
		notes: [
			"Use for owner-approved implementation/QA batches; never claim complete until result files and validation evidence are inspected.",
		],
	},
];

function cap(text: string, max = MAX_OUTPUT): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}
function firstString(...values: unknown[]): string | undefined {
	for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
	return undefined;
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}
function findExecutable(name: string): string | undefined {
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			/* ignore */
		}
	}
	return undefined;
}
function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function resolveCwd(ctx: ExtensionContext, requested?: string): string {
	const cwd = path.resolve(ctx.cwd || process.cwd(), requested?.trim() || ".");
	const stat = fs.statSync(cwd);
	if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
	return cwd;
}
function safeName(value: string, fallback = "pi-agents"): string {
	const safe = value
		.toLowerCase()
		.replace(/[^a-z0-9_.:-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return safe || fallback;
}
function makeJobId(): string {
	return `tmux-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}
function safeStatusKey(value?: string): string {
	const raw = value?.trim() || "pi-agents";
	if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(raw))
		throw new Error("statusKey must be 1-80 chars: letters, numbers, _, ., :, or -");
	return raw;
}

function runTmux(args: string[], timeoutMs = 5_000): RunResult {
	const tmux = process.env.PI_TMUX_MANAGER_TMUX_BIN || findExecutable("tmux") || "tmux";
	const result = spawnSync(tmux, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		maxBuffer: 256 * 1024,
	});
	return {
		ok: !result.error && result.status === 0,
		status: result.status,
		stdout: cap(result.stdout || ""),
		stderr: cap(result.stderr || ""),
		error: result.error ? String(result.error.message || result.error) : undefined,
		args: [tmux, ...args],
	};
}
function detectTmux(): TmuxDetection {
	const tmuxBin = process.env.PI_TMUX_MANAGER_TMUX_BIN || findExecutable("tmux");
	const errors: string[] = [];
	let version: string | undefined;
	let currentSession: string | undefined;
	let sessions: string[] = [];
	const insideTmux = Boolean(process.env.TMUX);
	if (!tmuxBin) errors.push("tmux CLI not found on PATH.");
	else {
		const versionRun = runTmux(["-V"], 2_000);
		if (versionRun.ok) version = versionRun.stdout.trim();
		else errors.push(`tmux -V failed: ${versionRun.error || versionRun.stderr || `exit ${versionRun.status}`}`);
		const listRun = runTmux(["list-sessions", "-F", "#{session_name}"]);
		if (listRun.ok) sessions = listRun.stdout.trim() ? listRun.stdout.trim().split(/\n+/) : [];
		else if (!/no server running/i.test(listRun.stderr))
			errors.push(`tmux list-sessions failed: ${listRun.error || listRun.stderr || `exit ${listRun.status}`}`);
		if (insideTmux) {
			const sessionRun = runTmux(["display-message", "-p", "#S"], 2_000);
			if (sessionRun.ok) currentSession = sessionRun.stdout.trim();
		}
	}
	return {
		insideTmux,
		tmuxBin,
		cliAvailable: Boolean(tmuxBin),
		version,
		currentSession,
		sessions,
		env: { tmux: process.env.TMUX, term: process.env.TERM },
		errors,
	};
}
function formatDetection(d: TmuxDetection): string {
	return [
		`tmux: ${d.cliAvailable ? "available" : "missing"}`,
		d.tmuxBin ? `bin: ${d.tmuxBin}` : undefined,
		d.version ? `version: ${d.version}` : undefined,
		`insideTmux: ${d.insideTmux}`,
		d.currentSession ? `currentSession: ${d.currentSession}` : undefined,
		d.sessions.length ? `sessions: ${d.sessions.join(", ")}` : "sessions: none",
		d.errors.length ? `errors:\n- ${d.errors.join("\n- ")}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}
function setupHelp(d: TmuxDetection): string {
	if (d.cliAvailable)
		return `tmux CLI available: ${d.tmuxBin || "tmux"}\nUse tmux_agent_manager action=workspace_plan or fire_task. Set dryRun=true only when a preview is useful.`;
	return [
		"tmux CLI not found.",
		"Install tmux for your environment, then reload Pi:",
		"- Debian/Ubuntu/WSL: sudo apt-get install tmux",
		"- Fedora: sudo dnf install tmux",
		"- Arch: sudo pacman -S tmux",
		"- macOS: brew install tmux",
		"- Windows: use WSL/MSYS2/Cygwin where a real tmux binary is available on PATH.",
		"cmux is macOS-only and intentionally not used by this tmux manager.",
	].join("\n");
}
async function guardTmux(_ctx: ExtensionContext, detection: TmuxDetection, purpose: string) {
	if (detection.cliAvailable) return { allowed: true, text: `tmux available for ${purpose}.` };
	return { allowed: false, text: `${setupHelp(detection)}\n\nCannot run tmux-managed work until tmux is on PATH.` };
}
function tmuxManagerInstructions(toolName: string, detection: TmuxDetection): string {
	return [
		`tmux is available (${detection.version || detection.tmuxBin || "tmux"}). For managed ${toolName} work, use tmux_agent_manager instead of direct foreground/background dispatch.`,
		"Suggested next call:",
		'tmux_agent_manager({ action: "fire_task", teamTemplate: "builder-validator", task: "<objective>" })',
		"The launch returns immediately after panes, event watchers, and prompt handoffs are armed.",
		"Managed mode creates panes, prompt files, result files, event-driven terminal handoffs, tmux display-message notifications, @pi_* status options, shared variables, and one-shot deadlines.",
	].join("\n");
}
function validateTemplate(value: unknown, source: string): TeamTemplate {
	if (!value || typeof value !== "object") throw new Error(`${source}: template must be an object`);
	const template = value as TeamTemplate;
	if (!firstString(template.name)) throw new Error(`${source}: missing name`);
	if (!firstString(template.description)) throw new Error(`${source}: missing description`);
	if (!Array.isArray(template.agents) || template.agents.length < 1)
		throw new Error(`${source}: agents must be a non-empty array`);
	if (template.agents.length > 12) throw new Error(`${source}: agents max is 12`);
	template.agents.forEach((agent, index) => {
		const provider = agent.provider || "custom";
		if (!Object.hasOwn(PROVIDER_COMMANDS, provider))
			throw new Error(`${source}: unsupported provider at agents[${index}]: ${provider}`);
		if (provider === "custom" && !firstString(agent.command))
			throw new Error(`${source}: custom agent ${agent.name || index} needs command`);
	});
	return template;
}
function loadTemplateFiles(): { templates: TeamTemplate[]; errors: string[] } {
	const templates: TeamTemplate[] = [];
	const errors: string[] = [];
	for (const dir of templateDirs()) {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const filePath = path.join(dir, entry.name);
			try {
				const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
				templates.push(validateTemplate(parsed, filePath));
			} catch (error: unknown) {
				errors.push(`${filePath}: ${errorMessage(error)}`);
			}
		}
	}
	return { templates, errors };
}
function getTeamTemplates(): { templates: TeamTemplate[]; errors: string[] } {
	const byName = new Map<string, TeamTemplate>();
	for (const template of TEAM_TEMPLATES) byName.set(template.name.toLowerCase(), template);
	const loaded = loadTemplateFiles();
	for (const template of loaded.templates) byName.set(template.name.toLowerCase(), template);
	return { templates: Array.from(byName.values()), errors: loaded.errors };
}
function findTeamTemplate(name?: string): TeamTemplate | undefined {
	if (!name) return undefined;
	const wanted = name.trim().toLowerCase();
	return getTeamTemplates().templates.find((template) => template.name.toLowerCase() === wanted);
}
function requireTeamTemplate(name?: string): TeamTemplate {
	const { templates, errors } = getTeamTemplates();
	const wanted = name?.trim().toLowerCase();
	const template = wanted ? templates.find((item) => item.name.toLowerCase() === wanted) : undefined;
	if (!template)
		throw new Error(
			`unknown teamTemplate '${name || ""}'. Use action=list_templates.${errors.length ? ` Template load errors: ${errors.join("; ")}` : ""}`,
		);
	return template;
}
function templateSummary(): { text: string; templates: TeamTemplate[]; errors: string[] } {
	const loaded = getTeamTemplates();
	const lines = loaded.templates.map((template) => `- ${template.name}: ${template.description}`);
	if (loaded.errors.length) lines.push("", "Template load errors:", ...loaded.errors.map((error) => `- ${error}`));
	return { text: lines.join("\n"), ...loaded };
}
function formatTemplate(template: TeamTemplate): string {
	return JSON.stringify(template, null, 2);
}
function templateDefaults(params: Params): Partial<TeamTemplate> {
	return findTeamTemplate(params.teamTemplate) || {};
}

function normalizeAgents(params: Params): AgentSpec[] {
	const template = findTeamTemplate(params.teamTemplate);
	const input: AgentSpec[] = params.agents?.length
		? params.agents
		: template?.agents?.length
			? template.agents
			: DEFAULT_AGENT_PROVIDERS.map((provider) => ({ provider }));
	if (input.length < 1) throw new Error("agents must contain at least one agent");
	if (input.length > 12) throw new Error("agents max is 12");
	return input.map((agent, index) => {
		const provider = agent.provider || "custom";
		if (!Object.hasOwn(PROVIDER_COMMANDS, provider)) throw new Error(`unsupported provider: ${provider}`);
		const name =
			firstString(agent.name, provider === "custom" ? `custom-${index + 1}` : provider) || `agent-${index + 1}`;
		const baseCommand = firstString(agent.command, PROVIDER_COMMANDS[provider]);
		if (!baseCommand) throw new Error(`agent ${name} needs command when provider=custom`);
		const tools = Array.isArray(agent.tools) && agent.tools.length > 0 ? agent.tools : undefined;
		const command = tools ? `${baseCommand} --tools ${tools.join(",")}` : baseCommand;
		return { provider, name, command, cwd: agent.cwd, tools };
	});
}
function defaultProviderInvocation(provider: Provider): string {
	switch (provider) {
		case "pi":
			return "pi";
		case "agy":
			return "agy";
		case "codex":
			return "codex";
		case "claude":
			return "claude";
		case "opencode":
			return "opencode";
		case "custom":
			return "";
	}
}
function interactivePromptText(prompt: string): string {
	return prompt.replace(/\r?\n/g, "\\n");
}
function spellMarker(marker: string): string {
	return marker.split("").join(" ");
}
function managedPrompt(
	task: string,
	jobId: string,
	agent: { name: string; provider: Provider },
	doneMarker: string,
	blockedMarker: string,
	varsPath: string,
): string {
	return [
		`You are ${agent.name} (${agent.provider}) working inside a tmux-managed Pi worker pane.`,
		`Job id: ${jobId}`,
		`Shared variable file: ${varsPath}`,
		"",
		"Objective:",
		task,
		"",
		"Rules:",
		"- Work autonomously until honest PASS or BLOCKED.",
		"- Verify important claims before PASS; include concise evidence.",
		"- If user input, credentials, destructive approval, publishing, or unavailable dependency blocks you, report BLOCKED instead of waiting silently.",
		"- Never print secrets/tokens. Prompts, commands, and logs persist under ~/.pi/agent/work/background/tmux-agent-manager/state/jobs.",
		"- If a task names an external decision variable, read it only at the decision point; never loop or poll the shared JSON file.",
		"",
		"Completion contract:",
		"Your final response must contain exactly one marker line. Build it by removing spaces from one of these character sequences:",
		`  DONE: ${spellMarker(doneMarker)}`,
		`  BLOCKED: ${spellMarker(blockedMarker)}`,
		"If BLOCKED, print a short reason on the next line. Do not print either marker until the final answer. After marker, stop.",
	].join("\n");
}
function buildWorkspacePlan(ctx: ExtensionContext, params: Params) {
	const cwd = resolveCwd(ctx, params.cwd);
	const agents = normalizeAgents(params).map((agent, index) => ({
		...agent,
		cwd: resolveCwd(ctx, agent.cwd || cwd),
		id: `${safeName(agent.name || agent.provider || "agent")}-${index + 1}`,
	}));
	const workspaceName = firstString(params.workspaceName, `pi-agents-${Date.now().toString(36)}`) || "pi-agents";
	const sessionName = safeName(workspaceName, "pi-agents");
	const launchCommands = agents.map(
		(agent) => `tmux pane: ${agent.name} -> cd ${quoteShell(agent.cwd)} && ${agent.command}`,
	);
	return { workspaceName, sessionName, cwd, agents, launchCommands };
}
export function makePaneWatcherScript(job: FireTaskPlan): string {
	const agentCases = job.agents.flatMap((agent) => [
		`  ${agent.id})`,
		`    agent_name=${quoteShell(agent.name)}`,
		`    agent_id_json=${quoteShell(JSON.stringify(agent.id))}`,
		`    agent_name_json=${quoteShell(JSON.stringify(agent.name))}`,
		`    done_marker=${quoteShell(agent.doneMarker)}`,
		`    blocked_marker=${quoteShell(agent.blockedMarker)}`,
		`    log_path=${quoteShell(agent.logPath)}`,
		`    log_path_json=${quoteShell(JSON.stringify(agent.logPath))}`,
		`    result_path=${quoteShell(agent.resultPath)}`,
		`    stop_request_path=${quoteShell(`${agent.resultPath}.stop-requested`)}`,
		`    pane_id=${quoteShell(agent.paneId || "")}`,
		`    pane_id_json=${quoteShell(JSON.stringify(agent.paneId || null))}`,
		"    ;;",
	]);
	return [
		"#!/bin/sh",
		"set -eu",
		"umask 077",
		"LC_ALL=C",
		"export LC_ALL",
		`job_id=${quoteShell(job.id)}`,
		`job_id_json=${quoteShell(JSON.stringify(job.id))}`,
		`session_name=${quoteShell(job.sessionName)}`,
		`deadline=${Math.max(1, job.deadlineSeconds)}`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
		"agent_id=${1:-}",
		'case "$agent_id" in',
		...agentCases,
		"  *) printf 'unknown tmux agent id: %s\\n' \"$agent_id\" >&2; exit 2 ;;",
		"esac",
		"lock_path=$result_path.lock",
		"status_path=$result_path.status.$$",
		"timer_pid=",
		"awk_pid=",
		"finish() {",
		"  status=$1",
		"  notified_by=$2",
		'  [ ! -e "$result_path" ] || return 0',
		'  mkdir "$lock_path" 2>/dev/null || return 0',
		"  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
		"  temporary=$result_path.tmp.$$",
		'  printf \'{\\n  "jobId": %s,\\n  "agentId": %s,\\n  "agentName": %s,\\n  "status": "%s",\\n  "exitCode": null,\\n  "logPath": %s,\\n  "paneId": %s,\\n  "finishedAt": "%s",\\n  "notifiedBy": "%s"\\n}\\n\' \\',
		'    "$job_id_json" "$agent_id_json" "$agent_name_json" "$status" "$log_path_json" "$pane_id_json" "$finished_at" "$notified_by" > "$temporary"',
		'  mv "$temporary" "$result_path"',
		'  rm -f "$stop_request_path"',
		"  option_suffix=$(printf '%s' \"$job_id-$agent_id\" | tr -c 'A-Za-z0-9_.:-' '-')",
		'  tmux set-option -t "$session_name" "@pi_$option_suffix" "$status" >/dev/null 2>&1 || true',
		'  tmux set-option -t "$session_name" "@pi_$job_id" "$status:$agent_name" >/dev/null 2>&1 || true',
		'  tmux display-message -t "$session_name" "tmux agent $agent_name: $status (job $job_id)" >/dev/null 2>&1 || true',
		"}",
		"cleanup() {",
		'  [ -z "$timer_pid" ] || kill "$timer_pid" 2>/dev/null || true',
		'  [ -z "$awk_pid" ] || kill "$awk_pid" 2>/dev/null || true',
		'  rm -f "$status_path"',
		"}",
		"terminate() { cleanup; exit 0; }",
		"trap terminate TERM INT HUP",
		"trap cleanup EXIT",
		"parent_pid=$$",
		"exec 3<&0",
		"(",
		"  sleep_pid=",
		'  stop_timer() { [ -z "$sleep_pid" ] || kill "$sleep_pid" 2>/dev/null || true; exit 0; }',
		"  trap stop_timer TERM INT HUP",
		'  sleep "$deadline" &',
		"  sleep_pid=$!",
		'  wait "$sleep_pid" 2>/dev/null || exit 0',
		"  sleep_pid=",
		'  if [ -e "$stop_request_path" ]; then finish stopped stop-requested-event; else finish timeout deadline-event; fi',
		'  kill -TERM "$parent_pid" 2>/dev/null || true',
		") &",
		"timer_pid=$!",
		"logged_bytes=0",
		'[ ! -f "$log_path" ] || logged_bytes=$(wc -c < "$log_path" | tr -d \' \')',
		'awk -v done="$done_marker" -v blocked="$blocked_marker" -v log_file="$log_path" -v status_file="$status_path" -v logged="$logged_bytes" -v max=4194304 -v esc="$(printf \'\\033\')" \'',
		'function settle(status, reason) { print status "|" reason > status_file; close(status_file); settled = 1; exit }',
		"{",
		"  raw = $0 ORS",
		"  remaining = max - logged",
		'  if (remaining > 0) { if (length(raw) > remaining) raw = substr(raw, 1, remaining); printf "%s", raw >> log_file; logged += length(raw) }',
		"  clean = $0",
		'  gsub(esc "\\\\[[0-9;?]*[ -/]*[@-~]", "", clean)',
		'  gsub(/\\r/, "", clean)',
		'  sub(/^[ \\t]+/, "", clean); sub(/[ \\t]+$/, "", clean)',
		'  if (clean == done) settle("done", "pane-output-event")',
		'  if (clean == blocked) settle("blocked", "pane-output-event")',
		"}",
		'END { if (!settled) { print "failed|pane-stream-ended" > status_file; close(status_file) } }',
		"' <&3 &",
		"awk_pid=$!",
		'wait "$awk_pid" || true',
		"awk_pid=",
		'kill "$timer_pid" 2>/dev/null || true',
		'wait "$timer_pid" 2>/dev/null || true',
		"timer_pid=",
		'if [ -e "$stop_request_path" ]; then',
		"  finish stopped stop-requested-event",
		'elif [ -f "$status_path" ]; then',
		'  terminal=$(cat "$status_path")',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
		'  finish "${terminal%%|*}" "${terminal#*|}"',
		"else",
		"  finish failed watcher-status-missing",
		"fi",
		"exit 0",
	].join("\n");
}
function buildFireTaskPlan(ctx: ExtensionContext, params: Params): FireTaskPlan {
	const defaults = templateDefaults(params);
	const task = firstString(params.task, params.body);
	if (!task) throw new Error("fire_task requires task (or body) with the worker objective");
	const cwd = resolveCwd(ctx, params.cwd);
	const id = firstString(params.jobId) || makeJobId();
	if (!/^[a-zA-Z0-9_.:-]{4,80}$/.test(id))
		throw new Error("jobId must be 4-80 chars: letters, numbers, _, ., :, or -");
	const jobDir = path.join(jobsRoot(), id);
	const workspaceName = firstString(params.workspaceName, `Pi job ${id}`) || `Pi job ${id}`;
	const sessionName = safeName(workspaceName, id);
	const rawAgents = normalizeAgents(params);
	const agents: FireAgentPlan[] = rawAgents.map((agent, index) => {
		const provider = agent.provider || "custom";
		const slug = `${safeName(agent.name || provider)}-${index + 1}`;
		const markerBase = `TMUX_${crypto.createHash("sha1").update(`${id}:${slug}`).digest("hex").slice(0, 10).toUpperCase()}`;
		const doneMarker = `${markerBase}_DONE`;
		const blockedMarker = `${markerBase}_BLOCKED`;
		return {
			id: slug,
			name: firstString(agent.name, provider) || slug,
			provider,
			command: firstString(agent.command, PROVIDER_COMMANDS[provider]),
			cwd: resolveCwd(ctx, agent.cwd || cwd),
			// tools already baked into command by normalizeAgents
			doneMarker,
			blockedMarker,
			promptPath: path.join(jobDir, `${slug}.prompt.md`),
			logPath: path.join(jobDir, `${slug}.log`),
			resultPath: path.join(jobDir, `${slug}.result.json`),
		};
	});
	const job: FireTaskPlan = {
		id,
		createdAt: new Date().toISOString(),
		parentSessionFile: ctx.sessionManager.getSessionFile(),
		workspaceName,
		sessionName,
		cwd,
		task,
		teamTemplate: params.teamTemplate,
		deadlineSeconds: clampInt(
			params.deadlineSeconds,
			defaults.deadlineSeconds || DEFAULT_DEADLINE_SECONDS,
			5,
			MAX_DEADLINE_SECONDS,
		),
		jobDir,
		jobPath: path.join(jobDir, "job.json"),
		varsPath: path.join(jobDir, "variables.json"),
		watcherPath: path.join(jobDir, "pane-watcher.sh"),
		agents,
		launchCommands: [],
	};
	job.launchCommands = agents.map(
		(agent) =>
			`${agent.command || defaultProviderInvocation(agent.provider)} then inject ${path.basename(agent.promptPath)}`,
	);
	return job;
}
function archiveExistingJobDir(jobDir: string): string {
	const root = archiveRoot();
	ensureDir(root);
	const target = path.join(root, `${path.basename(jobDir)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	fs.renameSync(jobDir, target);
	return target;
}
function prepareJobDirForLaunch(job: FireTaskPlan, force?: boolean): string | undefined {
	if (!fs.existsSync(job.jobDir)) return undefined;
	if (!force)
		throw new Error(
			`tmux job already exists: ${job.id}. Use a new jobId, or pass force:true to archive the old job before launching.`,
		);
	return archiveExistingJobDir(job.jobDir);
}
function writeFireTaskFiles(job: FireTaskPlan): void {
	ensureDir(job.jobDir);
	if (!fs.existsSync(job.varsPath))
		fs.writeFileSync(job.varsPath, `${JSON.stringify({ updatedAt: null, variables: {} }, null, 2)}\n`, {
			mode: 0o600,
		});
	for (const agent of job.agents) {
		fs.writeFileSync(
			agent.promptPath,
			`${managedPrompt(job.task, job.id, agent, agent.doneMarker, agent.blockedMarker, job.varsPath)}\n`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			agent.logPath,
			`[tmux-agent-manager] waiting for captured pane output\njob=${job.id} agent=${agent.name} pane=${agent.paneId || "pending"} command=${agent.command || defaultProviderInvocation(agent.provider)}\n`,
			{ mode: 0o600 },
		);
	}
	fs.writeFileSync(job.watcherPath, makePaneWatcherScript(job), { mode: 0o700 });
	fs.chmodSync(job.watcherPath, 0o700);
	fs.writeFileSync(
		job.jobPath,
		`${JSON.stringify({ ...job, agents: job.agents.map((agent) => ({ ...agent, result: null })) }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}
function startPaneWatchers(job: FireTaskPlan): Array<{ agentId: string; paneId: string }> {
	const started: Array<{ agentId: string; paneId: string }> = [];
	for (const agent of job.agents) {
		if (!agent.paneId) throw new Error(`Missing pane id for tmux agent ${agent.name}`);
		const command = `sh ${quoteShell(job.watcherPath)} ${quoteShell(agent.id)}`;
		const result = runTmux(["pipe-pane", "-O", "-t", agent.paneId, command]);
		if (!result.ok) {
			throw new Error(
				`Failed to arm completion watcher for ${agent.name}: ${result.error || result.stderr || result.stdout}`,
			);
		}
		started.push({ agentId: agent.id, paneId: agent.paneId });
	}
	return started;
}
function targetDisplayName(agent: AgentSpec, index: number): string {
	return firstString(agent.name, agent.provider, `agent-${index + 1}`) || `agent-${index + 1}`;
}
function tmuxSessionExists(name: string): boolean {
	return runTmux(["has-session", "-t", name], 2_000).ok;
}
function sendCommandToPane(paneId: string, command: string): void {
	runTmux(["send-keys", "-t", paneId, "-l", command]);
	runTmux(["send-keys", "-t", paneId, "Enter"]);
}
function launchTmuxSession(
	sessionName: string,
	cwd: string,
	panes: Array<{ title: string; cwd: string; command: string }>,
): { runs: RunResult[]; paneIds: string[] } {
	if (tmuxSessionExists(sessionName))
		throw new Error(
			`tmux session already exists: ${sessionName}. Use stop_session/stop_job first or choose a different workspaceName.`,
		);
	const runs: RunResult[] = [];
	const paneIds: string[] = [];
	const first = panes[0];
	const create = runTmux(
		["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", sessionName, "-n", "agents", "-c", first.cwd || cwd],
		5_000,
	);
	runs.push(create);
	if (!create.ok)
		throw new Error(`tmux new-session failed: ${create.error || create.stderr || `exit ${create.status}`}`);
	const firstPane = create.stdout.trim();
	paneIds.push(firstPane);
	sendCommandToPane(firstPane, first.command);
	for (const pane of panes.slice(1)) {
		const split = runTmux(
			["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${sessionName}:0`, "-c", pane.cwd || cwd],
			5_000,
		);
		runs.push(split);
		if (!split.ok)
			throw new Error(`tmux split-window failed: ${split.error || split.stderr || `exit ${split.status}`}`);
		const paneId = split.stdout.trim();
		paneIds.push(paneId);
		sendCommandToPane(paneId, pane.command);
	}
	runs.push(runTmux(["select-layout", "-t", `${sessionName}:0`, "tiled"], 3_000));
	return { runs, paneIds };
}
function injectPromptToPane(paneId: string, prompt: string, provider: Provider): void {
	const text = interactivePromptText(prompt);
	if (provider === "claude") {
		const bufferName = `pi-tmux-${crypto.randomBytes(4).toString("hex")}`;
		runTmux(["set-buffer", "-b", bufferName, text], 10_000);
		runTmux(["paste-buffer", "-b", bufferName, "-t", paneId], 10_000);
		runTmux(["send-keys", "-t", paneId, "Enter"], 3_000);
		runTmux(["delete-buffer", "-b", bufferName], 3_000);
		return;
	}
	runTmux(["send-keys", "-t", paneId, "-l", text], 10_000);
	runTmux(["send-keys", "-t", paneId, provider === "agy" ? "C-m" : "Enter"], 3_000);
}
function stopTmuxSession(
	sessionName: string,
	dryRun: boolean,
	confirm?: string,
): { text: string; run?: RunResult; existed: boolean } {
	if (!sessionName) throw new Error("session name required");
	const existed = tmuxSessionExists(sessionName);
	if (!existed) return { text: `tmux session not running: ${sessionName}`, existed: false };
	if (dryRun) return { text: `DRY RUN would stop tmux session: ${sessionName}`, existed: true };
	if (confirm !== "yes-tmux-stop") throw new Error("real stop requires confirm=yes-tmux-stop");
	const run = runTmux(["kill-session", "-t", sessionName], 5_000);
	if (!run.ok) throw new Error(`tmux kill-session failed: ${run.error || run.stderr || `exit ${run.status}`}`);
	return { text: `Stopped tmux session: ${sessionName}`, run, existed: true };
}
function isAlreadyExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function markStopRequested(job: FireTaskPlan): void {
	for (const agent of job.agents) {
		if (fs.existsSync(agent.resultPath)) continue;
		try {
			fs.writeFileSync(`${agent.resultPath}.stop-requested`, `${new Date().toISOString()}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		} catch (error: unknown) {
			if (!isAlreadyExistsError(error)) throw error;
		}
	}
}
function clearStopRequested(job: FireTaskPlan): void {
	for (const agent of job.agents) fs.rmSync(`${agent.resultPath}.stop-requested`, { force: true });
}
function persistStoppedResults(job: FireTaskPlan): void {
	for (const agent of job.agents) {
		if (!fs.existsSync(agent.resultPath)) {
			const result = {
				jobId: job.id,
				agentId: agent.id,
				agentName: agent.name,
				status: "stopped",
				exitCode: null,
				logPath: agent.logPath,
				paneId: agent.paneId || null,
				finishedAt: new Date().toISOString(),
				notifiedBy: "stop-action-event",
			};
			try {
				fs.writeFileSync(agent.resultPath, `${JSON.stringify(result, null, 2)}\n`, {
					encoding: "utf8",
					mode: 0o600,
					flag: "wx",
				});
			} catch (error: unknown) {
				if (!isAlreadyExistsError(error)) throw error;
			}
		}
		fs.rmSync(`${agent.resultPath}.stop-requested`, { force: true });
	}
}
function stopTmuxSessionWithJobSignals(
	sessionName: string,
	jobs: FireTaskPlan[],
	dryRun: boolean,
	confirm?: string,
): { text: string; run?: RunResult; existed: boolean } {
	if (!dryRun && confirm !== "yes-tmux-stop") throw new Error("real stop requires confirm=yes-tmux-stop");
	if (!dryRun) for (const job of jobs) markStopRequested(job);
	try {
		const result = stopTmuxSession(sessionName, dryRun, confirm);
		if (!dryRun) for (const job of jobs) persistStoppedResults(job);
		return result;
	} catch (error: unknown) {
		for (const job of jobs) clearStopRequested(job);
		throw error;
	}
}
function formatWorkspacePreview(plan: ReturnType<typeof buildWorkspacePlan>): string {
	return [
		`Session: ${plan.sessionName}`,
		`Cwd: ${plan.cwd}`,
		"Panes:",
		...plan.agents.map((agent, index) => `- ${targetDisplayName(agent, index)}: ${agent.command} (cwd ${agent.cwd})`),
	].join("\n");
}
function formatFireTaskPreview(job: FireTaskPlan): string {
	return [
		`Job: ${job.id}`,
		`Session: ${job.sessionName}`,
		`Cwd: ${job.cwd}`,
		`State: ${job.jobPath}`,
		`Deadline: ${job.deadlineSeconds}s enforced by each event-driven pane watcher`,
		"Workers:",
		...job.agents.map((agent) => `- ${agent.name}: ${agent.command || defaultProviderInvocation(agent.provider)}`),
	].join("\n");
}
function loadJob(id: string): FireTaskPlan {
	const jobPath = path.join(jobsRoot(), id, "job.json");
	if (!fs.existsSync(jobPath)) throw new Error(`tmux job not found: ${id}`);
	const parsed = JSON.parse(fs.readFileSync(jobPath, "utf8")) as FireTaskPlan;
	if (!Array.isArray(parsed.agents)) throw new Error(`tmux job has invalid agents: ${id}`);
	for (const agent of parsed.agents) {
		try {
			agent.result = JSON.parse(fs.readFileSync(agent.resultPath, "utf8")) as AgentResult;
		} catch {
			delete agent.result;
		}
	}
	try {
		parsed.variables = readVariables(parsed.varsPath);
	} catch {
		parsed.variables = { updatedAt: null, variables: {} };
	}
	return parsed;
}
function loadJobPlans(): FireTaskPlan[] {
	try {
		return fs
			.readdirSync(jobsRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				try {
					return [loadJob(entry.name)];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}
function listJobs(): unknown[] {
	try {
		return fs
			.readdirSync(jobsRoot(), { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => {
				try {
					const job = loadJob(d.name);
					return {
						id: job.id,
						workspaceName: job.workspaceName,
						sessionName: job.sessionName,
						createdAt: job.createdAt,
						agents: job.agents.map((agent) => ({ name: agent.name, status: agent.result?.status || "pending" })),
					};
				} catch (error: unknown) {
					return { id: d.name, error: errorMessage(error) };
				}
			});
	} catch {
		return [];
	}
}
function readVariables(varsPath: string): { updatedAt: string | null; variables: Record<string, unknown> } {
	try {
		return JSON.parse(fs.readFileSync(varsPath, "utf8"));
	} catch {
		return { updatedAt: null, variables: {} };
	}
}
function setVariable(jobId: string, name: string, value: string) {
	if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(name))
		throw new Error("variableName must be 1-80 chars: letters, numbers, _, ., :, or -");
	const job = loadJob(jobId);
	const current = readVariables(job.varsPath);
	current.variables[name] = value;
	current.updatedAt = new Date().toISOString();
	fs.writeFileSync(job.varsPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
	return { varsPath: job.varsPath, variables: current.variables, updatedAt: current.updatedAt };
}
async function executeTool(
	_toolCallId: string,
	params: Params,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const action = params.action || "status";
	const detection = detectTmux();
	if (action === "status")
		return { content: [{ type: "text", text: formatDetection(detection) }], details: { action, detection } };
	if (action === "setup_help")
		return { content: [{ type: "text", text: setupHelp(detection) }], details: { action, detection } };
	if (action === "guard") {
		const guard = await guardTmux(ctx, detection, "tmux-managed interactive subagent/provider orchestration");
		return { content: [{ type: "text", text: guard.text }], details: { action, detection, guard } };
	}
	if (action === "list_jobs")
		return { content: [{ type: "text", text: JSON.stringify(listJobs(), null, 2) }], details: { action } };
	if (action === "list_templates") {
		const summary = templateSummary();
		return {
			content: [{ type: "text", text: summary.text }],
			details: { action, templates: summary.templates, errors: summary.errors, templateDirs: templateDirs() },
		};
	}
	if (action === "show_template") {
		const template = requireTeamTemplate(params.teamTemplate || params.title);
		return { content: [{ type: "text", text: formatTemplate(template) }], details: { action, template } };
	}
	if (action === "job_status") {
		if (!params.jobId) throw new Error("job_status requires jobId");
		const job = loadJob(params.jobId);
		return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }], details: { action, job } };
	}
	if (action === "list_variables") {
		if (!params.jobId) throw new Error("list_variables requires jobId");
		const job = loadJob(params.jobId);
		return {
			content: [{ type: "text", text: JSON.stringify(job.variables || { variables: {} }, null, 2) }],
			details: { action, jobId: params.jobId, variables: job.variables },
		};
	}
	if (action === "set_variable") {
		if (!params.jobId) throw new Error("set_variable requires jobId");
		if (!params.variableName) throw new Error("set_variable requires variableName");
		const value = firstString(params.variableValue, params.body, params.status, "") || "";
		const result = setVariable(params.jobId, params.variableName, value);
		return {
			content: [
				{
					type: "text",
					text: `Set tmux job variable ${params.variableName} for ${params.jobId}. Workers read ${result.varsPath} only at the named decision point.`,
				},
			],
			details: { action, jobId: params.jobId, variableName: params.variableName, result },
		};
	}
	const guard = await guardTmux(ctx, detection, `tmux ${action}`);
	if (!guard.allowed)
		return { content: [{ type: "text", text: guard.text }], details: { action, detection, guard, skipped: true } };
	if (action === "stop_job") {
		if (!params.jobId) throw new Error("stop_job requires jobId");
		const job = loadJob(params.jobId);
		const result = stopTmuxSessionWithJobSignals(job.sessionName, [job], params.dryRun !== false, params.confirm);
		return {
			content: [{ type: "text", text: result.text }],
			details: {
				action,
				detection,
				jobId: params.jobId,
				sessionName: job.sessionName,
				dryRun: params.dryRun !== false,
				result,
			},
		};
	}
	if (action === "stop_session") {
		const sessionName = firstString(params.workspaceName, params.title);
		if (!sessionName) throw new Error("stop_session requires workspaceName or title with the tmux session name");
		const jobs = loadJobPlans().filter((job) => job.sessionName === sessionName);
		const result = stopTmuxSessionWithJobSignals(sessionName, jobs, params.dryRun !== false, params.confirm);
		return {
			content: [{ type: "text", text: result.text }],
			details: { action, detection, sessionName, dryRun: params.dryRun !== false, result },
		};
	}
	if (action === "workspace_plan" || action === "launch_workspace") {
		const plan = buildWorkspacePlan(ctx, params);
		const preview = formatWorkspacePreview(plan);
		if (action === "workspace_plan" || params.dryRun === true)
			return {
				content: [{ type: "text", text: `DRY RUN tmux workspace plan\n${preview}` }],
				details: { action, detection, dryRun: true, plan },
			};
		const panes = plan.agents.map((agent, index) => ({
			title: targetDisplayName(agent, index),
			cwd: agent.cwd || plan.cwd,
			command: agent.command || PROVIDER_COMMANDS[agent.provider || "custom"],
		}));
		const launch = launchTmuxSession(plan.sessionName, plan.cwd, panes);
		return {
			content: [
				{
					type: "text",
					text: `Launched tmux session '${plan.sessionName}'. Attach with: tmux attach -t ${plan.sessionName}`,
				},
			],
			details: { action, detection, runs: launch.runs, paneIds: launch.paneIds, plan },
		};
	}
	if (action === "fire_task") {
		const job = buildFireTaskPlan(ctx, params);
		if (params.dryRun === true)
			return {
				content: [{ type: "text", text: `DRY RUN tmux interactive task\n${formatFireTaskPreview(job)}` }],
				details: { action, detection, dryRun: true, job },
			};
		if (tmuxSessionExists(job.sessionName))
			throw new Error(
				`tmux session already exists: ${job.sessionName}. Use stop_job/stop_session first or choose a different workspaceName.`,
			);
		const archivedJobDir = prepareJobDirForLaunch(job, params.force);
		const panes = job.agents.map((agent) => ({
			title: agent.name,
			cwd: agent.cwd,
			command: agent.command || defaultProviderInvocation(agent.provider),
		}));
		const launch = launchTmuxSession(job.sessionName, job.cwd, panes);
		job.agents.forEach((agent, index) => {
			agent.paneId = launch.paneIds[index];
		});
		writeFireTaskFiles(job);
		const watcherPanes = startPaneWatchers(job);
		for (const agent of job.agents) {
			if (!agent.paneId) continue;
			injectPromptToPane(agent.paneId, fs.readFileSync(agent.promptPath, "utf8"), agent.provider);
		}
		return {
			content: [
				{
					type: "text",
					text: [
						`Launched tmux interactive fire-and-forget job ${job.id}.`,
						`Session: ${job.sessionName}`,
						`Attach: tmux attach -t ${job.sessionName}`,
						`Job state: ${job.jobPath}`,
						archivedJobDir ? `Archived previous job dir: ${archivedJobDir}` : undefined,
						"Completion: event-driven pane output watchers armed (no polling).",
					]
						.filter(Boolean)
						.join("\n"),
				},
			],
			details: { action, detection, job, runs: launch.runs, paneIds: launch.paneIds, watcherPanes, archivedJobDir },
		};
	}
	if (action === "notify") {
		const title = firstString(params.title, "Pi") || "Pi";
		const body = firstString(params.body, "Pi needs attention") || "Pi needs attention";
		const target = firstString(params.workspaceName, detection.currentSession, detection.sessions[0]);
		if (!target) throw new Error("notify requires an active tmux session or workspaceName target");
		const run = runTmux(["display-message", "-t", target, `${title}: ${body}`], 3_000);
		if (!run.ok) throw new Error(`tmux display-message failed: ${run.error || run.stderr || `exit ${run.status}`}`);
		return {
			content: [{ type: "text", text: `Sent tmux display-message to ${target}: ${title}` }],
			details: { action, detection, run },
		};
	}
	if (action === "set_status") {
		const key = safeStatusKey(params.statusKey);
		const value = firstString(params.status, params.body, "") || "";
		const target = firstString(params.workspaceName, detection.currentSession, detection.sessions[0]);
		const args = target
			? ["set-option", "-t", target, `@pi_${key}`, value]
			: ["set-option", "-g", `@pi_${key}`, value];
		const run = runTmux(args, 3_000);
		if (!run.ok) throw new Error(`tmux set-option failed: ${run.error || run.stderr || `exit ${run.status}`}`);
		return {
			content: [{ type: "text", text: `Set tmux user option @pi_${key}=${value}` }],
			details: { action, detection, run },
		};
	}
	if (action === "clear_status") {
		const key = safeStatusKey(params.statusKey);
		const target = firstString(params.workspaceName, detection.currentSession, detection.sessions[0]);
		const args = target ? ["set-option", "-u", "-t", target, `@pi_${key}`] : ["set-option", "-gu", `@pi_${key}`];
		const run = runTmux(args, 3_000);
		if (!run.ok) throw new Error(`tmux clear status failed: ${run.error || run.stderr || `exit ${run.status}`}`);
		return {
			content: [{ type: "text", text: `Cleared tmux user option @pi_${key}` }],
			details: { action, detection, run },
		};
	}
	throw new Error(`unsupported action: ${action}`);
}

function isFireTaskTerminal(job: FireTaskPlan): boolean {
	return job.agents.length > 0 && job.agents.every((agent) => agent.result !== undefined);
}

function readBoundedLogTail(filePath: string, maxBytes = 2048): string {
	try {
		const size = fs.statSync(filePath).size;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		const descriptor = fs.openSync(filePath, "r");
		try {
			fs.readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
		} finally {
			fs.closeSync(descriptor);
		}
		return buffer.toString("utf8").replace(/<(?=\/?untrusted_content\b)/gi, "&lt;");
	} catch {
		return "(no captured output)";
	}
}

function formatFireTaskHandoff(job: FireTaskPlan): string {
	const included = job.agents.slice(0, 4);
	return [
		`tmux background task terminal handoff: ${job.id}`,
		`session: ${job.sessionName}`,
		...included.flatMap((agent) => [
			`- ${agent.name}: ${agent.result?.status ?? "unknown"}`,
			`<untrusted_content source="tmux_agent:${job.id}:${agent.id}">`,
			readBoundedLogTail(agent.logPath),
			"</untrusted_content>",
		]),
		...(job.agents.length > included.length
			? [`- ${job.agents.length - included.length} additional agent handoff(s) omitted.`]
			: []),
		"This event woke the parent; do not poll. Continue safe scoped work from the bounded handoff and inspect terminal artifacts only if needed for a material claim.",
	].join("\n");
}

function markFireTaskNotified(job: FireTaskPlan): void {
	const current = JSON.parse(fs.readFileSync(job.jobPath, "utf8")) as FireTaskPlan;
	current.notifiedAt = new Date().toISOString();
	const temporaryPath = `${job.jobPath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporaryPath, job.jobPath);
	job.notifiedAt = current.notifiedAt;
}

export default function tmuxAgentManagerExtension(pi: ExtensionAPI) {
	let handoffContext: ExtensionContext | undefined;
	let handoffTail = Promise.resolve();
	const jobWatchers = new Map<string, fs.FSWatcher>();

	const closeJobWatchers = () => {
		for (const watcher of jobWatchers.values()) watcher.close();
		jobWatchers.clear();
	};

	const refreshJobHandoffs = async (ctx: ExtensionContext): Promise<void> => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const jobs = loadJobPlans().filter((job) => !job.parentSessionFile || job.parentSessionFile === sessionFile);
		for (const job of jobs) {
			if (!isFireTaskTerminal(job) || job.notifiedAt) continue;
			pi.sendMessage(
				{
					customType: "tmux-background-completion",
					content: formatFireTaskHandoff(job),
					display: true,
					details: {
						jobId: job.id,
						sessionName: job.sessionName,
						agents: job.agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.result?.status })),
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			markFireTaskNotified(job);
			if (ctx.hasUI) ctx.ui.notify(`tmux background task ${job.id} completed.`, "info");
		}

		const activeIds = new Set(jobs.filter((job) => !isFireTaskTerminal(job)).map((job) => job.id));
		for (const [jobId, watcher] of jobWatchers) {
			if (activeIds.has(jobId)) continue;
			watcher.close();
			jobWatchers.delete(jobId);
		}
		for (const job of jobs) {
			if (isFireTaskTerminal(job) || jobWatchers.has(job.id)) continue;
			try {
				const watcher = fs.watch(job.jobDir, { persistent: false }, (_event, fileName) => {
					if (fileName && !String(fileName).endsWith(".result.json") && String(fileName) !== "job.json") return;
					if (handoffContext) void queueJobHandoffRefresh(handoffContext);
				});
				watcher.on("error", (error) => {
					watcher.close();
					jobWatchers.delete(job.id);
					if (ctx.hasUI) ctx.ui.notify(`tmux completion signal failed for ${job.id}: ${error.message}`, "warning");
				});
				jobWatchers.set(job.id, watcher);
			} catch (error: unknown) {
				if (ctx.hasUI)
					ctx.ui.notify(`tmux completion signal failed for ${job.id}: ${errorMessage(error)}`, "warning");
			}
		}
	};

	function queueJobHandoffRefresh(ctx: ExtensionContext): Promise<void> {
		const refresh = handoffTail.then(() => refreshJobHandoffs(ctx));
		const guarded = refresh.catch((error: unknown) => {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`tmux terminal handoff failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		});
		handoffTail = guarded;
		return guarded;
	}

	pi.on("session_start", async (_event, ctx) => {
		handoffContext = ctx;
		closeJobWatchers();
		await queueJobHandoffRefresh(ctx);
	});
	pi.on("session_shutdown", async () => {
		handoffContext = undefined;
		closeJobWatchers();
		handoffTail = Promise.resolve();
	});

	pi.registerTool({
		name: "tmux_agent_manager",
		label: "tmux Agent Manager",
		description:
			"tmux-exclusive interactive agent/workspace manager for Windows/Linux/macOS environments where tmux is on PATH. Opens real provider CLIs in panes, injects prompts, captures output, and replaces cmux outside iOS/macOS cmux use.",
		promptSnippet:
			"Use tmux to launch managed interactive agent/provider panes with prompt injection, captured output, completion markers, shared variables, and final notifications.",
		promptGuidelines: [
			"Use tmux_agent_manager for Windows/Linux tmux-managed workers. Do not use cmux on Windows/Linux; cmux is macOS-only and manual-disabled there.",
			"Prefer action=fire_task for interactive worker batches. It returns after event watchers and prompts are armed; do not wait, poll, or peek for completion.",
			"Use action=list_templates/show_template before assembling repeated teams; pass teamTemplate when a built-in team fits.",
			"Use action=workspace_plan before launch_workspace when designing a pane layout.",
			"Use stop_job/stop_session dry-run first, then confirm=yes-tmux-stop for real cleanup.",
			"Do not put secrets in task text or command strings; prompts, commands, and logs persist under ~/.pi/agent/work/background/tmux-agent-manager/state/jobs.",
			"tmux display/status actions are metadata only; validate worker result/log files before claiming task completion.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("status"),
						Type.Literal("setup_help"),
						Type.Literal("guard"),
						Type.Literal("notify"),
						Type.Literal("set_status"),
						Type.Literal("clear_status"),
						Type.Literal("workspace_plan"),
						Type.Literal("launch_workspace"),
						Type.Literal("fire_task"),
						Type.Literal("job_status"),
						Type.Literal("list_jobs"),
						Type.Literal("set_variable"),
						Type.Literal("list_variables"),
						Type.Literal("list_templates"),
						Type.Literal("show_template"),
						Type.Literal("stop_job"),
						Type.Literal("stop_session"),
					],
					{
						description:
							"status, setup_help, guard, notify, set_status, clear_status, workspace_plan, launch_workspace, fire_task, job_status, list_jobs, set_variable, list_variables, list_templates, show_template, stop_job, or stop_session. Default status.",
					},
				),
			),
			title: Type.Optional(Type.String({ description: "Notification title or workspace title context." })),
			body: Type.Optional(
				Type.String({ description: "Notification body/status text, or fallback task text for fire_task." }),
			),
			subtitle: Type.Optional(
				Type.String({ description: "Accepted for cmux parity; tmux display-message ignores subtitle." }),
			),
			statusKey: Type.Optional(
				Type.String({
					description: "Status key for tmux set_status/clear_status. Stored as @pi_<key>. Default pi-agents.",
				}),
			),
			status: Type.Optional(Type.String({ description: "Status value for set_status." })),
			icon: Type.Optional(
				Type.String({ description: "Accepted for cmux parity; tmux display-message/user options ignore icon." }),
			),
			color: Type.Optional(
				Type.String({ description: "Accepted for cmux parity; tmux display-message/user options ignore color." }),
			),
			workspaceName: Type.Optional(
				Type.String({
					description:
						"tmux session name/title for workspace_plan/launch_workspace/fire_task, or target for notify/status.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for planned/launched agent workspace. Defaults to current cwd.",
				}),
			),
			teamTemplate: Type.Optional(
				Type.String({
					description:
						"Built-in team template name for workspace/fire_task, or target for show_template. Use list_templates first. Current templates include provider-prompt-smoke, full-provider-review, builder-validator, plus JSON templates under templates/.",
				}),
			),
			task: Type.Optional(
				Type.String({
					description: "Fire-and-forget worker objective. Required for fire_task unless body is provided.",
				}),
			),
			jobId: Type.Optional(
				Type.String({
					description: "Job id for fire_task (optional), job_status/list_variables/set_variable (required).",
				}),
			),
			variableName: Type.Optional(
				Type.String({
					description:
						"For set_variable: named condition/decision variable workers read only at the decision point.",
				}),
			),
			variableValue: Type.Optional(
				Type.String({ description: "For set_variable: value to write. body/status can also supply the value." }),
			),
			deadlineSeconds: Type.Optional(
				Type.Number({
					description:
						"For fire_task: seconds before each event-driven pane watcher records a timeout. Default 1200.",
					minimum: 5,
					maximum: MAX_DEADLINE_SECONDS,
				}),
			),
			agents: Type.Optional(
				Type.Array(
					Type.Object({
						provider: Type.Optional(
							Type.Union([
								Type.Literal("pi"),
								Type.Literal("codex"),
								Type.Literal("agy"),
								Type.Literal("claude"),
								Type.Literal("opencode"),
								Type.Literal("custom"),
							]),
						),
						name: Type.Optional(Type.String({ description: "Pane/worker name." })),
						command: Type.Optional(
							Type.String({
								description:
									"Interactive CLI start command for this pane, e.g. claude, agy, pi, or a custom wrapper CLI. The manager injects the prompt after launch and captures pane output.",
							}),
						),
						cwd: Type.Optional(Type.String({ description: "Optional per-agent cwd." })),
					}),
					{ description: "Agents/providers to lay out in tmux. Default: pi, agy, codex." },
				),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description:
						"Preview only when true. Launch actions run by default; stop actions remain previews by default.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For fire_task only: archive an existing job directory with the same jobId before launch. Existing tmux sessions are still refused; stop them first.",
				}),
			),
			confirm: Type.Optional(
				Type.String({ description: "Required for real stop_job/stop_session: yes-tmux-stop." }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await executeTool(toolCallId, params as Params, signal, onUpdate, ctx);
			await queueJobHandoffRefresh(ctx);
			return result;
		},
	});

	pi.registerCommand("tmux-agents", {
		description: "Check tmux availability and show managed-agent guidance.",
		handler: async (_args, ctx) => {
			const detection = detectTmux();
			const text = detection.cliAvailable
				? tmuxManagerInstructions("agent/provider", detection)
				: setupHelp(detection);
			ctx.ui.notify(text, detection.cliAvailable ? "info" : "warning");
		},
	});
}
