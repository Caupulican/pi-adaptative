/**
 * O seletor de configuração e as telas de cópia de segurança e restauração em português do Brasil: os grupos de recursos,
 * os nomes dos tipos, os títulos e cada linha de estado e cada erro que os comandos de cópia de segurança e restauração
 * mostram ao dono.
 */

export const CONFIG_SCREEN = {
	resourceTypes: {
		extensions: "Extensões",
		skills: "Skills",
		prompts: "Prompts",
		themes: "Temas",
	},
	scope: { user: "usuário", project: "projeto", temporary: "temporário" },
	groups: {
		package: (source: string, scope: string) => `${source} (${scope})`,
		userAt: (directory: string) => `Usuário (${directory})`,
		projectAt: (directory: string) => `Projeto (${directory})`,
		userDefault: "Usuário (~/.pi/agent/)",
		projectDefault: "Projeto (.pi/)",
		userSettings: "Configurações do usuário",
		projectSettings: "Configurações do projeto",
	},
	title: "Configuração de recursos",
	filter: "Digite para filtrar recursos",
	empty: "Nenhum recurso encontrado",
	backup: {
		saved: (file: string) => `Cópia de segurança da configuração salva em ${file}`,
		usage: "Uso: /config-restore <file>",
		missing: (file: string) => `O arquivo de cópia de segurança não existe: ${file}`,
		parseFailed: (message: string) => `Falha ao ler o arquivo de cópia de segurança: ${message}`,
		notObject: "Arquivo de cópia de segurança inválido: deve ser um objeto JSON",
		confirmTitle: "Restaurar a configuração?",
		confirmBody:
			"Isto sobrescreve os perfis e as configurações locais com os valores da cópia de segurança. Deseja continuar?",
		proceed: "Prosseguir com a restauração.",
		abort: "Cancelar e abortar.",
		aborted: "Restauração cancelada.",
		restored: "Configuração restaurada.",
		failed: (message: string) => `Falha ao restaurar a configuração: ${message}; configuração anterior restaurada`,
		failedWithRollback: (message: string, rollback: string) =>
			`Falha ao restaurar a configuração: ${message}; a reversão também falhou: ${rollback}`,
	},
	validation: {
		arrayOfStrings: (label: string) =>
			`Arquivo de cópia de segurança inválido: ${label} deve ser uma lista de strings`,
		profilesObject: "Arquivo de cópia de segurança inválido: settings.resourceProfiles deve ser um objeto",
		malformedProfile: (name: string) =>
			`Arquivo de cópia de segurança inválido: perfil de recurso malformado "${name}"`,
		profilesMustBeObject: "Arquivo de cópia de segurança inválido: profiles deve ser um objeto",
		unsafeProfileFile: (filename: string) =>
			`Arquivo de cópia de segurança inválido: nome de arquivo de perfil inseguro "${filename}"`,
		profileNotSerializable: (filename: string) =>
			`Arquivo de cópia de segurança inválido: o perfil "${filename}" não é serializável`,
		runtimeValidation: "a configuração restaurada falhou na validação em runtime",
	},
};
