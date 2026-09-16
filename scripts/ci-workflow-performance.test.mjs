import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const releaseScript = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const firstPartyPackages = ["ai", "agent", "tui", "coding-agent"].map((name) => ({
	name,
	manifest: JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8")),
}));
const codingAgentReadme = readFileSync(new URL("../packages/coding-agent/README.md", import.meta.url), "utf8");
const quickstartDocs = readFileSync(new URL("../packages/coding-agent/docs/quickstart.md", import.meta.url), "utf8");
const indexDocs = readFileSync(new URL("../packages/coding-agent/docs/index.md", import.meta.url), "utf8");
const windowsDocs = readFileSync(new URL("../packages/coding-agent/docs/windows.md", import.meta.url), "utf8");
const installScript = readFileSync(new URL("../scripts/install-linux-ci-deps.sh", import.meta.url), "utf8");
const installScriptPath = fileURLToPath(new URL("../scripts/install-linux-ci-deps.sh", import.meta.url));

function withInstallerHarness(options, fn) {
	const dir = mkdtempSync(join(tmpdir(), "ci-deps-test-"));
	try {
		const binDir = join(dir, "bin");
		const stateDir = join(dir, "state");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });

		const sudoPath = join(binDir, "sudo");
		writeFileSync(sudoPath, options.sudoScript ?? "#!/usr/bin/env bash\nexec \"$@\"\n");
		chmodSync(sudoPath, 0o755);

		const aptPath = join(binDir, "apt-get");
		const aptScript =
			typeof options.aptScript === "function"
				? options.aptScript(stateDir)
				: (options.aptScript ?? "#!/usr/bin/env bash\nexit 0\n");
		writeFileSync(aptPath, aptScript);
		chmodSync(aptPath, 0o755);

		const dpkgPath = join(binDir, "dpkg-query");
		const dpkgScript =
			typeof options.dpkgScript === "function"
				? options.dpkgScript(stateDir)
				: (options.dpkgScript ?? "#!/usr/bin/env bash\necho \"install ok installed\"\n");
		writeFileSync(dpkgPath, dpkgScript);
		chmodSync(dpkgPath, 0o755);

		const pkgConfigPath = join(binDir, "pkg-config");
		writeFileSync(pkgConfigPath, options.pkgConfigScript ?? "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(pkgConfigPath, 0o755);

		const fdPath = join(binDir, "fd");
		writeFileSync(fdPath, options.fdScript ?? "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fdPath, 0o755);

		const rgPath = join(binDir, "rg");
		writeFileSync(rgPath, options.rgScript ?? "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(rgPath, 0o755);

		// Create default mock test seams for Ubuntu OS-release and keyring
		const mockKeyringPath = join(stateDir, "ubuntu-archive-keyring.gpg");
		writeFileSync(mockKeyringPath, "MOCK_KEYRING_GPG");

		const mockOsReleasePath = join(stateDir, "os-release");
		writeFileSync(mockOsReleasePath, options.osReleaseContent ?? 'ID=ubuntu\nVERSION_CODENAME=noble\n');

		const start = Date.now();
		const res = spawnSync(installScriptPath, [], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CI_OS_RELEASE_PATH: options.osReleasePath ?? mockOsReleasePath,
				CI_KEYRING_PATH: options.keyringPath ?? mockKeyringPath,
				CI_APT_UPDATE_TIMEOUT: "1s",
				CI_APT_DOWNLOAD_TIMEOUT: "1s",
				CI_APT_INSTALL_TIMEOUT: "1s",
				CI_APT_KILL_AFTER: "1s",
				CI_APT_MAX_ATTEMPTS: "2",
				CI_APT_RETRY_DELAY: "0",
				...(options.env ?? {}),
			},
			encoding: "utf8",
		});
		const elapsed = Date.now() - start;
		return fn({
			res,
			elapsed,
			stateDir,
			mockKeyringPath,
			mockOsReleasePath,
			readState: (filename) => {
				const p = join(stateDir, filename);
				return readFileSync(p, "utf8");
			},
			hasState: (filename) => {
				const p = join(stateDir, filename);
				return existsSync(p);
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("normal CI keeps small workspaces on the quality job and shards coding-agent four ways", () => {
	assert.match(workflow, /run: npm test -- packages\/tui packages\/ai packages\/agent/u);
	assert.match(workflow, /^  coding-agent-test:\n/mu);
	assert.match(workflow, /shard: \[1, 2, 3, 4\]/u);
	assert.match(workflow, /--shard=\$\{\{ matrix\.shard \}\}\/4/u);
	assert.doesNotMatch(workflow, /^\s+run: npm test\s*$/mu);
});

function assertNativeProcessPhase(source) {
	const qualityJob = source.slice(0, source.indexOf("  coding-agent-test:"));
	const steps = qualityJob.split(/^      - name: /mu).slice(1);
	const parallel = steps.filter((step) => step.startsWith("Test non-coding-agent workspaces\n"));
	const native = steps.filter((step) => step.startsWith("Test native process-tree control alone\n"));
	assert.equal(parallel.length, 1);
	assert.equal(native.length, 1, "native process control must remain a mandatory quality phase");
	assert(steps.indexOf(native[0]) > steps.indexOf(parallel[0]), "native control must follow the parallel suite");
	const condition = (step) => step.match(/\n        if: >\n([\s\S]*?)(?=\n        [a-z])/u)?.[1].trim();
	assert.equal(condition(native[0]), condition(parallel[0]), "both OS jobs must run the native phase whenever the parallel suite runs");
	assert.match(parallel[0], /PI_VITEST_ISOLATE_NATIVE_PROCESS: "1"/u);
	assert.equal((source.match(/PI_VITEST_ISOLATE_NATIVE_PROCESS/gu) ?? []).length, 1, "exclusion must be scoped to the parallel step");
	assert.doesNotMatch(native[0], /continue-on-error|PI_VITEST_ISOLATE_NATIVE_PROCESS/u);
	assert.match(native[0], /working-directory: packages\/agent/u);
	assert.match(native[0], /run: node \.\.\/\.\.\/node_modules\/vitest\/dist\/cli\.js --run --bail=0 test\/reliability\/process-tree-native-tree\.test\.ts\s*$/u);
}

test("CI pairs native-process exclusion with an unchanged mandatory control on both operating systems", () => {
	assertNativeProcessPhase(workflow);
	assert.throws(() => assertNativeProcessPhase(workflow.replace("Test native process-tree control alone", "Removed native control")));
	assert.throws(() => assertNativeProcessPhase(workflow.replace("--bail=0 test/reliability/process-tree-native-tree.test.ts", "--bail=0 test/reliability/process-tree-target-safety.test.ts")));
});

test("agent config excludes only the native control when the parallel CI phase explicitly requests it", () => {
	const fixture = fileURLToPath(new URL("./test-fixtures/agent-vitest-config.mjs", import.meta.url));
	const snapshots = ["", "0", "true", "1"].map((flag) => {
		const result = spawnSync(process.execPath, [fixture], { encoding: "utf8", env: { ...process.env, PI_VITEST_ISOLATE_NATIVE_PROCESS: flag } });
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	});
	const nativeFile = "test/reliability/process-tree-native-tree.test.ts";
	assert.equal(snapshots[0].includes(nativeFile), false);
	assert.deepEqual(snapshots[1], snapshots[0]);
	assert.deepEqual(snapshots[2], snapshots[0]);
	assert.deepEqual(snapshots[3], [...snapshots[0], nativeFile]);
});

test("CI keeps every matrix failure available for evidence collection", () => {
	const jobSections = ["build-check-test", "coding-agent-test"].map((jobName, index, jobs) => {
		const start = workflow.indexOf(`  ${jobName}:`);
		assert.notEqual(start, -1, `${jobName} must exist`);
		const nextStart = index + 1 < jobs.length ? workflow.indexOf(`  ${jobs[index + 1]}:`, start + 1) : workflow.length;
		assert.notEqual(nextStart, -1, `${jobName} section must have a boundary`);
		return workflow.slice(start, nextStart);
	});

	for (const [jobName, section] of [
		["build-check-test", jobSections[0]],
		["coding-agent-test", jobSections[1]],
	]) {
		assert.match(section, /^    strategy:\n      fail-fast: false$/mu, `${jobName} must retain every matrix result`);
	}
});

test("npm publication is structurally disabled for every first-party workspace", () => {
	for (const { name, manifest } of firstPartyPackages) {
		assert.equal(manifest.private, true, `${name} must be private and not publishable`);
		assert.equal(manifest.publishConfig, undefined, `${name} must not define npm publication configuration`);
		assert.equal(manifest.scripts?.prepublishOnly, undefined, `${name} must not have a publication lifecycle hook`);
	}

	for (const scriptName of ["publish", "publish:dry", "prepublishOnly"]) {
		assert.equal(rootPackage.scripts?.[scriptName], undefined, `root package must not expose ${scriptName}`);
	}
	assert.equal(existsSync(new URL("./publish.mjs", import.meta.url)), false, "publication helper must be removed");
	assert.equal(rootPackage.scripts?.["release:local"], undefined, "npm package release helper must not be exposed");
	assert.equal(existsSync(new URL("./local-release.mjs", import.meta.url)), false, "npm package release helper must be removed");
	assert.equal(existsSync(new URL("./release-artifact-smoke.mjs", import.meta.url)), false, "npm artifact smoke helper must be removed");
	assert.equal(existsSync(new URL("./release-artifact-smoke.test.mjs", import.meta.url)), false, "npm artifact smoke test must be removed");
	assert.doesNotMatch(rootPackage.scripts?.["check:release-binary-benchmark"] ?? "", /release-artifact-smoke/u);
	assert.equal(rootPackage.scripts?.["check:shrinkwrap"], undefined, "npm publication shrinkwrap check must be removed");
	assert.equal(existsSync(new URL("./generate-coding-agent-shrinkwrap.mjs", import.meta.url)), false, "npm shrinkwrap generator must be removed");
	assert.equal(existsSync(new URL("../packages/coding-agent/npm-shrinkwrap.json", import.meta.url)), false, "npm shrinkwrap must be removed");
	assert.doesNotMatch(
		releaseScript,
		/npm publish|publish-npm|trusted publishing|NODE_AUTH_TOKEN|NPM_TOKEN|release:local|shrinkwrap/iu,
		"the release coordinator must not regain npm publication or shrinkwrap paths",
	);
});

test("normal CI reserves twenty minutes for runner setup plus bounded suite execution", () => {
	const shardJobStart = workflow.indexOf("  coding-agent-test:");
	assert.notEqual(shardJobStart, -1);
	const qualityJob = workflow.slice(0, shardJobStart);
	const shardJob = workflow.slice(shardJobStart);
	assert.match(qualityJob, /^    timeout-minutes: 20$/mu);
	assert.match(shardJob, /^    timeout-minutes: 20$/mu);
});

test("release fast paths skip every coding-agent shard after the exact suite already passed", () => {
	const qualityJob = workflow.slice(0, workflow.indexOf("  coding-agent-test:"));
	assert.match(qualityJob, /runner\.os == 'Linux' &&\n\s+inputs\.skip_tests != true/u);
	assert.match(qualityJob, /runner\.os == 'Windows' &&\n\s+inputs\.skip_tests != true/u);

	const shardJobStart = workflow.indexOf("  coding-agent-test:");
	assert.notEqual(shardJobStart, -1);
	const shardJob = workflow.slice(shardJobStart);
	assert.match(shardJob, /inputs\.skip_tests != true/u);
	assert.match(shardJob, /!startsWith\(github\.event\.head_commit\.message, 'Release v'\)/u);
});

test("release publishes standalone installer assets and no npm distribution job", () => {
	const releaseJobStart = releaseWorkflow.indexOf("  release:");
	assert.notEqual(releaseJobStart, -1);
	const releaseJob = releaseWorkflow.slice(releaseJobStart);
	assert.doesNotMatch(releaseWorkflow, /^  publish-npm:/mu);
	assert.doesNotMatch(releaseWorkflow, /NODE_AUTH_TOKEN|NPM_TOKEN|Publish npm packages/u);
	assert.match(releaseJob, /install\.sh/u);
	assert.match(releaseJob, /install\.ps1/u);
	assert.match(releaseJob, /SHA256SUMS/u);
	assert.match(releaseJob, /sha256sum/u);
	assert.match(releaseJob, /--clobber/u, "release asset upload must be idempotent");
	for (const asset of [
		"pi-darwin-arm64.tar.gz",
		"pi-darwin-x64.tar.gz",
		"pi-linux-x64.tar.gz",
		"pi-linux-arm64.tar.gz",
		"pi-windows-x64.zip",
		"pi-windows-arm64.zip",
	]) {
		assert.match(releaseJob, new RegExp(asset.replaceAll(".", "\\."), "u"), `release must upload ${asset}`);
	}
});

test("release gates execute both standalone installers against the just-built archives", () => {
	const buildJobStart = releaseWorkflow.indexOf("  build:");
	const windowsJobStart = releaseWorkflow.indexOf("  verify-windows-binary:");
	const linuxJobStart = releaseWorkflow.indexOf("  benchmark-linux-binary:");
	assert.notEqual(buildJobStart, -1);
	assert.notEqual(windowsJobStart, -1);
	assert.notEqual(linuxJobStart, -1);

	const buildJob = releaseWorkflow.slice(buildJobStart, windowsJobStart);
	const windowsJob = releaseWorkflow.slice(windowsJobStart, linuxJobStart);
	assert.match(buildJob, /Verify Linux standalone installer/u);
	assert.match(buildJob, /PI_INSTALL_TEST_MODE=1/u);
	assert.match(buildJob, /\.\/install\.sh/u);
	assert.match(buildJob, /pi-linux-x64\.tar\.gz/u);
	assert.match(buildJob, /Verify Linux arm64 release layout/u);
	assert.match(buildJob, /pi-linux-arm64\.tar\.gz/u);
	assert.match(buildJob, /readelf -h/u);
	assert.match(buildJob, /AArch64/u);
	assert.match(windowsJob, /Verify Windows standalone installer/u);
	assert.match(windowsJob, /PI_INSTALL_TEST_MODE/u);
	assert.match(windowsJob, /install\.ps1/u);
	assert.match(windowsJob, /pi-windows-\$arch\.zip/u);
	assert.match(windowsJob, /current\.version/u);
});

test("direct tag publication proves a full tested tree and exact-commit destructive provenance", () => {
	const provenanceStart = releaseWorkflow.indexOf("  release-provenance:");
	const releaseStart = releaseWorkflow.indexOf("  release:");
	assert.notEqual(provenanceStart, -1);
	assert.notEqual(releaseStart, -1);
	const provenanceJob = releaseWorkflow.slice(provenanceStart, releaseStart);
	const releaseJob = releaseWorkflow.slice(releaseStart);
	assert.match(provenanceJob, /^      actions: read$/mu);
	assert.match(provenanceJob, /git rev-parse "\$\{RELEASE_TAG\}\^\{commit\}"/u);
	assert.match(provenanceJob, /node scripts\/release-ci-proof\.mjs "\$release_sha" "\$GITHUB_REPOSITORY"/u);
	assert.doesNotMatch(provenanceJob, /git diff --name-only -z/u);
	assert.match(releaseScript, /requireCiProof\(sha, repo\)/u);
	assert.match(releaseScript, /requireReleaseCiProof\(releaseSha, getRepoSlug\(\)\)/u);
	assert.match(provenanceJob, /verify_workflow destructive\.yml "\$release_sha"/u);
	assert.match(provenanceJob, /\.headSha == \$sha/u);
	assert.match(provenanceJob, /\.status == "completed"/u);
	assert.match(provenanceJob, /\.conclusion == "success"/u);
	assert.match(releaseJob, /needs: \[quality-gate, build, release-provenance, verify-release-binary-performance\]/u);
});

test("the normal check gate executes standalone installer regressions", () => {
	const gate = rootPackage.scripts?.["check:release-binary-benchmark"] ?? "";
	assert.match(gate, /install-standalone\.test\.mjs/u);
	assert.match(gate, /install-standalone-windows\.test\.mjs/u);
});

test("primary distribution docs use the repository release installer and reject upstream install owners", () => {
	const installerUrl = "https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.sh";
	assert.match(codingAgentReadme, new RegExp(installerUrl.replaceAll(".", "\\."), "u"));
	assert.match(quickstartDocs, new RegExp(installerUrl.replaceAll(".", "\\."), "u"));
	assert.match(indexDocs, new RegExp(installerUrl.replaceAll(".", "\\."), "u"));
	assert.match(windowsDocs, /pi-windows-x64\.zip/u);
	assert.match(windowsDocs, /pi-windows-arm64\.zip/u);
	assert.match(
		windowsDocs,
		/irm https:\/\/github\.com\/Caupulican\/pi-adaptative\/releases\/latest\/download\/install\.ps1 \| iex/u,
	);

	const forbiddenDistributionOwners = /pi\.dev\/install|github\.com\/(?:badlogic\/pi-mono|earendil-works\/pi-mono)|@(?:earendil-works|mariozechner)\/pi-/u;
	for (const [label, content] of [
		["coding-agent README", codingAgentReadme],
		["quickstart", quickstartDocs],
		["index", indexDocs],
		["Windows", windowsDocs],
	]) {
		assert.doesNotMatch(content, forbiddenDistributionOwners, `${label} must not advertise an upstream installer`);
	}
});

test("release jobs do not resolve runner-scoped paths before a step starts", () => {
	const invalidJobEnvEntries = releaseWorkflow.match(/^      [A-Z_][A-Z0-9_]*:.*\$\{\{\s*runner\./gmu) ?? [];
	assert.deepEqual(invalidJobEnvEntries, []);
});

test("CI jobs share the bounded Linux dependency installation script without duplicate YAML commands", () => {
	const matches = workflow.match(/run: \.\/scripts\/install-linux-ci-deps\.sh/g);
	assert.equal(matches?.length, 2);
	assert.doesNotMatch(workflow, /apt-get update/u);
	assert.doesNotMatch(workflow, /apt-get install/u);
});

test("bounded Linux dependency installer configures owned HTTPS sources, kill-after timeouts, and verification", () => {
	assert.match(installScript, /unset ID UBUNTU_CODENAME VERSION_CODENAME/u);
	assert.match(installScript, /ID=ubuntu/u);
	assert.match(installScript, /Dir::Etc::sourcelist=/u);
	assert.match(installScript, /Dir::Etc::sourceparts=/u);
	assert.match(installScript, /https:\/\/archive\.ubuntu\.com\/ubuntu\//u);
	assert.match(installScript, /https:\/\/security\.ubuntu\.com\/ubuntu\//u);
	assert.match(installScript, /Acquire::http::Timeout=15/u);
	assert.match(installScript, /Acquire::https::Timeout=15/u);
	assert.match(installScript, /Acquire::Retries=3/u);
	assert.match(installScript, /timeout --kill-after=/u);
	assert.match(installScript, /apt-get install -y --download-only/u);
	assert.match(installScript, /apt-get install -y --no-download/u);
	assert.match(installScript, /dpkg-query -W -f='\$\{Status\}\\n'/u);
	assert.match(installScript, /for tool in fd rg pkg-config; do/u);
	assert.match(installScript, /for mod in cairo pango librsvg-2\.0; do/u);
	assert.match(installScript, /trap 'rm -rf "\$\{TMP_DIR\}"' EXIT/u);
});

test(
	"behavioral harness: network fetch stall is forcibly killed, retries, and passes owned HTTPS sources to every phase",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				aptScript: (stateDir) => `#!/usr/bin/env bash
echo "$@" >> "${stateDir}/apt.log"

# Capture the generated sources list on first inspection
for arg in "$@"; do
  if [[ "$arg" == *"Dir::Etc::sourcelist="* ]]; then
    src="\${arg#*Dir::Etc::sourcelist=}"
    if [ -f "$src" ] && [ ! -f "${stateDir}/captured-sources.list" ]; then
      cp "$src" "${stateDir}/captured-sources.list"
    fi
  fi
done

if [ "$1" = "update" ]; then
  count_file="${stateDir}/update.count"
  count=1
  if [ -f "$count_file" ]; then
    count=$(($(cat "$count_file") + 1))
  fi
  echo "$count" > "$count_file"
  if [ "$count" -eq 1 ]; then
    # Ignore SIGTERM and hang until SIGKILL from --kill-after
    trap "" TERM
    sleep 10
    exit 0
  fi
  exit 0
fi
if [[ "$*" == *"--download-only"* ]]; then
  exit 0
fi
if [[ "$*" == *"--no-download"* ]]; then
  exit 0
fi
exit 0
`,
			},
			({ res, elapsed, readState, mockKeyringPath }) => {
				assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
				assert(elapsed >= 1500 && elapsed < 8000, `Expected bounded wall time between 1.5s and 8s, got ${elapsed}ms`);
				const updateCount = parseInt(readState("update.count").trim(), 10);
				assert.equal(updateCount, 2, "Expected exactly 2 update attempts (1 killed, 1 successful retry)");

				const aptLog = readState("apt.log");
				const lines = aptLog.trim().split("\n");
				assert.equal(lines.length, 4, "Expected 4 apt invocations: 2 update attempts + 1 download-only + 1 no-download");

				for (const line of lines) {
					assert.match(line, /-o Dir::Etc::sourcelist=/u, "Every apt invocation must receive CI-owned sourcelist");
					assert.match(line, /-o Dir::Etc::sourceparts=/u, "Every apt invocation must disable runner sourceparts");
				}

				const capturedSources = readState("captured-sources.list");
				assert.match(capturedSources, new RegExp(`\\[signed-by=${mockKeyringPath.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}\\]`, "u"));
				assert.match(capturedSources, /https:\/\/archive\.ubuntu\.com\/ubuntu\/ noble main universe/u);
				assert.match(capturedSources, /https:\/\/archive\.ubuntu\.com\/ubuntu\/ noble-updates main universe/u);
				assert.match(capturedSources, /https:\/\/security\.ubuntu\.com\/ubuntu\/ noble-security main universe/u);
				assert.doesNotMatch(capturedSources, /azure\.archive\.ubuntu\.com/u, "Must exclude runner Azure mirrorlist");
				assert.doesNotMatch(
					capturedSources,
					/microsoft|google|github|nodesource|docker/iu,
					"Must exclude 3rd-party repositories",
				);
			},
		);
	},
);

test(
	"behavioral harness: negative control - non-Ubuntu OS distribution fails fast before apt invocation",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				osReleaseContent: "ID=debian\nVERSION_CODENAME=trixie\n",
				aptScript: (stateDir) => `#!/usr/bin/env bash\necho "$@" >> "${stateDir}/apt.log"\nexit 0\n`,
			},
			({ res, hasState }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /unsupported Linux distribution 'debian'/u);
				assert.equal(hasState("apt.log"), false, "apt must never be invoked on non-Ubuntu OS");
			},
		);
	},
);

test(
	"behavioral harness: negative control - missing fields in os-release cannot inherit values from environment",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				osReleaseContent: 'NAME="Custom Linux"\nPRETTY_NAME="Custom Linux 1.0"\n',
				env: {
					ID: "ubuntu",
					UBUNTU_CODENAME: "noble",
					VERSION_CODENAME: "noble",
				},
				aptScript: (stateDir) => `#!/usr/bin/env bash\necho "$@" >> "${stateDir}/apt.log"\nexit 0\n`,
			},
			({ res, hasState }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /unsupported Linux distribution ''|invalid or missing Ubuntu codename ''/u);
				assert.equal(hasState("apt.log"), false, "apt must never be invoked when os-release lacks fields despite inherited env");
			},
		);
	},
);

