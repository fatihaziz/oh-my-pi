#!/usr/bin/env python3
"""Re-apply the local OMP patch bundle after `bun update -g` wipes it.

The installed Bun-managed package (`@oh-my-pi/pi-coding-agent`) ships its
TypeScript source next to `dist/cli.js`. This engine applies ONE unified
source-level patch to that source and rebuilds the bundle, instead of the
old per-patch minified-anchor rewrites.

Single source of truth
    scripts/omp-unified.patch — `git diff v{BASE}..unified-patch` from the
    merge worktree (see Regeneration below). Everything local rides in it:

      S1  session switch thinking effort   upstream PR #8029
      P1  getLoader json/toml/text assets  local only; no PR
      P6  guided-goal ask-tool interview   upstream PR #8187
      P7  guided-goal recon-first          fork PR fatihaziz/oh-my-pi#1
      P9  guard lying editor launcher    local only; upstreamable
      P10 git concurrency limiter        DEFERRED at 18.1.4 rebase: upstream
                                         removed utils/git.ts (VCS moved to
                                         @oh-my-pi/pi-natives/vcs); re-home
                                         pending; upstream PR #9936 closed
                                         unmerged by owner 2026-09-03

    Retired: P3 (thinking label "max") — upstream-native since 17.3.x.
    Retired: P5 (fresh-session vibe autostart) — removed 2026-08-20 by user
    decision: fresh sessions must start in normal mode; vibe is /vibe only.

MARKERS below only VERIFY the rebuilt bundle; they never rewrite bytes.

Idempotence
    `git apply --check` decides the installed-source state:
      forward check passes  -> source pristine: apply + rebuild
      reverse check passes  -> source already patched: rebuild only when a
                               bundle marker is missing or --rebuild is set
      both fail             -> CONFLICT (exit 3): source diverged

Version gate
    The patch is generated against UNIFIED_BASE_VERSION. Any other installed
    version is a conflict: regenerate the patch first (below), bump the
    constant, and re-run. The vault sync (`sync-to-global.py`) bumps
    `ompInstall.version` in env.yml and calls this engine after install.

Regeneration (new upstream release W.X.Y)
    cd <omp-repo>
    git fetch origin main "+refs/pull/8029/head:refs/remotes/origin/pr/8029" \
        "+refs/pull/8187/head:refs/remotes/origin/pr/8187"
    git fetch fork fix/guided-goal-recon-before-asking
    git worktree add tmp/upstream-unified-WXY -b unified-patch-WXY vW.X.Y
    cd tmp/upstream-unified-WXY
    git merge --no-ff origin/pr/8029           # resolve conflicts
    git merge --no-ff origin/pr/8187           # resolve conflicts
    git merge --no-ff fork/fix/guided-goal-recon-before-asking
    # re-fold P1 if upstream still lacks it, run
    # `bun check` + the switch/guided tests, then:
    git diff vW.X.Y..HEAD > ../../scripts/omp-unified.patch
    # bump UNIFIED_BASE_VERSION here and ompInstall.version in the vault.
    Retire any PR that upstream merged (drop its marker + AGENTS.md row).

Exit codes: 0 ok, 2 rolled back (smoke failed), 3 conflict (nothing written).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

BACKUP_SUFFIX = ".ompbak"  # -> cli.js.ompbak beside the bundle
REPO_ROOT = Path(__file__).resolve().parents[1]
UNIFIED_PATCH = REPO_ROOT / "scripts" / "omp-unified.patch"
UNIFIED_BASE_VERSION = "18.1.4"
PACKAGE_PREFIX = "packages/coding-agent/"
# Only source ships in the npm package; CHANGELOG/test hunks stay repo-side.
APPLY_PREFIX = PACKAGE_PREFIX + "src/"


# ── Locate the bundle ─────────────────────────────────────────────────────────


def find_cli_js() -> Path:
    """Resolve <bun-global>/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js."""
    rel = Path("node_modules") / "@oh-my-pi" / "pi-coding-agent" / "dist" / "cli.js"
    roots: list[Path] = []
    env = os.environ.get("BUN_INSTALL_GLOBAL_DIR")
    if env:
        roots.append(Path(env))
    # Bun's default global install dirs.
    roots.append(Path.home() / ".bun" / "install" / "global")
    # User's known machine layout (last-resort fallback).
    roots.append(Path(r"E:\CACHE\Bun\install\global"))
    for root in roots:
        candidate = root / rel
        if candidate.exists():
            return candidate
    raise SystemExit(
        "Could not locate OMP cli.js. Set BUN_INSTALL_GLOBAL_DIR or pass --cli <path>.\n"
        f"Tried: {', '.join(str(r / rel) for r in roots)}"
    )


def read_package_version(package_root: Path) -> str:
    try:
        return json.loads((package_root / "package.json").read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return ""


# ── Bundle markers (verification only) ────────────────────────────────────────
#
# Each marker: stable literal the rebuilt bundle must contain when the unified
# patch is in. Anchored on property names, setting keys, and prompt prose that
# survive minification. They never rewrite anything.

MARKERS = [
    {
        "id": "S1",
        "name": "S1 session switch thinking effort",
        "source": "packages/coding-agent/src/modes/{components/thinking-strip.ts,controllers/selector-controller.ts}",
        "resolution": "Upstream PR #8029. Regenerate scripts/omp-unified.patch from a fresh merge worktree (see module docstring); retire this marker if upstream merges the PR.",
        "applied": lambda t: "Esc keep current" in t,
    },
    {
        "id": "P1",
        "name": "P1 getLoader json/toml/text",
        "source": "packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts:getLoader",
        "resolution": "Local only; no PR. Regenerate the unified patch; drop this marker if upstream widens getLoader natively.",
        "applied": lambda t: '.json"))return"json"' in t,
    },
    {
        "id": "P6",
        "name": "P6 guided-goal ask tool",
        "source": "packages/coding-agent/src/prompts/goals/guided-goal-interview.md",
        "resolution": "Upstream PR #8187. Regenerate the unified patch; retire this marker after upstream merges equivalent behavior.",
        "applied": lambda t: "call per reply, one to three questions in that call" in t,
    },
    {
        "id": "P7",
        "name": "P7 guided-goal recon",
        "source": "packages/coding-agent/src/prompts/goals/guided-goal-interview.md",
        "resolution": "Fork PR fatihaziz/oh-my-pi#1; never upstream. Rides in the unified patch after the P6 prompt text.",
        "applied": lambda t: "- Ask only what recon cannot answer." in t,
    },
    {
        "id": "P8",
        "name": "P8 hidden Windows editor shell",
        "source": "packages/coding-agent/src/utils/external-editor.ts:openInEditor",
        "resolution": "Local only. Keep until upstream sets Bun.spawn windowsHide for the Windows external-editor shell.",
        "applied": lambda t: (i := t.find("omp-editor-")) >= 0
        and 'windowsHide:process.platform==="win32"' in t[i : i + 1000],
    },
    {
        "id": "P9",
        "name": "P9 lying editor launcher guard",
        "source": "packages/coding-agent/src/utils/external-editor.ts:openInEditor",
        "resolution": "Local only; upstreamable. Regenerate the unified patch; drop this marker once upstream rejects a launcher that exits 0 without ever opening the file.",
        "applied": lambda t: "without opening the file" in t,
	},
]


def evaluate_markers(text: str) -> list[dict]:
    return [
        {"marker": marker, "present": bool(marker["applied"](text))}
        for marker in MARKERS
    ]


def print_marker_results(results: list[dict]) -> None:
    for result in results:
        state = "present" if result["present"] else "missing"
        print(f"  [{state}] {result['marker']['name']}")


def print_marker_resolutions(results: list[dict]) -> None:
    for result in results:
        if result["present"]:
            continue
        marker = result["marker"]
        print(f"    source: {marker['source']}")
        print(f"    resolve: {marker['resolution']}")


# ── Unified patch handling ────────────────────────────────────────────────────


def filter_patch_for_package(patch_text: str) -> str:
    """Keep only the `packages/coding-agent/src/` file sections of the diff."""
    sections: list[str] = []
    current: list[str] | None = None
    keep = False
    for line in patch_text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current and keep:
                sections.append("".join(current))
            current = [line]
            # `diff --git a/<path> b/<path>` — match on the b-side path.
            keep = f" b/{APPLY_PREFIX}" in line
        elif current is not None:
            current.append(line)
    if current and keep:
        sections.append("".join(current))
    return "".join(sections)


def patched_source_paths(filtered_patch: str) -> list[str]:
    """Package-relative paths (below packages/coding-agent/) the patch touches."""
    paths: list[str] = []
    for line in filtered_patch.splitlines():
        if line.startswith("+++ b/") and line[6:].startswith(APPLY_PREFIX):
            paths.append(line[6 + len(PACKAGE_PREFIX):])
    return paths


def created_file_paths(filtered_patch: str) -> list[str]:
    """Package-relative paths of files the patch CREATES (absent upstream)."""
    paths: list[str] = []
    pending_new = False
    for line in filtered_patch.splitlines():
        if line.startswith("diff --git "):
            pending_new = False
        elif line == "--- /dev/null":
            pending_new = True
        elif line.startswith("+++ b/") and pending_new:
            paths.append(line[6 + len(PACKAGE_PREFIX):])
            pending_new = False
    return paths


def git_apply(package_root: Path, filtered_patch: str, *extra: str) -> subprocess.CompletedProcess:
    """`git apply -p3` inside the installed package (strips packages/coding-agent/).

    The patch rides in a temp file, never a text-mode pipe: Windows Python
    rewrites LF to CRLF on text stdin, which corrupts every context line.
    """
    patch_file = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="\n", suffix=".patch", delete=False
        ) as handle:
            handle.write(filtered_patch)
            patch_file = Path(handle.name)
        return subprocess.run(
            ["git", "apply", "-p3", "--whitespace=nowarn", *extra, str(patch_file)],
            cwd=package_root,
            capture_output=True,
            text=True,
            timeout=60,
        )
    finally:
        if patch_file is not None:
            patch_file.unlink(missing_ok=True)


def classify_source_state(package_root: Path, filtered_patch: str) -> tuple[str, str, list[str]]:
    """Return ("pristine"|"patched"|"conflict", detail, stray_created_files).

    Strays are files this patch CREATES that already exist on disk while the
    rest of the source is unpatched: leftovers from an earlier patch
    generation that `bun add -g` upgrades never delete. The caller removes
    them inside the rebuild transaction; this probe never writes.
    """
    reverse = git_apply(package_root, filtered_patch, "--check", "--reverse")
    if reverse.returncode == 0:
        return "patched", "", []
    strays = [rel for rel in created_file_paths(filtered_patch) if (package_root / rel).exists()]
    excludes = [f"--exclude={rel}" for rel in strays]
    forward = git_apply(package_root, filtered_patch, "--check", *excludes)
    if forward.returncode == 0:
        return "pristine", "", strays
    return "conflict", (forward.stderr.strip() or forward.stdout.strip()), strays


# ── Transactional rebuild ─────────────────────────────────────────────────────


def _restore_transaction(transaction: dict | None) -> None:
    if transaction is None:
        return
    for path, content in transaction["sources"].items():
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(content, encoding="utf-8")
    dist = transaction["dist"]
    dist.mkdir(parents=True, exist_ok=True)
    shutil.copytree(transaction["backup"] / "dist", dist, dirs_exist_ok=True)
    shutil.rmtree(transaction["backup"], ignore_errors=True)


def rebuild_bundle(
    cli: Path, filtered_patch: str, source_state: str, strays: list[str] | None = None
) -> tuple[dict | None, str]:
    """Apply the unified patch (when pristine), rebuild dist/cli.js, verify markers.

    Returns (transaction, "") on success — caller drops the backup after the
    smoke test — or (None, reason) after rolling everything back.
    """
    package_root = cli.parent.parent
    repo_tmp = REPO_ROOT / "tmp"
    repo_tmp.mkdir(exist_ok=True)
    backup_root = Path(tempfile.mkdtemp(prefix="omp-unified-", dir=repo_tmp))
    touched = [package_root / rel for rel in patched_source_paths(filtered_patch)]
    source_backups = {
        path: path.read_text(encoding="utf-8") if path.exists() else None for path in touched
    }
    dist = package_root / "dist"
    shutil.copytree(dist, backup_root / "dist")
    transaction = {"sources": source_backups, "dist": dist, "backup": backup_root}

    build_script = package_root / "scripts/bundle-dist.ts"
    original_build_script = build_script.read_text(encoding="utf-8")
    stats_dir = (REPO_ROOT / "packages" / "stats").as_posix()
    stats_arg = f"--cwd={stats_dir}"
    patched_build_script = original_build_script.replace("--cwd=../stats", stats_arg)
    if patched_build_script.count(stats_arg) != 2:
        shutil.rmtree(backup_root, ignore_errors=True)
        return None, "bundle-dist.ts stats-workspace anchors changed"

    # The installed omp-stats package ships an EMPTY embedded-client payload;
    # rebuild it locally and copy it in so `omp stats` keeps its dashboard.
    docs_script = package_root / "scripts/generate-docs-index.ts"
    local_stats_payload = Path(stats_dir) / "src" / "embedded-client.generated.txt"
    installed_stats_payload = package_root.parent / "omp-stats" / "src" / "embedded-client.generated.txt"
    original_stats_payload = installed_stats_payload.read_text(encoding="utf-8")
    generate_line = f'await runCommand(["bun", "{stats_arg}", "run", "gen:stats"]);'
    copy_line = (
        f'await fs.copyFile("{local_stats_payload.as_posix()}", '
        f'"{installed_stats_payload.as_posix()}");'
    )
    patched_build_script = patched_build_script.replace(generate_line, f"{generate_line}\n\t\t{copy_line}", 1)
    if patched_build_script.count(copy_line) != 1:
        shutil.rmtree(backup_root, ignore_errors=True)
        return None, "bundle-dist.ts stats-payload copy anchor changed"
    original_docs_script = docs_script.read_text(encoding="utf-8")
    docs_dir = (REPO_ROOT / "docs").as_posix()
    patched_docs_script = original_docs_script.replace(
        'const docsDir = path.resolve(packageDir, "../../docs");',
        f'const docsDir = "{docs_dir}";',
    )
    if patched_docs_script == original_docs_script:
        shutil.rmtree(backup_root, ignore_errors=True)
        return None, "generate-docs-index.ts docs-directory anchor changed"

    try:
        if source_state == "pristine":
            # Stale created-file leftovers from an earlier patch generation are
            # backed up in the transaction above; drop them so the full patch
            # applies cleanly.
            for rel in strays or []:
                (package_root / rel).unlink(missing_ok=True)
            applied = git_apply(package_root, filtered_patch)
            if applied.returncode != 0:
                shutil.rmtree(backup_root, ignore_errors=True)
                return None, f"git apply failed: {applied.stderr.strip() or applied.stdout.strip()}"
        docs_script.write_text(patched_docs_script, encoding="utf-8")
        build_script.write_text(patched_build_script, encoding="utf-8")
        result = subprocess.run(
            ["bun", "scripts/bundle-dist.ts"],
            cwd=package_root,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        _restore_transaction(transaction)
        return None, str(exc)
    finally:
        installed_stats_payload.write_text(original_stats_payload, encoding="utf-8")
        docs_script.write_text(original_docs_script, encoding="utf-8")
        build_script.write_text(original_build_script, encoding="utf-8")
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "bundle build returned nonzero"
        _restore_transaction(transaction)
        return None, detail
    built_text = cli.read_text(encoding="utf-8", errors="replace")
    missing = [r["marker"]["name"] for r in evaluate_markers(built_text) if not r["present"]]
    if missing:
        (repo_tmp / "omp-unified-last-build.js").write_text(built_text, encoding="utf-8")
        _restore_transaction(transaction)
        return None, f"rebuilt bundle is missing markers: {', '.join(missing)}"
    return transaction, ""


# ── Smoke test ────────────────────────────────────────────────────────────────


def omp_smoke() -> bool | None:
    """Return True if `omp --version` exits 0, False if it fails, None if omp
    isn't runnable from here (skip rollback in that case)."""
    try:
        r = subprocess.run(["omp", "--version"], capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return None
    except Exception:
        return False
    return r.returncode == 0 and "omp/" in (r.stdout + r.stderr)


# ── Driver ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Re-apply the unified OMP source patch after an update.")
    ap.add_argument("--cli", help="path to dist/cli.js (default: auto-detect)")
    ap.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    ap.add_argument("--restore", action="store_true", help="restore cli.js from cli.js.ompbak and exit")
    ap.add_argument(
        "--rebuild",
        action="store_true",
        help="rebuild the bundle even when every marker is already present",
    )
    args = ap.parse_args(argv)

    cli = Path(args.cli).resolve() if args.cli else find_cli_js()
    backup = cli.with_name(cli.name + BACKUP_SUFFIX)
    package_root = cli.parent.parent
    print(f"bundle: {cli}")

    if args.restore:
        if not backup.exists():
            raise SystemExit(f"no backup at {backup}")
        cli.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"restored {cli.name} from {backup.name}")
        return 0

    if not UNIFIED_PATCH.exists():
        print(f"[conflict] unified patch missing: {UNIFIED_PATCH}")
        print("    resolve: regenerate it from the merge worktree (see module docstring).")
        return 3

    version = read_package_version(package_root)
    if version != UNIFIED_BASE_VERSION:
        print(f"  [conflict] installed version {version or 'unknown'} != patch base {UNIFIED_BASE_VERSION}")
        print("    source: scripts/omp-unified.patch")
        print(
            "    resolve: regenerate the unified patch against the installed release "
            "(module docstring), bump UNIFIED_BASE_VERSION, and re-run."
        )
        print("[CONFLICT] Unified patch does not target this package; no changes written.")
        return 3

    filtered_patch = filter_patch_for_package(UNIFIED_PATCH.read_text(encoding="utf-8"))
    if not filtered_patch:
        print("[conflict] unified patch contains no packages/coding-agent/src/ sections")
        print("    resolve: regenerate scripts/omp-unified.patch (see module docstring).")
        return 3

    source_state, detail, strays = classify_source_state(package_root, filtered_patch)
    if source_state == "conflict":
        print("  [conflict] installed source matches neither pristine nor patched state")
        if detail:
            print(f"    reason: {detail.splitlines()[0]}")
        print("    source: scripts/omp-unified.patch")
        print(
            "    resolve: reinstall the package (bun add -g @oh-my-pi/pi-coding-agent"
            f"@{UNIFIED_BASE_VERSION}) or regenerate the unified patch, then re-run."
        )
        print("[CONFLICT] Unified patch is not safe for this package; no changes written.")
        return 3

    bundle_text = cli.read_text(encoding="utf-8", errors="replace")
    results = evaluate_markers(bundle_text)
    print_marker_results(results)
    missing = [r for r in results if not r["present"]]

    if not missing and not args.rebuild:
        print("All patches already present - nothing to do.")
        return 0

    if args.dry_run:
        reason = "--rebuild" if not missing else f"source {source_state}"
        print(f"[dry-run] would rebuild the bundle from the unified patch ({reason}).")
        return 0

    # Pristine cli.js backup only when the bundle carries no marker at all, so
    # a re-run never clobbers the pristine copy with already-patched bytes.
    if len(missing) == len(results) and not backup.exists():
        backup.write_text(bundle_text, encoding="utf-8")
        print(f"  backed up pristine bundle -> {backup.name}")

    transaction, error = rebuild_bundle(cli, filtered_patch, source_state, strays)
    if transaction is None:
        print_marker_resolutions(missing or results)
        print(f"[CONFLICT] Could not rebuild the patched bundle: {error}")
        return 3

    smoke = omp_smoke()
    if smoke is False:
        _restore_transaction(transaction)
        print("[ROLLBACK] `omp --version` failed after patching - restored pre-run bytes.")
        return 2
    if smoke is None:
        print("[warn] `omp` not runnable here - skipped smoke test (patches written).")
    else:
        print("smoke: omp --version OK")

    shutil.rmtree(transaction["backup"], ignore_errors=True)
    print("Done - all patches applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
