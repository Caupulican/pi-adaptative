/**
 * A tela de configurações em português do Brasil: cada rótulo de linha, descrição, título de submenu, palavra
 * de valor, dica e resumo de uma linha. A forma é a do catálogo inglês. Os valores de máquina que os arquivos
 * de configuração guardam e o código compara ficam no código; aqui está só o que a pessoa lê.
 */

export const SETTINGS_SCREEN = {
	values: {
		on: "Ligado",
		off: "Desligado",
		onLower: "ligado",
		offLower: "desligado",
		notSet: "(não definido)",
		unset: "(não definido)",
		none: "(nenhum)",
		inherit: "(herdar)",
		active: "ativo",
		agentChooses: "O agente escolhe",
		agentChoosesEffort: "o agente escolhe o esforço",
		agentChoosesLower: "o agente escolhe",
		auto: "AUTO",
		autoTier: "(AUTO)",
		autonomyModeFull: "autonomia permanente",
		noModel: "sem modelo",
		unknown: "desconhecido",
		enterTask: "digite uma tarefa",
		show: "mostrar",
		configure: "configurar",
		yes: "Sim",
		no: "Não",
	},
	valueLabels: {
		onOff: { true: "Ligado", false: "Desligado" },
		scope: {
			global: "Global",
			project: "Este projeto",
			directoryProfile: "Este diretório",
		},
		delivery: { "one-at-a-time": "Uma por vez", all: "Todas" },
		costGuardAction: { warn: "Apenas avisar", downgrade: "Reduzir raciocínio" },
		projectContextScope: {
			"this-directory": "Este diretório",
			"this-project": "Este projeto",
			"all-projects": "Todos os projetos",
		},
		projectContextLoad: {
			"global-only": "Somente global",
			"on-demand": "Sob demanda",
		},
		autonomyMode: {
			off: "Desligada",
			safe: "Segura",
			balanced: "Equilibrada",
			full: "Autonomia permanente",
		},
		modelCapability: {
			auto: "Automática",
			off: "Desligada",
			full: "Completa",
			lean: "Enxuta",
			minimal: "Mínima",
			chat: "Conversa",
		},
		routerSelection: {
			manual: "Manual",
			auto: "Automática",
			hybrid: "Híbrida",
		},
		unsetModel: { "(unset)": "(não definido)" } as Record<string, string>,
		routerPoolPreference: {
			"subscription-first": "Assinaturas primeiro",
			balanced: "Equilibrado",
		},
		transport: {
			sse: "Streaming (SSE)",
			websocket: "WebSocket",
			"websocket-cached": "WebSocket, com cache",
			auto: "Automático",
		},
		httpIdleTimeout: {
			"30 sec": "30 s",
			"1 min": "1 min",
			"2 min": "2 min",
			"5 min": "5 min",
			"11 min": "11 min",
			disabled: "desativado",
		} as Record<string, string>,
		doubleEscape: { tree: "Abrir árvore", fork: "Fork", none: "Nenhuma" },
		treeFilter: {
			default: "Padrão",
			"no-tools": "Sem ferramentas",
			"user-only": "Somente suas mensagens",
			"labeled-only": "Somente com rótulo",
			all: "Tudo",
		},
		systemOneProvider: {
			auto: "Automático",
			typesafe: "TypeSafe",
			openrouter: "OpenRouter",
		},
		hmoePreset: {
			balanced: "Equilibrado",
			quality: "Qualidade",
			"subscription-first": "Assinaturas primeiro",
			cost: "Custo",
			speed: "Velocidade",
			"local-first": "Local primeiro",
			custom: "Personalizado",
		},
		hmoeTeam: {
			single: "Modelo único",
			primary_critic: "Principal + crítico",
			independent_verifier: "Verificador independente",
			adaptive_team: "Time adaptativo",
		},
		hmoeIndependence: {
			none: "Nenhuma",
			fresh_context: "Contexto novo",
			distinct_profile: "Perfil distinto",
			distinct_model: "Modelo distinto",
			distinct_family: "Família distinta",
			distinct_provider: "Provedor distinto",
		},
		hmoePreference: {
			prefer_subscription: "Preferir assinatura",
			prefer_local: "Preferir local",
			neutral: "Neutro",
		},
	},
	hints: {
		select: "Enter para selecionar · Esc para voltar",
		filterAndSelect: "Digite para filtrar · Enter para selecionar · Esc para voltar",
		textInput: (emptyHint: string) => `Enter para salvar · Esc para voltar · ${emptyHint}`,
		emptyClearsSetting: "vazio limpa a configuração",
	},
	summaries: {
		disabled: "desativado",
		disabledLegacyDirectApply: "desativado (aplicação direta antiga)",
		enabled: "ativado",
		enabledUnbounded: "ativado (sem limite)",
		selfModification: (hasPath: boolean): string => (hasPath ? "ativado" : "ativado (caminho ausente)"),
		costGuard: (action: string, usd: string) => `${action} em US$ ${usd}/turno`,
		autonomy: (mode: string, turns: string, stall: number, autoContinue: string) =>
			`${mode}, ${turns}, parada após ${stall}, automático ${autoContinue}`,
		turns: (turns: number): string => (turns === 0 ? "turnos ilimitados" : `${turns} turnos`),
		researchLane: (usd: string, runs: number) => `ativado (US$ ${usd}/passada, ${runs} execuções por sessão)`,
		contextCuration: (model: string, jobs: number) => `ligado · ${model} · ${jobs} tarefas por turno`,
		learningPolicy: (autoApply: string, confidence: number) =>
			`ligado · aplicação automática ${autoApply} · confiança mínima ${confidence}`,
		modelCapabilityAuto: "Automática (derivada da janela de contexto do modelo)",
		workerDelegationBudget: (usd: string) => `ativado (US$ ${usd}/worker)`,
		autoLearn: (model: string) => `ativado (${model})`,
		contextPolicy: (preserve: number, minChars: number) =>
			`ativado (preserva ${preserve}, mínimo de ${minChars} caracteres)`,
		contextMemoryOff: (externalConsent: string) => `desativado (${externalConsent})`,
		contextMemoryExternalConsent: (on: boolean): string =>
			on ? "consentimento externo ligado" : "externo desligado",
		contextMemory: (max: number, inPrompt: string, external: string) =>
			`ativado (máximo ${max}${inPrompt}, ${external})`,
		contextMemoryInPrompt: ", no prompt",
		contextMemoryExternal: (on: boolean): string => (on ? "externo ligado" : "somente local"),
		router: (parts: {
			state: string;
			mode: string;
			pool: string;
			preference: string;
			gate: string;
			cheap: string;
			medium: string;
			expensive: string;
			learn: string;
		}) =>
			`${parts.state} · ${parts.mode} · conjunto ${parts.pool} · ${parts.preference} · ${parts.gate} · barato: ${parts.cheap} · médio: ${parts.medium} · caro: ${parts.expensive} · aprendizado: ${parts.learn}`,
		routerGate: (on: boolean): string => (on ? "filtro ativo" : "filtro inativo"),
		routerTier: (model: string, thinking: string) => `${model} · raciocínio ${thinking}`,
	},
	scopes: {
		global: "global",
		project: "projeto",
		directoryProfile: "perfil do diretório",
	},
	statuses: {
		costGuardOn: (usd: string, action: string) =>
			`Proteção de custo por turno ativada em US$ ${usd}/turno (${action}).`,
		costGuardOff: "Proteção de custo por turno desativada.",
		httpIdleTimeout: (value: string) => `Tempo ocioso do HTTP: ${value}`,
		themeFailed: (name: string, error: string) =>
			`Falha ao carregar o tema "${name}": ${error}\nTema escuro aplicado.`,
		projectContextOn: "lista o AGENTS.md deste projeto",
		projectContextGlobalOnly: "somente o AGENTS.md global",
		projectContextWhere: {
			thisDirectory: "este diretório",
			thisProject: "este projeto",
			allProjects: "todos os projetos",
		},
		projectContextFiles: (load: string, where: string) =>
			`Arquivos de contexto do projeto: ${load} (${where}). Rode /reload para aplicar.`,
		selfModificationSaved: (scope: string) =>
			`Configurações de automodificação salvas no escopo ${scope}. Inicie uma nova sessão ou rode /reload para as proteções do prompt de sistema atualizarem por completo.`,
		autonomySaved: (mode: string, scope: string) =>
			`Modo de autonomia ${mode} salvo no escopo ${scope}. Use /autonomy status.`,
		researchLaneSaved: (scope: string) =>
			`Configurações de pesquisa em segundo plano salvas no escopo ${scope}. Use /autonomy research ou /autonomy diagnostics.`,
		workerDelegationSaved: (scope: string) =>
			`Configurações de delegação para workers salvas no escopo ${scope}. A ferramenta delegate as usa.`,
		learningPolicySaved: (scope: string) => `Política de aprendizado salva no escopo ${scope}.`,
		systemOneProviderSaved: (provider: string) =>
			`Provedor do System One definido como ${provider}; a próxima avaliação o usa.`,
		peerError: (error: string) => `Erro na configuração do modelo par: ${error}`,
		peerSelectionDisabled: "desativado",
		peerSelection: (model: string, effort: string) => `${model} (${effort})`,
		peerOtherScope: (scope: string, activeScope: string, selection: string) =>
			`Modelo par salvo no escopo ${scope}; a configuração ativa do escopo ${activeScope} continua ${selection}.`,
		peerSaved: (scope: string, reason: string) => `Configurações do modelo par salvas no escopo ${scope}: ${reason}`,
		peerToolUnavailable: "a ferramenta de modelo par da raiz não está disponível nesta sessão",
		peerDisabled: "Modelo par desativado; as descobertas anteriores continuam disponíveis.",
		peerApplied: (selection: string, scope: string) =>
			`Modelo par: ${selection}, salvo no escopo ${scope}. Vale para a próxima revisão; sem esforço, vale o padrão do modelo.`,
		modelCapabilitySaved: (scope: string) =>
			`Modo de capacidade do modelo salvo no escopo ${scope}. Vale na próxima troca de modelo ou em /reload.`,
		contextCurationSaved: (scope: string) =>
			`Configurações de curadoria de contexto salvas no escopo ${scope}. Rode /fitness <model> antes, se o modelo não foi sondado.`,
		modelRouterSaved: (scope: string) =>
			`Configurações do roteador de modelos salvas no escopo ${scope}. Use /session ou /usage para inspecionar o roteamento.`,
		autoLearnSaved: (scope: string) =>
			`Configurações do Auto Learn salvas no escopo ${scope}. Use /auto-learn status ou /auto-learn run.`,
		contextPolicySaved: (scope: string) =>
			`Configurações de política de contexto e prompt salvas no escopo ${scope}.`,
		contextMemorySaved: (scope: string) =>
			`Configurações de recuperação de contexto e memória salvas no escopo ${scope}.`,
	},
	rows: {
		autoCompact: {
			label: "Compactação automática",
			description: "Compacta o contexto automaticamente quando ele fica grande demais",
		},
		costGuard: {
			label: "Proteção de custo por turno",
			description: "Aviso opcional de projeção em dólar por turno ou redução do raciocínio; desativada por padrão",
		},
		steeringMode: {
			label: "Modo de direcionamento",
			description:
				"Enter durante o streaming enfileira mensagens de direcionamento. 'Uma por vez': entrega uma e espera a resposta. 'Todas': entrega todas de uma vez.",
		},
		followUpMode: {
			label: "Modo de follow-up",
			description: (key: string) =>
				`${key} enfileira mensagens de follow-up até o agente parar. 'Uma por vez': entrega uma e espera a resposta. 'Todas': entrega todas de uma vez.`,
		},
		transport: {
			label: "Transporte",
			description: "Transporte preferido para provedores que aceitam mais de um",
		},
		httpIdleTimeout: {
			label: "Tempo ocioso do HTTP",
			description:
				"Intervalo ocioso máximo ao esperar cabeçalhos ou partes do corpo HTTP. Desative para modelos locais que pausam por mais de cinco minutos.",
		},
		hideThinking: {
			label: "Ocultar raciocínio",
			description: "Oculta os blocos de raciocínio nas respostas do assistente",
		},
		projectInstructions: {
			label: "Instruções do projeto",
			description:
				"Autoriza os arquivos da família AGENTS, extensões, skills e prompts deste diretório. Recursos globais e empacotados continuam disponíveis.",
		},
		collapseChangelog: {
			label: "Recolher changelog",
			description: "Mostra o changelog condensado após atualizações",
		},
		quietStartup: {
			label: "Início silencioso",
			description: "Desativa a impressão detalhada na inicialização",
		},
		doubleEscapeAction: {
			label: "Ação do Esc duplo",
			description: "Ação ao pressionar Esc duas vezes com o editor vazio",
		},
		treeFilterMode: {
			label: "Modo de filtro da árvore",
			description: "Filtro padrão ao abrir /tree",
		},
		selfModification: {
			label: "Automodificação",
			description:
				"Ativa as proteções de autoevolução do Pi e configura a cópia editável do código do pi-adaptative",
		},
		autonomy: {
			label: "Autonomia",
			description:
				"Escolha uma predefinição de autonomia em vez de ajustar vários parâmetros de aprendizado em segundo plano",
		},
		researchLane: {
			label: "Pesquisa em segundo plano",
			description:
				"Pesquisa autônoma somente leitura, opcional: passadas limitadas em segundo plano que produzem pacotes de evidência para objetivos ativos",
		},
		workerDelegation: {
			label: "Delegação para workers",
			description:
				"Workers folha neutros de provedor, ativados por padrão, com autoridade herdada e predefinições de execução opcionais escritas pelo dono",
		},
		learningPolicy: {
			label: "Política de aprendizado",
			description:
				"Filtra gravações duráveis vindas de reflexão: propostas, limites de confiança, auditorias e reversão",
		},
		modelCapability: {
			label: "Capacidade do modelo",
			description:
				"Como o pi adapta a superfície de ferramentas e os orçamentos das vias de execução a modelos pequenos (derivado dos metadados do próprio modelo)",
		},
		contextCuration: {
			label: "Curadoria de contexto",
			description:
				"Curador local opcional: resume os textos compactados pelo GC e pontua a relevância de trechos antigos em pequenas tarefas locais",
		},
		systemOneProvider: { label: "Provedor do System One" },
		peer: { label: "Modelo par" },
		modelRouter: {
			label: "Roteador de modelos",
			description:
				"Configuração do roteador: modo de seleção (Manual, Automática ou Híbrida), modelos favoritos candidatos, preferência Assinaturas primeiro, modelos fixados por faixa, calibração, prévia de rota e diagnóstico",
		},
		autoLearn: {
			label: "Auto Learn avançado",
			description: "Ajustes avançados do aprendizado e da coleta em segundo plano automáticos",
		},
		contextPolicy: {
			label: "Política de contexto e prompt",
			description:
				"Aplicação opcional da política de versões curtas de artefato: substitui por uma versão curta a saída antiga de ferramentas respaldada por artefato apenas no prompt que o modelo vê, nunca na transcrição. Exige a ferramenta de recuperação de artefatos ativa.",
		},
		contextMemory: {
			label: "Recuperação de contexto e memória",
			description:
				"Recuperação local automática e segura, ativada por padrão, com evidência limitada no prompt. A saída de consultas externas é um consentimento visível separado e continua desligada por padrão.",
		},
		warnings: {
			label: "Avisos",
			description: "Ativa ou desativa avisos individuais",
		},
		thinkingLevel: {
			label: "Nível de raciocínio",
			description: "Profundidade de raciocínio do modelo ativo; a política de delegação é configurada à parte",
		},
		theme: { label: "Tema", description: "Tema de cores da interface" },
		resources: {
			label: "Recursos",
			description: "Gerencia perfis e situações, a biblioteca e as origens de recursos externos.",
		},
		showImages: {
			label: "Mostrar imagens",
			description: "Renderiza imagens no terminal",
		},
		imageWidth: {
			label: "Largura da imagem",
			description: "Largura preferida da imagem embutida, em colunas do terminal",
		},
		autoResizeImages: {
			label: "Redimensionar imagens automaticamente",
			description: "Reduz imagens grandes para no máximo 2000x2000, para melhor compatibilidade com o modelo",
		},
		blockImages: {
			label: "Bloquear imagens",
			description: "Impede que imagens sejam enviadas aos provedores de LLM",
		},
		skillCommands: {
			label: "Comandos de skill",
			description: "Registra skills como comandos /skill:name",
		},
		showHardwareCursor: {
			label: "Mostrar cursor do terminal",
			description: "Mostra o cursor do terminal sem deixar de posicioná-lo para o suporte a IME",
		},
		editorPadding: {
			label: "Margem do editor",
			description: "Margem horizontal do editor de entrada (0-3)",
		},
		autocompleteMaxItems: {
			label: "Máximo de itens no autocompletar",
			description: "Itens visíveis na lista de autocompletar (3-20)",
		},
		clearOnShrink: {
			label: "Limpar ao encolher",
			description: "Limpa as linhas vazias quando o conteúdo encolhe (pode causar cintilação)",
		},
		terminalProgress: {
			label: "Progresso no terminal",
			description: "Mostra indicadores de progresso OSC 9;4 na barra de abas do terminal",
		},
	},
	resourcesMenu: {
		addCatalog: {
			label: "Adicionar sua pasta de catálogo →",
			description: "Primeiro uso: adicione uma pasta com skills, extensões, perfis e agentes compartilhados.",
		},
		profile: {
			label: "Perfil / Situação",
			description: (current: string) => `Selecione o perfil ou a situação ativa. Atual: ${current}`,
		},
		library: {
			label: "Gerenciar biblioteca",
			description: "Liga ou desliga ferramentas, skills e extensões permitidas no perfil e escopo ativos.",
		},
		profiles: {
			label: "Gerenciar perfis e situações",
			description: "Cria, exclui ou persiste definições de perfil e situação.",
		},
		sources: {
			label: "Origens",
			description: (count: number) => `Gerencia as raízes de recursos externos (${count} registradas).`,
		},
		title: "Central de recursos",
		description: "Configura perfis e situações e os catálogos de recursos externos.",
		profileDefault: "Usar a seleção de perfil configurada (padrão da sessão)",
	},
	costGuard: {
		title: "Limite da proteção de custo por turno",
		description:
			"Digite um limite de projeção em dólar, finito e não negativo. A chave Ativado continua obrigatória.",
		hint: "número finito e não negativo; entrada inválida mantém o valor atual",
		scope: {
			label: "Escopo de gravação",
			description: "Salva esta proteção de custo globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description: "Adesão explícita. Um limite salvo sozinho fica dormente e nunca limita nem rotula um turno.",
		},
		maxTurnUsd: {
			label: "Máximo de dólares por turno",
			description:
				"Gasto projetado do turno em primeiro plano e do segundo plano do turno atual; zero mantém a proteção inativa",
		},
		action: {
			label: "Ação",
			description: "apenas avisar, ou reduzir o raciocínio em um nível suportado para a requisição iminente",
		},
	},
	projectContext: {
		scope: {
			label: "Escopo de gravação",
			description:
				"Este diretório: apenas esta pasta (sobreposição do usuário). Este projeto: .pi/settings.json. Todos os projetos: todos os repositórios.",
		},
		load: {
			label: "Carregamento",
			description:
				"Somente global exclui os arquivos da família AGENTS, extensões, skills e prompts do projeto. Sob demanda os admite.",
		},
		summaryGlobalOnly: "somente global",
		summaryThisProject: "este projeto",
		summaryAllProjects: "todos os projetos",
		summaryThisDirectory: "este diretório",
	},
	selfModification: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva esta configuração de automodificação globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description: "Permite que agentes alterem o código e a estrutura do próprio Pi apenas quando a tarefa pedir",
		},
		sourcePath: {
			label: "Caminho do código",
			description: "Caminho da cópia do código do pi-adaptative que os agentes podem editar para autoevolução",
		},
		sourcePathTitle: "Caminho do código do pi-adaptative",
		sourcePathDescription: "Define o caminho da cópia usada pelas proteções de autoevolução. Vazio o limpa.",
	},
	autonomy: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva esta predefinição de autonomia globalmente ou no .pi/settings.json do projeto atual",
		},
		mode: {
			label: "Modo",
			description:
				"Uma predefinição para o aprendizado e para os sinais de reflexão da sessão raiz: desligado, seguro, equilibrado ou autonomia permanente",
		},
		autoContinue: {
			label: "Continuar objetivo automaticamente",
			description: "Continua um objetivo ativo sempre que o Pi fica ocioso, até uma condição terminal real",
		},
		turns: {
			label: "Turnos do objetivo",
			description: "Limite opcional de prompts de continuação; 0 é ilimitado, como no Codex",
		},
		recoveryThreshold: {
			label: "Limite de recuperação do objetivo",
			description:
				"Rodadas sem mudança antes de o Pi inspecionar a evidência de falha e trocar de abordagem sem parar",
		},
		maxMinutes: {
			label: "Máximo de minutos do objetivo",
			description: "Orçamento de tempo por ciclo de continuação do objetivo; 0 desativa o orçamento de tempo",
		},
		delayMs: {
			label: "Atraso do objetivo (ms)",
			description: "Atraso antes do início da continuação automática ociosa; 0 começa logo após a ociosidade",
		},
	},
	researchLane: {
		scope: {
			label: "Escopo de gravação",
			description:
				"Salva estas configurações de pesquisa em segundo plano globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description:
				"Executa pesquisa em segundo plano somente leitura e limitada quando ocioso e com objetivo ativo (exige o modo de autonomia ligado)",
		},
		budget: {
			label: "Orçamento por passada",
			description:
				"Orçamento em dólar por passada de pesquisa; estouros marcam a pesquisa como orçamento esgotado no diagnóstico",
		},
		maxMilliseconds: {
			label: "Máximo de milissegundos",
			description: "Orçamento de tempo por passada de pesquisa; 0 desativa o orçamento de tempo",
		},
		idleDelayMs: {
			label: "Atraso ocioso (ms)",
			description: "Atraso antes do início da pesquisa disparada por ociosidade; 0 começa logo após a ociosidade",
		},
		runsPerSession: {
			label: "Execuções por sessão",
			description:
				"Máximo de passadas de pesquisa disparadas por ociosidade por sessão; /autonomy research explícito não tem limite",
		},
	},
	workerDelegation: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva estas configurações de delegação globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description:
				"Permite que modelos capazes acionem workers folha persistentes e autônomos; ativado por padrão, e false explícito desliga de vez",
		},
		budget: {
			label: "Orçamento por tarefa de worker",
			description: "Orçamento acumulado em dólar para uma tarefa de worker; 0 desativa este teto",
		},
		budgetTitle: "Orçamento em dólar da tarefa de worker",
		budgetDescription: (max: number) =>
			`Digite um número finito e não negativo, no máximo ${max}. Zero desativa o teto de custo das configurações.`,
		budgetHint: (max: number) => `número em [0, ${max}]; entrada inválida mantém o valor atual`,
		milliseconds: {
			label: "Milissegundos por tarefa de worker",
			description: "Orçamento de tempo ativo para uma tarefa de worker; 0 desativa o orçamento de tempo",
		},
		millisecondsTitle: "Tempo ativo da tarefa de worker",
		millisecondsDescription:
			"Digite os milissegundos ativos por tarefa de worker como inteiro seguro não negativo. Zero desativa o teto de tempo.",
		millisecondsHint: "inteiro seguro não negativo; entrada inválida mantém o valor atual",
		writeEnabled: {
			label: "Permitir gravação de arquivos",
			description:
				"Deixa os workers alterarem arquivos pelas ferramentas de escrita e edição; a autoridade padrão vale para toda a máquina e false explícito a revoga",
		},
	},
	learningPolicy: {
		scope: {
			label: "Escopo de gravação",
			description:
				"Salva estas configurações da política de aprendizado globalmente ou no .pi/settings.json do projeto",
		},
		enabled: {
			label: "Ativado",
			description:
				"Filtra as gravações de reflexão da sessão raiz pela política de aprendizado (propostas, auditorias, reversão). Desativado mantém o modo direto antigo com registros de auditoria.",
		},
		autoApply: {
			label: "Aplicação automática",
			description:
				"Permite que gravações elegíveis sejam aplicadas automaticamente; caso contrário tudo vira proposta",
		},
		autoApplySupersessions: {
			label: "Aplicação automática de substituições",
			description:
				"Permite que uma substituição ou remoção de memória (sobrescreve ou exclui um fato existente) seja aplicada automaticamente quando elegível; desligado mantém toda substituição como proposta",
		},
		confidence: {
			label: "Limite de confiança",
			description:
				"Confiança mínima (0-100) para uma gravação ser aplicada automaticamente; abaixo disso, proposta ou nada",
		},
		minObservations: {
			label: "Mínimo de observações",
			description:
				"Observações necessárias antes da aplicação automática (allowedAutoApplyLayers continua somente no JSON)",
		},
	},
	modelCapability: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva globalmente ou no .pi/settings.json do projeto",
		},
		mode: {
			label: "Modo",
			description:
				'"Automática" deriva a superfície de ferramentas e os orçamentos das vias de execução da janela de contexto do próprio modelo; "Desligada" desativa a adaptação; um nome de classe a força',
		},
	},
	contextCuration: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva estas configurações de curadoria globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description:
				"Curador local: resume os textos compactados pelo GC e pontua a relevância de trechos antigos. Exige um modelo local apto ao resumo (rode /fitness <model>).",
		},
		model: {
			label: "Modelo curador",
			description:
				"Modelo local que executa as tarefas de curadoria; recusado até passar na sondagem de fitness de resumo nesta máquina",
		},
		maxJobsPerTurn: {
			label: "Máximo de tarefas por turno",
			description: "Tarefas de curadoria drenadas por turno (cada uma é uma pequena conclusão local)",
		},
	},
	systemOne: {
		inForce: (name: string, model: string) => `Em vigor: ${name} (${model}).`,
		noKey: (setup: string) => `Sem chave para esta escolha: o System One fica desligado até você ${setup}.`,
		orJoiner: " ou ",
		setupTypesafe: "usar /login typesafe ou TYPESAFE_API_KEY",
		setupOpenRouter: "usar /login openrouter ou OPENROUTER_API_KEY",
	},
	peer: {
		description: (scope: string) =>
			`Modelo par da raiz independente do System One; escopo ativo: ${scope}. O perfil de diretório sobrepõe o projeto, que sobrepõe o global.`,
		scope: {
			label: "Escopo de gravação",
			description:
				"Cada escopo substitui toda a configuração do modelo par; o perfil de diretório sobrepõe o projeto, que sobrepõe o global.",
		},
		enabled: {
			label: "Ativado",
			description:
				"Modelo par independente, apenas na sessão raiz; funciona com o System One desligado. Desativar preserva descobertas anteriores.",
		},
		model: {
			label: "Modelo",
			description:
				"Escolha um modelo par entre as contas configuradas. O modelo líder, a cota e o escopo explícito de --models/SDK podem tornar uma escolha indisponível.",
		},
		thinking: {
			label: "Raciocínio",
			description:
				"Escolha um esforço suportado ou deixe o agente escolher. Sem esforço, vale o padrão do modelo. Escolher outro modelo limpa uma sobreposição incompatível.",
		},
		thinkingTitle: "Raciocínio do modelo par",
		thinkingDescription: "Escolha um esforço ou deixe o agente escolher; sem esforço, vale o padrão do modelo",
		choosesForEachReview: "Escolhe para cada revisão",
	},
	autoLearn: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva esta configuração do Auto Learn globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description: "Dispara automaticamente a coleta de histórico em segundo plano em sessões longas",
		},
		model: {
			label: "Modelo coletor",
			description: (pattern?: string) =>
				pattern
					? `Modelo para o aprendizado explícito e em segundo plano. "ativo" usa ${pattern}; modelos configurados por assinatura/API aparecem primeiro. A reflexão automática usa o turno atual da sessão do orquestrador.`
					: 'Modelo para o aprendizado explícito e em segundo plano. Use "ativo" para o modelo da sessão atual, ou escolha um modelo configurado por assinatura/API. A reflexão automática usa o turno atual da sessão do orquestrador.',
		},
		messageTrigger: {
			label: "Gatilho de mensagens",
			description: "Dispara após esta quantidade de entradas de mensagem no branch ativo",
		},
		contextTrigger: {
			label: "Gatilho de contexto %",
			description: "Dispara quando o uso do contexto atual chega a esta porcentagem",
		},
		cooldown: {
			label: "Intervalo de espera (min)",
			description: "Intervalo por sessão e por dono da sessão entre execuções do coletor",
		},
		lease: {
			label: "Minutos da concessão",
			description: "Duração da concessão de estado compartilhado de um coletor em segundo plano em execução",
		},
		maxLearners: {
			label: "Máximo de coletores",
			description: "Máximo de coletores do Auto Learn em execução por sessão e por dono da sessão",
		},
		applyHighConfidence: {
			label: "Aplicar alta confiança",
			description:
				"Permite aplicar automaticamente candidatos de memória de alta confiança; a autoridade de escrita mais ampla segue autonomy.mode",
		},
		reflectionReview: {
			label: "Revisão por reflexão",
			description:
				"Inclui um sinal durável de reflexão da sessão raiz em turnos externos elegíveis; sinais de turno concluído se juntam a ele",
		},
		reflectionToolTrigger: {
			label: "Gatilho de ferramentas da reflexão",
			description:
				"Enfileira um sinal de reflexão da sessão raiz após esta quantidade de chamadas de ferramenta em um turno concluído",
		},
		reflectionCooldown: {
			label: "Intervalo de reflexão",
			description: "Intervalo por sessão e por dono da sessão entre sinais automáticos de reflexão da sessão raiz",
		},
	},
	contextPolicy: {
		scope: {
			label: "Escopo de gravação",
			description:
				"Salva esta configuração de política de contexto e prompt globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Aplicação da política de prompt",
			description:
				"Opcional: substitui por uma versão curta a saída antiga de grep/find respaldada por artefato apenas no prompt que o modelo vê. Nunca toca a transcrição nem o histórico da sessão. Exige a ferramenta de recuperação de artefatos ativa neste turno (não é configurável aqui: é um fato do runtime, não uma configuração).",
		},
		preserveRecent: {
			label: "Preservar mensagens recentes",
			description:
				"Nunca substitui por uma versão curta um resultado de ferramenta entre esta quantidade de mensagens mais recentes",
		},
		minChars: {
			label: "Mínimo de caracteres para a versão curta",
			description:
				"Só substitui por uma versão curta um resultado cujo texto original visível ao provedor tenha pelo menos esta quantidade de caracteres",
		},
	},
	contextMemory: {
		scope: {
			label: "Escopo de gravação",
			description:
				"Salva esta configuração de recuperação de memória globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Recuperação de memória local",
			description:
				"Ativada por padrão: busca na memória local do Pi evidência relevante. false explícito desliga de vez a lembrança antiga e a recuperação de contexto. Provedores externos continuam bloqueados pelo consentimento separado abaixo.",
		},
		maxResults: {
			label: "Máximo de resultados",
			description: "Máximo de itens de memória recuperados por consulta (1-20)",
		},
		includeInPrompt: {
			label: "Incluir no prompt",
			description:
				"Ativada por padrão e limitada por orçamento: apresenta a memória recuperada como evidência não confiável, limitada e rotulada por origem, apenas no prompt do modelo, nunca na transcrição nem como instrução.",
		},
		externalQueries: {
			label: "Permitir consultas externas",
			description:
				"Consentimento explícito para enviar texto de consulta limitado a provedores de memória externos elegíveis. Desligado por padrão; consultas secretas ou grandes ainda falham fechadas, e a lembrança retornada é cercada como dado não confiável.",
		},
	},
	modelRouter: {
		scope: {
			label: "Escopo de gravação",
			description: "Salva esta configuração de roteamento globalmente ou no .pi/settings.json do projeto atual",
		},
		enabled: {
			label: "Ativado",
			description:
				"Encaminha turnos somente leitura e de pesquisa para o modelo barato e turnos de modificação e uso intenso de ferramentas para o modelo caro",
		},
		selectionMode: {
			label: "Modo de seleção",
			description:
				"Manual: apenas modelos fixados por faixa · Automática: o roteador escolhe o modelo de cada faixa no conjunto de candidatos · Híbrida: faixas fixadas vencem, faixas sem fixação são escolhidas automaticamente",
		},
		pool: {
			label: "Conjunto de candidatos",
			description:
				"Só favoritos disponíveis podem ser roteados. Configurar modelos restringe essa lista; favorite modelos em /model. Uma lista de favoritos vazia não deixa candidatos para rotear.",
		},
		configureModels: {
			label: "Configurar modelos →",
			description: "Abre o seletor de modelos; ao fechar, a configuração do roteador volta no conjunto editado.",
		},
		poolMenuTitle: "Conjunto de candidatos do roteador",
		poolMenuDescription: (summary: string, subscriptions: number) =>
			`${summary} · ${subscriptions} com assinatura · selecione um modelo para calibrar`,
		poolUnavailable: "Conjunto indisponível nesta visão",
		poolPreference: {
			label: "Preferência do conjunto",
			description:
				"Assinaturas primeiro: modelos adequados com assinatura ficam à frente dos cobrados por uso (depois da admissão rígida) · Equilibrado: apenas a ordem da evidência",
		},
		cheapModel: {
			label: "Modelo barato",
			description: "Escolha o modelo para turnos somente leitura, de pesquisa, de explicação e de pergunta",
		},
		mediumModel: {
			label: "Modelo médio",
			description: "Escolha o modelo para implementação normal com escopo, edições, testes e refatorações mecânicas",
		},
		expensiveModel: {
			label: "Modelo caro",
			description:
				"Escolha o modelo para turnos de modificação, implementação e uso intenso de ferramentas escalado",
		},
		executorModel: {
			label: "Modelo do executor",
			description:
				"Escolha o modelo da via do executor local; sem definição, a execução direta do toolkit fica desativada",
		},
		learningModel: {
			label: "Modelo de aprendizado",
			description:
				"Escolha o modelo para o aprendizado explícito e em segundo plano e para o trabalho do criador de skills; a reflexão automática usa o turno atual da sessão do orquestrador",
		},
		cheapThinking: {
			label: "Raciocínio da faixa barata",
			description:
				"Sobreposição do nível de raciocínio para turnos roteados da faixa barata (somente leitura e pesquisa); (herdar) mantém o comportamento de hoje: o nível da sessão, limitado ao modelo roteado",
		},
		mediumThinking: {
			label: "Raciocínio da faixa média",
			description:
				"Sobreposição do nível de raciocínio para turnos roteados da faixa média (implementação com escopo); (herdar) mantém o comportamento de hoje: o nível da sessão, limitado ao modelo roteado",
		},
		expensiveThinking: {
			label: "Raciocínio da faixa cara",
			description:
				"Sobreposição do nível de raciocínio para turnos roteados da faixa cara (modificação e escalada); (herdar) mantém o comportamento de hoje: o nível da sessão, limitado ao modelo roteado",
		},
		executorThinking: {
			label: "Raciocínio do executor",
			description:
				"Sobreposição do nível de raciocínio para a via direta do executor; (herdar) mantém o comportamento de hoje: o nível da sessão, limitado ao modelo roteado",
		},
		cheapThinkingTitle: "Raciocínio da faixa barata",
		cheapThinkingDescription:
			"Selecione uma sobreposição do nível de raciocínio para turnos roteados da faixa barata, ou herde o nível da sessão",
		mediumThinkingTitle: "Raciocínio da faixa média",
		mediumThinkingDescription:
			"Selecione uma sobreposição do nível de raciocínio para turnos roteados da faixa média, ou herde o nível da sessão",
		expensiveThinkingTitle: "Raciocínio da faixa cara",
		expensiveThinkingDescription:
			"Selecione uma sobreposição do nível de raciocínio para turnos roteados da faixa cara, ou herde o nível da sessão",
		executorThinkingTitle: "Raciocínio do executor",
		executorThinkingDescription:
			"Selecione uma sobreposição do nível de raciocínio para a via direta do executor, ou herde o nível da sessão",
		inheritThinking: "Herda o nível de raciocínio da sessão neste turno, limitado ao modelo roteado",
		fitnessGate: {
			label: "Filtro de fitness",
			description:
				"Filtro subtrativo opcional: bloqueia modelos de faixa apenas quando a via sondada do roteador falhou",
		},
		calibrate: {
			label: "Calibrar",
			description:
				"Só por ação do operador. Reaproveita a sondagem de fitness (runModelFitness) e a sondagem real de ferramentas; nada roda ao abrir as configurações.",
			currentValue: (pending: number | undefined) =>
				pending === undefined ? "indisponível" : `${pending} precisam de calibração`,
			title: "Calibração do roteador",
			subtitle: (scope: string) => `Abrange ${scope}. Você confirma antes de qualquer execução.`,
			one: {
				label: "Calibrar um modelo",
				description: (scope: string) => `Escolha um modelo do conjunto; roda ${scope} e então oferece uma função.`,
			},
			unprobed: {
				label: (pending: number) => `Calibrar sem sondagem (${pending})`,
				description:
					"Sonda todo modelo do conjunto cuja evidência do roteador falta ou está velha. Exige chamadas ao provedor.",
			},
			all: {
				label: (count: number) => `Recalibrar selecionados (${count})`,
				description:
					"Sonda de novo todo modelo do conjunto, substituindo a evidência existente. Exige chamadas ao provedor.",
			},
			surfaces: (count: number, names: string) => `${count} superfícies de fitness do roteador (${names})`,
			probe: "sondagem real de execução de ferramentas",
			scope: (surfaces: string, probe: string) => `${surfaces} + ${probe}`,
			surfaceNames: {
				cheap: "barato",
				medium: "médio",
				expensive: "caro",
				executor: "executor",
				compaction: "compactação",
				curation: "curadoria",
				scout: "coleta",
			} as Record<string, string>,
		},
		clearCheap: "Limpa o modelo barato do roteamento; turnos de pesquisa voltam ao modelo da sessão ativa",
		clearMedium: "Limpa o modelo médio do roteamento; turnos de implementação voltam conforme a política do roteador",
		clearExpensive: "Limpa o modelo caro do roteamento; turnos de modificação voltam ao modelo da sessão ativa",
		clearExecutor: "Limpa o modelo da via do executor; a execução direta do toolkit fica desativada",
		autoSelectTier: "Deixa o roteador escolher o modelo desta faixa automaticamente no conjunto de candidatos",
		preview: {
			label: "Prévia de rota",
			description:
				"Digite uma tarefa de exemplo. A prévia determinística não faz chamada ao provedor; a prévia ao vivo (juiz/H-MoE) é uma ação explícita separada.",
			title: "Prévia de rota",
			taskDescription:
				"Digite uma tarefa de exemplo. Enter mostra a prévia determinística (sem chamada ao provedor). Prefixe com `live:` para rodar o caminho do juiz/H-MoE.",
			emptyHint: "vazio cancela",
		},
		diagnostics: {
			label: "Diagnóstico",
			description:
				"Mostra o estado do roteador: modo, conjunto, preferência, fitness das faixas e decisões recentes com a origem da seleção.",
			title: "Diagnóstico do roteador",
			reportInto: "Imprime o relatório de estado do roteador na conversa.",
			show: {
				label: "Mostrar diagnóstico",
				description: "O mesmo relatório de /session routing status",
			},
		},
		hmoePreset: {
			label: "Predefinição H-MoE",
			description: "Predefinição numérica de pesos para habilidade, operação e confiabilidade",
		},
		hmoeTeam: {
			label: "Estratégia de time H-MoE",
			description:
				"Modo de seleção para modelo único, principal + crítico, verificador independente ou time adaptativo",
		},
		hmoeIndependence: {
			label: "Independência H-MoE",
			description: "Nível de independência exigido ao selecionar modelos verificadores ou críticos",
		},
		hmoePreference: {
			label: "Preferência H-MoE",
			description: "Preferência de ordem entre candidatos adequados depois da admissão rígida",
		},
	},
	warnings: {
		anthropicExtraUsage: {
			label: "Uso extra da Anthropic",
			description: "Avisa quando a autenticação por assinatura da Anthropic pode usar uso extra pago",
		},
	},
	dialogs: {
		thinkingTitle: "Nível de raciocínio",
		thinkingDescription: "Selecione a profundidade de raciocínio suportada pelo modelo ativo",
		themeTitle: "Tema",
		themeDescription: "Selecione o tema de cores",
		themeCurrent: "(atual)",
		showImagesInline: "Mostra imagens no terminal",
		showImagesPlaceholder: "Mostra um texto no lugar",
		thinkingLevels: {
			off: "Sem raciocínio",
			minimal: "Raciocínio muito breve (~1k tokens)",
			low: "Raciocínio leve (~2k tokens)",
			medium: "Raciocínio moderado (~8k tokens)",
			high: "Raciocínio profundo (~16k tokens)",
			xhigh: "Raciocínio máximo (~32k tokens)",
			max: "Profundidade máxima de raciocínio para os problemas mais difíceis",
			ultra: "Esforço de raciocínio máximo disponível (se o provedor permitir)",
		} as Record<string, string>,
	},
	modelPicker: {
		description:
			"Escolha entre os modelos disponíveis nas contas de assinatura ou API configuradas. Digite para filtrar; o modo manual é a alternativa.",
		executorDescription: "Escolha entre os modelos configurados. Digite para filtrar; o modo manual é a alternativa.",
		customDescription: "Digite um padrão provedor/modelo de pi --list-models.",
		emptyClears: "vazio limpa a configuração",
		manualOption: "Manual / personalizado…",
		manualOptionDescription: "Digite um padrão de modelo que não está na lista",
		customSetting: "Configuração personalizada atual",
		activeOption: "Usar o modelo da sessão atual",
		activeOptionWithModel: (pattern: string) => `Usar o modelo da sessão atual (${pattern})`,
		clearModel: "Limpar esta configuração de modelo",
		favoriteMark: "favorito",
		outsidePoolMark: "fora do conjunto · favorite e inclua no escopo para rotear",
		cheap: {
			title: "Modelo barato / de pesquisa",
			customTitle: "Modelo barato / de pesquisa personalizado",
		},
		medium: {
			title: "Modelo médio / de implementação",
			customTitle: "Modelo médio / de implementação personalizado",
		},
		expensive: {
			title: "Modelo caro / de modificação",
			customTitle: "Modelo caro / de modificação personalizado",
		},
		executor: {
			title: "Modelo da via do executor",
			customTitle: "Modelo da via do executor personalizado",
		},
		learning: {
			title: "Modelo de aprendizado",
			description:
				"Escolha ativo ou um modelo das contas de assinatura ou API configuradas para o aprendizado explícito e em segundo plano. A reflexão automática usa o turno atual da sessão do orquestrador. Digite para filtrar; o modo manual é a alternativa.",
			customTitle: "Modelo de aprendizado personalizado",
			customDescription:
				'Digite "ativo" ou um padrão provedor/modelo para o aprendizado explícito e em segundo plano, de pi --list-models.',
			customEmptyHint: 'vazio usa "ativo"',
		},
		peer: {
			title: "Modelo par",
			description:
				"Digite para filtrar os modelos configurados. Escolher um modelo ativa o modelo par da sessão raiz; um esforço sem suporte volta para O agente escolhe.",
			customTitle: "Modelo par",
			customDescription: "Digite uma referência provedor/modelo exata.",
			customEmptyHint: "vazio deixa o agente escolher",
		},
		autoLearn: {
			title: "Modelo coletor do Auto Learn",
			description:
				"Escolha ativo ou um modelo das contas de assinatura ou API configuradas no momento. Digite para filtrar; escolha manual para um padrão personalizado.",
			customTitle: "Modelo do Auto Learn personalizado",
			customDescription: 'Digite "ativo" ou um padrão provedor/modelo como "openai/gpt-5.4".',
			customEmptyHint: 'vazio usa "ativo"',
		},
	},
};
