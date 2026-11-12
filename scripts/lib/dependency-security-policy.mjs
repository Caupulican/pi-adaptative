import { DEPENDENCY_FORKS } from "../dependency-forks/definitions.mjs";

export const requiredSecurityOverrides = new Map([
	["nanoid", "3.3.18"],
	["brace-expansion", "5.0.12"],
]);

const requiredSelectorSecurityOverrides = [
	{ selector: "undici@7", packageName: "undici", major: 7, version: "7.30.1" },
	{ selector: "undici@8", packageName: "undici", major: 8, version: "8.12.4" },
];

const requiredCodingAgentRuntimePins = [
	{ packageName: "glob", version: "14.0.2" },
	{ packageName: "minimatch", version: "11.0.1" },
];

function resolveLockedDependency(packages, parentPath, dependency) {
	let directory = parentPath;
	while (directory && directory !== ".") {
		if (directory.split("/").at(-1) !== "node_modules") {
			const candidate = `${directory}/node_modules/${dependency}`;
			if (packages[candidate]) return candidate;
		}
		const separator = directory.lastIndexOf("/");
		directory = separator < 0 ? "." : directory.slice(0, separator);
	}
	const rootCandidate = `node_modules/${dependency}`;
	return packages[rootCandidate] ? rootCandidate : undefined;
}

export function validateRequiredSecurityOverrides(rootPackage, rootLockfile, codingAgentPackage) {
	const failures = [];
	for (const fork of DEPENDENCY_FORKS) {
		const expected = `file:./${fork.directory}`;
		if (rootPackage.overrides?.[fork.original] !== `$${fork.original}` || rootPackage.devDependencies?.[fork.original] !== expected)
			failures.push(`package.json: overrides.${fork.original} must use the pinned local fork ${expected}`);
	}
	for (const [name, requiredVersion] of requiredSecurityOverrides) {
		const overrideVersion = rootPackage.overrides?.[name];
		if (overrideVersion !== requiredVersion) {
			failures.push(`package.json: overrides.${name} must be ${requiredVersion}, found ${overrideVersion ?? "missing"}`);
		}

		const resolvedVersion = rootLockfile.packages?.[`node_modules/${name}`]?.version;
		if (resolvedVersion === undefined) {
			failures.push(
				`package-lock.json: node_modules/${name} must resolve to ${requiredVersion}, found ${resolvedVersion ?? "missing"}`,
			);
		}
	}
	for (const { selector, packageName, major, version } of requiredSelectorSecurityOverrides) {
		const overrideVersion = rootPackage.overrides?.[selector];
		if (overrideVersion !== version) {
			failures.push(`package.json: overrides.${selector} must be ${version}, found ${overrideVersion ?? "missing"}`);
		}

		const matchingEntries = Object.entries(rootLockfile.packages ?? {}).filter(([path, entry]) => {
			if (path !== `node_modules/${packageName}` && !path.endsWith(`/node_modules/${packageName}`)) return false;
			return typeof entry.version === "string" && entry.version.startsWith(`${major}.`);
		});
		if (matchingEntries.length === 0) {
			failures.push(`package-lock.json: ${selector} must have an installed resolution`);
		}
		for (const [path, entry] of matchingEntries) {
			if (entry.version !== version) {
				failures.push(`package-lock.json: ${path} must resolve to ${version}, found ${entry.version ?? "missing"}`);
			}
		}
	}
	const directUndiciVersion = requiredSelectorSecurityOverrides.find((required) => required.selector === "undici@8").version;
	if (codingAgentPackage?.dependencies?.undici !== directUndiciVersion) {
		failures.push(
			`packages/coding-agent/package.json: dependencies.undici must be ${directUndiciVersion}, found ${codingAgentPackage?.dependencies?.undici ?? "missing"}`,
		);
	}
	for (const { packageName, version } of requiredCodingAgentRuntimePins) {
		if (codingAgentPackage?.dependencies?.[packageName] !== version) {
			failures.push(
				`packages/coding-agent/package.json: dependencies.${packageName} must be ${version}, found ${codingAgentPackage?.dependencies?.[packageName] ?? "missing"}`,
			);
		}
		const packagePath = resolveLockedDependency(rootLockfile.packages ?? {}, "packages/coding-agent", packageName);
		const resolvedVersion = packagePath ? rootLockfile.packages[packagePath]?.version : undefined;
		if (resolvedVersion !== version) {
			failures.push(
				`package-lock.json: ${packageName} resolved from packages/coding-agent must be ${version}, found ${resolvedVersion ?? "missing"} at ${packagePath ?? "no lock path"}`,
			);
		}
	}
	for (const [name, version] of Object.entries(rootPackage.overrides ?? {})) {
		if (typeof version !== "string") continue;
		if (requiredSelectorSecurityOverrides.some((required) => required.selector === name)) continue;
		const fork = DEPENDENCY_FORKS.find((entry) => entry.original === name);
		if (fork) {
			let found = false;
			for (const [path, entry] of Object.entries(rootLockfile.packages ?? {})) {
				if (path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)) continue;
				found = true;
				const target = rootLockfile.packages?.[fork.directory];
				if (entry.link !== true || entry.resolved !== fork.directory || !target || target.link ||
					target.version !== fork.version || (target.name !== undefined && target.name !== fork.name))
					failures.push(`package-lock.json: ${path} must resolve to ${fork.name}@${fork.version}`);
			}
			if (!found) failures.push(`package-lock.json: ${name} must have a hardened installed resolution`);
			continue;
		}
		for (const [path, entry] of Object.entries(rootLockfile.packages ?? {})) {
			if (path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)) continue;
			if (entry.version !== version) {
				failures.push(`package-lock.json: ${path} must resolve to ${version}, found ${entry.version ?? "missing"}`);
			}
		}
	}
	return failures;
}

