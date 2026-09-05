import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { consumeRuntimeEnvelope, RUNTIME_SUPERVISOR_ENV } from "../src/cli/runtime-channel.ts";
import { superviseInteractiveRuntime } from "../src/cli/runtime-supervision.ts";
import type * as selfLaunch from "../src/core/process-matrix/self-launch-target.ts";

const ports = vi.hoisted(() => ({ root: "", target: vi.fn(), capture: vi.fn(), launch: vi.fn(), release: vi.fn() }));
vi.mock("../src/config.ts", () => ({
	getAgentDir: () => ports.root,
	getPackageDir: () => join(ports.root, "packages", "coding-agent"),
	isBunBinary: false,
}));
vi.mock("../src/core/process-matrix/self-launch-target.ts", async (original) => ({
	...(await original<typeof selfLaunch>()),
	getSelfLaunchTarget: ports.target,
}));
vi.mock("../src/utils/work-directory.ts", () => ({
	acquireWorkRun: () => ({ path: join(ports.root, "lease"), release: ports.release }),
}));
vi.mock("../src/cli/runtime-child-process.ts", () => ({ launchRuntimeChild: ports.launch }));
vi.mock("../src/cli/runtime-artifact-store.ts", () => ({
	RuntimeArtifactStore: class {
		capture = ports.capture;
		retire = async () => {};
		target() {
			return {
				executable: join(ports.root, "snapshot", "node"),
				argsPrefix: [join(ports.root, "snapshot", "cli.ts")],
			};
		}
	},
}));

let previousExitCode: typeof process.exitCode;
afterEach(async () => {
	process.exitCode = previousExitCode;
	if (ports.root) await rm(ports.root, { recursive: true, force: true });
});

it("mints the stable source launcher before capture and passes it separately from the copied child target", async () => {
	previousExitCode = process.exitCode;
	ports.root = await mkdtemp(join(tmpdir(), "pi-supervision-target-"));
	const packageDir = join(ports.root, "packages", "coding-agent");
	const cli = join(packageDir, "src", "cli.ts");
	const loader = join(ports.root, "loader.mjs");
	await mkdir(join(packageDir, "src"), { recursive: true });
	await mkdir(join(ports.root, "lease"));
	await writeFile(cli, "");
	await writeFile(loader, "");
	ports.target.mockReturnValue({
		executable: process.execPath,
		argsPrefix: [`--import=${pathToFileURL(loader).href}`, relative(process.cwd(), cli)],
	});
	ports.capture.mockResolvedValue(join(ports.root, "snapshot"));
	ports.launch.mockImplementation(() => ({
		terminal: Promise.resolve(0),
		onMessage: () => () => {},
		send: () => {},
		stop: () => {},
	}));
	expect(await superviseInteractiveRuntime([])).toBe(true);
	const [copied, , options] = ports.launch.mock.calls[0];
	expect(copied.executable).toBe(join(ports.root, "snapshot", "node"));
	const env = { [RUNTIME_SUPERVISOR_ENV]: options.env[RUNTIME_SUPERVISOR_ENV] };
	expect(consumeRuntimeEnvelope(env, process.pid, true)?.stableTarget).toEqual({
		executable: process.execPath,
		argsPrefix: [`--import=${loader}`, cli],
		environment: { PI_PACKAGE_DIR: packageDir, TSX_TSCONFIG_PATH: join(ports.root, "tsconfig.json") },
	});
	expect(env).toEqual({});
	expect(ports.release).toHaveBeenCalledOnce();
});
