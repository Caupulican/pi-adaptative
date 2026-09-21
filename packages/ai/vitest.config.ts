import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 30000, // 30 seconds for API calls
		setupFiles: ['../../scripts/vitest-worker-parent-exit.ts'],
		execArgv: ['--conditions=pi-source'],
	}
});
