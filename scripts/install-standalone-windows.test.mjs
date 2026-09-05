import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";

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
	if (process.platform === "win32") return tempPath || tmpdir();
	const drivePath = tempPath.match(/^([A-Za-z]):\\(.*)$/u);
	if (drivePath) return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll("\\", "/")}`;
	return tempPath || tmpdir();
}

let nativeFixtureCompiler;
let nativeFixtureCompilerChecked = false;
let sharedFixtureRoot;
let sharedFixtureExecutable;

function getNativeFixtureCompiler() {
	if (!nativeFixtureCompilerChecked) {
		nativeFixtureCompilerChecked = true;
		const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
		if (result.error?.code === "ENOENT") return undefined;
		assert.equal(result.status, 0, `native fixture compiler probe failed: ${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
		nativeFixtureCompiler = "powershell.exe";
	}
	return nativeFixtureCompiler;
}

function fixturePowerShellExecutable() {
	// Never substitute shell text for a Windows executable when the native compiler is absent.
	return getNativeFixtureCompiler() ? powershellExecutable() : null;
}

function assertWindowsPe(executable) {
	const bytes = readFileSync(executable);
	assert.ok(bytes.length >= 64 && bytes.subarray(0, 2).toString("ascii") === "MZ", "fixture must be a Windows PE, not shell text");
	const offset = bytes.readUInt32LE(60);
	assert.ok(offset >= 64 && offset <= bytes.length - 4 && bytes.subarray(offset, offset + 4).equals(Buffer.from([80, 69, 0, 0])), "fixture must contain a valid PE signature");
}

