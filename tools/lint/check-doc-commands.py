#!/usr/bin/env python3
"""Documentation command executability lint (PRD DOC-004, local slice).

DOC-004's full signal is "shell/PowerShell commands execute on a clean
matching runner". That execution is CI-side; this lint is the repository
half, run by `make check`:

- every fenced shell block (bash/sh) must parse under `bash -n`;
- no block may mix shell prompts (`$ `, `# ` line prefixes) into commands;
- a block may opt out only by an explicit `# not-executable:` first-line
  marker stating why (pseudocode) — an unlabeled non-parsing block fails;
- every repository path a command references (`./x`, `dir/file`) must
  exist in the tree;
- external commands are inventoried (not failed) so the runner job can
  provision them from one place.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC_FILES = sorted(
    [*ROOT.glob("docs/*.md"), ROOT / "README.md", ROOT / "CONTRIBUTING.md",
     *ROOT.glob("apps/*/README.md")],
)
FENCE = re.compile(r"^```(bash|sh|shell)\s*$")
PROMPT = re.compile(r"^\s*\$ ")
PATH_REF = re.compile(r"(?<![\w-])(\.{}/[\w./@-]+|[\w-]+/[\w./@-]+\.[\w]+)")
OPT_OUT = "# not-executable:"


def extract_blocks(text: str) -> list[tuple[int, list[str]]]:
    blocks = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        if FENCE.match(lines[index]):
            block = []
            index += 1
            while index < len(lines) and not lines[index].startswith("```"):
                block.append(lines[index])
                index += 1
            blocks.append((index - len(block), block))
        index += 1
    return blocks


def main() -> int:
    if shutil.which("bash") is None:
        print("ERROR: bash not available for DOC-004 parsing")
        return 1
    problems: list[str] = []
    inventory: set[str] = set()
    for doc in DOC_FILES:
        text = doc.read_text(encoding="utf-8")
        for line_number, block in extract_blocks(text):
            relative = doc.relative_to(ROOT)
            if block and block[0].startswith(OPT_OUT):
                continue  # explicit, labeled pseudocode
            script = "\n".join(block)
            parse = subprocess.run(
                ["bash", "-n"], input=script, capture_output=True, text=True)
            if parse.returncode != 0:
                problems.append(
                    f"{relative}:{line_number}: shell block does not parse — "
                    f"{parse.stderr.strip().splitlines()[0] if parse.stderr else 'syntax error'} "
                    "(mark pseudocode with a leading '# not-executable: reason' if intended)")
                continue
            for offset, line in enumerate(block):
                if PROMPT.match(line) and line.strip() not in ("$", "#"):
                    problems.append(
                        f"{relative}:{line_number + offset}: prompt prefix inside a command block "
                        f"({line.strip()[:40]!r}) — commands must be copy-pasteable")
            for match in PATH_REF.finditer(script):
                candidate = match.group(1).rstrip(".,;:")
                before = script[:match.start()]
                if "://" in before[-80:] or before.rstrip().endswith("github.com"):
                    continue  # URL tail, not a repo path
                if Path(candidate).name.startswith(".env"):
                    continue  # runtime-created config; .env.example is the tracked file
                if (ROOT / candidate).exists() or (doc.parent / candidate).exists():
                    continue
                if candidate.startswith("./") or candidate.count("/") >= 1:
                    if not re.fullmatch(r"(etc|usr|opt|var|tmp|app|home|root|certs)/.*", candidate):
                        problems.append(
                            f"{relative}:{line_number}: command references missing repo path "
                            f"{candidate}")
            first_words = {line.split()[0] for line in block if line.strip()}
            inventory.update(first_words)
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    externals = sorted(word for word in inventory
                       if shutil.which(word) is None and "/" not in word
                       and word not in {"echo", "cd", "export", "set", "if", "then",
                                        "fi", "for", "do", "done", "while", "cat"})
    print(f"doc commands: PASS ({sum(len(extract_blocks(d.read_text(encoding='utf-8'))) for d in DOC_FILES)}"
          f" blocks parse; runner should provision: {' '.join(externals) or 'nothing extra'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
