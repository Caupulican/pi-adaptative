import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, getPackageDir, isBunBinary } from "../config.ts";
import {
	getSelfLaunchTarget,
	normalizeSelfLaunchTarget,
	type StableSelfLaunchTarget,
} from "../core/process-matrix/self-launch-target.ts";
import { type RuntimeChild, RuntimeSupervisor } from "../core/runtime-supervisor.ts";
import { writeFileAtomicSync } from "../core/util/atomic-file.ts";
import { acquireWorkRun } from "../utils/work-directory.ts";
import { RuntimeArtifactStore, type RuntimeOrigin } from "./runtime-artifact-store.ts";
import { getRuntimeChildChannel, RUNTIME_SUPERVISOR_ENV } from "./runtime-channel.ts";
import { launchRuntimeChild } from "./runtime-child-process.ts";
import { createStandaloneRuntimeOrigin } from "./runtime-origin.ts";

/** The parent never opens a session file or reads the terminal. Each child owns both exclusively. */
export async function superviseInteractiveRuntime(args: readonly string[]): Promise<boolean> {
	if (getRuntimeChildChannel()) return false;
	const target = getSelfLaunchTarget();
	if (!target) throw new Error("Cannot capture this runtime's launch target.");
	if (/--(?:require|import|loader)\b/.test(process.env.NODE_OPTIONS ?? ""))
		throw new Error("Runtime supervision requires loader paths in argv, not external NODE_OPTIONS loaders.");
	const packageDir = getPackageDir();
	const source = !isBunBinary && existsSync(join(packageDir, "src", "cli.ts"));
	const root = source ? resolve(packageDir, "..", "..") : packageDir;
	const entries = source
		? [
				"node_modules",
				"package.json",
				"tsconfig.json",
				"tsconfig.base.json",
				...["agent", "ai", "coding-agent", "tui"].flatMap((name) =>
					[
						"src",
						"dist",
						"node_modules",
						"package.json",
						"docs",
						"examples",
						"scripts",
						"README.md",
						"CHANGELOG.md",
					].map((entry) => `packages/${name}/${entry}`),
				),
			]
		: await readdir(root);
	const origin: RuntimeOrigin = { root, entries: entries.filter((entry) => existsSync(join(root, entry))), target };
	const installed = source ? undefined : await createStandaloneRuntimeOrigin(packageDir, target);
	const stableLaunch = source ? normalizeSelfLaunchTarget(target, root) : installed?.stableTarget;
	const stableTarget: StableSelfLaunchTarget | null = stableLaunch
		? {
				...stableLaunch,
				environment: {
					PI_PACKAGE_DIR: source ? packageDir : "",
					TSX_TSCONFIG_PATH: source ? join(root, "tsconfig.json") : "",
				},
			}
		: null;
	const lease = acquireWorkRun({ agentDir: getAgentDir(), category: "runtime", tenant: "generations" });
	const store = new RuntimeArtifactStore(installed?.capture ?? origin, lease.path);
	let supervisor: RuntimeSupervisor | undefined;
	const stopping = () => supervisor?.stop();
	try {
		const initial = await store.capture();
		supervisor = new RuntimeSupervisor({
			capture: () => store.capture(),
			retire: (artifact) => store.retire(artifact),
			record: (record) =>
				writeFileAtomicSync(join(lease.path, "handoff.json"), JSON.stringify(record), { mode: 0o600 }),
			watch: (milliseconds, expired) => {
				const timer = setTimeout(expired, milliseconds);
				return () => clearTimeout(timer);
			},
			launch: (artifact, handoff): RuntimeChild => {
				const launch = store.target(artifact);
				const env: NodeJS.ProcessEnv = {
					...process.env,
					PI_PACKAGE_DIR: source ? join(artifact, "packages", "coding-agent") : artifact,
					[RUNTIME_SUPERVISOR_ENV]: JSON.stringify({
						parentPid: process.pid,
						origin: installed?.origin ?? root,
						stableTarget,
						handoff,
					}),
				};
				if (source) env.TSX_TSCONFIG_PATH = join(artifact, "tsconfig.json");
				return launchRuntimeChild(launch, args, { cwd: process.cwd(), env });
			},
		});
		process.once("SIGTERM", stopping);
		// Inherited terminal children receive the terminal's SIGINT themselves. Do not turn Escape/
		// Ctrl+C cancellation into a parent-driven teardown while the child is still flushing state.
		const ignoreTerminalInterrupt = () => {};
		process.on("SIGINT", ignoreTerminalInterrupt);
		try {
			process.exitCode = await supervisor.run(initial);
		} finally {
			process.off("SIGINT", ignoreTerminalInterrupt);
		}
		return true;
	} finally {
		process.off("SIGTERM", stopping);
		lease.release();
	}
}
