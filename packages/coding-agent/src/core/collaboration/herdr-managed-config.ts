import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingFileError, withFileLock, writeFileAtomic } from "../util/atomic-file.ts";
import { readBoundedTextFile } from "../util/bounded-file.ts";

/** Native restore loses admitted wrapper/env/permission identity; only the coordinator may resume work. */
export async function ensureHerdrManagedConfiguration(configPath: string, create: boolean): Promise<void> {
	const content = `onboarding = false\n[terminal]\ndefault_shell = "${process.platform === "win32" ? "powershell.exe" : "/bin/sh"}"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n`;
	const validate = async () => {
		let existing: string;
		try {
			existing = await readBoundedTextFile(configPath, 8192, "Herdr managed configuration");
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
			if (!create)
				throw new Error("The managed Herdr configuration is missing; an existing turn cannot be relaunched.");
			await writeFileAtomic(configPath, content, { mode: 0o600 });
			return;
		}
		if (existing === content) return;
		if (
			create &&
			existing === content.replace("resume_agents_on_restore = false", "resume_agents_on_restore = true")
		) {
			await writeFileAtomic(configPath, content, { mode: 0o600 });
			return;
		}
		throw new Error(
			"Managed Herdr configuration is not recognized or permits an unowned native restore; no configuration was overwritten.",
		);
	};
	if (!create) return validate();
	await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
	await withFileLock(configPath, validate);
}