export function validateScopedConsumerSecurityOverrides(rootPackage, rootLockfile, consumers) {
	const failures = [];
	const expected = {
		mistral: {
			manifest: consumers?.mistral,
			workspacePath: "packages/ai",
			name: "@mistralai/mistralai",
			version: "2.6.4",
			zodRange: "^3.25.0 || ^4.0.0",
			zodVersion: "4.6.6",
		},
		sandbox: {
			manifest: consumers?.sandbox,
			workspacePath: "packages/coding-agent/examples/extensions/sandbox",
			name: "@anthropic-ai/sandbox-runtime",
			version: "0.0.75",
			zodRange: "^3.24.1",
			zodVersion: "3.25.76",
		},
	};
	for (const [consumer, requirement] of Object.entries(expected)) {
		if (!requirement.manifest || requirement.manifest.dependencies?.[requirement.name] !== requirement.version) {
			failures.push(`consumer manifest: ${consumer} must declare ${requirement.name}@${requirement.version}`);
		}
	}

	const scopedOverride = rootPackage.overrides?.[expected.mistral.name];
	if (!scopedOverride || typeof scopedOverride !== "object" || scopedOverride.zod !== expected.mistral.zodVersion) {
		failures.push(`package.json: overrides.${expected.mistral.name}.zod must be ${expected.mistral.zodVersion}`);
	}
	if (rootPackage.overrides?.zod !== undefined) {
		failures.push("package.json: overrides.zod must stay unset; the patched version is scoped to @mistralai/mistralai");
	}

	const lockPackages = rootLockfile.packages ?? {};
	const resolvedPaths = {};
	for (const [consumer, requirement] of Object.entries(expected)) {
		const packagePath = resolveLockedDependency(lockPackages, requirement.workspacePath, requirement.name);
		const entry = packagePath ? lockPackages[packagePath] : undefined;
		if (!entry) {
			failures.push(`package-lock.json: ${requirement.name} must resolve from ${requirement.workspacePath}`);
			continue;
		}
		if (entry.version !== requirement.version) {
			failures.push(`package-lock.json: ${packagePath} must resolve to ${requirement.version}, found ${entry.version ?? "missing"}`);
		}
		if (entry.dependencies?.zod !== requirement.zodRange) {
			failures.push(`package-lock.json: ${requirement.name} must declare zod range ${requirement.zodRange}, found ${entry.dependencies?.zod ?? "missing"}`);
		}
		const zodPath = resolveLockedDependency(lockPackages, packagePath, "zod");
		resolvedPaths[consumer] = zodPath;
		const zodVersion = zodPath ? lockPackages[zodPath]?.version : undefined;
		if (zodVersion !== requirement.zodVersion) {
			failures.push(`package-lock.json: ${requirement.name} must resolve zod@${requirement.zodVersion}, found ${zodVersion ?? "missing"} at ${zodPath ?? "no lock path"}`);
		}
	}
	if (resolvedPaths.mistral && resolvedPaths.sandbox && resolvedPaths.mistral === resolvedPaths.sandbox) {
		failures.push("package-lock.json: Mistral and sandbox-runtime must resolve zod from distinct package paths");
	}
	return failures;
}
