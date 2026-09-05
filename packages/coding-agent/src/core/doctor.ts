import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import {
	ensureFffNodePackage,
	ensureTool,
	type FffInstallOutcome,
	getLastFffInstallOutcome,
	loadAvailableFffNodePackage,
	probeVersion,
} from "../utils/tools-manager.ts";
import { type AgentDirectoryLayoutReport, inspectAgentDirectoryLayout } from "./agent-directory-layout.ts";
import { checkHerdrInstallation, provisionHerdr } from "./collaboration/herdr-provision.ts";
import { OllamaRuntime } from "./models/local-runtime.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "./python-runtime.ts";

/**
 * Environment doctor: verifies required tooling and installs what it safely
 * can, instead of leaving provisioning entirely to lazy first-use (the exact
 * gap behind "ran `pi-adaptative update` on another machine and fff-node
 * never got installed" -- see fff-lazy-install.test.ts/fff-search-tools.test.ts
 * for the underlying lazy-install fix; this module is the proactive half).
 *
 * Two tool kinds, two different postures:
 * - "managed": pi owns provisioning and attempts it when absent (fff-node,
 *   pinned rg/jq/uv, and the Python interpreter resolved through uv).
 * - "system": pi does not own the install (Ollama). GUIDE MODE only -- exact
 *   manual steps are reported, never executed.
 */

export type DoctorToolKind = "managed" | "system";

export interface DoctorCheck {
	/** Stable identifier, e.g. "fff-node", "ripgrep", "jq", "ollama", "python". */
	id: string;
	/** Human-readable label for the report. */
	label: string;
	kind: DoctorToolKind;
	present: boolean;
	/** Version/path/status summary, present or not. */
	detail?: string;
	/** Only set for a "managed" tool: whether an install was just attempted. */
	installAttempted?: boolean;
	/** Only set for a "system" tool that's missing: exact manual steps, never executed. */
	guide?: string[];
}

export interface DoctorReport {
	checks: DoctorCheck[];
	notices?: DoctorNotice[];
}

export interface DoctorNotice {
	id: string;
	label: string;
	detail: string;
}

/** Minimal slice of OllamaRuntime the doctor needs -- lets tests inject a fake without touching the real runtime. */
export type DoctorOllamaRuntime = Pick<OllamaRuntime, "detect" | "installGuide">;

export interface DoctorDeps {
	loadAvailableFffNodePackage: () => unknown | undefined;
	ensureFffNodePackage: (silent?: boolean) => Promise<unknown | undefined>;
	getLastFffInstallOutcome: () => FffInstallOutcome | undefined;
	ensureTool: (tool: "jq" | "jscpd" | "rg", silent: boolean) => Promise<string | undefined>;
	ensurePythonRuntime: (options: { silent: boolean }) => Promise<PythonRuntimeOutcome>;
	provisionHerdr: typeof provisionHerdr;
	/** Best-effort `<command> --version` probe; undefined if it can't be run. Used only to enrich a status line, never for presence detection. */
	probeVersion: (command: string, versionArgs?: readonly string[]) => string | undefined;
	ollamaRuntime: DoctorOllamaRuntime;
	inspectAgentDirectoryLayout: () => AgentDirectoryLayoutReport;
}

export interface RunDoctorOptions {
	/** Self-installers already provision Herdr with the activated release; extension updates must not install it. */
	includeHerdr?: boolean;
	/**
	 * Whether the fff-node managed install (if one is attempted) stays quiet.
	 * Default true, matching runUpdatePreflight's existing background
	 * behavior. The interactive `doctor` command passes `false` so a
	 * multi-second install doesn't read as a silent hang.
	 */
	silent?: boolean;
}

const realDoctorDeps: DoctorDeps = {
	loadAvailableFffNodePackage,
	ensureFffNodePackage,
	getLastFffInstallOutcome,
	ensureTool,
	ensurePythonRuntime,
	provisionHerdr,
	probeVersion,
	ollamaRuntime: new OllamaRuntime({ agentDir: getAgentDir() }),
	inspectAgentDirectoryLayout: () => inspectAgentDirectoryLayout(getAgentDir()),
};