test("Windows fixture validation rejects shell text and 16-bit headers before packaging or launch", (context) => {
	const root = mkdtempSync(join(tmpdir(), "pi-fixture-header-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "not-an-executable.bin");
	writeFileSync(file, "#!/bin/sh\nexit 0\n");
	assert.throws(() => assertWindowsPe(file), /Windows PE/u);
	const legacy = Buffer.alloc(128);
	legacy.write("MZ", 0, "ascii");
	legacy.writeUInt32LE(64, 60);
	legacy.write("NE", 64, "ascii");
	writeFileSync(file, legacy);
	assert.throws(() => assertWindowsPe(file), /PE signature/u);
});

function getSharedWindowsFixture() {
	if (sharedFixtureExecutable) return sharedFixtureExecutable;
	const compiler = getNativeFixtureCompiler();
	assert.ok(compiler, "native Windows PowerShell is required to compile the real PE fixture");
	sharedFixtureRoot = mkdtempSync(join(powershellTempDirectory(compiler), "pi-installer-pe-fixture-"));
	const executable = join(sharedFixtureRoot, "pi-fixture.exe");
	const code = `using System; using System.IO;
public class PiFixture {
 public static int Main(string[] args) {
  string[] version = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "pi.fixture"));
  if (args.Length == 1 && args[0] == "--version") { Console.WriteLine(version[0]); return 0; }
  string log = Environment.GetEnvironmentVariable("PI_TEST_HERDR_LOG");
  if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, typeof(PiFixture).Assembly.Location + "|" + String.Join(" ", args) + "|" + Environment.GetEnvironmentVariable("PATH") + "\\n");
  if (args.Length != 1 || args[0] != "--provision-herdr") return 90;
  string root = Environment.GetEnvironmentVariable("PI_INSTALL_DIR");
  if (!String.IsNullOrEmpty(root) && File.ReadAllText(Path.Combine(root, "current.version")).Trim() != version[1]) return 91;
  int status; Int32.TryParse(Environment.GetEnvironmentVariable("PI_TEST_HERDR_EXIT"), out status);
  Console.WriteLine(status == 0 ? "[OK] Herdr fixture available" : "Herdr fixture download denied");
  return status;
 }
}`;
	const quote = (value) => `'${value.replaceAll("'", "''")}'`;
	execFileSync(compiler, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Add-Type -TypeDefinition ${quote(code)} -OutputAssembly ${quote(powershellPath(compiler, executable))} -OutputType ConsoleApplication`]);
	assertWindowsPe(executable);
	sharedFixtureExecutable = executable;
	return executable;
}

after(() => { if (sharedFixtureRoot) rmSync(sharedFixtureRoot, { recursive: true, force: true }); });

function createReleaseFixture(root, version, reportedVersion, checksum = true, shell) {
	const fixture = join(root, `release-${version}`);
	const payload = join(fixture, "payload");
	mkdirSync(join(payload, "docs"), { recursive: true });
	copyFileSync(getSharedWindowsFixture(), join(payload, "pi.exe"));
	chmodSync(join(payload, "pi.exe"), 0o755);
	assertWindowsPe(join(payload, "pi.exe"));
	writeFileSync(join(payload, "pi.fixture"), `${reportedVersion}\nv${version}\n`);
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

function normalizePowerShellDiagnostic(output) {
	return stripVTControlCharacters(output).replace(/\s+\|\s+/gu, " ").replace(/\s+/gu, " ").trim();
}

test("normalizes PowerShell diagnostics without changing semantic text", () => {
	const formatted = [
		"\u001b[31;1mException: /tmp/install.ps1:16\u001b[0m",
		"Line |",
		" 16 | throw 'Pi Adaptative installer: staged pi.exe --version did not report exactly'",
		"    | ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
		"    | Pi Adaptative installer: staged pi.exe --version did not report exactly",
		"    | 1.2.3.",
	].join("\n");
	const normalized = normalizePowerShellDiagnostic(formatted);
	assert.match(normalized, /did not report exactly 1\.2\.3\./u);
	assert.doesNotMatch(normalized, /\s\|\s/u);
	assert.equal(normalizePowerShellDiagnostic("plain diagnostic"), "plain diagnostic");
	assert.equal(normalizePowerShellDiagnostic("plain|diagnostic"), "plain|diagnostic");
});

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
	assert.match(installer, /\[System\.IO\.Directory\]::Move\(\$Source, \$Destination\)/u);
	assert.doesNotMatch(installer, /Move-Item -LiteralPath \$Source -Destination \$Destination/u);
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
	const shell = fixturePowerShellExecutable();
	if (!shell || process.platform === "win32") {
		context.skip("requires Linux-hosted PowerShell and the native Windows PE fixture compiler");
		return;
	}
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-windows-installer-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const firstFixture = createReleaseFixture(root, "1.2.3", "1.2.3", true, shell);
	const first = runOfflineInstaller(shell, {
		LOCALAPPDATA: "",
		USERPROFILE: "",
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
	assert.equal(
		existsSync(join(installRoot, "releases", "v1.2.3")),
		false,
		`expected v1.2.3 to be pruned\nstdout:\n${third.stdout}\nstderr:\n${third.stderr}`,
	);
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.4")), true);
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.5")), true);
});

test("Herdr native Windows skips legacy and noncanonical verified versions without invoking the flag", (context) => {
	const shell = getNativeFixtureCompiler();
	if (!shell) { context.skip("native Windows PowerShell is unavailable"); return; }
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-herdr-legacy-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const nativeInstaller = join(root, "install.ps1");
	writeFileSync(nativeInstaller, installer);
	for (const version of ["0.98.0", "0.10.2", "0.098.1", "0.98.1-rc.1", "9999999999.0.0"]) {
		const fixture = createReleaseFixture(root, version, version, true, shell);
		const installRoot = join(root, `install-${version}`);
		const log = join(root, `herdr-${version}.log`);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = runOfflineInstaller(shell, {
				PI_VERSION: `v${version}`, PI_INSTALL_TEST_BASE_URL: powershellPath(shell, fixture),
				PI_INSTALL_DIR: powershellPath(shell, installRoot), PI_BIN_DIR: powershellPath(shell, join(root, `bin-${version}`)),
				PI_TEST_HERDR_LOG: powershellPath(shell, log),
			}, powershellPath(shell, nativeInstaller));
			assert.equal(result.status, 0, `${version}: ${result.stdout}\n${result.stderr}`);
			assert.match(normalizePowerShellDiagnostic(result.stdout), /Skipping Herdr.*0\.98\.1/u);
			assert.equal(existsSync(log), false, `legacy flag invoked for ${version}`);
			assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), `v${version}`);
		}
	}
});

for (const version of ["0.98.1", "1.2.3"]) test(`Herdr ${version} native Windows provisioning runs after activation on fresh/repeated installs and stays optional`, (context) => {
	const shell = getNativeFixtureCompiler();
	if (!shell) { context.skip("native Windows PowerShell is unavailable"); return; }
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-herdr installer-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const nativeInstaller = join(root, "install.ps1");
	writeFileSync(nativeInstaller, installer);
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const log = join(root, "herdr.log");
	const fixture = createReleaseFixture(root, version, version, true, shell);
	const environment = {
		PI_VERSION: `v${version}`, PI_INSTALL_TEST_BASE_URL: powershellPath(shell, fixture),
		PI_INSTALL_DIR: powershellPath(shell, installRoot), PI_BIN_DIR: powershellPath(shell, binRoot),
		PI_TEST_HERDR_LOG: powershellPath(shell, log),
	};
	for (const exitCode of [0, 0, 9]) {
		const result = runOfflineInstaller(shell, { ...environment, PI_TEST_HERDR_EXIT: String(exitCode) }, powershellPath(shell, nativeInstaller));
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /Herdr/u);
		assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), `v${version}`);
		if (exitCode) assert.match(normalizePowerShellDiagnostic(`${result.stdout}\n${result.stderr}`), /Herdr.*(?:unavailable|failed).*Pi remains usable/iu);
	}
	const calls = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(calls.length, 3);
	// .NET Framework GetFullPath expands 8.3 TEMP aliases, as the installer does.
	const canonicalRoot = execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[IO.Path]::GetFullPath('${powershellPath(shell, root).replaceAll("'", "''")}')`], { encoding: "utf8" }).trim();
	for (const call of calls) {
		const [executable, args, path] = call.split("|");
		assert.equal(executable.toLowerCase(), `${canonicalRoot}\\install\\releases\\v${version}\\pi.exe`.toLowerCase());
		assert.equal(args, "--provision-herdr");
		assert.equal(path.split(";")[0], `${canonicalRoot}\\bin`);
	}
	// Negative control: failed verification must not invoke optional provisioning.
	writeFileSync(join(fixture, "SHA256SUMS"), `${"0".repeat(64)}  pi-windows-x64.zip\n`);
	const failed = runOfflineInstaller(shell, environment, powershellPath(shell, nativeInstaller));
	assert.notEqual(failed.status, 0);
	assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
});

