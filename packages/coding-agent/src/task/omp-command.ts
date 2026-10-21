import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";

/** The worker must use the SDK artifact loaded by its parent, not another PATH shim. */
export function nativeWorkerLaunch(): { executable: string; entry: string } {
	return {
		executable: process.execPath,
		entry: isCompiledBinary() ? "" : fileURLToPath(new URL("../cli.ts", import.meta.url)),
	};
}
