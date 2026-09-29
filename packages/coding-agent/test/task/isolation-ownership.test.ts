import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as natives from "@oh-my-pi/pi-natives";
import { ISOLATION_OWNER_FILE, needsNativeTeardown } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

const { IsoBackendKind } = natives;

// The sidecar set decides which retained workspaces `omp worktree clear`
// routes through native `isoStop` instead of plain recursive `rm`.
describe("retained workspace teardown set", () => {
	it("routes mounts and subvolumes through native teardown, nothing else", () => {
		for (const kind of [IsoBackendKind.Overlayfs, IsoBackendKind.Projfs, IsoBackendKind.Btrfs]) {
			expect(needsNativeTeardown(kind)).toBe(true);
		}
		for (const kind of [
			IsoBackendKind.Apfs,
			// ZFS clones need dataset-aware teardown too, but isoStop locates
			// the dataset by its recorded mountpoint property, which no longer
			// matches after the retain rename — pi-iso mount-table support first.
			IsoBackendKind.Zfs,
			IsoBackendKind.LinuxReflink,
			IsoBackendKind.WindowsBlockClone,
			IsoBackendKind.Rcopy,
		]) {
			expect(needsNativeTeardown(kind)).toBe(false);
		}
	});

	it("rejects non-backend values", () => {
		for (const value of [undefined, null, "overlayfs", 1.5, -1, 999]) {
			expect(needsNativeTeardown(value)).toBe(false);
		}
	});
});

it.skipIf(process.platform !== "win32")(
	"publishes Windows ownership while the supervisor keeps stdin open",
	async () => {
		const scratch = path.resolve("tmp");
		await fs.mkdir(scratch, { recursive: true });
		const temporary = await TempDir.create(path.join(scratch, "isolation-owner-test-"));
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../fixtures/isolation-owner-probe.ts"), temporary.path()],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			},
		);
		// Fake time cannot interrupt a child blocked on inherited stdin. Success never waits for this watchdog.
		const deadline = setTimeout(() => child.kill(), 5000);
		try {
			const code = await child.exited;
			const error = await new Response(child.stderr).text();
			expect({ code, error }).toEqual({ code: 0, error: "" });
			expect(await Bun.file(temporary.join(ISOLATION_OWNER_FILE)).json()).toEqual({
				pid: child.pid,
				id: "OwnerProbe",
			});
		} finally {
			clearTimeout(deadline);
			child.kill();
			await temporary.remove();
		}
	},
);
