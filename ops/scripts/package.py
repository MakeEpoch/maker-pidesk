#!/usr/bin/env python3
"""Create a source release without caches, local state, or archived prototypes."""

from datetime import datetime, timezone
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]
INCLUDE = (
    "app",
    "docs",
    "driver",
    "ops",
    "tests",
    "AGENTS.md",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "pyproject.toml",
    "Makefile",
    "package.json",
    "package-lock.json",
    ".prettierrc.json",
    ".editorconfig",
    ".gitignore",
)
EXCLUDE = {"__pycache__", ".DS_Store", "build", "dist"}


def build_release():
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = output / f"pidesk-0.1.0-{stamp}.tar.gz"
    paths = []
    for name in INCLUDE:
        path = ROOT / name
        paths.extend([path] if path.is_file() else (p for p in path.rglob("*") if p.is_file()))
    with tarfile.open(destination, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(paths):
            relative = path.relative_to(ROOT)
            if any(part in EXCLUDE or part.endswith(".egg-info") for part in relative.parts):
                continue
            if path.suffix in (".pyc", ".ko", ".o", ".cmd") or path.name.startswith("._"):
                continue
            archive.add(path, arcname=str(relative), recursive=False)
    return destination


if __name__ == "__main__":
    print(build_release())