test("offline Windows installer retries transient release activation locks and fails closed when exhausted", (context) => {
	const shell = fixturePowerShellExecutable();
	if (!shell || process.platform === "win32") {
		context.skip("requires Linux-hosted PowerShell and the native Windows PE fixture compiler");
		return;
	}
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-windows-activation-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const firstFixture = createReleaseFixture(root, "1.2.3", "1.2.3", true, shell);
	const first = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, firstFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.3",
		PI_INSTALL_TEST_MOVE_FAILURES: "2",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	const firstOutput = `${first.stdout}\n${first.stderr}`;
	assert.equal(first.status, 0, firstOutput);
	assert.equal(firstOutput.match(/Release activation hit a transient lock; retrying/g)?.length, 2, firstOutput);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.3");
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.3", "pi.exe")), true);
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.3", "docs", "retained.txt")), true);
	assert.deepEqual(
		readdirSync(join(installRoot, "releases")).filter((entry) => entry.startsWith(".staging-")),
		[],
	);

	const secondFixture = createReleaseFixture(root, "1.2.4", "1.2.4", true, shell);
	const exhausted = runOfflineInstaller(shell, {
		PI_VERSION: "v1.2.4",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, secondFixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.4",
		PI_INSTALL_TEST_MOVE_FAILURES: "99",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	});
	const exhaustedOutput = `${exhausted.stdout}\n${exhausted.stderr}`;
	const exhaustedDiagnostic = normalizePowerShellDiagnostic(exhaustedOutput);
	assert.notEqual(exhausted.status, 0, exhaustedOutput);
	assert.match(exhaustedDiagnostic, /Could not activate release after 8 attempts/);
	assert.equal(
		exhaustedDiagnostic.match(/Release activation hit a transient lock; retrying/g)?.length,
		7,
		exhaustedOutput,
	);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.3");
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.4")), false);
	assert.deepEqual(
		readdirSync(join(installRoot, "releases")).filter((entry) => entry.startsWith(".staging-")),
		[],
	);
});

test("offline Windows installer fails closed when a partial activation target appears before rename", (context) => {
	const shell = fixturePowerShellExecutable();
	if (!shell || process.platform === "win32") {
		context.skip("requires Linux-hosted PowerShell and the native Windows PE fixture compiler");
		return;
	}
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-windows-partial-activation-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const fixture = createReleaseFixture(root, "1.2.3", "1.2.3", true, shell);
	const activationCall = "                Move-InstallerDirectory $staging $targetDir";
	const injectedActivation = [
		"                if ($env:PI_INSTALL_TEST_MODE -eq \"1\" -and $env:PI_INSTALL_TEST_PARTIAL_ACTIVATION -eq \"1\") {",
		"                    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null",
		"                    Move-Item -LiteralPath (Join-Path $staging \"docs\") -Destination $targetDir -ErrorAction Stop",
		"                }",
		activationCall,
	].join("\n");
	const candidateInstaller = installer.replace(activationCall, injectedActivation);
	assert.notEqual(candidateInstaller, installer, "activation instrumentation anchor must match");
	const candidateInstallerPath = join(root, "install-partial-activation.ps1");
	writeFileSync(candidateInstallerPath, candidateInstaller);

	const result = runOfflineInstaller(
		shell,
		{
			PI_VERSION: "v1.2.3",
			PI_INSTALL_TEST_BASE_URL: powershellPath(shell, fixture),
			PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.3",
			PI_INSTALL_TEST_PARTIAL_ACTIVATION: "1",
			PI_INSTALL_DIR: powershellPath(shell, installRoot),
			PI_BIN_DIR: powershellPath(shell, binRoot),
		},
		powershellPath(shell, candidateInstallerPath),
	);
	const output = `${result.stdout}\n${result.stderr}`;
	assert.notEqual(result.status, 0, output);
	assert.match(normalizePowerShellDiagnostic(output), /activat|destination|target/iu);
	assert.equal(existsSync(join(installRoot, "current.version")), false);
	assert.equal(existsSync(join(installRoot, "releases", "v1.2.3", "pi.exe")), false);
});

