#!/usr/bin/env python3
# Adapted from repo-docs in ad-claude-marketplace (MIT); see ../LICENSE.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Mechanical checks over a repository's documentation.

Catches what the eye does not: broken internal links and anchors, malformed
Mermaid blocks, out-of-bounds linkStyle indices, dangling references to docs
files from source, and dash density.

    python3 check_docs.py <repo root> [--quiet]

Exit code 0 when clean, 1 on errors. Warnings do not affect it.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SKIP_DIRS = {
    ".git", ".venv", "venv", "node_modules", ".pi-subagents", ".telegram-inbox",
    "__pycache__", ".mypy_cache",
    ".ruff_cache", ".pytest_cache", "dist", "build", ".tox", "target",
}
SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".ts", ".go", ".rs", ".sh", ".toml", ".yml", ".yaml", ".c", ".h"}

MERMAID_TYPES = (
    "flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram",
    "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "gitGraph",
    "mindmap", "timeline", "quadrantChart", "requirementDiagram", "C4Context",
    "sankey-beta", "xychart-beta", "block-beta", "packet-beta", "architecture-beta",
)

# Mermaid flowchart arrows: >=2 dashes or equals signs, optionally dotted,
# with an optional head. Counted after labels are stripped.
ARROW_RE = re.compile(r"<?(?:-{2,}|={2,}|-\.{1,3}-*)(?:>|x|o)?")
LABEL_RE = re.compile(r"\[[^\]]*\]|\{[^}]*\}|\([^)]*\)|\|[^|]*\||\"[^\"]*\"")
LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})\s*(\S*)")


def slugify(heading: str) -> str:
    """The anchor the way GitHub builds it."""
    text = re.sub(r"`([^`]*)`", r"\1", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_~]", "", text)
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    return re.sub(r"\s+", "-", text)


def anchors_of(text: str) -> set[str]:
    slugs: set[str] = set()
    seen: dict[str, int] = {}
    in_fence = False
    fence = ""
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if m and (not in_fence or line.strip().startswith(fence)):
            if in_fence:
                in_fence, fence = False, ""
            else:
                in_fence, fence = True, m.group(2)
            continue
        if in_fence:
            continue
        h = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if not h:
            continue
        base = slugify(h.group(2))
        n = seen.get(base)
        seen[base] = 0 if n is None else n + 1
        slugs.add(base if n is None else f"{base}-{seen[base]}")
    return slugs


def mermaid_blocks(text: str) -> list[tuple[int, str]]:
    blocks, buf, start, inside = [], [], 0, False
    for i, line in enumerate(text.splitlines(), 1):
        if not inside and re.match(r"^\s*`{3,}\s*mermaid\s*$", line):
            inside, buf, start = True, [], i
        elif inside and re.match(r"^\s*`{3,}\s*$", line):
            blocks.append((start, "\n".join(buf)))
            inside = False
        elif inside:
            buf.append(line)
    return blocks


def check_mermaid(src: str) -> list[str]:
    problems: list[str] = []
    body = [ln for ln in src.splitlines() if ln.strip() and not ln.strip().startswith("%%")]
    if not body:
        return ["empty mermaid block"]
    head = body[0].strip()
    if not head.startswith(MERMAID_TYPES):
        problems.append(f"unknown diagram type: {head!r}")
        return problems
    if not head.startswith(("flowchart", "graph")):
        return problems

    links = 0
    for line in body[1:]:
        s = line.strip()
        if s.startswith(("linkStyle", "style", "classDef", "class ", "click", "subgraph", "end")):
            continue
        links += len(ARROW_RE.findall(LABEL_RE.sub(" ", s)))

    for line in body[1:]:
        s = line.strip()
        if not s.startswith("linkStyle"):
            continue
        idx = re.match(r"linkStyle\s+([\d,\s]+)", s)
        if not idx:
            continue
        for raw in idx.group(1).replace(" ", "").split(","):
            if raw.isdigit() and int(raw) >= links:
                problems.append(
                    f"linkStyle {raw}: counted {links} links (0..{links - 1}). "
                    "The GitHub render will throw. The count is heuristic - recount by hand"
                )
    return problems


