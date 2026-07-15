import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import {
	ensureFffNodePackage,
	type FffInstallOutcome,
	getLastFffInstallOutcome,
	getToolPath,
	loadAvailableFffNodePackage,
	probeVersion,
} from "../utils/tools-manager.ts";
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
 *   plus pinned uv and the Python interpreter resolved through it).
 * - "system": pi does not own the install (ripgrep and ollama). GUIDE MODE
 *   only -- exact manual steps are reported, never executed.
 */

export type DoctorToolKind = "managed" | "system";

export interface DoctorCheck {
	/** Stable identifier, e.g. "fff-node", "ripgrep", "ollama", "python". */
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
}

/** Minimal slice of OllamaRuntime the doctor needs -- lets tests inject a fake without touching the real runtime. */
export type DoctorOllamaRuntime = Pick<OllamaRuntime, "detect" | "installGuide">;

export interface DoctorDeps {
	loadAvailableFffNodePackage: () => unknown | undefined;
	ensureFffNodePackage: (silent?: boolean) => Promise<unknown | undefined>;
	getLastFffInstallOutcome: () => FffInstallOutcome | undefined;
	getRgPath: () => string | null;
	ensurePythonRuntime: (options: { silent: boolean }) => Promise<PythonRuntimeOutcome>;
	/** Best-effort `<command> --version` probe; undefined if it can't be run. Used only to enrich a status line, never for presence detection. */
	probeVersion: (command: string, versionArgs?: readonly string[]) => string | undefined;
	ollamaRuntime: DoctorOllamaRuntime;
}

export interface RunDoctorOptions {
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
	getRgPath: () => getToolPath("rg"),
	ensurePythonRuntime,
	probeVersion,
	ollamaRuntime: new OllamaRuntime({ agentDir: getAgentDir() }),
};

const RIPGREP_GUIDE = [
	"ripgrep (rg) was not found. Pi never runs installers itself -- manual steps (user-level, no sudo):",
	"  - macOS (Homebrew): brew install ripgrep",
	"  - Debian/Ubuntu: apt install ripgrep",
	"  - Arch: pacman -S ripgrep",
	"  - Or download a release: https://github.com/BurntSushi/ripgrep/releases",
];

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

/** SYSTEM tool: guide mode only, never installed by the doctor. */
function checkRipgrep(deps: DoctorDeps): DoctorCheck {
	const path = deps.getRgPath();
	if (!path) {
		return { id: "ripgrep", label: "ripgrep (rg)", kind: "system", present: false, guide: RIPGREP_GUIDE };
	}
	const version = firstLine(deps.probeVersion(path));
	return {
		id: "ripgrep",
		label: "ripgrep (rg)",
		kind: "system",
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

export async function runDoctor(
	deps: DoctorDeps = realDoctorDeps,
	options: RunDoctorOptions = {},
): Promise<DoctorReport> {
	const silent = options.silent ?? true;
	const [fffNode, ollama, python] = await Promise.all([
		checkFffNode(deps, silent),
		checkOllama(deps),
		checkPython(deps, silent),
	]);
	return { checks: [fffNode, checkRipgrep(deps), ollama, python] };
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
	return lines.join("\n");
}

/**
 * Best-effort preflight meant to be called right after `pi-adaptative update`
 * succeeds. Must never fail the update itself: any error here is swallowed
 * and reported as a skipped check, not surfaced as an update failure.
 */
export async function runUpdatePreflight(deps: DoctorDeps = realDoctorDeps): Promise<void> {
	try {
		const report = await runDoctor(deps);
		console.log(`\n${formatDoctorReport(report)}\n`);
	} catch (error) {
		console.log(chalk.dim(`(environment check skipped: ${error instanceof Error ? error.message : String(error)})`));
	}
}
