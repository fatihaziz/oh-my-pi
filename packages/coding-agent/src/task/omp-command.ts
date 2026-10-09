import process from "node:process";
import { fileURLToPath } from "node:url";

/** The worker must use the SDK artifact loaded by its parent, not another PATH shim. */
export function nativeWorkerLaunch(): { executable: string; entry: string } {
	const entry = new URL("../cli.ts", import.meta.url);
	return {
		executable: process.execPath,
		entry: entry.pathname.includes("/$bunfs/") ? "" : fileURLToPath(entry),
	};
}
