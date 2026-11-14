/**
 * Os avisos em português do Brasil que o host escreve na tela: as linhas de erro e de aviso em volta de uma falha, o
 * que uma compactação e uma nova tentativa dizem ao começar, terminar e cair para a alternativa, e os avisos de uma
 * linha das checagens de início. Nada daqui chega a um modelo: uma mensagem que uma ferramenta ou um provedor escreveu
 * é entregue inteira e mantém as próprias palavras.
 */

import type { InterfaceText } from "../interface-text.ts";

export const NOTICES = {
	earendilJoined: "O pi entrou na Earendil",
	earendilReadPost: "Leia o post do blog:",
	error: (message: string) => `Erro: ${message}`,
	warning: (message: string) => `Aviso: ${message}`,
	toCancel: (keys: string) => `(${keys} para cancelar)`,
	unknownErrorOccurred: "Erro desconhecido ao executar",
	unknownError: "Erro desconhecido",
	errorWord: "Erro",

	compactionCancelled: "Compactação cancelada",
	compactionFailed: "A compactação falhou",
	contextCompacted: "Contexto compactado",
	contextCompactedWithFallback: (cause: string) => `Contexto compactado (alternativa: ${cause})`,
	compactionFallbackLost: (cause: string) =>
		`A compactação caiu para um checkpoint mais simples (${cause}): o resumo narrativo foi perdido; ficaram só os arquivos e os fatos da tarefa.`,
	compactionSkipped: (reason: string) => `Compactação ignorada · ${reason}`,
	compactingContext: (cancelHint: string) => `Compactando o contexto ${cancelHint}`,
	autoCompacting: (overflow: boolean, cancelHint: string) =>
		`${overflow ? "Contexto acima do limite · " : ""}Compactação automática ${cancelHint}`,
	compactionFallbackCause: (cause: string) =>
		(
			({
				unresolved: "o modelo de resumo não está configurado",
				unauthed: "o modelo de resumo não tem credenciais",
				exhausted: "a cota do modelo de resumo acabou",
			}) as Readonly<Record<string, string>>
		)[cause] ?? "o modelo de resumo não respondeu",

	retryCountdown: (attempt: number, maxAttempts: number, seconds: number, keys: string) =>
		`Nova tentativa ${attempt}/${maxAttempts} em ${seconds}s · ${keys} cancelar`,
	retryFailed: (attempts: number, error: string) =>
		`A nova tentativa falhou depois de ${attempts} tentativas: ${error}`,

	unhandledRejection: (headline: string) => `Promise rejeitada sem tratamento. A sessão continua. ${headline}`,

	migratedCredentials: (providers: string) => `Credenciais migradas para auth.json: ${providers}`,
	modelsJsonError: (error: string) => `Erro em models.json: ${error}`,
	themeLoadFailed: (theme: string, error: string) =>
		`Falha ao carregar o tema "${theme}": ${error}\nVoltando para o tema escuro.`,
	autoLearnOfferFailed: (error: string) => `Falha ao oferecer o Auto Learn de novo: ${error}`,
	historyLoadFailed: (error: string) => `Falha ao carregar o histórico da TUI: ${error}`,
	pendingInputResumeFailed: (error: string) => `Falha ao retomar a entrada pendente: ${error}`,
	curatorArchived: (count: number, names: string) =>
		`Curador: ${count} ${count === 1 ? "skill antiga arquivada" : "skills antigas arquivadas"} automaticamente: ${names}. Para restaurar, use /curate restore <name>.`,

	shortcutHandlerError: (message: string) => `Erro no atalho: ${message}`,
	terminalInputHandlerError: (message: string) => `Erro no handler de entrada do terminal: ${message}`,
	handlerFailed: "O handler falhou.",
	extensionError: (extension: string, error: string) => `Erro na extensão "${extension}": ${error}`,

	savingPaused: "Gravação pausada: /resume reabre esta sessão",
	sessionSavePaused:
		"A gravação está pausada: a última escrita no arquivo desta sessão não terminou bem, então nada mais é gravado até o arquivo ser reaberto. O que está na tela continua. Use /resume e escolha esta sessão para reabrir, ou /new para começar outra.",
	resumeThisSession: "Para retomar esta sessão:",

	suspendUnsupported: "Suspender para segundo plano não é suportado no Windows",

	failedToCreateSession: "Falha ao criar a sessão",
	failedToForkSession: "Falha ao fazer fork da sessão",
	/** Uma espera salva com a sua aprovação cujo uso não pôde ser registrado, e cujo salvamento também não pôde ser desfeito. */
	watchArmedApprovalUnrecorded: (watchId: string, cause: string) =>
		`A espera "${watchId}" está armada, mas o uso da sua aprovação da verificação dela não pôde ser registrado e desfazer o salvamento também falhou (${cause}). A aprovação não consta como usada; apague a espera se ela não deve rodar.`,

	widgetTruncated: "... (widget truncado)",
	/** O aviso de cobrança de uma sessão autenticada com uma chave de assinatura. */
	anthropicSubscriptionAuth:
		"A autenticação por assinatura da Anthropic está ativa. O uso por harnesses de terceiros é descontado do uso extra e cobrado por token, fora dos limites do seu plano Claude. Gerencie o uso extra em https://claude.ai/settings/usage.",
	/** O que a extensão de colaboração relata quando os próprios passos falham: o texto do erro vem em seguida. */
	collaboration: {
		controlHandoffFailed: (error: string) => `Falha no handoff de controle da colaboração: ${error}`,
		cleanupExhausted: (jobId: string, agentId: string, error: string) =>
			`A limpeza da colaboração se esgotou para ${jobId}/${agentId}; o trabalho em andamento segue isolado: ${error}`,
		peerDeliveryFailed: (error: string) => `Falha na entrega a um peer da colaboração: ${error}`,
		handoffFailed: (error: string) => `Falha no handoff da colaboração: ${error}`,
		signalFailed: (error: string) => `Falha no sinal da colaboração: ${error}`,
		restorationFailed: (error: string) => `Falha na restauração da colaboração: ${error}`,
		paneUnverified: (paneId: string, reason: string) =>
			`O painel Herdr ${paneId} não pôde ser verificado (${reason}); o posicionamento volta para managed-workspace.`,
	},
} satisfies InterfaceText["notices"];