test(
	"behavioral harness: negative control - invalid or missing codename fails fast before apt invocation",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				osReleaseContent: "ID=ubuntu\nVERSION_CODENAME=invalid/codename!\n",
				aptScript: (stateDir) => `#!/usr/bin/env bash\necho "$@" >> "${stateDir}/apt.log"\nexit 0\n`,
			},
			({ res, hasState }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /invalid or missing Ubuntu codename/u);
				assert.equal(hasState("apt.log"), false, "apt must never be invoked with invalid codename");
			},
		);
	},
);

test(
	"behavioral harness: negative control - relative or malformed keyring path fails fast before apt invocation",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				keyringPath: "relative/keyring.gpg",
				aptScript: (stateDir) => `#!/usr/bin/env bash\necho "$@" >> "${stateDir}/apt.log"\nexit 0\n`,
			},
			({ res, hasState }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /invalid keyring path 'relative\/keyring\.gpg'/u);
				assert.equal(hasState("apt.log"), false, "apt must never be invoked with relative/malformed keyring path");
			},
		);
	},
);

test(
	"behavioral harness: negative control - missing or unreadable keyring fails fast before apt invocation",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				keyringPath: "/tmp/nonexistent-keyring-" + Date.now() + ".gpg",
				aptScript: (stateDir) => `#!/usr/bin/env bash\necho "$@" >> "${stateDir}/apt.log"\nexit 0\n`,
			},
			({ res, hasState }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /Ubuntu archive keyring .* is missing, empty, or unreadable/u);
				assert.equal(hasState("apt.log"), false, "apt must never be invoked with missing keyring");
			},
		);
	},
);

