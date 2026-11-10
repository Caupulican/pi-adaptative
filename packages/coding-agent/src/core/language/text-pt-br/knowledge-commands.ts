/**
 * The Brazilian Portuguese words of the knowledge, taste and memory commands: the listings, the confirmations and the
 * refusals the host writes, and the memory drift and history diagnostics. Codes the data holds, such as a record's kind,
 * basis or action, stay as they are, so a label never changes what the code decides.
 */

import type { InterfaceText } from "../interface-text.ts";

export const KNOWLEDGE_COMMANDS = {
	knowledge: {
		validityFuture: (from: string) => `futuro, a partir de ${from}`,
		validityExpired: (until: string) => `expirado em ${until}`,
		validityCurrent: "atual",
		reachProject: "este projeto",
		reachGlobal: "global",
		ownerCommand: "comando do dono",
		ownerMessage: "mensagem do dono",
		revision: (revision: number) => `revisão ${revision}`,
		shortRevision: (revision: number) => `r${revision}`,
		evidenced: (at: string) => `última evidência ${at}`,
		summaryBody: (subject: string, key: string, text: string) => `    ${subject} / ${key}: ${text}`,
		needId:
			"Informe um registro de conhecimento pelo id ou pelos primeiros 8 caracteres ou mais (veja /knowledge list).",
		unknownRecord: (prefix: string) => `Nenhum registro de conhecimento atual ${prefix} neste escopo.`,
		ambiguousRecord: (prefix: string) => `${prefix} corresponde a mais de um registro; digite mais caracteres do id.`,
		noMore: "Não há mais registros de conhecimento aceitos.",
		none: (filter: string) => `Nenhum registro de conhecimento aceito${filter}.`,
		listHead: (revision: number, filter: string) => `Conhecimento aceito, revisão ${revision}${filter}:`,
		listMore: (query: string) => `Mais: /knowledge list ${query}`,
		listHint: "/knowledge show <id> para procedência · history <id> · correct <id> <new value> · forget <id>",
		title: (id: string) => `Conhecimento ${id}`,
		factLine: (subject: string, key: string) => `  ${subject} / ${key}`,
		value: (text: string) => `  Valor: ${text}`,
		evidencedRange: (first: string, last: string) => `  Evidências: a primeira em ${first}, a última em ${last}`,
		validRange: (from: string, until: string) => `  Válido: de ${from}${until}`,
		validUntilPart: (until: string) => ` até ${until}`,
		evidenceHead: (from: number, to: number, total: number, shortId: string) =>
			`  Evidências desta revisão (${from}-${to} de ${total}; as revisões anteriores guardam as suas em /knowledge history ${shortId}):`,
		citation: (provenance: string, at: string, sessionId: string, sourceId: string, quote: string) =>
			`  - ${provenance}, ${at}, sessão ${sessionId}, origem ${sourceId}\n      "${quote}"`,
		moreEvidence: (shortId: string, offset: number) => `Mais evidências: /knowledge show ${shortId} ${offset}`,
		historyNone: (shortId: string) => `Não há revisões anteriores de ${shortId}.`,
		historyHead: (shortId: string, subject: string, key: string) =>
			`Revisões de ${shortId} (${subject} / ${key}), mais recentes primeiro:`,
		historyVersion: (revision: number, basis: string, evidencedAt: string, provenance: string, text: string) =>
			`  r${revision} · ${basis} · evidência ${evidencedAt} · ${provenance}\n    ${text}`,
		historyMore: (shortId: string, revision: number) => `Mais: /knowledge history ${shortId} ${revision}`,
		commandTooLong: (max: number) => `Nada mudou: o comando tem mais de ${max} caracteres.`,
		noConfirmation: "Nada mudou: a confirmação do dono não está disponível.",
		forgetTitle: "Esquecer conhecimento",
		forgetQuestion: (kind: string, revision: number, fact: string, text: string) =>
			`Esquecer este fato de ${kind} na revisão ${revision}? O valor, o histórico de revisões e os nomes são removidos; só uma evidência do dono mais nova que este pedido pode ensiná-lo de novo.\n${fact}: ${text}`,
		correctTitle: "Corrigir conhecimento",
		correctQuestion: (kind: string, revision: number, fact: string, now: string, next: string) =>
			`Substituir o valor deste fato de ${kind} na revisão ${revision}?\n${fact}\nAgora: ${now}\nNovo: ${next}`,
		notConfirmed: "Nada mudou: o dono não confirmou.",
		held: (reason: string) => `Nada mudou: ${reason}.`,
		forgot: (shortId: string, revision: number) =>
			`${shortId} esquecido (revisão ${revision}). Só uma evidência do dono mais nova pode ensiná-lo de novo.`,
		corrected: (shortId: string, revision: number) =>
			`${shortId} corrigido: a revisão ${revision} tem o novo valor; o anterior fica no histórico.`,
		unavailable: "O conhecimento do dono fica disponível enquanto a memória ICM está ativa numa sessão raiz.",
		failed: (error: string) => `Conhecimento: ${error}`,
	},
	taste: {
		empty: 'Nenhum gosto aprendido ainda. O gosto vem do que você declara sobre como quer o código e os outros trabalhos escritos, por exemplo "prefiro retornos antecipados a condicionais aninhadas".',
		noMore: "Não há mais itens de gosto.",
		basisStated: "declarado",
		basisInferred: "inferido",
		sourceCount: (count: number) => `${count} ${count === 1 ? "fonte" : "fontes"}`,
		bullet: (text: string, basis: string, sources: string, lastEvidence: string, shortId: string) =>
			`- ${text} (${basis}, ${sources}, última evidência ${lastEvidence}) \`${shortId}\``,
		title: "# Gosto",
		projectHeading: "Gosto deste projeto",
		globalHeading: "Gosto global",
		exportRelativePath: "Nada foi escrito: um caminho relativo precisa ficar dentro da pasta de trabalho.",
		exported: (target: string) => `Arquivo gravado: ${target}`,
		exportHeader: (date: string) =>
			`<!-- Visão gerada do que o harness aprendeu, ${date}. Edite com /knowledge correct e /knowledge forget, não aqui. -->`,
		proposalsTitle: "# Propostas de gosto",
		proposalsIntro:
			"Nada aqui é conhecimento ainda. `/taste accept <id>` declara uma como seu gosto; `/taste reject <id>` descarta para sempre.",
		noProposals: "Nenhuma proposta de gosto aguardando.",
		proposalScopeProject: "Este projeto",
		proposalScopeGlobal: "Global",
		proposalHead: (text: string, shortId: string) => `- ${text} \`${shortId}\``,
		proposalMeta: (scope: string, origin: string, offeredAt: string) =>
			`  ${scope} · de ${origin} · oferecida em ${offeredAt}`,
		proposalEvidence: "  Evidências:",
		needProposalId: "Informe o id da proposta: pelo menos oito caracteres hexadecimais.",
		noProposalStartsWith: (token: string) => `Nenhuma proposta começa com ${token}.`,
		ambiguousProposal: (token: string) => `Mais de uma proposta começa com ${token}; digite mais caracteres.`,
		notTasteProposal: (shortId: string) =>
			`A proposta ${shortId} não é uma proposta de gosto; /taste não decide sobre ela.`,
		alreadyDecided: (shortId: string, status: string) => `A proposta ${shortId} já foi ${status}.`,
		commandTooLong: (max: number) => `Nada mudou: o comando tem mais de ${max} caracteres.`,
		noConfirmation: "Nada mudou: a confirmação do dono não está disponível.",
		acceptTitle: "Aceitar gosto",
		acceptQuestion: (kind: string, scope: string, text: string) =>
			`Declarar este fato de ${kind} como seu, para ${scope}?\n${text}`,
		scopeProject: "este projeto",
		scopeEveryProject: "todos os projetos",
		notConfirmed: "Nada mudou: o dono não confirmou.",
		unchanged: (reason: string) => `Nada mudou: ${reason}`,
		held: (reason: string) => `Nada mudou: ${reason}. A proposta continua pendente.`,
		accepted: (proposalId: string, tasteId: string) =>
			`Proposta ${proposalId} aceita como gosto ${tasteId}.  /knowledge show ${tasteId}`,
		rejected: (shortId: string) => `Proposta ${shortId} rejeitada. Ela não será oferecida de novo.`,
		unavailable: "O gosto fica disponível enquanto a memória ICM está ativa numa sessão raiz.",
		failed: (error: string) => `Gosto: ${error}`,
		more: (id: string) => `\nMais: /taste ${id}`,
	},
	memory: {
		unavailable: "A memória gerenciada não está disponível nesta sessão.",
		drifted: (count: number) =>
			`${count} ${count === 1 ? "arquivo de memória gerenciada divergiu" : "arquivos de memória gerenciada divergiram"}: /memory accept <target> adota o arquivo, /memory restore <target> traz o conteúdo gerenciado de volta`,
		inSync: "Os arquivos de memória gerenciada estão em sincronia com as revisões gerenciadas.",
		managedState: (status: string) => `estado gerenciado ${status}`,
		empty: "VAZIO no disco: divergiu",
		driftedOne: "divergiu (editado fora do protocolo gerenciado)",
		inSyncOne: "em sincronia",
		entryLine: (target: string, label: string, state: string, chars: number, managed: string, path: string) =>
			`- ${target}: ${label}, ${state}; no disco ${chars} caracteres; ${managed}\n  ${path}`,
		managedChars: (chars: number) => `${chars} caracteres gerenciados guardados`,
		managedMissing: "conteúdo gerenciado não guardado",
		historyIndexingError: (at: string, message: string) => `  detalhe do erro de indexação (${at}): ${message}`,
		historyOldIndexingError: (at: string, message: string) =>
			`  detalhe de um erro de indexação antigo, nenhuma fonte falhando agora (${at}): ${message}`,
		historyTransportStopped: "transporte parado",
		historyUnavailable: "histórico indisponível",
		historyDetail: (label: string, reason: string) => `  ${label}: ${reason}`,
		historyRetrievalError: (error: string) => `  detalhe do erro de recuperação: ${error}`,
		historyHierarchyOff: (reason: string) => `  hierarquia não está rodando: ${reason}`,
		historyReadAccess: (reason: string) => `  detalhe do acesso de leitura dos resumos: ${reason}`,
		historyFailure: (level: number, reason: string, message: string) =>
			`  falha da hierarquia (nível ${level}, ${reason}): ${message}`,
		historyRecovery: (issue: string) => `  recuperação da hierarquia: ${issue}`,
		historyFault: (at: string, cause: string) =>
			`  falha mais recente do coordenador (registrada em ${at}, pode ter passado): ${cause}`,
		historyInternalCause: (at: string, cause: string) =>
			`  causa interna mais recente do coordenador (só a mais nova, registrada em ${at}, pode ter passado): ${cause}`,
		historySummariesHeld: (reason: string) => `  resumos de modelo retidos: ${reason}`,
		historyHeldJob: (hold: string, reason: string) => `  causa do primeiro job retido${hold}: ${reason}`,
		historyHeldKind: (kind: string) => ` (retenção: ${kind})`,
		repairAcknowledge: "Reconheça a possível perda para reparar: /memory history repair-forget I-accept-lost-forgets",
		repeatSessionId: "Repita o id da sessão para confirmar: /memory history forget <session> <session>",
		system: (system: string) => `Sistema de memória: ${system}`,
	},
} satisfies InterfaceText["knowledgeCommands"];
