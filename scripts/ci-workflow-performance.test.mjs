import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const installScript = readFileSync(new URL("../scripts/install-linux-ci-deps.sh", import.meta.url), "utf8");

test("normal CI keeps small workspaces on the quality job and shards coding-agent four ways", () => {
	assert.match(workflow, /run: npm test -- packages\/tui packages\/ai packages\/agent/u);
	assert.match(workflow, /^  coding-agent-test:\n/mu);
	assert.match(workflow, /shard: \[1, 2, 3, 4\]/u);
	assert.match(workflow, /--shard=\$\{\{ matrix\.shard \}\}\/4/u);
	assert.doesNotMatch(workflow, /^\s+run: npm test\s*$/mu);
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

test("CI jobs share the bounded Linux dependency installation script without duplicate YAML commands", () => {
	const matches = workflow.match(/run: \.\/scripts\/install-linux-ci-deps\.sh/g);
	assert.equal(matches?.length, 2);
	assert.doesNotMatch(workflow, /apt-get update/u);
	assert.doesNotMatch(workflow, /apt-get install/u);
});

test("bounded Linux dependency installer configures kill-after timeouts, split download/apply, and package verification", () => {
	assert.match(installScript, /Acquire::http::Timeout=15/u);
	assert.match(installScript, /Acquire::https::Timeout=15/u);
	assert.match(installScript, /Acquire::Retries=3/u);
	assert.match(installScript, /timeout --kill-after=/u);
	assert.match(installScript, /apt-get install -y --download-only/u);
	assert.match(installScript, /apt-get install -y --no-download/u);
	assert.match(installScript, /dpkg-query -W -f='\$\{Status\}\\n'/u);
	assert.match(installScript, /for tool in fd rg pkg-config; do/u);
	assert.match(installScript, /for mod in cairo pango librsvg-2\.0; do/u);
});

test("behavioral harness: network fetch stall is forcibly killed with kill-after, retries, and succeeds within bounds", () => {
	const dir = mkdtempSync(join(tmpdir(), "ci-deps-test-"));
	try {
		const binDir = join(dir, "bin");
		const stateDir = join(dir, "state");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });

		const sudoPath = join(binDir, "sudo");
		writeFileSync(sudoPath, "#!/usr/bin/env bash\nexec \"$@\"\n");
		chmodSync(sudoPath, 0o755);

		const aptPath = join(binDir, "apt-get");
		const aptScript = `#!/usr/bin/env bash
echo "$@" >> "${stateDir}/apt.log"
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
`;
		writeFileSync(aptPath, aptScript);
		chmodSync(aptPath, 0o755);

		const dpkgPath = join(binDir, "dpkg-query");
		writeFileSync(dpkgPath, "#!/usr/bin/env bash\necho \"install ok installed\"\n");
		chmodSync(dpkgPath, 0o755);

		const pkgConfigPath = join(binDir, "pkg-config");
		writeFileSync(pkgConfigPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(pkgConfigPath, 0o755);

		const fdPath = join(binDir, "fd");
		writeFileSync(fdPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fdPath, 0o755);

		const rgPath = join(binDir, "rg");
		writeFileSync(rgPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(rgPath, 0o755);

		const scriptPath = join(new URL("../scripts/install-linux-ci-deps.sh", import.meta.url).pathname);
		const start = Date.now();
		const res = spawnSync(scriptPath, [], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CI_APT_UPDATE_TIMEOUT: "1s",
				CI_APT_DOWNLOAD_TIMEOUT: "1s",
				CI_APT_INSTALL_TIMEOUT: "1s",
				CI_APT_KILL_AFTER: "1s",
				CI_APT_MAX_ATTEMPTS: "2",
				CI_APT_RETRY_DELAY: "0",
			},
			encoding: "utf8",
		});
		const elapsed = Date.now() - start;
		assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
		assert(elapsed >= 1500 && elapsed < 8000, `Expected bounded wall time between 1.5s and 8s, got ${elapsed}ms`);
		const updateCount = parseInt(readFileSync(join(stateDir, "update.count"), "utf8").trim(), 10);
		assert.equal(updateCount, 2, "Expected exactly 2 update attempts (1 killed, 1 successful retry)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("behavioral harness: local package apply runs exactly once and fails terminally without retrying dpkg mutation", () => {
	const dir = mkdtempSync(join(tmpdir(), "ci-deps-test-"));
	try {
		const binDir = join(dir, "bin");
		const stateDir = join(dir, "state");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });

		const sudoPath = join(binDir, "sudo");
		writeFileSync(sudoPath, "#!/usr/bin/env bash\nexec \"$@\"\n");
		chmodSync(sudoPath, 0o755);

		const aptPath = join(binDir, "apt-get");
		const aptScript = `#!/usr/bin/env bash
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
`;
		writeFileSync(aptPath, aptScript);
		chmodSync(aptPath, 0o755);

		const dpkgPath = join(binDir, "dpkg-query");
		writeFileSync(dpkgPath, "#!/usr/bin/env bash\necho \"install ok installed\"\n");
		chmodSync(dpkgPath, 0o755);

		const pkgConfigPath = join(binDir, "pkg-config");
		writeFileSync(pkgConfigPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(pkgConfigPath, 0o755);

		const fdPath = join(binDir, "fd");
		writeFileSync(fdPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fdPath, 0o755);

		const rgPath = join(binDir, "rg");
		writeFileSync(rgPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(rgPath, 0o755);

		const scriptPath = join(new URL("../scripts/install-linux-ci-deps.sh", import.meta.url).pathname);
		const res = spawnSync(scriptPath, [], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CI_APT_UPDATE_TIMEOUT: "1s",
				CI_APT_DOWNLOAD_TIMEOUT: "1s",
				CI_APT_INSTALL_TIMEOUT: "1s",
				CI_APT_KILL_AFTER: "1s",
				CI_APT_MAX_ATTEMPTS: "2",
				CI_APT_RETRY_DELAY: "0",
			},
			encoding: "utf8",
		});
		assert.notEqual(res.status, 0);
		assert.match(res.stderr, /Refusing to retry mutating dpkg state/u);
		const aptLog = readFileSync(join(stateDir, "apt.log"), "utf8");
		const noDownloadCount = aptLog.split("\n").filter((l) => l.includes("--no-download")).length;
		assert.equal(noDownloadCount, 1, "Expected local apply (--no-download) to execute exactly once");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("behavioral harness: package, tool, or module verification failure terminates with error", () => {
	const dir = mkdtempSync(join(tmpdir(), "ci-deps-test-"));
	try {
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });

		const sudoPath = join(binDir, "sudo");
		writeFileSync(sudoPath, "#!/usr/bin/env bash\nexec \"$@\"\n");
		chmodSync(sudoPath, 0o755);

		const aptPath = join(binDir, "apt-get");
		writeFileSync(aptPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(aptPath, 0o755);

		const dpkgPath = join(binDir, "dpkg-query");
		writeFileSync(
			dpkgPath,
			`#!/usr/bin/env bash
if [[ "$*" == *"libgif-dev"* ]]; then
  exit 1
fi
echo "install ok installed"
`,
		);
		chmodSync(dpkgPath, 0o755);

		const pkgConfigPath = join(binDir, "pkg-config");
		writeFileSync(pkgConfigPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(pkgConfigPath, 0o755);

		const fdPath = join(binDir, "fd");
		writeFileSync(fdPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fdPath, 0o755);

		const rgPath = join(binDir, "rg");
		writeFileSync(rgPath, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(rgPath, 0o755);

		const scriptPath = join(new URL("../scripts/install-linux-ci-deps.sh", import.meta.url).pathname);
		const res = spawnSync(scriptPath, [], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CI_APT_UPDATE_TIMEOUT: "1s",
				CI_APT_DOWNLOAD_TIMEOUT: "1s",
				CI_APT_INSTALL_TIMEOUT: "1s",
				CI_APT_KILL_AFTER: "1s",
				CI_APT_MAX_ATTEMPTS: "2",
				CI_APT_RETRY_DELAY: "0",
			},
			encoding: "utf8",
		});
		assert.notEqual(res.status, 0);
		assert.match(res.stderr, /package 'libgif-dev' is not installed properly/u);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