def unclosed_fence(text: str) -> bool:
    depth, fence = 0, ""
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if not m:
            continue
        if depth == 0:
            depth, fence = 1, m.group(2)[:3]
        elif line.strip().startswith(fence) and not m.group(3):
            depth = 0
    return depth != 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", nargs="?", default=".", type=Path)
    ap.add_argument("--quiet", action="store_true", help="errors only")
    args = ap.parse_args()
    root = args.root.resolve()

    md = [
        p for p in root.rglob("*.md")
        if not any(part in SKIP_DIRS for part in p.relative_to(root).parts)
    ]
    if not md:
        print(f"no markdown found under {root}")
        return 1

    anchors = {p: anchors_of(p.read_text(encoding="utf-8", errors="replace")) for p in md}
    errors: list[str] = []
    warnings: list[str] = []

    for path in md:
        rel = path.relative_to(root)
        text = path.read_text(encoding="utf-8", errors="replace")

        if unclosed_fence(text):
            errors.append(f"{rel}: unclosed code fence")

        for m in LINK_RE.finditer(text):
            target = m.group(1)
            if target.startswith(("http://", "https://", "mailto:", "tel:", "<")):
                continue
            line = text[: m.start()].count("\n") + 1
            file_part, _, frag = target.partition("#")
            dest = path if not file_part else (path.parent / file_part).resolve()
            if not dest.exists():
                errors.append(f"{rel}:{line}: no such file - {target}")
                continue
            if frag and dest.suffix == ".md" and dest in anchors and frag not in anchors[dest]:
                near = [a for a in sorted(anchors[dest]) if frag.split("-")[0] in a][:3]
                hint = f" (close: {', '.join(near)})" if near else ""
                errors.append(f"{rel}:{line}: no such anchor - {target}{hint}")

        for start, src in mermaid_blocks(text):
            for problem in check_mermaid(src):
                errors.append(f"{rel}:{start}: mermaid - {problem}")

        prose = re.sub(r"`{3,}.*?`{3,}", "", text, flags=re.S)
        prose = re.sub(r"^\s*\|.*$", "", prose, flags=re.M)
        prose = re.sub(r"^#{1,6}\s+.*$", "", prose, flags=re.M)
        # The first dash in a list item, or after a bold lead-in, is a
        # definition separator ("**Link** - what it covers"), not a hedge.
        prose = re.sub(r"^(\s*[-*+]\s[^\n—]*)—", r"\1", prose, flags=re.M)
        prose = re.sub(r"^(\*\*[^*\n]+\*\*[^\n—]*)—", r"\1", prose, flags=re.M)
        prose = re.sub(r"^(\s*\d+\.\s[^\n—]*)—", r"\1", prose, flags=re.M)
        words = len(prose.split())
        dashes = prose.count("—")
        # In Russian the copula dash is grammatically required rather than a
        # hedge, so the threshold is much looser and the kind of dash matters
        # more than the count. See the reusable repo-docs prose checklist.
        letters = re.findall(r"[^\W\d_]", prose, flags=re.UNICODE)
        cyrillic = sum(1 for ch in letters if "\u0400" <= ch <= "\u04ff")
        ru = bool(letters) and cyrillic / len(letters) > 0.3
        limit = 1 / 45 if ru else 1 / 100
        if words > 200 and dashes / words > limit:
            tail = (
                "Russian copula dashes are normal - check the kind, not the count"
                if ru else "review the repo-docs prose checklist"
            )
            warnings.append(f"{rel}: {dashes} dashes per {words} words of prose - dense, {tail}")

    doc_names = {str(p.relative_to(root)) for p in md}
    mentioned: dict[str, list[str]] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        body = path.read_text(encoding="utf-8", errors="replace")
        for ref in set(re.findall(r"[\w./-]*docs/[\w./-]+\.md", body)):
            if ref.lstrip("./") not in doc_names:
                mentioned.setdefault(ref, []).append(str(path.relative_to(root)))
    for ref, where in sorted(mentioned.items()):
        errors.append(f"dangling reference to {ref} from source: {', '.join(sorted(where)[:4])}")

    if warnings and not args.quiet:
        print("Warnings:")
        for w in warnings:
            print(f"  {w}")
        print()
    if errors:
        print("Errors:")
        for e in errors:
            print(f"  {e}")
        print(f"\n{len(errors)} errors across {len(md)} files")
        return 1
    if not args.quiet:
        print(f"OK: {len(md)} files, links and mermaid clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
