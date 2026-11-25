import { harnessLog, type LogLevel } from "../../kernel/harness-log.ts";
import { harnessLogDir } from "../agent-paths.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { getSessionRole } from "../session-role.ts";
import { openHarnessLogFiles } from "./harness-log-files.ts";

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
		...openHarnessLogFiles(harnessLogDir(agentDir), logging.maxFileMb, logging.retainDays),
		...(logging.level ? { level: logging.level } : {}),
		...(logging.categories ? { categories: logging.categories } : {}),
		role: getSessionRole(),
	});
	harnessLog.info("session", "the harness log started", { level: harnessLog.getLevel(), agentDir });
}
