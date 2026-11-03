/**
 * The hidden pi command that runs the detached bot daemon: `pi --bot-daemon <agentDir> <leaseToken>`.
 * Dependency-free so the CLI entry can recognise it before loading anything else.
 */
export const BOT_DAEMON_COMMAND = "--bot-daemon";

export function botDaemonCommandArgs(agentDir: string, leaseToken: string): string[] {
	return [BOT_DAEMON_COMMAND, agentDir, leaseToken];
}
