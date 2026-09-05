import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installerPath = join(repositoryRoot, "install.sh");
const officialRepository = "https://github.com/Caupulican/pi-adaptative";
const posixBehaviorTest = process.platform === "win32" ? test.skip : test;

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createFixture(root, assetName, version, provisionFixture = false) {
	const fixtureRoot = join(root, `fixture-${version}`);
	const payloadRoot = join(fixtureRoot, "pi");
	mkdirSync(join(payloadRoot, "docs"), { recursive: true });
	mkdirSync(join(payloadRoot, "node_modules", "@caupulican", "retained"), { recursive: true });
	const executable = join(payloadRoot, "pi");
	writeFileSync(
		executable,
		provisionFixture ? `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi
printf '%s|%s|%s\\n' "$0" "$*" "$PATH" >> "$PI_TEST_HERDR_LOG"
[ "$#" = 1 ] && [ "$1" = "--provision-herdr" ] || exit 90
[ "$(readlink "$PI_INSTALL_DIR/current")/pi" = "$0" ] || exit 91
printf '%s\\n' '[OK] Herdr fixture available'
exit "\${PI_TEST_HERDR_EXIT:-0}"
` : `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${version}'; else printf '%s\\n' 'fixture'; fi\n`,
	);
	chmodSync(executable, 0o755);
	writeFileSync(join(payloadRoot, "docs", "retained.txt"), "retained release tree\n");
	writeFileSync(join(payloadRoot, "node_modules", "@caupulican", "retained", "asset.txt"), "retained asset\n");
	const archivePath = join(fixtureRoot, assetName);
	execSync(`tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(fixtureRoot)} pi`);
	const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
	const checksumPath = join(fixtureRoot, "SHA256SUMS");
	writeFileSync(checksumPath, `${digest}  ${assetName}\n`);
	return { archivePath, checksumPath };
}

function createHarness() {
	const root = mkdtempSync(join(tmpdir(), "pi-standalone-installer-"));
	const fakeBin = join(root, "bin");
	mkdirSync(fakeBin, { recursive: true });
	const curlPath = join(fakeBin, "curl");
	writeFileSync(
		curlPath,
		`#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) output="$2"; shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$PI_TEST_URL_LOG"
case "$url" in
  */api.github.com/repos/Caupulican/pi-adaptative/releases/latest)
    printf '{"tag_name":"%s"}\\n' "\${PI_TEST_LATEST_TAG:-v1.2.3}" > "$output" ;;
  */SHA256SUMS)
    if [ "\${PI_TEST_NO_CHECKSUM:-0}" = "1" ]; then exit 22; fi
    cp "$PI_TEST_CHECKSUM" "$output" ;;
  *) cp "$PI_TEST_ARCHIVE" "$output" ;;
esac
`,
	);
	chmodSync(curlPath, 0o755);
	const unamePath = join(fakeBin, "uname");
	writeFileSync(
		unamePath,
		`#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\\n' "\${PI_TEST_UNAME_S:-Linux}" ;;
  -m) printf '%s\\n' "\${PI_TEST_UNAME_M:-x86_64}" ;;
  *) exit 1 ;;
esac
`,
	);
	chmodSync(unamePath, 0o755);
	const sudoPath = join(fakeBin, "sudo");
	writeFileSync(sudoPath, "#!/bin/sh\nprintf '%s\\n' sudo-called >&2\nexit 99\n");
	chmodSync(sudoPath, 0o755);
	const urlLog = join(root, "urls.log");
	const env = {
		...process.env,
		PATH: `${fakeBin}:${process.env.PATH}`,
		HOME: join(root, "home"),
		PI_TEST_URL_LOG: urlLog,
		PI_TEST_UNAME_S: "Linux",
		PI_TEST_UNAME_M: "x86_64",
	};
	mkdirSync(env.HOME, { recursive: true });
	return { root, env, urlLog };
}

function runInstaller(harness, overrides = {}) {
	return spawnSync(installerPath, [], {
		env: { ...harness.env, ...overrides },
		encoding: "utf8",
	});
}

