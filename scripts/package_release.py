"""Build a GitHub npm archive, MCPB and Python wheel from one locked engine."""

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PACKAGE = json.loads((ROOT / "package.json").read_text())
LOCK = json.loads((ROOT / "package-lock.json").read_text())["packages"]
VERSION = PACKAGE["version"]
GITHUB = "https://github.com/Yuikij/pdfbookmarks-ai"
NATIVE_PLATFORMS = (
    "darwin-arm64", "darwin-x64", "win32-arm64-msvc", "win32-x64-msvc",
    "linux-arm64-gnu", "linux-arm64-musl", "linux-x64-gnu", "linux-x64-musl",
)


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def add_canvas_package(platform, engine, workspace):
    package = f"@napi-rs/canvas-{platform}"
    dependency = LOCK[f"node_modules/{package}"]
    local = workspace / platform
    local.mkdir()
    run("npm", "pack", "--ignore-scripts", dependency["resolved"], cwd=local)
    (archive,) = local.glob("*.tgz")
    algorithm, checksum = dependency["integrity"].split("-", 1)
    import base64
    with archive.open("rb") as stream:
        digest = base64.b64encode(hashlib.file_digest(stream, algorithm).digest()).decode()
    if digest != checksum:
        raise RuntimeError(f"Integrity check failed for {package}")
    with tarfile.open(archive) as source:
        source.extractall(local, filter="data")
    (local / "package").rename(engine / "node_modules" / package)


def main():
    DIST.mkdir(exist_ok=True)
    run("npm", "pack", "--ignore-scripts", "--pack-destination", str(DIST))
    with tempfile.TemporaryDirectory(prefix="pdfbookmarks-build-") as tmp:
        workspace = Path(tmp)
        python_root = workspace / "python"
        module = python_root / "pdfbookmarks_mcp"
        engine = module / "engine"
        engine.mkdir(parents=True)

        for name in ("package.json", "package-lock.json", "LICENSE"):
            shutil.copy2(ROOT / name, engine / name)
        for name in ("src", "fonts"):
            shutil.copytree(ROOT / name, engine / name)
        run("npm", "ci", "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", cwd=engine)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            for _ in executor.map(lambda platform: add_canvas_package(platform, engine, workspace), NATIVE_PLATFORMS):
                pass

        shutil.rmtree(engine / "node_modules" / ".bin", ignore_errors=True)
        (engine / "node_modules" / ".package-lock.json").unlink(missing_ok=True)
        shutil.copy2(ROOT / "packaging" / "manifest.json", engine / "manifest.json")
        manifest = json.loads((engine / "manifest.json").read_text())
        if manifest["version"] != VERSION:
            raise RuntimeError("MCPB version differs from package.json")
        bundle = DIST / f"pdfbookmarks-{VERSION}.mcpb"
        with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(engine.rglob("*")):
                if file.is_file():
                    archive.write(file, file.relative_to(engine))

        for name in ("README.md", "LICENSE"):
            shutil.copy2(ROOT / name, python_root / name)
        project = (ROOT / "packaging" / "pyproject.toml").read_text()
        if f'version = "{VERSION}"' not in project:
            raise RuntimeError("Python package version differs from package.json")
        (python_root / "pyproject.toml").write_text(project)
        shutil.copy2(ROOT / "packaging" / "launcher.py", module / "__init__.py")
        run("uv", "build", "--wheel", "--out-dir", str(DIST), cwd=python_root)

    with bundle.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    server = {
        "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        "name": PACKAGE["mcpName"],
        "title": "PDFBookmarks",
        "description": "Edit local PDF bookmarks and write verified links from text or scanned tables of contents.",
        "repository": {"url": GITHUB, "source": "github"},
        "websiteUrl": PACKAGE["homepage"],
        "version": VERSION,
        "packages": [{
            "registryType": "mcpb",
            "identifier": f"{GITHUB}/releases/download/v{VERSION}/{bundle.name}",
            "fileSha256": checksum,
            "transport": {"type": "stdio"},
        }],
    }
    (DIST / "server.json").write_text(json.dumps(server, indent=2) + "\n")
    print(f"Artifacts: {os.fspath(DIST)}")


if __name__ == "__main__":
    main()
