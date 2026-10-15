#!/usr/bin/env bun
import { isAbsolute, resolve } from "node:path";

// Initialize before requiring the CLI: its imports capture the agent directory.
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const flags = separator < 0 ? argv : argv.slice(0, separator);
if (argv[0] === "--runtime-info") {
	const { version } = require("../package.json");
	process.stdout.write(`${JSON.stringify({ flavor: "foyer", version, executable: process.execPath })}\n`);
} else if (!agentDir || !isAbsolute(agentDir)) {
	process.stderr.write("Foyer must supply an absolute PI_CODING_AGENT_DIR for its runtime.\n");
	process.exitCode = 1;
} else if (flags.some(arg => arg === "--profile" || arg.startsWith("--profile=") || arg === "--alias" || arg.startsWith("--alias="))) {
	process.stderr.write("Foyer owns runtime profiles; use Profile Control instead of standalone profile aliases.\n");
	process.exitCode = 1;
} else if (process.env.PI_COMPILED !== "true") {
	process.stderr.write("Use the compiled Foyer runtime; source CLI execution is not supported.\n");
	process.exitCode = 1;
} else {
	Object.assign(process.env, {
		PI_CODING_AGENT_DIR: resolve(agentDir),
		PI_COMPILED: "true",
	});
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	delete process.env.CLAUDE_CONFIG_DIR;
	// The compiled CLI owns worker inbox setup, error handling and execution.
	require("./cli");
}
