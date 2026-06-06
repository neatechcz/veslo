#!/usr/bin/env python3
"""Focused regression checks for quick_validate fallback behavior."""

import tempfile
from pathlib import Path

import quick_validate


def write_skill(root, content):
    skill_dir = Path(root) / "demo-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(content)
    return skill_dir


def main():
    original_yaml = quick_validate.yaml
    quick_validate.yaml = None
    try:
        with tempfile.TemporaryDirectory() as root:
            skill_dir = write_skill(
                root,
                """---
name: demo-skill
description: Use when users ask to test fallback validation.
veslo_internal_pack: true
veslo_internal_snapshot: "2026-06-06"
---

# Demo Skill
""",
            )
            assert quick_validate.validate_skill(skill_dir) == (True, "Skill is valid!")

        with tempfile.TemporaryDirectory() as root:
            skill_dir = write_skill(
                root,
                """---
name: demo-skill
description: Use when users ask to test fallback validation.
metadata:
  owner: platform
---

# Demo Skill
""",
            )
            valid, message = quick_validate.validate_skill(skill_dir)
            assert not valid
            assert "PyYAML is required for complex frontmatter" in message
    finally:
        quick_validate.yaml = original_yaml

    print("quick_validate fallback tests passed")


if __name__ == "__main__":
    main()
