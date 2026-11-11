import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const [repo, base, id] = Bun.argv.slice(2);
setWorktreesDir(base);
const handle = await ensureIsolation(repo!, id!, IsoBackendKind.Rcopy);
try {
	if (vcs.requireGit(handle.mergedDir).info().commonDir === vcs.requireGit(repo!).info().commonDir) {
		throw new Error("Isolation shares Git metadata with its parent");
	}
	process.stdout.write(await readFile(path.join(handle.mergedDir, "merged.txt"), "utf8"));
} finally {
	await cleanupIsolation(handle);
}