function assertNoForbiddenDistributionReferences(source, label) {
	for (const forbidden of ["pi.dev", "badlogic/pi-mono", "@earendil-works", "@mariozechner"]) {
		assert.doesNotMatch(
			source,
			new RegExp(escapeRegExp(forbidden), "iu"),
			`${label} must not reference ${forbidden}`,
		);
	}
}

test("standalone installers are owned by Caupulican/pi-adaptative and avoid legacy distributions", () => {
	const installer = readFileSync(installerPath, "utf8");
	assert.match(installer, /^#!\/bin\/sh\n/u);
	assert.match(installer, new RegExp(escapeRegExp(officialRepository), "u"));
	assert.match(installer, /pi-adaptative/u);
	assertNoForbiddenDistributionReferences(installer, "POSIX installer");
	assert.doesNotMatch(installer, /\b(?:npm|node)\b/u);
	assert.doesNotMatch(installer, /\bsudo\b/u);
});

posixBehaviorTest("Linux x64 and arm64 installs retain the complete archive tree and publish an atomic current link", (context) => {
	for (const architecture of ["x86_64", "aarch64"]) {
		const harness = createHarness();
		context.after(() => rmSync(harness.root, { recursive: true, force: true }));
		const assetName = `pi-linux-${architecture === "x86_64" ? "x64" : "arm64"}.tar.gz`;
		const fixture = createFixture(harness.root, assetName, "1.2.3");
		const installDir = join(harness.root, "data", "pi");
		const binDir = join(harness.root, "bin-installed");
		const result = runInstaller(harness, {
			PI_VERSION: "v1.2.3",
			PI_INSTALL_DIR: installDir,
			PI_BIN_DIR: binDir,
			PI_TEST_UNAME_M: architecture,
			PI_TEST_ARCHIVE: fixture.archivePath,
			PI_TEST_CHECKSUM: fixture.checksumPath,
		});
		assert.equal(result.status, 0, `${architecture}: ${result.stderr}`);
		assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.3");
		assert.equal(readFileSync(join(installDir, "current", "docs", "retained.txt"), "utf8"), "retained release tree\n");
		assert.equal(
			readFileSync(join(installDir, "current", "node_modules", "@caupulican", "retained", "asset.txt"), "utf8"),
			"retained asset\n",
		);
		assert.equal(readlinkSync(join(binDir, "pi")), join(installDir, "current", "pi"));
		assert.equal(lstatSync(join(installDir, "current")).isSymbolicLink(), true);
		const marker = join(installDir, "releases", "v1.2.3", ".pi-adaptative-managed");
		assert.equal(readFileSync(marker, "utf8"), "pi-adaptative-managed-release-v1\n");
		const urls = readFileSync(harness.urlLog, "utf8");
		assert.match(urls, new RegExp(`${officialRepository}/releases/download/v1\\.2\\.3/${assetName}`, "u"));
		assert.match(urls, new RegExp(`${officialRepository}/releases/download/v1\\.2\\.3/SHA256SUMS`, "u"));
		rmSync(marker);
		const repeated = runInstaller(harness, {
			PI_VERSION: "v1.2.3",
			PI_INSTALL_DIR: installDir,
			PI_BIN_DIR: binDir,
			PI_TEST_UNAME_M: architecture,
			PI_TEST_ARCHIVE: fixture.archivePath,
			PI_TEST_CHECKSUM: fixture.checksumPath,
		});
		assert.equal(repeated.status, 0, repeated.stderr);
		assert.equal(readFileSync(marker, "utf8"), "pi-adaptative-managed-release-v1\n");
		const upgradeFixture = createFixture(harness.root, assetName, "1.2.4");
		const upgrade = runInstaller(harness, {
			PI_VERSION: "v1.2.4",
			PI_INSTALL_DIR: installDir,
			PI_BIN_DIR: binDir,
			PI_TEST_UNAME_M: architecture,
			PI_TEST_ARCHIVE: upgradeFixture.archivePath,
			PI_TEST_CHECKSUM: upgradeFixture.checksumPath,
		});
		assert.equal(upgrade.status, 0, upgrade.stderr);
		assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.4");
		const releaseEntries = readdirSync(join(installDir, "releases"));
		assert.equal(releaseEntries.length, 2);
	}
});

posixBehaviorTest("Herdr skips legacy and noncanonical verified versions without invoking the flag", (context) => {
	for (const version of ["0.98.0", "0.10.2", "0.098.1", "0.98.1-rc.1", "9999999999.0.0"]) {
		const harness = createHarness();
		context.after(() => rmSync(harness.root, { recursive: true, force: true }));
		const fixture = createFixture(harness.root, "pi-linux-x64.tar.gz", version, true);
		const log = join(harness.root, "herdr.log");
		const installDir = join(harness.root, "install");
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = runInstaller(harness, {
				PI_VERSION: `v${version}`, PI_INSTALL_DIR: installDir, PI_BIN_DIR: join(harness.root, "installed-bin"),
				PI_TEST_ARCHIVE: fixture.archivePath, PI_TEST_CHECKSUM: fixture.checksumPath, PI_TEST_HERDR_LOG: log,
			});
			assert.equal(result.status, 0, `${version}: ${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /Skipping Herdr.*0\.98\.1/u);
			assert.equal(existsSync(log), false, `legacy flag invoked for ${version}`);
			assert.equal(readlinkSync(join(installDir, "current")), join(installDir, "releases", `v${version}`));
		}
	}
});

for (const version of ["0.98.1", "1.2.3"]) posixBehaviorTest(`Herdr ${version} provisioning runs only from the verified active release on fresh/repeated installs and stays optional`, (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const fixture = createFixture(harness.root, "pi-linux-x64.tar.gz", version, true);
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	const log = join(harness.root, "herdr.log");
	const environment = {
		PI_VERSION: `v${version}`, PI_INSTALL_DIR: installDir, PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: fixture.archivePath, PI_TEST_CHECKSUM: fixture.checksumPath,
		PI_TEST_HERDR_LOG: log,
	};
	for (const exitCode of [0, 0, 9]) {
		const result = runInstaller(harness, { ...environment, PI_TEST_HERDR_EXIT: String(exitCode) });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /Herdr/u);
		assert.equal(readlinkSync(join(installDir, "current")), join(installDir, "releases", `v${version}`));
		if (exitCode) assert.match(`${result.stdout}\n${result.stderr}`, /Herdr.*(?:unavailable|failed).*Pi remains usable/iu);
	}
	const calls = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(calls.length, 3);
	for (const call of calls) {
		const [executable, args, path] = call.split("|");
		assert.equal(executable, join(installDir, "releases", `v${version}`, "pi"));
		assert.equal(args, "--provision-herdr");
		assert.equal(path.split(":")[0], binDir);
	}
	// Negative control: failed verification never invokes optional provisioning.
	const failed = runInstaller(harness, { ...environment, PI_TEST_NO_CHECKSUM: "1" });
	assert.notEqual(failed.status, 0);
	assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
});

posixBehaviorTest("retention only removes managed release directories and preserves unknown version-looking data", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const firstFixture = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.3");
	const secondFixture = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.4");
	const thirdFixture = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.5");
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	const install = (version, fixture) => runInstaller(harness, {
		PI_VERSION: `v${version}`,
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: fixture.archivePath,
		PI_TEST_CHECKSUM: fixture.checksumPath,
	});
	assert.equal(install("1.2.3", firstFixture).status, 0);
	const unknownRelease = join(installDir, "releases", "v9.9.9");
	mkdirSync(unknownRelease, { recursive: true });
	const sentinel = join(unknownRelease, "do-not-delete.txt");
	writeFileSync(sentinel, "unmanaged\n");
	assert.equal(install("1.2.4", secondFixture).status, 0);
	assert.equal(readFileSync(sentinel, "utf8"), "unmanaged\n");
	assert.equal(install("1.2.5", thirdFixture).status, 0);
	assert.equal(readFileSync(sentinel, "utf8"), "unmanaged\n");
	assert.equal(existsSync(join(installDir, "releases", "v1.2.3")), false);
});

posixBehaviorTest("same-version pre-existing release data is rejected without deletion or activation", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const firstFixture = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.3");
	const nextFixture = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.4");
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	const first = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: firstFixture.archivePath,
		PI_TEST_CHECKSUM: firstFixture.checksumPath,
	});
	assert.equal(first.status, 0, first.stderr);

	const preExistingRelease = join(installDir, "releases", "v1.2.4");
	mkdirSync(preExistingRelease, { recursive: true });
	const sentinel = join(preExistingRelease, "unowned-data.txt");
	writeFileSync(sentinel, "do not delete\n");

	const attempted = runInstaller(harness, {
		PI_VERSION: "v1.2.4",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: nextFixture.archivePath,
		PI_TEST_CHECKSUM: nextFixture.checksumPath,
	});
	assert.notEqual(attempted.status, 0);
	assert.match(`${attempted.stdout}\n${attempted.stderr}`, /unowned|existing release/iu);
	assert.equal(readFileSync(sentinel, "utf8"), "do not delete\n");
	assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.3");
});

posixBehaviorTest("legacy active release is validated before ownership adoption", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const fixture = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.3");
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	const first = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: fixture.archivePath,
		PI_TEST_CHECKSUM: fixture.checksumPath,
	});
	assert.equal(first.status, 0, first.stderr);
	const releaseDir = join(installDir, "releases", "v1.2.3");
	const marker = join(releaseDir, ".pi-adaptative-managed");
	rmSync(marker);
	const executable = join(releaseDir, "pi");
	writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' '9.9.9'\n");
	chmodSync(executable, 0o755);
	const sentinel = join(releaseDir, "legacy-sentinel.txt");
	writeFileSync(sentinel, "preserve\n");

	const attempted = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: fixture.archivePath,
		PI_TEST_CHECKSUM: fixture.checksumPath,
	});
	assert.notEqual(attempted.status, 0);
	assert.match(`${attempted.stdout}\n${attempted.stderr}`, /active pi --version|does not match/iu);
	assert.equal(existsSync(marker), false);
	assert.equal(readFileSync(executable, "utf8"), "#!/bin/sh\nprintf '%s\\n' '9.9.9'\n");
	assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
});

posixBehaviorTest("latest resolves once to an exact release tag before downloading the archive", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const assetName = "pi-linux-x64.tar.gz";
	const fixture = createFixture(harness.root, assetName, "1.2.3");
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	const result = runInstaller(harness, {
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: fixture.archivePath,
		PI_TEST_CHECKSUM: fixture.checksumPath,
		PI_TEST_LATEST_TAG: "v1.2.3",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.3");
	const urls = readFileSync(harness.urlLog, "utf8").trim().split("\n");
	assert.equal(urls.filter((url) => url.endsWith("/releases/latest")).length, 1);
	assert.equal(urls.filter((url) => url.includes("/releases/download/v1.2.3/")).length, 2);
});

posixBehaviorTest("release workflow test mode installs from a local verified artifact directory without network", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const assetName = "pi-linux-x64.tar.gz";
	createFixture(harness.root, assetName, "1.2.3");
	const result = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: join(harness.root, "data", "pi"),
		PI_BIN_DIR: join(harness.root, "bin-installed"),
		PI_INSTALL_TEST_MODE: "1",
		PI_INSTALL_TEST_BASE_URL: join(harness.root, "fixture-1.2.3"),
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(harness.urlLog), false, "local test mode must not invoke curl");
});

posixBehaviorTest("checksum failure preserves the previously active release and unsafe roots fail closed", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const assetName = "pi-linux-x64.tar.gz";
	const good = createFixture(harness.root, assetName, "1.2.3");
	const bad = createFixture(harness.root, assetName, "1.2.4");
	const badChecksum = join(harness.root, "bad-SHA256SUMS");
	writeFileSync(badChecksum, `${"0".repeat(64)}  ${assetName}\n`);
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	const first = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.equal(first.status, 0, first.stderr);
	const failedUpgrade = runInstaller(harness, {
		PI_VERSION: "v1.2.4",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: bad.archivePath,
		PI_TEST_CHECKSUM: badChecksum,
	});
	assert.notEqual(failedUpgrade.status, 0);
	assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.3");
	const duplicateChecksum = join(harness.root, "duplicate-SHA256SUMS");
	const digest = createHash("sha256").update(readFileSync(good.archivePath)).digest("hex");
	writeFileSync(duplicateChecksum, `${digest}  ${assetName}\n${digest}  ${assetName}\n`);
	const duplicate = runInstaller(harness, {
		PI_VERSION: "v1.2.5",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: duplicateChecksum,
	});
	assert.notEqual(duplicate.status, 0);
	assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.3");
	const malformedDuplicateChecksum = join(harness.root, "malformed-duplicate-SHA256SUMS");
	writeFileSync(malformedDuplicateChecksum, `${digest}  ${assetName}\ninvalid  ${assetName}\n`);
	const malformedDuplicate = runInstaller(harness, {
		PI_VERSION: "v1.2.5",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: malformedDuplicateChecksum,
	});
	assert.notEqual(malformedDuplicate.status, 0);
	assert.equal(execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(), "1.2.3");
	const unsafe = runInstaller(harness, {
		PI_INSTALL_DIR: "/",
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.notEqual(unsafe.status, 0);
	assert.match(`${unsafe.stdout}\n${unsafe.stderr}`, /unsafe|absolute|install root/iu);
	const unsupported = runInstaller(harness, {
		PI_TEST_UNAME_M: "ppc64le",
		PI_INSTALL_DIR: join(harness.root, "unsupported", "pi"),
		PI_BIN_DIR: join(harness.root, "unsupported", "bin"),
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.notEqual(unsupported.status, 0);
	assert.match(`${unsupported.stdout}\n${unsupported.stderr}`, /unsupported platform/iu);
	const injected = runInstaller(harness, {
		PI_VERSION: "v1.2.3/evil",
		PI_INSTALL_DIR: join(harness.root, "injected", "pi"),
		PI_BIN_DIR: join(harness.root, "injected", "bin"),
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.notEqual(injected.status, 0);
	assert.match(`${injected.stdout}\n${injected.stderr}`, /PI_VERSION|release version|unsafe characters|semantic version/iu);
	const malformedSemver = runInstaller(harness, {
		PI_VERSION: "v1.2.3.evil",
		PI_INSTALL_DIR: join(harness.root, "malformed-version", "pi"),
		PI_BIN_DIR: join(harness.root, "malformed-version", "bin"),
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.notEqual(malformedSemver.status, 0);
	assert.match(`${malformedSemver.stdout}\n${malformedSemver.stderr}`, /semantic version/iu);
	const lockDir = join(harness.root, "locked", "pi", ".install.lock");
	mkdirSync(lockDir, { recursive: true });
	const locked = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: join(harness.root, "locked", "pi"),
		PI_BIN_DIR: join(harness.root, "locked", "bin"),
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.notEqual(locked.status, 0);
	assert.match(`${locked.stdout}\n${locked.stderr}`, /already active|lock/iu);
});

posixBehaviorTest("wrong-root archives and unowned launchers are rejected without activation", (context) => {
	const harness = createHarness();
	context.after(() => rmSync(harness.root, { recursive: true, force: true }));
	const badRoot = join(harness.root, "wrong-root");
	mkdirSync(badRoot, { recursive: true });
	writeFileSync(join(badRoot, "pi"), "not an archive entry\n");
	const archivePath = join(harness.root, "pi-linux-x64.tar.gz");
	execSync(`tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(harness.root)} wrong-root`);
	const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
	const checksumPath = join(harness.root, "SHA256SUMS");
	writeFileSync(checksumPath, `${digest}  pi-linux-x64.tar.gz\n`);
	const installDir = join(harness.root, "data", "pi");
	const binDir = join(harness.root, "bin-installed");
	mkdirSync(binDir, { recursive: true });
	const result = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: archivePath,
		PI_TEST_CHECKSUM: checksumPath,
	});
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(join(installDir, "current")), false);
	const good = createFixture(harness.root, "pi-linux-x64.tar.gz", "1.2.3");
	writeFileSync(join(binDir, "pi"), "pre-existing launcher\n");
	const collision = runInstaller(harness, {
		PI_VERSION: "v1.2.3",
		PI_INSTALL_DIR: installDir,
		PI_BIN_DIR: binDir,
		PI_TEST_ARCHIVE: good.archivePath,
		PI_TEST_CHECKSUM: good.checksumPath,
	});
	assert.notEqual(collision.status, 0);
	assert.match(`${collision.stdout}\n${collision.stderr}`, /unowned pi launcher/iu);
	assert.equal(existsSync(join(installDir, "current")), false);
});
