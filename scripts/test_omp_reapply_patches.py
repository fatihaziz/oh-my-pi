import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "omp-reapply-patches.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("omp_reapply_patches", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {SCRIPT}")
ENGINE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ENGINE
SPEC.loader.exec_module(ENGINE)


def make_diff(path: str, old: str, new: str) -> str:
    """Single-file unified diff replacing one line (old -> new)."""
    return (
        f"diff --git a/{path} b/{path}\n"
        f"index 0000001..0000002 100644\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        "@@ -1 +1 @@\n"
        f"-{old}\n"
        f"+{new}\n"
    )


SRC_PATH = "packages/coding-agent/src/thinking.ts"
AI_SRC_PATH = "packages/ai/src/providers/failure.ts"
TEST_PATH = "packages/coding-agent/test/thinking.test.ts"
CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.md"
MULTI_PATCH = make_diff(SRC_PATH, "const a = 1;", "const a = 2;") + make_diff(
    AI_SRC_PATH, "const b = 1;", "const b = 2;"
)
MIXED_PATCH = (
    make_diff(CHANGELOG_PATH, "old changelog", "new changelog")
    + make_diff(SRC_PATH, "const a = 1;", "const a = 2;")
    + make_diff(TEST_PATH, "old test", "new test")
)


class FilterPatchTests(unittest.TestCase):
    def test_keeps_only_package_src_sections(self):
        filtered = ENGINE.filter_patch_for_package(MIXED_PATCH)
        self.assertIn(f"b/{SRC_PATH}", filtered)
        self.assertNotIn(CHANGELOG_PATH, filtered)
        self.assertNotIn(TEST_PATH, filtered)

    def test_empty_when_no_src_sections(self):
        patch = make_diff(CHANGELOG_PATH, "a", "b")
        self.assertEqual("", ENGINE.filter_patch_for_package(patch))

    def test_patched_source_paths_are_package_relative(self):
        filtered = ENGINE.filter_patch_for_package(MIXED_PATCH)
        self.assertEqual({"pi-coding-agent": ["src/thinking.ts"]}, ENGINE.patched_source_paths(filtered))

    def test_multi_package_paths_split_per_installed_package(self):
        filtered = ENGINE.filter_patch_for_package(MULTI_PATCH)
        self.assertEqual(
            {"pi-coding-agent": ["src/thinking.ts"], "pi-ai": ["src/providers/failure.ts"]},
            ENGINE.patched_source_paths(filtered),
        )
        grouped = ENGINE.sections_by_package(filtered)
        self.assertEqual({"pi-coding-agent", "pi-ai"}, set(grouped))
        self.assertIn("b/packages/ai/src/providers/failure.ts", grouped["pi-ai"])