test("offline Windows installer bounds staging cleanup and preserves the primary failure", (context) => {
	const shell = fixturePowerShellExecutable();
	if (!shell || process.platform === "win32") {
		context.skip("requires Linux-hosted PowerShell and the native Windows PE fixture compiler");
		return;
	}
	const root = mkdtempSync(join(powershellTempDirectory(shell), "pi-windows-cleanup-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const fixture = createReleaseFixture(root, "1.2.3", "1.2.3", true, shell);
	const baseEnv = {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_TEST_BASE_URL: powershellPath(shell, fixture),
		PI_INSTALL_TEST_VERSION_OUTPUT: "1.2.3",
		PI_INSTALL_DIR: powershellPath(shell, installRoot),
		PI_BIN_DIR: powershellPath(shell, binRoot),
	};
	const first = runOfflineInstaller(shell, baseEnv);
	assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

	const transient = runOfflineInstaller(shell, {
		...baseEnv,
		PI_INSTALL_TEST_VERSION_OUTPUT: "0.0.0",
		PI_INSTALL_TEST_REMOVE_FAILURES: "2",
	});
	const transientOutput = `${transient.stdout}\n${transient.stderr}`;
	const transientDiagnostic = normalizePowerShellDiagnostic(transientOutput);
	assert.notEqual(transient.status, 0, transientOutput);
	assert.match(transientDiagnostic, /did not report exactly 1\.2\.3/);
	assert.match(transientDiagnostic, /Staging cleanup hit a transient lock; retrying/);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.3");
	assert.deepEqual(
		readdirSync(join(installRoot, "releases")).filter((entry) => entry.startsWith(".staging-")),
		[],
	);

	const cleanupOnly = runOfflineInstaller(shell, {
		...baseEnv,
		PI_INSTALL_TEST_REMOVE_FAILURES: "99",
	});
	const cleanupOnlyOutput = `${cleanupOnly.stdout}\n${cleanupOnly.stderr}`;
	const cleanupOnlyDiagnostic = normalizePowerShellDiagnostic(cleanupOnlyOutput);
	assert.notEqual(cleanupOnly.status, 0, cleanupOnlyOutput);
	assert.match(cleanupOnlyDiagnostic, /Could not clean staging directory after 8 attempts/);
	assert.equal(
		cleanupOnlyDiagnostic.match(/Staging cleanup hit a transient lock; retrying/g)?.length,
		7,
		cleanupOnlyOutput,
	);
	assert.doesNotMatch(cleanupOnlyDiagnostic, /Preserving original installation error/);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.3");
	const strandedStaging = readdirSync(join(installRoot, "releases")).filter((entry) => entry.startsWith(".staging-"));
	assert.equal(strandedStaging.length, 1, cleanupOnlyOutput);
	rmSync(join(installRoot, "releases", strandedStaging[0]), { recursive: true, force: true });

	const permanent = runOfflineInstaller(shell, {
		...baseEnv,
		PI_INSTALL_TEST_VERSION_OUTPUT: "0.0.0",
		PI_INSTALL_TEST_REMOVE_FAILURES: "99",
	});
	const permanentOutput = `${permanent.stdout}\n${permanent.stderr}`;
	const permanentDiagnostic = normalizePowerShellDiagnostic(permanentOutput);
	assert.notEqual(permanent.status, 0, permanentOutput);
	assert.match(permanentDiagnostic, /did not report exactly 1\.2\.3/);
	assert.match(permanentDiagnostic, /Could not clean staging directory after 8 attempts/);
	assert.match(permanentDiagnostic, /Preserving original installation error/);
	assert.equal(readFileSync(join(installRoot, "current.version"), "utf8").trim(), "v1.2.3");
});

if (process.env.PI_WINDOWS_INSTALLER_DEBUG === "1") {
	const shell = powershellExecutable();
	if (shell) {
		console.log(execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" }).trim());
	}
}