function describeFffOutcome(outcome: FffInstallOutcome | undefined): string {
	switch (outcome?.status) {
		case "already-available":
			return "already available";
		case "installed":
			return "installed just now";
		case "offline":
			return "offline mode enabled, skipped";
		case "unsupported-platform":
			return "no native build for this platform";
		case "install-failed":
			return `install failed: ${outcome.reason}`;
		default:
			return "unavailable";
	}
}

/** First line only -- a compiled-features/build-flags tail (e.g. rg --version) is noise in a one-line status report. */
function firstLine(text: string | undefined): string | undefined {
	return text?.split("\n")[0];
}

/** MANAGED tool: pi owns this install path, so the doctor actually attempts it when missing. */
async function checkFffNode(deps: DoctorDeps, silent: boolean): Promise<DoctorCheck> {
	// Delegate entirely to ensureFffNodePackage rather than re-deriving "is it
	// already there" here: that function (and its offline/unsupported-platform/
	// cooldown handling, see tools-manager.ts) is the single source of truth for
	// whether an install should even be attempted -- the doctor must not
	// duplicate or second-guess that logic, only report its outcome honestly.
	const installed = await deps.ensureFffNodePackage(silent);
	const outcome = deps.getLastFffInstallOutcome();
	return {
		id: "fff-node",
		label: "FFF native search (@ff-labs/fff-node)",
		kind: "managed",
		present: Boolean(installed),
		installAttempted: outcome !== undefined && outcome.status !== "already-available",
		detail: describeFffOutcome(outcome),
	};
}

/** MANAGED tools: exact releases and checksums are owned by tools-manager. */
async function checkManagedDataTool(
	deps: DoctorDeps,
	tool: "jq" | "jscpd" | "rg",
	silent: boolean,
): Promise<DoctorCheck> {
	const path = await deps.ensureTool(tool, silent);
	const id = tool === "rg" ? "ripgrep" : tool;
	const label =
		tool === "rg" ? "ripgrep (rg)" : tool === "jscpd" ? "jscpd v5 (clone scanner)" : "jq (JSON projection)";
	if (!path) return { id, label, kind: "managed", present: false, detail: "managed install unavailable" };
	const version = firstLine(deps.probeVersion(path));
	return {
		id,
		label,
		kind: "managed",
		present: true,
		detail: version ? `${path} (${version})` : path,
	};
}

/** SYSTEM tool: guide mode only, never installed by the doctor (OllamaRuntime.installGuide() is itself already guide-mode-only). */
async function checkOllama(deps: DoctorDeps): Promise<DoctorCheck> {
	const status = await deps.ollamaRuntime.detect();
	if (!status.binaryPath) {
		return {
			id: "ollama",
			label: "Ollama (local model runtime)",
			kind: "system",
			present: false,
			guide: deps.ollamaRuntime.installGuide(),
		};
	}
	const version = firstLine(deps.probeVersion(status.binaryPath));
	const versionSuffix = version ? `, ${version}` : "";
	const activeStore = status.activeStore
		? `${status.activeStore.path} [${status.activeStore.kind}, ${status.activeStore.modelCount} model(s)]`
		: `none; pi-owned store ${status.ownedModelsDir} has ${status.ownedStore.modelCount} model(s)`;
	return {
		id: "ollama",
		label: "Ollama (local model runtime)",
		kind: "system",
		present: true,
		detail: `binary: ${status.binaryPath} [${status.binarySource}]${versionSuffix}; server: ${status.serverUp ? "up" : "down"} at ${status.serverUrl}; active store: ${activeStore}`,
	};
}

/** MANAGED tool: uv and Python share one deduplicated runtime manager with bounded provisioning. */
async function checkPython(deps: DoctorDeps, silent: boolean): Promise<DoctorCheck> {
	const outcome = await deps.ensurePythonRuntime({ silent });
	if (outcome.status !== "ready") {
		return {
			id: "python",
			label: "Python (uv-managed)",
			kind: "managed",
			present: false,
			detail: outcome.reason,
		};
	}
	return {
		id: "python",
		label: "Python (uv-managed)",
		kind: "managed",
		present: true,
		installAttempted: outcome.pythonInstalled,
		detail: `uv: ${outcome.uvPath}; python: ${outcome.pythonPath}${outcome.pythonInstalled ? " (installed just now)" : ""}`,
	};
}

