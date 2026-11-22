// Paired design and outcome accounting shared by the live driver and offline regression fixtures.
export function planTrials(tasks, repetitions, armNames = ["direct", "auto"]) {
	const trials = [];
	for (let repetition = 1; repetition <= repetitions; repetition++) {
		for (const [index, task] of tasks.entries()) {
			const arms = (repetition + index) % 2 ? armNames : [...armNames].reverse();
			for (const arm of arms)
				trials.push({ id: `${task.id}-${repetition}-${arm}`, caseId: task.id, repetition, arm });
		}
	}
	return trials;
}

export async function runGradedTask({ task, turn, assess, maxCorrections, observe }) {
	let prompt = task.prompt;
	const submissions = [];
	for (let corrections = 0; ; corrections++) {
		await observe({ corrections });
		const answer = await turn(prompt);
		const findings = await assess(answer);
		submissions.push({ corrections, findings });
		await observe({ corrections, submissions: [...submissions] });
		if (!findings.length) return "accepted";
		if (corrections === maxCorrections) return "rejected";
		prompt = `Please correct the submitted work and finish the original task. Acceptance feedback:\n${findings.join("\n")}`;
	}
}

export function summarize(plan, rows) {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const arms = {};
	const pairs = [];
	const names = plan.some((trial) => trial.arm === "baseline") ? ["baseline", "candidate"] : ["direct", "auto"];
	for (const name of names) {
		const planned = plan.filter((p) => p.arm === name);
		const finished = planned.map((p) => byId.get(p.id)).filter(Boolean);
		const accepted = finished.filter((r) => r.status === "accepted");
		const measured = finished.filter((r) => Number.isFinite(r.costUsd));
		const knownCostUsd = measured.reduce((sum, r) => sum + r.costUsd, 0);
		const durationMs = finished.reduce((sum, r) => sum + r.elapsedMs, 0);
		const complete = finished.length === planned.length;
		arms[name] = {
			planned: planned.length,
			finished: finished.length,
			pending: planned.length - finished.length,
			accepted: accepted.length,
			firstPass: accepted.filter((r) => r.corrections === 0).length,
			statusCounts: Object.fromEntries(
				[...new Set(finished.map((r) => r.status))].map((s) => [s, finished.filter((r) => r.status === s).length]),
			),
			acceptanceRate: finished.length ? accepted.length / finished.length : null,
			corrections: finished.reduce((sum, r) => sum + r.corrections, 0),
			delegated: finished.filter((r) => r.attempts?.length).length,
			elapsedMs: durationMs,
			elapsedMsPerAccepted: complete && accepted.length ? durationMs / accepted.length : null,
			pricedTrials: measured.length,
			knownCostUsd,
			costUsdPerAccepted:
				complete && measured.length === planned.length && accepted.length ? knownCostUsd / accepted.length : null,
		};
	}
	for (const p of plan.filter((trial) => trial.arm === names[0])) {
		const direct = byId.get(p.id);
		const auto = byId.get(`${p.caseId}-${p.repetition}-${names[1]}`);
		if (!direct || !auto) continue;
		pairs.push({
			caseId: p.caseId,
			repetition: p.repetition,
			[names[0]]: direct.status,
			[names[1]]: auto.status,
			acceptedDelta: Number(auto.status === "accepted") - Number(direct.status === "accepted"),
			correctionsDelta: auto.corrections - direct.corrections,
			...(names[0] === "baseline"
				? {
						tokensDelta:
							Number.isSafeInteger(auto.tokens) && Number.isSafeInteger(direct.tokens)
								? auto.tokens - direct.tokens
								: null,
					}
				: {}),
			elapsedMsDelta: auto.elapsedMs - direct.elapsedMs,
			costUsdDelta:
				Number.isFinite(auto.costUsd) && Number.isFinite(direct.costUsd) ? auto.costUsd - direct.costUsd : null,
		});
	}
	return { complete: rows.length === plan.length, arms, pairs, trials: rows };
}