test(
	"behavioral harness: local package apply runs exactly once and fails terminally without retrying dpkg mutation",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				aptScript: (stateDir) => `#!/usr/bin/env bash
echo "$@" >> "${stateDir}/apt.log"
if [ "$1" = "update" ]; then
  exit 0
fi
if [[ "$*" == *"--download-only"* ]]; then
  exit 0
fi
if [[ "$*" == *"--no-download"* ]]; then
  echo "dpkg failure" >&2
  exit 1
fi
exit 0
`,
			},
			({ res, readState }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /Refusing to retry mutating dpkg state/u);
				const aptLog = readState("apt.log");
				const noDownloadCount = aptLog.split("\n").filter((l) => l.includes("--no-download")).length;
				assert.equal(noDownloadCount, 1, "Expected local apply (--no-download) to execute exactly once");
			},
		);
	},
);

test(
	"behavioral harness: package, tool, or module verification failure terminates with error",
	{ skip: process.platform !== "linux" && "Linux-only GNU timeout/sudo/apt boundary" },
	() => {
		withInstallerHarness(
			{
				dpkgScript: `#!/usr/bin/env bash
if [[ "$*" == *"libgif-dev"* ]]; then
  exit 1
fi
echo "install ok installed"
`,
			},
			({ res }) => {
				assert.notEqual(res.status, 0);
				assert.match(res.stderr, /package 'libgif-dev' is not installed properly/u);
			},
		);
	},
);
