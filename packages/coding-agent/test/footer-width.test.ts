import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	dailyCost?: number;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		getSpawnedUsage: () => ({ cost: 0, reports: 0 }),
		getDailyUsageTotals: () => ({ totalCost: options.dailyCost ?? 0 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	providerCount: number,
	extensionStatuses = new Map<string, string>(),
	autonomyStatus?: string,
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => providerCount,
		getAutonomyStatus: () => autonomyStatus,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("folds duplicate learning footer statuses into one phase chip", () => {
		const session = createSession({ sessionName: "" });
		const statuses = new Map<string, string>([
			["auto-learn", "(learning)"],
			["continuous-learning", "\u001b[33m(learning)\u001b[0m\u001b[2m auto\u001b[0m"],
			["pi-chat", "pi-chat"],
		]);
		const footer = new FooterComponent(session, createFooterData(1, statuses));

		const statusLine = stripAnsi(footer.render(120).at(-1) ?? "");

		expect(statusLine).toContain("learn:auto");
		expect(statusLine).toContain("pi-chat");
		expect(statusLine).not.toContain("(learning) (learning)");
	});

	it("shows the active-day cost total in the visible stats line", () => {
		const session = createSession({ sessionName: "", dailyCost: 2.415 });
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1] ?? "");

		expect(statsLine).toContain("day:$2.415");
	});

	it("renders autonomy status on the status line when present", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1, new Map(), "Autonomy: idle"));

		const lines = footer.render(120);
		const statusLine = stripAnsi(lines.at(-1) ?? "");

		expect(lines.length).toBe(3); // pwd, stats, status
		expect(statusLine).toBe("Autonomy: idle");
	});

	it("renders autonomy status before extension statuses when both are present", () => {
		const session = createSession({ sessionName: "" });
		const statuses = new Map<string, string>([["my-ext", "ext-status"]]);
		const footer = new FooterComponent(session, createFooterData(1, statuses, "Autonomy: running"));

		const lines = footer.render(120);
		const statusLine = stripAnsi(lines.at(-1) ?? "");

		expect(statusLine).toBe("Autonomy: running ext-status");
	});

	it("sanitizes autonomy status before rendering it on the footer line", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1, new Map(), "Autonomy:\nrunning\tfast"));

		const lines = footer.render(120);
		const statusLine = stripAnsi(lines.at(-1) ?? "");

		expect(lines).toHaveLength(3);
		expect(statusLine).toBe("Autonomy: running fast");
	});

	it("truncates long autonomy status to width with the existing footer truncation path", () => {
		const session = createSession({ sessionName: "" });
		const longStatus = `Autonomy: ${"running ".repeat(50)}`;
		const footer = new FooterComponent(session, createFooterData(1, new Map(), longStatus));

		const width = 80;
		const lines = footer.render(width);
		const statusLine = lines.at(-1) ?? "";

		expect(visibleWidth(statusLine)).toBeLessThanOrEqual(width);
		expect(stripAnsi(statusLine)).toContain("...");
	});

	it("leaves footer line count unchanged when autonomy status and extension statuses are absent", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(120);
		expect(lines.length).toBe(2); // Only pwd and stats
	});
});
