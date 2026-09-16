import config from "../../packages/agent/vitest.config.ts";

console.log(JSON.stringify(config.test.exclude ?? []));
