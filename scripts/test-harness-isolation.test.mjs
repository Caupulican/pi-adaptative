import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const harnessPath = join(repositoryRoot, "test.sh");
const releasePath = join(repositoryRoot, "scripts", "release.mjs");
const clearedVariables = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"KIMI_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"BEDROCK_EXTENSIVE_MODEL_TEST",
	"SAKANA_API_KEY",
	"FUGU_API_KEY",
	"FUGU_BASE_URL",
	"PI_RUN_SCRATCH",
	"PI_LOCAL_MODEL_BENCH",
	"PI_LOCAL_MODEL_BENCH_MODELS",
];
const nodeOptionInjectionVariables = ["NODE_OPTIONS", "npm_config_node_options", "NPM_CONFIG_NODE_OPTIONS"];
const capturedVariables = [
	"HOME",
	"PATH",
	"PI_ADAPTATIVE_CODING_AGENT_DIR",
	"PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR",
	"PI_NO_LOCAL_LLM",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TMP",
	"TEMP",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"SystemRoot",
	"ComSpec",
	...clearedVariables,
	...nodeOptionInjectionVariables,
];

function createFixture(context) {
	const root = mkdtempSync(join(tmpdir(), "pi-test-harness-isolation-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home with spaces");
	const userAgentDir = join(home, ".pi", "agent");
	const fakeBin = join(root, "bin");
	const harnessTmp = join(root, "harness tmp");
	const capture = join(root, "npm-calls.jsonl");
	const nodeOptionsRequireFile = join(root, "node-options-inject.cjs");
	mkdirSync(join(userAgentDir, "extensions"), { recursive: true });
	mkdirSync(fakeBin, { recursive: true });
	mkdirSync(harnessTmp, { recursive: true });
	writeFileSync(join(userAgentDir, "auth.json"), "user-auth-sentinel\n");
	writeFileSync(join(userAgentDir, "settings.json"), "user-settings-sentinel\n");
	writeFileSync(join(userAgentDir, "extensions", "owned.mjs"), "user-extension-sentinel\n");
	writeFileSync(nodeOptionsRequireFile, 'process.env.ANTHROPIC_API_KEY = "repopulated-by-node-options";\n');

	const fakeNpmPath = join(fakeBin, "npm");
	writeFileSync(
		fakeNpmPath,
		`#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const names = ${JSON.stringify(capturedVariables)};
const env = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
const resolvedHome = homedir();
const resolvedTmp = tmpdir();
appendFileSync(process.env.PI_TEST_HARNESS_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  env,
  resolvedHome,
  resolvedTmp,
  homeAuthExists: existsSync(join(resolvedHome, ".pi", "agent", "auth.json")),
  homeSettingsExists: existsSync(join(resolvedHome, ".pi", "agent", "settings.json")),
  homeExtensionExists: existsSync(join(resolvedHome, ".pi", "agent", "extensions", "owned.mjs")),
  isolatedAgentDirExists: existsSync(process.env.PI_ADAPTATIVE_CODING_AGENT_DIR ?? ""),
  isolatedSessionDirExists: existsSync(process.env.PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR ?? ""),
}) + "\\n");
if (process.env.PI_TEST_HARNESS_FAIL === "1") process.exit(17);
`,
	);
	chmodSync(fakeNpmPath, 0o755);

	return { root, home, userAgentDir, fakeBin, harnessTmp, capture, nodeOptionsRequireFile };
}

function nodeOptionsRequire(fixture) {
	return `--require=${JSON.stringify(fixture.nodeOptionsRequireFile)}`;
}

function assertNodeOptionsRequireInjection(fixture) {
	const result = spawnSync(
		process.execPath,
		["-e", 'process.exit(process.env.ANTHROPIC_API_KEY === "repopulated-by-node-options" ? 0 : 2)'],
		{
			encoding: "utf8",
			env: { NODE_OPTIONS: nodeOptionsRequire(fixture) },
		},
	);
	assert.equal(result.status, 0, `Node did not apply --require from NODE_OPTIONS:\n${result.stdout}\n${result.stderr}`);
}

function runHarness(fixture, { emulateWindows = false, fail = false } = {}) {
	const originalPath = process.env.PATH ?? "";
	const expectedPath = `${fixture.fakeBin}:${originalPath}`;
	const expectedSystemRoot = "C:\\Windows";
	const expectedComSpec = "C:\\Windows\\System32\\cmd.exe";
	const env = {
		HOME: fixture.home,
		LANG: "C",
		PATH: expectedPath,
		NODE_OPTIONS: nodeOptionsRequire(fixture),
		NPM_CONFIG_NODE_OPTIONS: nodeOptionsRequire(fixture),
		PI_ADAPTATIVE_CODING_AGENT_DIR: join(fixture.root, "must-not-use-agent"),
		PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR: join(fixture.root, "must-not-use-sessions"),
		PI_TEST_HARNESS_CAPTURE: fixture.capture,
		TMPDIR: fixture.harnessTmp,
		XDG_CACHE_HOME: join(fixture.home, ".cache"),
		XDG_CONFIG_HOME: join(fixture.home, ".config"),
		XDG_DATA_HOME: join(fixture.home, ".local", "share"),
		npm_config_node_options: nodeOptionsRequire(fixture),
	};
	if (emulateWindows) {
		Object.assign(env, {
			APPDATA: join(fixture.home, "AppData", "Roaming"),
			ComSpec: expectedComSpec,
			LOCALAPPDATA: join(fixture.home, "AppData", "Local"),
			OS: "Windows_NT",
			SystemRoot: expectedSystemRoot,
			TEMP: join(fixture.home, "real-temp"),
			TMP: join(fixture.home, "real-tmp"),
			USERPROFILE: fixture.home,
		});
	}
	for (const name of clearedVariables) env[name] = `must-clear-${name}`;
	if (fail) env.PI_TEST_HARNESS_FAIL = "1";

	const result = spawnSync("bash", [harnessPath], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env,
	});
	const records = existsSync(fixture.capture)
		? readFileSync(fixture.capture, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	return { expectedComSpec, expectedPath, expectedSystemRoot, records, result };
}

function assertUserStateUnchanged(fixture) {
	assert.equal(readFileSync(join(fixture.userAgentDir, "auth.json"), "utf8"), "user-auth-sentinel\n");
	assert.equal(readFileSync(join(fixture.userAgentDir, "settings.json"), "utf8"), "user-settings-sentinel\n");
	assert.equal(
		readFileSync(join(fixture.userAgentDir, "extensions", "owned.mjs"), "utf8"),
		"user-extension-sentinel\n",
	);
	assert.equal(existsSync(join(fixture.userAgentDir, "auth.json.bak")), false);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A bare `assert.match(source, /needle/)` also matches inside a comment, so commenting out the
// line it's meant to guard silently keeps the assertion green. Anchor to a real, non-commented
// line instead (mirrors the executable-line anchoring already used for the full-suite call below).
function assertActiveLine(source, needle, label = needle) {
	const pattern = new RegExp(`^(?!\\s*#).*${escapeRegExp(needle)}`, "m");
	assert.match(source, pattern, `${label} must be an active (uncommented) line, not commented out`);
}

test("the mandatory root check owns the isolated release-test harness contract", () => {
	const source = readFileSync(harnessPath, "utf8");
	const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));

	assertActiveLine(source, "mktemp -d");
	assertActiveLine(source, "export PI_ADAPTATIVE_CODING_AGENT_DIR=");
	assertActiveLine(source, "export PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR=");
	assertActiveLine(source, 'export HOME="$TEST_RUN_ROOT/home"');
	for (const name of [
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"TMP",
		"TEMP",
		"TMPDIR",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
	]) {
		assertActiveLine(source, `export ${name}=`, name);
	}
	const shellClearedVariables = [...source.matchAll(/^unset ([A-Za-z0-9_]+)$/gm)].map((match) => match[1]);
	assert.deepEqual(shellClearedVariables, [...clearedVariables, ...nodeOptionInjectionVariables]);
	assert.doesNotMatch(source, /auth\.json\.bak|AUTH_BACKUP|Moved auth\.json|Restored auth\.json/);
	assert.doesNotMatch(source, /\$HOME\/\.pi\/agent|~\/\.pi\/agent/);
	assert.doesNotMatch(source, /^\s*(?:export\s+)?PATH=/m);
	assert.equal(
		packageJson.scripts["check:test-harness-isolation"],
		"node --test scripts/test-harness-isolation.test.mjs scripts/release-staging.test.mjs scripts/workspace-test-plan.test.mjs scripts/ci-workflow-performance.test.mjs",
	);
	assert.match(packageJson.scripts.check, /npm run check:test-harness-isolation/);
	assert.equal(packageJson.scripts.test, "node scripts/run-workspace-tests.mjs");
});

