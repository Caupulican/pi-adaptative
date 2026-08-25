import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installerPath = join(repositoryRoot, "install.ps1");
const installer = readFileSync(installerPath, "utf8");

function powershellExecutable() {
	for (const command of ["pwsh", "powershell.exe"]) {
		const probe = spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
			encoding: "utf8",
		});
		if (probe.status === 0) return command;
	}
	return null;
}

function powershellPath(shell, value) {
	if (/^[A-Za-z]:[\\/]/u.test(value)) return value.replaceAll("/", "\\");
	const wslDrivePath = value.match(/^\/mnt\/([A-Za-z])\/(.*)$/u);
	if (wslDrivePath) return `${wslDrivePath[1].toUpperCase()}:\\${wslDrivePath[2].replaceAll("/", "\\")}`;
	const tempPath = execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$env:TEMP"], { encoding: "utf8" }).trim();
	if (/^[A-Za-z]:[\\/]/u.test(tempPath)) {
		const drive = tempPath[0].toUpperCase();
		return `${drive}:${value.replaceAll("/", "\\")}`;
	}
	return value;
}

function powershellTempDirectory(shell) {
	const tempPath = execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$env:TEMP"], { encoding: "utf8" }).trim();
	const drivePath = tempPath.match(/^([A-Za-z]):\\(.*)$/u);
	if (drivePath) return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll("\\", "/")}`;
	return tempPath || tmpdir();
}

function createReleaseFixture(root, version, reportedVersion, checksum = true, shell) {
	const fixture = join(root, `release-${version}`);
	const payload = join(fixture, "payload");
	mkdirSync(join(payload, "docs"), { recursive: true });
	writeFileSync(join(payload, "pi.exe"), `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${reportedVersion}'; else printf 'fixture\\n'; fi\n`);
	chmodSync(join(payload, "pi.exe"), 0o755);
	writeFileSync(join(payload, "docs", "retained.txt"), "complete release tree\n");
	const archive = join(fixture, "pi-windows-x64.zip");
	const quote = (value) => `'${value.replaceAll("'", "''")}'`;
	execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path ${quote(powershellPath(shell, join(payload, "*")))} -DestinationPath ${quote(powershellPath(shell, archive))} -Force`]);
	const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
	writeFileSync(join(fixture, "SHA256SUMS"), `${checksum ? digest : "0".repeat(64)}  pi-windows-x64.zip\n`);
	return fixture;
}

function runOfflineInstaller(shell, environment, candidateInstallerPath = installerPath) {
	const values = {
		PROCESSOR_ARCHITECTURE: "AMD64",
		PROCESSOR_ARCHITEW6432: "",
		PI_INSTALL_TEST_MODE: "1",
		PI_INSTALL_TEST_ASSUME_WINDOWS: "1",
		PI_INSTALL_TEST_SKIP_PATH: "1",
		...environment,
	};
	const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
	const assignments = Object.entries(values).map(([name, value]) => `$env:${name}=${quote(value)}`).join("; ");
	const command = `${assignments}; & ${quote(candidateInstallerPath)}`;
	return spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
		encoding: "utf8",
		env: process.env,
	});
}

test("Windows installer is a self-contained, owned-release PowerShell script", () => {
	assert.ok(existsSync(installerPath));
	assert.match(installer, /Caupulican\/pi-adaptative/u);
	assert.match(installer, /api\.github\.com\/repos\/Caupulican\/pi-adaptative\/releases\/latest/u);
	assert.match(installer, /releases\/download\/\$Version/u);
	assert.match(installer, /PROCESSOR_ARCHITEW6432/u);
	assert.match(installer, /AMD64/u);
	assert.match(installer, /ARM64/u);
	assert.match(installer, /PlatformID\]::Win32NT/u);
	assert.match(installer, /WSL_INTEROP/u);
	assert.match(installer, /MSYSTEM/u);
	assert.match(installer, /PI_VERSION/u);
	assert.match(installer, /SHA256SUMS/u);
	assert.match(installer, /System\.Security\.Cryptography\.SHA256\]::Create/u);
	assert.match(installer, /ComputeHash\(\$stream\)/u);
	assert.doesNotMatch(installer, /Get-FileHash/u);
	assert.match(installer, /exactly one valid checksum entry/u);
	assert.match(installer, /Split\('\/'\) -contains '\.\.'/u);
	assert.match(installer, /Expand-Archive/u);
	assert.match(installer, /current\.version/u);
	assert.match(installer, /PI_ADAPTATIVE_MANAGED_LAUNCHER/u);
	assert.match(installer, /Mutex/u);
	assert.match(installer, /Invoke-VersionSmoke/u);
	assert.match(installer, /output -ne \$expected/u);
	assert.match(installer, /PI_INSTALL_TEST_MODE[\s\S]*Copy-Item/u);
	assert.match(installer, /PI_INSTALL_TEST_SKIP_PATH/u);
	assert.match(installer, /Prune-Releases/u);
	assert.doesNotMatch(installer, /\bnpm\b/iu);
	assert.doesNotMatch(installer, /\bnode(?:\.js)?\b/iu);
	assert.doesNotMatch(installer, /pi\.dev/iu);
	assert.doesNotMatch(installer, /badlogic\/pi-mono/iu);
	assert.doesNotMatch(installer, /@earendil-works/iu);
	assert.doesNotMatch(installer, /@mariozechner/iu);
	assert.doesNotMatch(installer, /\$PSScriptRoot/iu);
});

test("Windows installer parses as PowerShell", (context) => {
	const shell = powershellExecutable();
	if (!shell) {
		context.skip("PowerShell is not available on this host");
		return;
	}
	const escaped = installerPath.replace(/'/g, "''");
	const script = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`;
	const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("installer rejects non-Windows hosts before any network request", (context) => {
	if (process.platform === "win32") {
		context.skip("host is Windows; do not run the installer against a live release");
		return;
	}
	const shell = powershellExecutable();
	if (!shell) {
		context.skip("PowerShell is not available on this host");
		return;
	}
	const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", installerPath], {
		encoding: "utf8",
		env: { ...process.env, PI_VERSION: "v0.97.0" },
	});
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}\n${result.stderr}`, /Windows PowerShell|Linux|macOS|WSL|Git Bash/iu);
});

test("release version resolution has one latest lookup and pinned asset URLs", () => {
	const latestLookups = installer.match(/api\.github\.com\/repos\/Caupulican\/pi-adaptative\/releases\/latest/g) ?? [];
	assert.equal(latestLookups.length, 1);
	assert.match(installer, /Assert-Version \$version/u);
	assert.match(installer, /\$baseUrl\/SHA256SUMS/u);
	assert.match(installer, /\$baseUrl\/\$assetName/u);
});

test("checksum verification works in native Windows PowerShell without Get-FileHash", (context) => {
	const shell = "powershell.exe";
	const probe = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
		encoding: "utf8",
	});
	if (probe.status !== 0) {
		context.skip("native Windows PowerShell is not available on this host");
		return;
	}

	const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : powershellTempDirectory(shell), "pi-windows-powershell-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const nativeInstallerPath = join(root, "install.ps1");
	writeFileSync(nativeInstallerPath, installer);
	const fixture = createReleaseFixture(root, "1.2.3", "1.2.3", true, shell);
	const result = runOfflineInstaller(
		shell,
		{
			PI_VERSION: "v1.2.3",
			PI_INSTALL_TEST_BASE_URL: powershellPath(shell, fixture),
			PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.3",
			PI_INSTALL_DIR: powershellPath(shell, join(root, "install")),
			PI_BIN_DIR: powershellPath(shell, join(root, "bin")),
		},
		powershellPath(shell, nativeInstallerPath),
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("offline Windows installer verifies, activates the complete tree, rolls back, and retains two releases", (context) => {
	const shell = powershellExecutable();
	if (!shell || process.platform === "win32") {
		context.skip("offline Linux-hosted PowerShell harness is only run on this host");
		return;
	}
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-windows-installer-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const firstFixture = createReleaseFixture(root, "1.2.3", "1.2.3", true, shell);
	const first = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, firstFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.3",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.3");
	assert.equal(readFileSync(join(installRoot, "releases", "v1.2.3", "docs", "retained.txt"), "utf8"), "complete release tree\n");
	const marker = join(installRoot, "releases", "v1.2.3", ".pi-adaptative-managed");
	assert.equal(readFileSync(marker, "utf8"), "pi-adaptative-managed-release-v1\r\n");
	rmSync(marker);
	const legacyRepeat = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, firstFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.3",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.equal(legacyRepeat.status, 0, `${legacyRepeat.stdout}\n${legacyRepeat.stderr}`);
	assert.equal(readFileSync(marker, "utf8").replaceAll("\r\n", "\n"), "pi-adaptative-managed-release-v1\n");

	const secondFixture = createReleaseFixture(root, "1.2.4", "1.2.4", true, shell);
	const second = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.4",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, secondFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.4",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.4");
	const unknownRelease = join(installRoot, "releases", "v9.9.9");
	mkdirSync(unknownRelease, { recursive: true });
	const unknownSentinel = join(unknownRelease, "do-not-delete.txt");
	writeFileSync(unknownSentinel, "unmanaged\n");

	const badVersionFixture = createReleaseFixture(root, "1.2.5", "9.9.9", true, shell);
	const badVersion = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.5",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, badVersionFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "9.9.9",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.notEqual(badVersion.status, 0);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.4");
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.5")), false);

	const badChecksumFixture = createReleaseFixture(root, "1.2.6", "1.2.6", false, shell);
	const badChecksum = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.6",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, badChecksumFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.6",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.notEqual(badChecksum.status, 0);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.4");
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.6")), false);

	const unownedFixture = createReleaseFixture(root, "1.2.6-unowned", "1.2.6", true, shell);
	const unownedTarget = join(installRoot, "releases", "v1.2.6");
	mkdirSync(unownedTarget, { recursive: true });
	const unownedSentinel = join(unownedTarget, "do-not-touch.txt");
	writeFileSync(unownedSentinel, "unmanaged\n");
	const unownedTargetAttempt = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.6",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, unownedFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.6",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.notEqual(unownedTargetAttempt.status, 0);
	assert.match(`${unownedTargetAttempt.stdout}\n${unownedTargetAttempt.stderr}`, /unowned|existing release/iu);
	assert.equal(readFileSync(unownedSentinel, "utf8"), "unmanaged\n");

	const thirdFixture = createReleaseFixture(root, "1.2.5", "1.2.5", true, shell);
	const third = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.5",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, thirdFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.5",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
	assert.equal(readFileSync(unknownSentinel, "utf8"), "unmanaged\n");
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.3")), false);
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.4")), true);
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.5")), true);
});

if (process.env.PI_WINDOWS_INSTALLER_DEBUG === "1") {
	const shell = powershellExecutable();
	if (shell) {
		console.log(execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" }).trim());
	}
}
