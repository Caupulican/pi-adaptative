import { join } from "node:path";
import { harnessLog, type LogLevel } from "../../kernel/harness-log.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { getSessionRole } from "../session-role.ts";

export interface LoggingSettingsSource {
	getLoggingSettings(): {
		readonly level?: LogLevel;
		readonly categories?: readonly string[];
		readonly maxFileMb?: number;
		readonly retainDays?: number;
	};
}

/** Starts the process's harness log under the agent directory with the owner's settings (the environment still wins). */
export function configureHarnessLog(agentDir: string, settings: LoggingSettingsSource): void {
	const logging = settings.getLoggingSettings();
	harnessLog.setRedactor(redactKnownSecrets);
	harnessLog.configure({
		dir: join(agentDir, "logs", "harness"),
		...(logging.level ? { level: logging.level } : {}),
		...(logging.categories ? { categories: logging.categories } : {}),
		...(logging.maxFileMb ? { maxFileBytes: logging.maxFileMb * 1024 * 1024 } : {}),
		...(logging.retainDays ? { retainDays: logging.retainDays } : {}),
		role: getSessionRole(),
	});
	harnessLog.info("session", "the harness log started", { level: harnessLog.getLevel(), agentDir });
}
