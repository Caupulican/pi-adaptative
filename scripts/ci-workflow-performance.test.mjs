import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
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

test("release publication is gated on deterministic Node-package and Bun-binary conversation smoke", () => {
	const smokeJobStart = releaseWorkflow.indexOf("  verify-node-bun-release:");
	assert.notEqual(smokeJobStart, -1, "release workflow must define the Node/Bun smoke job");
	const nextJobMatch = releaseWorkflow.slice(smokeJobStart + 2).match(/^  [a-z0-9-]+:\n/mu);
	assert.ok(nextJobMatch?.index !== undefined, "release smoke job must be followed by another job");
	const smokeJobEnd = smokeJobStart + 2 + nextJobMatch.index;
	const smokeJob = releaseWorkflow.slice(smokeJobStart, smokeJobEnd);

	assert.match(smokeJob, /^    needs: build$/mu);
	assert.match(smokeJob, /name: release-binaries/u);
	assert.match(smokeJob, /npm ci --ignore-scripts/u);
	assert.match(smokeJob, /npm run release:local -- --out .* --force --skip-check --skip-bun-install --skip-binary-build/u);
	assert.match(smokeJob, /node scripts\/release-artifact-smoke\.mjs/u);
	assert.match(smokeJob, /--node /u);
	assert.match(smokeJob, /--bun /u);
	assert.doesNotMatch(smokeJob, /secrets\./u, "deterministic smoke must not require provider credentials");
	assert.doesNotMatch(smokeJob, /build-binaries\.sh/u, "smoke must reuse the already-built Bun artifact");

	const releaseJobStart = releaseWorkflow.indexOf("  release:");
	const publishJobStart = releaseWorkflow.indexOf("  publish-npm:");
	assert.notEqual(releaseJobStart, -1);
	assert.notEqual(publishJobStart, -1);
	const releaseJob = releaseWorkflow.slice(releaseJobStart, publishJobStart);
	assert.match(releaseJob, /needs: \[[^\]]*verify-node-bun-release[^\]]*\]/u);
});

test("npm publish preserves the proven npm-token path with OIDC provenance", () => {
	const publishJobStart = releaseWorkflow.indexOf("  publish-npm:");
	assert.notEqual(publishJobStart, -1, "release workflow must define the npm publish job");
	const nextJobMatch = releaseWorkflow.slice(publishJobStart + 2).match(/^  [a-z0-9-]+:\n/mu);
	const publishJobEnd =
		nextJobMatch?.index === undefined ? releaseWorkflow.length : publishJobStart + 2 + nextJobMatch.index;
	const publishJob = releaseWorkflow.slice(publishJobStart, publishJobEnd);
	assert.match(publishJob, /^      id-token: write$/mu);
	assert.doesNotMatch(publishJob, /^    environment:/mu, "token publication must not acquire a new environment binding");
	assert.match(publishJob, /registry-url: 'https:\/\/registry\.npmjs\.org'/u);
	assert.match(publishJob, /cache: npm/u, "npm dependency caching must remain enabled for the publish job");

	const publishStepStart = publishJob.indexOf("      - name: Publish npm packages");
	assert.notEqual(publishStepStart, -1, "release workflow must define the npm publish step");
	assert.match(
		publishJob,
		/- name: Publish npm packages\n        env:\n          NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n        run: node scripts\/publish\.mjs/u,
		"publish must use the repository's established NPM_TOKEN secret",
	);
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
