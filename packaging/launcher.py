"""Run the bundled local PDFBookmarks MCP using the packaged Node runtime."""

import sys
from pathlib import Path

from nodejs_wheel import node


def main() -> int:
    cli = Path(__file__).parent / "engine" / "src" / "cli.js"
    return node([str(cli), *sys.argv[1:]])