test("the release command requires exact-HEAD GitHub CI before version mutation without a local full suite", () => {
	const source = readFileSync(releasePath, "utf8");
	const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
	const cleanWorktreeCheck = 'const status = run("git status --porcelain", { silent: true });';
	const exactHeadCiCheck = "assertHeadCiSucceeded(preflightSha);";
	const versionMutation = "const version = bumpOrSetVersion(RELEASE_TARGET);";

	assert.doesNotMatch(source, /run\("\.\/test\.sh"\)/, "release preparation must never run the full suite locally");
	assert.ok(source.indexOf(cleanWorktreeCheck) < source.indexOf(exactHeadCiCheck), "cleanliness must be checked first");
	assert.ok(source.indexOf(exactHeadCiCheck) < source.indexOf(versionMutation), "exact-HEAD CI must precede version mutation");

	// Lexical pins: these fast checks are a backstop alongside the execution-proof test below,
	// which is what actually defeats remapping/wrapper/run()-weakening bypasses of this gate.
	assert.equal(packageJson.scripts["release:patch"], "node scripts/release.mjs patch");
	assert.equal(packageJson.scripts["release:minor"], "node scripts/release.mjs minor");
	assert.equal(packageJson.scripts["release:major"], "node scripts/release.mjs major");
	assert.equal(packageJson.scripts["release:promote"], "node scripts/release.mjs promote");
});

