import "../builtin-install.ts";
import { runJourney8AccountWindowPhase } from "./journey-8-account-window.ts";
import { runJourney8MeteredPhase } from "./journey-8-budgets-and-brake.ts";
import { runJourney8CommandCodeAllowancePhase } from "./journey-8-command-code-allowance.ts";
import { runJourney8EmergencyStopPhase } from "./journey-8-emergency-stop.ts";
import { runJourney8OrchestrationRetentionPhase } from "./journey-8-orchestration-retention.ts";
import { HARNESS_PROVIDER } from "./journey-8-shared.ts";
import { runJourney } from "./shared.ts";

/**
 * The fleet when capacity runs out: a rate refusal narrows the account the workers share, dollars hold paid work only,
 * and the machine-wide emergency stop holds and releases the queue.
 *
 * Each leg runs in a world of its own, so the settings a leg needs, the window its account learns from and the spend its
 * files hold all start where the leg can assert them; each leg uses its own root session and leaves nothing running.
 */
export async function runJourney8(): Promise<void> {
	await runJourney(
		{
			name: "journey-8-account-window",
			journey: 8,
			// The account serves four at once under a ceiling of eight, so the account's own window runs out first. The
			// escalation ladder is off: this leg is about the fleet's room, not about what a failed worker climbs to.
			settings: {
				fleet: { ceiling: { running: 8 } },
				workerDelegation: { outcomes: { escalation: { enabled: false } } },
			},
		},
		async (world) => {
			await runJourney8AccountWindowPhase(world);
		},
	);

	await runJourney(
		{
			name: "journey-8-metered",
			journey: 8,
			// Today's budget and the brake are what the leg sets at runtime; the paid model is priced here, because a model
			// with no price costs nothing and dollars could never bind it.
			settings: {
				fleet: {
					ceiling: { running: 2 },
					budgets: { meteredUsdPerDay: 10, meteredUsdPerGoal: 0 },
					brake: { minUsd: 1 },
				},
				workerDelegation: { outcomes: { escalation: { enabled: false } } },
			},
			modelOptions: { "worker-b": { cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 } } },
		},
		async (world) => {
			await runJourney8MeteredPhase(world);
		},
	);

	await runJourney(
		{
			name: "journey-8-emergency-stop",
			journey: 8,
			settings: {
				fleet: { ceiling: { running: 4 } },
				workerDelegation: { outcomes: { escalation: { enabled: false } } },
			},
		},
		async (world) => {
			await runJourney8EmergencyStopPhase(world);
		},
	);

	await runJourney(
		{
			name: "journey-8-command-code-allowance",
			journey: 8,
			settings: {
				fleet: { ceiling: { running: 4 } },
				workerDelegation: {
					routeProviders: [HARNESS_PROVIDER],
					outcomes: { escalation: { enabled: false } },
				},
			},
			modelOptions: { "worker-b": { cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 } } },
		},
		async (world) => {
			await runJourney8CommandCodeAllowancePhase(world);
		},
	);

	await runJourney(
		{
			name: "journey-8-orchestration-retention",
			journey: 8,
			settings: {
				orchestration: { retention: { closedObjectiveDays: 1 } },
				workerDelegation: { outcomes: { escalation: { enabled: false } } },
			},
		},
		async (world) => {
			await runJourney8OrchestrationRetentionPhase(world);
		},
	);
}
