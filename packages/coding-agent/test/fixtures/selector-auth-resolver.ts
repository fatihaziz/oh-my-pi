import { SelectorController } from "../../src/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "../../src/modes/types";

// A runtime plugin returning an absolute path exposes Bun's Windows require()
// file: prefix failure. Install it after the controller loads, as extensions do.
const targets = new Map(
	[
		"@oh-my-pi/pi-ai/index.js",
		"@oh-my-pi/pi-tui/overlays/model-hub.js",
		"@oh-my-pi/pi-tui/overlays/model-picker.js",
	].map(specifier => [specifier, Bun.resolveSync(specifier, import.meta.dir)]),
);
Bun.plugin({
	name: "selector-auth-resolver-regression",
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\//, namespace: "file" }, args => {
			const target = targets.get(args.path);
			return target ? { path: target } : undefined;
		});
	},
});

const controller = new SelectorController({
	session: { modelRegistry: { getApiKeyForProvider: async () => undefined, authStorage: { has: () => false } } },
	showStatus: (message: string) => process.stdout.write(`${message}\n`),
} as unknown as InteractiveModeContext);
await controller.showOAuthSelector("logout");

if (process.argv[2]) {
	const observer = await loadLegacyPiModule(process.argv[2]);
	assert.equal(typeof (observer as { default: unknown }).default, "function");
	process.stdout.write("Foyer observer module loaded\n");
}

await initTheme();
const model = buildModel({
	id: "resolver-fixture",
	name: "Resolver fixture model",
	provider: "test",
	api: "ollama-chat",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});
let mounted: Component | undefined;
let hidden = false;
const modelController = new SelectorController({
	settings: Settings.isolated(),
	session: {
		model,
		scopedModels: [{ model }],
		getContextUsage: () => undefined,
		getRoleModelCycle: () => undefined,
		modelRegistry: {
			getAll: () => [model],
			getAvailable: () => [model],
			getError: () => undefined,
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
			authStorage: { hasAuth: () => false },
		},
	},
	ui: {
		terminal: { rows: 40 },
		requestRender: () => {},
		setFocus: () => {},
		showOverlay: (component: Component) => {
			mounted = component;
			return {
				hide: () => {
					hidden = true;
				},
			};
		},
	},
	editorContainer: { children: [] },
	editor: {},
	keybindings: { getKeys: () => [], getDisplayString: () => "" },
} as unknown as InteractiveModeContext);
for (const temporaryOnly of [true, false]) {
	hidden = false;
	modelController.showModelSelector({ temporaryOnly });
	assert.ok(mounted);
	assert.match(mounted.render(120).join("\n"), /Resolver fixture model/);
	mounted.handleInput?.("\u001b");
	assert.equal(hidden, true);
}
process.stdout.write("Model picker and hub rendered and closed\n");
import { strict as assert } from "node:assert";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../../src/config/settings";
import { loadLegacyPiModule } from "../../src/extensibility/plugins/legacy-pi-compat";