function createReleaseExecutionProofFixture(context, ciConclusion) {
	const root = mkdtempSync(join(tmpdir(), "pi-release-exec-proof-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const originDir = join(root, "origin.git");
	const workDir = join(root, "work");
	const fakeBin = join(root, "bin");
	const npmCapture = join(root, "npm-calls.jsonl");
	const testShCapture = join(root, "test-sh-called");
	mkdirSync(originDir, { recursive: true });
	mkdirSync(workDir, { recursive: true });
	mkdirSync(fakeBin, { recursive: true });

	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "pi-release-test",
		GIT_AUTHOR_EMAIL: "pi-release-test@example.com",
		GIT_COMMITTER_NAME: "pi-release-test",
		GIT_COMMITTER_EMAIL: "pi-release-test@example.com",
	};

	function git(args, options = {}) {
		const result = spawnSync("git", args, { cwd: workDir, encoding: "utf8", env: gitEnv, ...options });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
		}
		return result.stdout;
	}

	spawnSync("git", ["init", "--bare", "--initial-branch=main", originDir], { encoding: "utf8" });

	mkdirSync(join(workDir, "packages", "ai"), { recursive: true });
	writeFileSync(
		join(workDir, "packages", "ai", "package.json"),
		`${JSON.stringify({ name: "@caupulican/pi-ai", version: "1.0.0" }, null, "\t")}\n`,
	);
	writeFileSync(
		join(workDir, "package.json"),
		`${JSON.stringify({ name: "fixture", private: true, version: "0.0.0", scripts: {} }, null, "\t")}\n`,
	);
	const testShPath = join(workDir, "test.sh");
	writeFileSync(testShPath, '#!/usr/bin/env bash\nprintf "called\\n" >> "$PI_RELEASE_TEST_SH_CAPTURE"\nexit 86\n');
	chmodSync(testShPath, 0o755);

	git(["init", "--initial-branch=main"]);
	git(["add", "-A"]);
	git(["commit", "-m", "initial fixture commit"]);
	git(["remote", "add", "origin", originDir]);
	git(["push", "-u", "origin", "main"]);

	const headSha = git(["rev-parse", "HEAD"]).trim();
	const fakeGhPath = join(fakeBin, "gh");
	writeFileSync(
		fakeGhPath,
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
			JSON.stringify([{ headSha, status: "completed", conclusion: ciConclusion }]),
		)});\n`,
	);
	chmodSync(fakeGhPath, 0o755);

	const fakeNpmPath = join(fakeBin, "npm");
	writeFileSync(
		fakeNpmPath,
		`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.PI_RELEASE_NPM_CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(71);\n`,
	);
	chmodSync(fakeNpmPath, 0o755);

	const releaseEnv = {
		...gitEnv,
		PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
		PI_RELEASE_NPM_CAPTURE: npmCapture,
		PI_RELEASE_TEST_SH_CAPTURE: testShCapture,
	};

	return { root, workDir, originDir, git, releaseEnv, headSha, npmCapture, testShCapture };
}

test(
	"release.mjs aborts before mutation when exact-HEAD GitHub CI is red (execution proof)",
	{ skip: process.platform === "win32" },
	(context) => {
		const fixture = createReleaseExecutionProofFixture(context, "failure");
		const aiPackagePath = join(fixture.workDir, "packages", "ai", "package.json");
		const versionBefore = JSON.parse(readFileSync(aiPackagePath, "utf8")).version;

		const result = spawnSync(process.execPath, [releasePath, "patch"], {
			cwd: fixture.workDir,
			encoding: "utf8",
			env: fixture.releaseEnv,
		});

		assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, new RegExp(`HEAD ${fixture.headSha} ci\\.yml concluded failure`));
		assert.equal(existsSync(fixture.testShCapture), false, "red CI must stop before any local test command");
		assert.equal(existsSync(fixture.npmCapture), false, "red CI must stop before version mutation");

		const localTags = fixture.git(["tag", "-l"]).trim();
		assert.equal(localTags, "", "no tag may be created locally when the test gate fails");

		const originTags = spawnSync("git", ["tag", "-l"], {
			cwd: fixture.originDir,
			encoding: "utf8",
			env: fixture.releaseEnv,
		}).stdout.trim();
		assert.equal(originTags, "", "no tag may be pushed to origin when the test gate fails");

		const originLog = spawnSync("git", ["log", "--oneline", "main"], {
			cwd: fixture.originDir,
			encoding: "utf8",
			env: fixture.releaseEnv,
		}).stdout.trim();
		assert.equal(
			originLog.split("\n").length,
			1,
			"origin/main must not receive a release commit when the test gate fails",
		);

		const versionAfter = JSON.parse(readFileSync(aiPackagePath, "utf8")).version;
		assert.equal(versionAfter, versionBefore, "version must not be bumped when the test gate fails");
	},
);

test(
	"release.mjs delegates the full suite to successful exact-HEAD GitHub CI (execution proof)",
	{ skip: process.platform === "win32" },
	(context) => {
		const fixture = createReleaseExecutionProofFixture(context, "success");
		const result = spawnSync(process.execPath, [releasePath, "patch"], {
			cwd: fixture.workDir,
			encoding: "utf8",
			env: fixture.releaseEnv,
		});

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, new RegExp(`HEAD ${fixture.headSha} already has a successful ci\\.yml run`));
		assert.match(result.stdout, /GitHub Actions is the full-suite authority/);
		assert.equal(existsSync(fixture.testShCapture), false, "release preparation must not invoke local ./test.sh");
		const npmCalls = readFileSync(fixture.npmCapture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(npmCalls, [["run", "version:patch"]]);
	},
);

test(
	"test.sh hides user state behind an isolated home/profile without dropping PATH or Windows system variables",
	{ skip: process.platform === "win32" },
	(context) => {
		const fixture = createFixture(context);
		assertNodeOptionsRequireInjection(fixture);
		const { expectedComSpec, expectedPath, expectedSystemRoot, records, result } = runHarness(fixture, {
			emulateWindows: true,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(
			records.map((record) => record.args),
			[["run", "build"], ["test"]],
		);
		assertUserStateUnchanged(fixture);

		const runRoots = new Set();
		for (const record of records) {
			const runRoot = dirname(record.env.PI_ADAPTATIVE_CODING_AGENT_DIR);
			const isolatedHome = join(runRoot, "home");
			assert.equal(record.env.HOME, isolatedHome);
			assert.equal(record.resolvedHome, isolatedHome);
			assert.notEqual(record.env.HOME, fixture.home);
			assert.equal(record.env.USERPROFILE, isolatedHome);
			assert.equal(record.env.APPDATA, join(isolatedHome, "AppData", "Roaming"));
			assert.equal(record.env.LOCALAPPDATA, join(isolatedHome, "AppData", "Local"));
			assert.equal(record.env.TEMP, join(runRoot, "tmp"));
			assert.equal(record.env.TMP, join(runRoot, "tmp"));
			assert.equal(record.env.TMPDIR, join(runRoot, "tmp"));
			assert.equal(record.resolvedTmp, join(runRoot, "tmp"));
			assert.equal(record.env.XDG_CONFIG_HOME, join(runRoot, "xdg", "config"));
			assert.equal(record.env.XDG_CACHE_HOME, join(runRoot, "xdg", "cache"));
			assert.equal(record.env.XDG_DATA_HOME, join(runRoot, "xdg", "data"));
			assert.equal(record.env.PATH, expectedPath);
			assert.equal(record.env.SystemRoot, expectedSystemRoot);
			assert.equal(record.env.ComSpec, expectedComSpec);
			assert.equal(record.env.PI_NO_LOCAL_LLM, "1");
			for (const name of clearedVariables) assert.equal(record.env[name], null, name);
			for (const name of nodeOptionInjectionVariables) assert.equal(record.env[name], null, name);
			assert.equal(record.homeAuthExists, false);
			assert.equal(record.homeSettingsExists, false);
			assert.equal(record.homeExtensionExists, false);
			assert.equal(record.isolatedAgentDirExists, true);
			assert.equal(record.isolatedSessionDirExists, true);
			assert.equal(dirname(record.env.PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR), runRoot);
			assert.equal(relative(fixture.harnessTmp, runRoot).startsWith(".."), false);
			runRoots.add(runRoot);
		}
		assert.equal(runRoots.size, 1);
		assert.equal(existsSync([...runRoots][0]), false, "per-run test state must be removed on success");
	},
);

test(
	"test.sh removes only its isolated run directory after an npm failure",
	{ skip: process.platform === "win32" },
	(context) => {
		const fixture = createFixture(context);
		const { records, result } = runHarness(fixture, { fail: true });
		assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
		assert.equal(records.length, 1);
		assertUserStateUnchanged(fixture);
		const runRoot = dirname(records[0].env.PI_ADAPTATIVE_CODING_AGENT_DIR);
		assert.equal(records[0].resolvedHome, join(runRoot, "home"));
		assert.equal(records[0].resolvedTmp, join(runRoot, "tmp"));
		assert.equal(records[0].env.TMPDIR, join(runRoot, "tmp"));
		assert.equal(records[0].env.TMP, join(runRoot, "tmp"));
		assert.equal(records[0].env.TEMP, join(runRoot, "tmp"));
		assert.equal(records[0].env.XDG_CONFIG_HOME, join(runRoot, "xdg", "config"));
		assert.equal(records[0].env.XDG_CACHE_HOME, join(runRoot, "xdg", "cache"));
		assert.equal(records[0].env.XDG_DATA_HOME, join(runRoot, "xdg", "data"));
		for (const name of nodeOptionInjectionVariables) assert.equal(records[0].env[name], null, name);
		assert.equal(records[0].homeAuthExists, false);
		assert.equal(records[0].homeSettingsExists, false);
		assert.equal(records[0].homeExtensionExists, false);
		assert.equal(existsSync(runRoot), false, "per-run test state must be removed after failure");
		assert.equal(existsSync(fixture.root), true, "cleanup must not remove the fixture parent");
	},
);
