import { execSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeArtifactStore } from "../src/cli/runtime-artifact-store.ts";
import { bootstrapCollaborationPeers } from "../src/core/collaboration/peer-bootstrap.ts";
import { bindSupervisedSelfLaunchTarget } from "../src/core/process-matrix/self-launch-target.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const job = {
	id: "team",
	parentSessionId: "parent",
	sessionName: "team",
	cwd: process.cwd(),
	title: "team",
	createdAt: 1,
	deadlineSeconds: 30,
	agents: [],
};

it.skipIf(process.platform === "win32")(
	"keeps a persisted peer command runnable after snapshot retirement and clears snapshot-bound environment",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-stable-peer-"));
		roots.push(root);
		const origin = join(root, "original");
		const artifacts = join(root, "artifacts");
		await mkdir(origin);
		await mkdir(artifacts);
		const cli = join(origin, "cli.mjs");
		await writeFile(
			cli,
			"console.log(JSON.stringify({args:process.argv.slice(2),packageDir:process.env.PI_PACKAGE_DIR,config:process.env.TSX_TSCONFIG_PATH}));",
		);
		const target = { executable: process.execPath, argsPrefix: [cli] };
		const store = new RuntimeArtifactStore({ root: origin, entries: ["cli.mjs"], target }, artifacts);
		const snapshot = await store.capture();
		const retiredTarget = store.target(snapshot);
		bindSupervisedSelfLaunchTarget({
			...target,
			environment: { PI_PACKAGE_DIR: origin, TSX_TSCONFIG_PATH: join(origin, "tsconfig.json") },
		});
		const { job: persisted } = bootstrapCollaborationPeers(job, root);
		await store.retire(snapshot);
		expect(spawnSync(retiredTarget.executable, retiredTarget.argsPrefix).error).toBeDefined();
		expect(persisted.peerCommand).toContain(cli);
		const output = execSync(`${persisted.peerCommand} send two message hello`, {
			cwd: root,
			encoding: "utf8",
			timeout: 5000,
			env: { ...process.env, PI_PACKAGE_DIR: snapshot, TSX_TSCONFIG_PATH: join(snapshot, "tsconfig.json") },
		});
		expect(JSON.parse(output)).toEqual({
			args: ["--collaboration-peer", "send", "two", "message", "hello"],
			packageDir: origin,
			config: join(origin, "tsconfig.json"),
		});
	},
);

it("refuses peer admission when a supervised host has no proven stable launcher", () => {
	bindSupervisedSelfLaunchTarget(null);
	expect(() => bootstrapCollaborationPeers(job, "/state")).toThrow(/portable/);
});
