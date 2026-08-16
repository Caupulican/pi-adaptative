export const requiredSecurityOverrides = new Map([["nanoid", "3.3.18"]]);

export function validateRequiredSecurityOverrides(rootPackage, rootLockfile) {
	const failures = [];
	for (const [name, requiredVersion] of requiredSecurityOverrides) {
		const overrideVersion = rootPackage.overrides?.[name];
		if (overrideVersion !== requiredVersion) {
			failures.push(`package.json: overrides.${name} must be ${requiredVersion}, found ${overrideVersion ?? "missing"}`);
		}

		const resolvedVersion = rootLockfile.packages?.[`node_modules/${name}`]?.version;
		if (resolvedVersion !== requiredVersion) {
			failures.push(
				`package-lock.json: node_modules/${name} must resolve to ${requiredVersion}, found ${resolvedVersion ?? "missing"}`,
			);
		}
	}
	return failures;
}
