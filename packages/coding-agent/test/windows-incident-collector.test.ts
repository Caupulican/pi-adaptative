import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";

function resolvePowerShell(): string | undefined {
	const configured = process.env.PI_TEST_POWERSHELL;
	if (configured) return configured;
	try {
		return getShellConfig(undefined, "powershell").shell;
	} catch {
		return undefined;
	}
}

const powerShell = resolvePowerShell();
const collectorPath = resolve(process.cwd(), "../../scripts/collect-pi-incident.ps1");
const wslCollectorPath = resolve(process.cwd(), "../../scripts/collect-pi-incident.sh");
const scratchDirectories: string[] = [];

const powerShellRunsOnWindows =
	powerShell !== undefined &&
	spawnSync(
		powerShell,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::OSVersion.Platform"],
		{ encoding: "utf8", timeout: 5_000, windowsHide: true },
	).stdout.trim() === "Win32NT";

function pathForPowerShell(path: string): string {
	if (process.platform === "win32" || !powerShellRunsOnWindows) return path;
	const converted = spawnSync("wslpath", ["-w", path], {
		encoding: "utf8",
		timeout: 5_000,
	}).stdout.trim();
	if (!converted) throw new Error(`Could not convert WSL path for native PowerShell: ${path}`);
	return converted;
}

function createScratchDirectory(): string {
	const directory = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-windows-incident-"));
	scratchDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of scratchDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.runIf(process.platform === "win32" || powerShell !== undefined)("native Windows incident collector", () => {
	it("packages the affected evidence and excludes credential/configuration stores", () => {
		if (!powerShell) throw new Error("PowerShell is required on Windows");

		const root = createScratchDirectory();
		const agentDir = join(root, "agent dir");
		const sessionDir = join(agentDir, "sessions", "project with spaces");
		const stateDir = join(agentDir, "state");
		const orchestrationKey = `affected-session-${createHash("sha256").update("affected-session").digest("hex").slice(0, 16)}`;
		const orchestrationDir = join(stateDir, "orchestration", "sessions", orchestrationKey);
		const outputDir = root;
		const localCollectorPath = join(root, "collect-pi-incident.ps1");
		const tuiLog = join(root, "native-tui.log");
		const commandLog = join(root, "native-command.log");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(orchestrationDir, { recursive: true });
		copyFileSync(collectorPath, localCollectorPath);

		const oldSession = join(sessionDir, "old.jsonl");
		const affectedSession = join(sessionDir, "affected.jsonl");
		const autoLearnSession = join(sessionDir, "auto-learn.jsonl");
		writeFileSync(
			oldSession,
			'{"type":"session","id":"old-session","timestamp":"2026-01-01T10:00:00Z"}\nold evidence\n',
		);
		writeFileSync(
			affectedSession,
			[
				'{"type":"session","id":"affected-session","timestamp":"2026-01-02T10:00:00Z"}',
				'{"type":"message","timestamp":"2026-01-02T10:30:00Z","marker":"native failure marker"}',
				"",
			].join("\n"),
		);
		writeFileSync(
			autoLearnSession,
			'{"type":"session","id":"auto-learn-newest","timestamp":"2026-01-03T10:00:00Z"}\nautomatic evidence\n',
		);
		utimesSync(oldSession, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
		utimesSync(affectedSession, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
		utimesSync(autoLearnSession, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));

		writeFileSync(
			join(stateDir, "tool-recovery-events.jsonl"),
			[
				'{"ts":"2026-01-02T10:10:00Z","sessionId":"affected-session","marker":"matching recovery"}',
				'{"ts":"2026-01-02T10:15:00Z","sessionId":"other-session","marker":"unrelated recovery"}',
				"",
			].join("\n"),
		);
		writeFileSync(
			join(stateDir, "failure-corpus.jsonl"),
			[
				'{"ts":"2026-01-02T10:20:00Z","marker":"matching failure"}',
				'{"ts":"2026-01-01T10:20:00Z","marker":"unrelated failure"}',
				"",
			].join("\n"),
		);
		writeFileSync(join(orchestrationDir, "events.jsonl"), "orchestration marker\n");
		writeFileSync(tuiLog, "tui marker\n");
		writeFileSync(commandLog, "command marker\n");

		for (const sensitiveName of ["auth.json", "settings.json", ".env", "vault.json"]) {
			writeFileSync(join(agentDir, sensitiveName), `secret from ${sensitiveName}\n`);
		}

		const collectorEnv: NodeJS.ProcessEnv = { ...process.env, PI_TUI_WRITE_LOG: tuiLog };
		if (process.platform !== "win32" && powerShellRunsOnWindows) {
			collectorEnv.WSLENV = [process.env.WSLENV, "PI_TUI_WRITE_LOG/p"].filter(Boolean).join(":");
		}
		const collected = spawnSync(
			powerShell,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				pathForPowerShell(localCollectorPath),
				"-AgentDir",
				pathForPowerShell(agentDir),
				"-CommandLog",
				pathForPowerShell(commandLog),
			],
			{
				encoding: "utf8",
				env: collectorEnv,
				timeout: 30_000,
				windowsHide: true,
			},
		);
		expect(collected.status, collected.stderr || collected.stdout).toBe(0);

		const archives = readdirSync(outputDir).filter((name) => /^pi-incident-.*\.zip$/u.test(name));
		expect(archives).toHaveLength(1);
		const archivePath = join(outputDir, archives[0]);
		const extractedDir = join(root, "extracted");
		const extractScript = join(root, "extract.ps1");
		writeFileSync(
			extractScript,
			'param([string]$Archive, [string]$Destination)\n$ErrorActionPreference = "Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n',
		);
		const extracted = spawnSync(
			powerShell,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				pathForPowerShell(extractScript),
				"-Archive",
				pathForPowerShell(archivePath),
				"-Destination",
				pathForPowerShell(extractedDir),
			],
			{ encoding: "utf8", timeout: 30_000, windowsHide: true },
		);
		expect(extracted.status, extracted.stderr || extracted.stdout).toBe(0);
		const extractedEntries = readdirSync(extractedDir, { recursive: true }).map((entry) => entry.toString());
		const extractedSession = join(extractedDir, "session", basename(affectedSession));
		expect(existsSync(extractedSession), extractedEntries.join("\n")).toBe(true);

		expect(readFileSync(extractedSession, "utf8"), extractedEntries.join("\n")).toContain("native failure marker");
		const recoveryEvents = readFileSync(join(extractedDir, "state", "tool-recovery-events.jsonl"), "utf8");
		expect(recoveryEvents).toContain("matching recovery");
		expect(recoveryEvents).not.toContain("unrelated recovery");
		const failureCorpus = readFileSync(join(extractedDir, "state", "failure-corpus.jsonl"), "utf8");
		expect(failureCorpus).toContain("matching failure");
		expect(failureCorpus).not.toContain("unrelated failure");
		expect(
			readFileSync(
				join(extractedDir, "state", "orchestration", "sessions", orchestrationKey, "events.jsonl"),
				"utf8",
			),
		).toContain("orchestration marker");
		expect(readFileSync(join(extractedDir, "command-logs", basename(commandLog)), "utf8")).toContain(
			"command marker",
		);
		expect(readFileSync(join(extractedDir, "tui", basename(tuiLog)), "utf8")).toContain("tui marker");
		expect(readFileSync(join(extractedDir, "diagnostics", "environment.txt"), "utf8")).toContain("selected_session=");
		const manifest = readFileSync(join(extractedDir, "manifest.txt"), "utf8");
		expect(manifest).toContain("Affected session ID: affected-session");
		expect(manifest).toContain(
			"Incident window (UTC): 2026-01-02T09:45:00.0000000+00:00 through 2026-01-02T10:45:00.0000000+00:00",
		);
		expect(existsSync(join(extractedDir, "session", basename(autoLearnSession)))).toBe(false);

		const collectedNames = extractedEntries.map((entry) => basename(entry));
		for (const sensitiveName of ["auth.json", "settings.json", ".env", "vault.json"]) {
			expect(collectedNames).not.toContain(sensitiveName);
		}
	});
});