@unittest.skipIf(subprocess.run(["git", "--version"], capture_output=True).returncode != 0, "git unavailable")
class ClassifySourceStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.package = self.root / "node_modules" / "@oh-my-pi" / "pi-coding-agent"
        (self.package / "src").mkdir(parents=True)
        self.cli = self.package / "dist" / "cli.js"
        self.cli.parent.mkdir(parents=True, exist_ok=True)
        self.cli.write_text("bundle-bytes", encoding="utf-8")
        self.target = self.package / "src" / "thinking.ts"
        self.patch = ENGINE.filter_patch_for_package(make_diff(SRC_PATH, "const a = 1;", "const a = 2;"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_pristine_when_forward_check_passes(self):
        self.target.write_text("const a = 1;\n", encoding="utf-8")
        state, detail, strays = ENGINE.classify_source_state(self.cli, self.patch)
        self.assertEqual(("pristine", "", {}), (state, detail, strays))

    def test_patched_when_reverse_check_passes(self):
        self.target.write_text("const a = 2;\n", encoding="utf-8")
        state, _, strays = ENGINE.classify_source_state(self.cli, self.patch)
        self.assertEqual(("patched", {}), (state, strays))

    def test_conflict_when_source_diverged(self):
        self.target.write_text("const a = 999;\n", encoding="utf-8")
        state, detail, _ = ENGINE.classify_source_state(self.cli, self.patch)
        self.assertEqual("conflict", state)
        self.assertTrue(detail)

    def test_stray_created_file_still_classifies_pristine(self):
        # The base file is pristine; a file the patch CREATES already exists
        # with stale bytes (leftover from an earlier patch generation).
        self.target.write_text("const a = 1;\n", encoding="utf-8")
        created = "packages/coding-agent/src/new-file.ts"
        create_diff = (
            f"diff --git a/{created} b/{created}\n"
            "new file mode 100644\n"
            "index 0000000..0000003\n"
            "--- /dev/null\n"
            f"+++ b/{created}\n"
            "@@ -0,0 +1 @@\n"
            "+export const fresh = true;\n"
        )
        (self.package / "src" / "new-file.ts").write_text("stale bytes\n", encoding="utf-8")
        patch = ENGINE.filter_patch_for_package(
            make_diff(SRC_PATH, "const a = 1;", "const a = 2;") + create_diff
        )
        state, detail, strays = ENGINE.classify_source_state(self.cli, patch)
        self.assertEqual(("pristine", "", {"pi-coding-agent": ["src/new-file.ts"]}), (state, detail, strays))
        # The probe never deletes; only the rebuild transaction does.
        self.assertTrue((self.package / "src" / "new-file.ts").exists())

    def test_multi_package_pristine_when_both_forward_checks_pass(self):
        ai_package = self.root / "node_modules" / "@oh-my-pi" / "pi-ai" / "src" / "providers"
        ai_package.mkdir(parents=True, exist_ok=True)
        (ai_package / "failure.ts").write_text("const b = 1;\n", encoding="utf-8")
        self.target.write_text("const a = 1;\n", encoding="utf-8")
        filtered = ENGINE.filter_patch_for_package(MULTI_PATCH)
        state, _, _ = ENGINE.classify_source_state(self.cli, filtered)
        self.assertEqual("pristine", state)

    def test_mixed_package_states_conflict(self):
        ai_package = self.root / "node_modules" / "@oh-my-pi" / "pi-ai" / "src" / "providers"
        ai_package.mkdir(parents=True, exist_ok=True)
        (ai_package / "failure.ts").write_text("const b = 2;\n", encoding="utf-8")
        self.target.write_text("const a = 1;\n", encoding="utf-8")
        filtered = ENGINE.filter_patch_for_package(MULTI_PATCH)
        state, _, _ = ENGINE.classify_source_state(self.cli, filtered)
        self.assertEqual("conflict", state)


class MarkerTests(unittest.TestCase):
    PATCHED_BUNDLE = (
        'x="Esc keep current";'
        'if(p.endsWith(".json"))return"json";'
        "ask call per reply, one to three questions in that call\\n"
        "- Ask only what recon cannot answer."
        'omp-editor-x windowsHide:process.platform==="win32";'
        'reject("without opening the file");omp-fork:P11-openrouter-usage'
        'let statusText=response.statusText.trim();'
    )

    def test_all_markers_present_on_patched_bundle(self):
        results = ENGINE.evaluate_markers(self.PATCHED_BUNDLE)
        self.assertTrue(all(r["present"] for r in results))

    def test_all_markers_missing_on_pristine_bundle(self):
        results = ENGINE.evaluate_markers("pristine upstream bundle text")
        self.assertFalse(any(r["present"] for r in results))
        self.assertEqual(
            ["S1", "P1", "P6", "P7", "P8", "P9", "P11", "P12"],
            [r["marker"]["id"] for r in results],
        )


class MainDriverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.package = root / "node_modules" / "@oh-my-pi" / "pi-coding-agent"
        (self.package / "dist").mkdir(parents=True)
        self.cli = self.package / "dist" / "cli.js"
        self.cli.write_text("bundle-bytes", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def _write_version(self, version: str) -> None:
        (self.package / "package.json").write_text(
            '{"name": "@oh-my-pi/pi-coding-agent", "version": "%s"}' % version,
            encoding="utf-8",
        )

    def test_version_gate_conflicts_on_mismatch(self):
        self._write_version("0.0.1")
        output = io.StringIO()
        with redirect_stdout(output):
            code = ENGINE.main(["--cli", str(self.cli), "--dry-run"])
        self.assertEqual(3, code)
        self.assertIn("!= patch base", output.getvalue())
        self.assertIn("resolve:", output.getvalue())

    def test_missing_unified_patch_conflicts(self):
        self._write_version(ENGINE.UNIFIED_BASE_VERSION)
        original = ENGINE.UNIFIED_PATCH
        ENGINE.UNIFIED_PATCH = Path(self.tmp.name) / "absent.patch"
        try:
            output = io.StringIO()
            with redirect_stdout(output):
                code = ENGINE.main(["--cli", str(self.cli), "--dry-run"])
        finally:
            ENGINE.UNIFIED_PATCH = original
        self.assertEqual(3, code)
        self.assertIn("unified patch missing", output.getvalue())

    def test_restore_rewrites_bundle_from_backup(self):
        backup = self.cli.with_name(self.cli.name + ENGINE.BACKUP_SUFFIX)
        backup.write_text("pristine-bytes", encoding="utf-8")
        output = io.StringIO()
        with redirect_stdout(output):
            code = ENGINE.main(["--cli", str(self.cli), "--restore"])
        self.assertEqual(0, code)
        self.assertEqual("pristine-bytes", self.cli.read_text(encoding="utf-8"))


class UnifiedPatchFileTests(unittest.TestCase):
    """The committed patch file must stay coherent with the engine constants."""

    def test_patch_file_targets_package_sources(self):
        patch_text = ENGINE.UNIFIED_PATCH.read_text(encoding="utf-8")
        filtered = ENGINE.filter_patch_for_package(patch_text)
        self.assertTrue(filtered, "unified patch has no shippable packages/*/src/ sections")
        paths = ENGINE.patched_source_paths(filtered)
        self.assertIn("src/thinking.ts", paths["pi-coding-agent"])
        self.assertIn("src/prompts/goals/guided-goal-interview.md", paths["pi-coding-agent"])
        for rels in paths.values():
            self.assertTrue(all(p.startswith("src/") for p in rels))


if __name__ == "__main__":
    unittest.main()
