/**
 * As palavras em português do Brasil em volta da conversa: quem assina uma mensagem, a linha que uma chamada de
 * ferramenta desenha e suas dicas, as palavras que cortam uma saída e a reabrem, os resumos que uma compactação, um
 * branch e uma skill deixam, a atividade de uma linha que um agente em segundo plano ou uma rotina acrescenta ao
 * histórico, e o cabeçalho e o rodapé do paginador da transcrição. O que leva uma contagem ou um nome é função, para
 * cada língua decidir onde o valor fica e como ele concorda.
 */

import type { InterfaceText } from "../interface-text.ts";

export const CONVERSATION = {
	you: "Você",
	brain: "Mente",
	everyone: "todos",
	fromAnotherMachine: (mark: string) => `${mark} Mensagem de outra máquina`,
	onChannel: (channel: string) => `mensagem de ${channel}`,
	routed: "roteado",
	noModelName: "nenhum",
	tierRouted: "roteado",
	routeDirect: "direto",
	routeChosenByYou: (model: string) => `escolhido por você: ${model}`,
	routeEscalated: (model: string) => `escalado→${model} via model-router`,
	routeHmoe: (tier: string) => `${tier} via model-router/H-MoE`,
	routeSystemOne: (tier: string) => `${tier} via model-router/System One`,
	routeReadOnly: (tier: string) => `${tier}/somente leitura via model-router`,
	routeRouted: (tier: string) => `${tier} via model-router`,

	delegateFailed: (action: string) => `Mente · delegação ${action} falhou`,
	delegating: (action: string) => `→ delegando (${action}) para`,
	delegated: (action: string) => `→ delegado (${action}) para`,
	delegatedTarget: (action: string) =>
		action === "slices" ? "fatias em paralelo" : action === "race" ? "workers em corrida" : "subagente",
	awaitingHandoff: "→ aguardando a passagem do subagente…",
	goalStarted: "→ objetivo iniciado:",
	goalCompleted: "→ objetivo concluído",
	requirementSatisfied: (requirement: string) => `→ requisito atendido${requirement}`,

	elapsed: "Decorrido",
	took: "Levou",
	repairedArguments: "[argumentos reparados]",
	outputTruncatedForDisplay: (lines: number) =>
		`[saída truncada para exibição: ${lines} linhas; o resultado completo fica na conversa]`,
	toExpand: "para expandir",
	toCollapse: "para recolher",
	imagePlaceholder: "[Imagem: abra a transcrição para ver]",

	bashRunning: (keys: string) => `Rodando... (${keys} para cancelar)`,
	bashCancelled: "(cancelado)",
	bashExit: (code: number) => `(saiu com ${code})`,
	bashOutputTruncated: (path: string) => `Saída truncada. Saída completa: ${path}`,
	bashRunningState: "Em execução",
	bashCancelledState: "Cancelado",
	bashExitState: (code: number | undefined) =>
		code === undefined ? "saiu com código desconhecido" : `saiu com ${code}`,

	actionStatus: (pending: number, total: number) =>
		`${pending > 0 ? "Executando" : "Executadas"} ${total} ${total === 1 ? "ação" : "ações"}`,
	actionFailure: (failed: number) => ` · ${failed} ${failed === 1 ? "falhou" : "falharam"}`,
	viewTranscript: "para ver a transcrição",

	lineCount: (lines: number) => `${lines} ${lines === 1 ? "linha" : "linhas"}`,
	errorCount: (lines: number) => `erro · ${lines} ${lines === 1 ? "linha" : "linhas"}`,
	outputLabel: (lines: number) => `saída · ${lines} ${lines === 1 ? "linha" : "linhas"}`,
	errorLabel: "erro",
	diffLabel: (added: number, removed: number) => `diff${added || removed ? `  +${added} −${removed}` : ""}`,
	diffSummary: (added: number, removed: number) => `+${added} −${removed}`,
	moreLines: (hidden: number) =>
		`${hidden} ${hidden === 1 ? "linha a mais" : "linhas a mais"} · clique para mostrar tudo`,
	fullResultInTranscript: "… resultado completo na transcrição",
	systemOne: "System One",
	reasons: "motivos",
	reasonCount: (count: number) => `${count} ${count === 1 ? "motivo" : "motivos"}`,

	compactionLabel: "compactação",
	compactedFrom: (tokens: string) => `Compactado a partir de ${tokens} tokens`,
	compactedFromOpen: (tokens: string) => `Compactado a partir de ${tokens} tokens (`,
	branchLabel: "branch",
	branchSummaryTitle: "Resumo do branch",
	branchSummaryOpen: "Resumo do branch (",
	skillLabel: "Skill",
	toExpandParen: " para expandir)",

	backgroundActivityUnavailable: (kind: string) =>
		kind === "agent" ? "Atividade de agentes indisponível" : "Atividade de tarefas em segundo plano indisponível",
	agentNoun: (count: number) => (count === 1 ? "agente" : "agentes"),
	taskNoun: (count: number) => (count === 1 ? "tarefa em segundo plano" : "tarefas em segundo plano"),
	activitySucceeded: (count: number, noun: string) => `${count} ${noun} ${count === 1 ? "concluído" : "concluídos"}`,
	activityNeedsVerification: (count: number, noun: string) =>
		`${count} ${noun} ${count === 1 ? "precisa de verificação" : "precisam de verificação"}`,
	activityFailed: (count: number, noun: string) => `${count} ${noun} ${count === 1 ? "falhou" : "falharam"}`,
	activityCanceled: (count: number, noun: string) => `${count} ${noun} ${count === 1 ? "cancelado" : "cancelados"}`,

	scheduledRoutine: (routineId: string) => `Rotina agendada: ${routineId}`,
	scheduleOutcome: (refused: boolean, reason: string | undefined) =>
		`${refused ? "Não agendada" : "Não foi possível agendar"}${reason ? `: ${reason}` : ""}`,
	routineExpired: (routineId: string) => `A rotina ${routineId} chegou ao fim do prazo e foi removida`,
	routineEnded: (routineId: string) => `A rotina ${routineId} chegou ao fim e foi removida`,
	routineOutcome: (routineId: string, outcome: string) => `Rotina ${routineId}: ${outcome}`,
	routineOutcomeWithCause: (cause: string, outcome: string) => `${cause} · ${outcome}`,
	routineNothingForYou: "nada para você",
	routineEndedOutcome: "terminou",
	routineWaitsForMessage: "espera sua próxima mensagem",
	routineEarlierSlots: (count: number) => `cobre ${count} ${count === 1 ? "horário anterior" : "horários anteriores"}`,

	teamMessageTruncated: (characters: number, speaker: string) =>
		`_+${characters} caracteres; abra a conversa de ${speaker} para ver a mensagem inteira_`,
	worktreeSyncActivity: "Atividade de sincronização de worktree",
	processSupervisionActivity: "Atividade de supervisão de processos",

	modelInternalError: "A resposta do modelo falhou com um erro interno. Os detalhes estão no log.",
	verificationUnresolved:
		"A verificação continua em aberto: a checagem desta execução ainda falha. Rode de novo, ou use /verify para ver e dispensar.",
	abortedAfterRetries: (attempts: number) =>
		`Interrompido depois de ${attempts} ${attempts === 1 ? "nova tentativa" : "novas tentativas"}`,
	operationAborted: "Operação cancelada",
	noResponseReceived: "(Nenhuma resposta recebida do modelo)",

	notRun: (code: string, diagnostic: string | undefined, next: string | undefined) =>
		`Não executado: ${code}${diagnostic ? ` (${diagnostic})` : ""}.${next ? ` ${next}` : ""}`,

	transcriptTitle: "Transcrição",
	liveTail: "acompanhando o fim",
	pagerFooter: (scroll: string, page: string, jump: string, close: string) =>
		` ${scroll} rolar  ·  ${page} página  ·  ${jump} ir  ·  ${close} fechar`,

	cycle: (count: number) => `ciclo ${count}`,
	phaseTag: (phase: string) =>
		(
			({
				notice: "AVISO",
				warning: "ALERTA",
				forced: "FORÇADO",
				compacting: "COMPACTANDO",
				compacted: "COMPACTADO",
				resuming: "RETOMANDO",
			}) as Readonly<Record<string, string>>
		)[phase] ?? null,
} satisfies InterfaceText["conversation"];
