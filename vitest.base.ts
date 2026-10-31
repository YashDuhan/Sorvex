import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiModels: fileURLToPath(new URL("./packages/ai/src/models.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@sorvex\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@sorvex\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@sorvex\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@sorvex\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@sorvex\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@sorvex\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@sorvex\/mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@sorvex\/mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@sorvex\/mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@sorvex\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@sorvex\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
		{ find: /^@sorvex\/ai\/models$/, replacement: workspaceSourcePaths.aiModels },
			{ find: /^@sorvex\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@sorvex\/ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@sorvex\/ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@sorvex\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@sorvex\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@sorvex\/codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@sorvex\/codemode\/declarations$/, replacement: workspaceSourcePaths.codemodeDeclarations },
			{ find: /^@sorvex\/codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@sorvex\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
