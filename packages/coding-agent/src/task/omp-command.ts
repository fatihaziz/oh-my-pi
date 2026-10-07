import process from "node:process";
import { fileURLToPath } from "node:url";

import { $env } from "@oh-my-pi/pi-utils";

interface OmpCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "omp.cmd" : "omp";
const DEFAULT_SHELL = process.platform === "win32";

export function resolveOmpCommand(): OmpCommand {
	const envCmd = $env.PI_SUBPROCESS_CMD;
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}

/** The worker must use the SDK artifact loaded by its parent, not another PATH shim. */
export function nativeWorkerLaunch(): { executable: string; entry: string } {
	const entry = new URL("../cli.ts", import.meta.url);
	return {
		executable: process.execPath,
		entry: entry.pathname.includes("/$bunfs/") ? "" : fileURLToPath(entry),
	};
}