describe.skipIf(process.platform === "win32")("WSL incident collector", () => {
	it("collects the current session-owned orchestration namespace", () => {
		const root = createScratchDirectory();
		const agentDir = join(root, "agent");
		const sessionDir = join(agentDir, "sessions", "project");
		const stateDir = join(agentDir, "state");
		const sessionId = "affected-session";
		const orchestrationKey = `${sessionId}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
		const orchestrationDir = join(stateDir, "orchestration", "sessions", orchestrationKey);
		const outputDir = join(root, "output");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(orchestrationDir, { recursive: true });
		writeFileSync(join(sessionDir, "affected.jsonl"), `{"type":"session","id":"${sessionId}"}\nsession marker\n`);
		writeFileSync(join(stateDir, "tool-recovery-events.jsonl"), "recovery marker\n");
		writeFileSync(join(stateDir, "failure-corpus.jsonl"), "failure marker\n");
		writeFileSync(join(orchestrationDir, "events.jsonl"), "current orchestration marker\n");

		const collected = spawnSync("bash", [wslCollectorPath, "--agent-dir", agentDir, "--output-dir", outputDir], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(collected.status, collected.stderr || collected.stdout).toBe(0);

		const archives = readdirSync(outputDir).filter((name) => /^pi-incident-.*\.zip$/u.test(name));
		expect(archives).toHaveLength(1);
		const extractedDir = join(root, "extracted-wsl");
		mkdirSync(extractedDir);
		const extracted = spawnSync("python3", ["-m", "zipfile", "-e", join(outputDir, archives[0]), extractedDir], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(extracted.status, extracted.stderr || extracted.stdout).toBe(0);
		expect(
			readFileSync(
				join(extractedDir, "state", "orchestration", "sessions", orchestrationKey, "events.jsonl"),
				"utf8",
			),
		).toContain("current orchestration marker");
	});
});