function checkAgentDirectoryLayout(deps: DoctorDeps): DoctorNotice[] {
	const report = deps.inspectAgentDirectoryLayout();
	if (report.error) {
		return [
			{
				id: "agent-directory-layout",
				label: "Agent directory layout",
				detail: `could not inspect ${report.agentDir}: ${report.error}`,
			},
		];
	}
	if (report.unexpectedEntryCount === 0 && !report.truncated) return [];

	const listed = report.unexpectedEntries.join(", ");
	const omitted = report.unexpectedEntryCount - report.unexpectedEntries.length;
	const count = report.truncated ? `at least ${report.unexpectedEntryCount}` : String(report.unexpectedEntryCount);
	const listing = listed ? `: ${listed}${omitted > 0 ? ` (+${omitted} more)` : ""}` : "";
	const truncation = report.truncated ? `; scan stopped after ${report.scannedEntries} entries` : "";
	return [
		{
			id: "agent-directory-layout",
			label: "Agent directory layout",
			detail: `${count} unexpected root entr${report.unexpectedEntryCount === 1 ? "y" : "ies"}${listing}${truncation}. Extension data belongs under state/extensions, cache/extensions, or leased work/extensions`,
		},
	];
}

export async function runDoctor(
	deps: DoctorDeps = realDoctorDeps,
	options: RunDoctorOptions = {},
): Promise<DoctorReport> {
	const silent = options.silent ?? true;
	const [fffNode, ripgrep, jq, jscpd, ollama, python, herdr] = await Promise.all([
		checkFffNode(deps, silent),
		checkManagedDataTool(deps, "rg", silent),
		checkManagedDataTool(deps, "jq", silent),
		checkManagedDataTool(deps, "jscpd", silent),
		checkOllama(deps),
		checkPython(deps, silent),
		options.includeHerdr === false ? undefined : checkHerdrInstallation({ silent }, deps.provisionHerdr),
	]);
	const checks: DoctorCheck[] = [fffNode, ripgrep, jq, jscpd, ollama, python];
	const notices = checkAgentDirectoryLayout(deps);
	if (herdr) {
		const result = { id: "herdr", label: "Herdr (optional collaboration)", detail: herdr.detail };
		if (herdr.present) checks.push({ ...result, kind: "managed", present: true });
		else notices.push(result);
	}
	return { checks, notices };
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [];
	for (const check of report.checks) {
		const status = check.present ? chalk.green("[OK]") : chalk.yellow("[MISSING]");
		const detail = check.detail ? ` -- ${check.detail}` : "";
		lines.push(`${status} ${check.label}${detail}`);
		if (!check.present && check.guide) {
			for (const guideLine of check.guide) lines.push(`  ${guideLine}`);
		}
	}
	for (const notice of report.notices ?? []) {
		lines.push(`${chalk.yellow("[WARN]")} ${notice.label} -- ${notice.detail}`);
	}
	return lines.join("\n");
}

/**
 * Best-effort preflight meant to be called right after `pi-adaptative update`
 * succeeds. Must never fail the update itself: any error here is swallowed
 * and reported as a skipped check, not surfaced as an update failure.
 */
export async function runUpdatePreflight(deps: DoctorDeps = realDoctorDeps): Promise<void> {
	try {
		// The standalone installer reports Herdr from the newly activated binary. Do not repeat
		// that install from an older updater, or introduce it on extension-only/help commands.
		const report = await runDoctor(deps, { includeHerdr: false });
		console.log(`\n${formatDoctorReport(report)}\n`);
	} catch (error) {
		console.log(chalk.dim(`(environment check skipped: ${error instanceof Error ? error.message : String(error)})`));
	}
}
