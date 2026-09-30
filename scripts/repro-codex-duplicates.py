#!/usr/bin/env python3
"""Manual, isolated Codex discovery repro. Requires codex, node, and a built SKIT CLI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    cli = Path(__file__).resolve().parent.parent / "packages/cli/bin/skit.js"
    with tempfile.TemporaryDirectory(prefix="skit-codex-duplicates-") as temporary:
        root = Path(temporary)
        home, project = root / "home", root / "project"
        home.mkdir()
        project.mkdir()
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        env = {
            **os.environ,
            "HOME": str(home),
            "CODEX_HOME": str(home / ".codex"),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "SKIT_HOME": str(home / ".skit"),
        }
        source = home / "Work/skills/design-preferences"
        source.mkdir(parents=True)
        document = "---\nname: design-preferences\ndescription: Apply design preferences.\n---\nDesign clearly.\n"
        (source / "SKILL.md").write_text(document)
        legacy = home / ".codex/skills"
        shared = home / ".agents/skills"
        legacy.mkdir(parents=True)
        shared.mkdir(parents=True)
        (legacy / "design-preferences").symlink_to(source, target_is_directory=True)
        copy = shared / "design-preferences"

        def skit(*args):
            result = subprocess.run(
                ["node", str(cli), *args], cwd=project, env=env,
                capture_output=True, text=True, timeout=25,
            )
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
            return result.stdout

        def check(case, expected_count, documents=None, display_collision=False, managed=False):
            report = json.loads(skit("doctor", "--json"))["data"]["codex"]
            assert report["status"] == "checked", report
            assert not report["errors"], report
            findings = report["findings"]
            duplicate = next((f for f in findings if f["kind"] == "duplicate-name"), None)
            if expected_count == 1:
                assert duplicate is None, report
            else:
                assert duplicate and len(duplicate["instances"]) == expected_count, report
                assert duplicate["documents"] == documents, report
                if managed:
                    assert any(i["skitManaged"] for i in duplicate["instances"]), report
            assert any(f["kind"] == "display-name-collision" for f in findings) == display_collision, report
            print(f"PASS {case} (Codex CLI {report.get('version', 'unknown')})")

        copy.symlink_to(source, target_is_directory=True)
        check("two symlinks to one source", 1)
        copy.unlink()
        copy.mkdir()
        (copy / "SKILL.md").write_text(document)
        check("separate identical copy plus source symlink", 2, "identical")
        (copy / "SKILL.md").write_text(document + "Different behavior.\n")
        check("separate different copy plus source symlink", 2, "different")
        (copy / "SKILL.md").unlink()
        copy.rmdir()
        skit("add", str(source))
        skit("enable", "design-preferences", "--for", "codex")
        check("real SKIT projection plus pre-existing source symlink", 2, "identical", managed=True)
        project_skill = project / ".agents/skills/design-preferences"
        project_skill.mkdir(parents=True)
        (project_skill / "SKILL.md").write_text(document)
        check("project and user copies coexist", 3, "identical", managed=True)
        other = shared / "design-preferences-other"
        other.mkdir()
        (other / "SKILL.md").write_text(document.replace("name: design-preferences", "name: design-preferences-other"))
        # Use two foreign instances for metadata changes; do not edit the managed projection.
        for directory in (source, other):
            (directory / "agents").mkdir()
            (directory / "agents/openai.yaml").write_text("interface:\n  display_name: Design Preferences\n")
        check("different skill names share a picker label", 3, "identical", display_collision=True, managed=True)


if __name__ == "__main__":
    main()
