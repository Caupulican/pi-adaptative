import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import type { PiSelfLaunchTarget } from "./resume-launcher.ts";

export interface StableSelfLaunchTarget extends PiSelfLaunchTarget {
	environment: { PI_PACKAGE_DIR: string; TSX_TSCONFIG_PATH: string };
}

let supervisedTarget: StableSelfLaunchTarget | null | undefined;

/** Installed only by the consumed supervisor channel; null forbids a snapshot fallback. */
export function bindSupervisedSelfLaunchTarget(target: StableSelfLaunchTarget | null): void {
	supervisedTarget = target
		? { ...target, argsPrefix: [...target.argsPrefix], environment: { ...target.environment } }
		: null;
}

/** Persistent commands must outlive a retained runtime generation, unlike finite control helpers. */
export function getStableSelfLaunchTarget():
	| (PiSelfLaunchTarget & { environment?: StableSelfLaunchTarget["environment"] })
	| undefined {
	if (supervisedTarget !== undefined) {
		return supervisedTarget
			? {
					...supervisedTarget,
					argsPrefix: [...supervisedTarget.argsPrefix],
					environment: { ...supervisedTarget.environment },
				}
			: undefined;
	}
	const target = getSelfLaunchTarget();
	return target ? normalizeSelfLaunchTarget(target) : undefined;
}

/** One argv owner for both immutable captures and durable original-source commands. */
export function normalizeSelfLaunchTarget(target: PiSelfLaunchTarget, root?: string): PiSelfLaunchTarget {
	const args = [...target.argsPrefix];
	for (let index = 0; index < args.length; index++) {
		const argument = /^-r.+/.test(args[index]) ? `--require=${args[index].slice(2)}` : args[index];
		const loader = /^(--(?:import|require|loader|experimental-loader)|-r)(?:=(.*))?$/.exec(argument);
		if (!loader) continue;
		const specifier = loader[2] ?? args[++index];
		if (!specifier || !(isAbsolute(specifier) || specifier.startsWith("file:") || /^\.\.?[/\\]/.test(specifier)))
			throw new Error(
				"Runtime loader must use an explicit path within the captured root; use the native source launcher for source checkouts.",
			);
		const path = specifier.startsWith("file:") ? fileURLToPath(specifier) : resolve(specifier);
		if (root !== undefined && !isPathWithinScope(path, root))
			throw new Error("Runtime loader points outside the captured root.");
		args[index] = loader[2] === undefined ? path : `${loader[1]}=${path}`;
	}
	if (args.length) {
		const entry = resolve(args.at(-1)!);
		if (root !== undefined && !isPathWithinScope(entry, root))
			throw new Error("Runtime entry point is outside the captured root.");
		args[args.length - 1] = entry;
	}
	return { executable: target.executable, argsPrefix: args };
}

/** Resolve only the running host, retaining loader flags for source checkouts. */
export function getSelfLaunchTarget(
	host: Pick<NodeJS.Process, "execPath" | "execArgv" | "argv"> = process,
): PiSelfLaunchTarget | undefined {
	const executableName = host.execPath.split(/[\\/]/).at(-1)?.toLowerCase();
	if (!["node", "node.exe", "bun", "bun.exe"].includes(executableName ?? "")) {
		return { executable: host.execPath, argsPrefix: [] };
	}
	const cliPath = host.argv[1];
	return cliPath && !cliPath.startsWith("-")
		? { executable: host.execPath, argsPrefix: [...host.execArgv, cliPath] }
		: undefined;
}
