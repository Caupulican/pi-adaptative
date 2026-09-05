import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RuntimeArtifactStore } from "../src/cli/runtime-artifact-store.ts";
import { RUNTIME_SUPERVISOR_ENV } from "../src/cli/runtime-channel.ts";
import { launchRuntimeChild } from "../src/cli/runtime-child-process.ts";
import { RuntimeSupervisor, type RuntimeSupervisorRecord } from "../src/core/runtime-supervisor.ts";

it("recovers the same handoff from a real candidate syntax failure using the independent code snapshot", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-process-"));
	const source = join(root, "source");
	const artifacts = join(root, "artifacts");
	await mkdir(source);
	await mkdir(artifacts);
	const sessionFile = join(root, "session.jsonl");
	const request = { id: "real-update", sessionId: "same-session", sessionFile };
	await writeFile(
		join(source, "cli.mjs"),
		`
import { appendFileSync } from "node:fs";
const { handoff } = JSON.parse(process.env.${RUNTIME_SUPERVISOR_ENV});
const request = ${JSON.stringify(request)};
process.send({ type: "ready" });
if (handoff) {
  appendFileSync(handoff.sessionFile, JSON.stringify({ ...handoff, pid: process.pid }) + "\\n");
  process.exit(0);
} else {
  appendFileSync(request.sessionFile, JSON.stringify({ initial: true, pid: process.pid }) + "\\n");
  process.on("message", message => {
    if (message.type === "prepared") process.send({ type: "handoff", id: request.id }, () => process.exit(0));
  });
  process.send({ type: "prepare", request });
}
`,
	);
	const store = new RuntimeArtifactStore(
		{
			root: source,
			entries: ["cli.mjs"],
			target: { executable: process.execPath, argsPrefix: [join(source, "cli.mjs")] },
		},
		artifacts,
	);
	const records: RuntimeSupervisorRecord[] = [];
	const supervisor = new RuntimeSupervisor({
		capture: async () => {
			await writeFile(join(source, "cli.mjs"), "this is invalid JavaScript {{{");
			return store.capture();
		},
		retire: (artifact) => store.retire(artifact),
		record: (record) => {
			records.push(record);
		},
		watch: (ms, expired) => {
			const timer = setTimeout(expired, Math.min(ms, 5000));
			return () => clearTimeout(timer);
		},
		launch: (artifact, handoff) =>
			launchRuntimeChild(store.target(artifact), [], {
				cwd: root,
				env: {
					...process.env,
					[RUNTIME_SUPERVISOR_ENV]: JSON.stringify({ parentPid: process.pid, origin: source, handoff }),
				},
				terminal: "ignore",
			}),
	});
	try {
		expect(await supervisor.run(await store.capture())).toBe(0);
		const lines = (await readFile(sessionFile, "utf8"))
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line) as Record<string, unknown>);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatchObject({ ...request, disposition: "rollback" });
		expect(lines[1].pid).not.toBe(lines[0].pid);
		expect(records.map((record) => record.phase)).toEqual([
			"starting",
			"ready",
			"prepared",
			"handoff",
			"terminal",
			"starting",
			"terminal",
			"rollback",
			"starting",
			"ready",
			"terminal",
		]);
	} finally {
		supervisor.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
