"""Vendor the landing page's browser libraries from the official npm registry.

The first run resolves current versions; later runs reuse vendor/versions.json.
Pass --refresh to deliberately resolve new versions. No runtime CDN is needed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
MANIFEST = VENDOR / "versions.json"
PINNED = {"three": "0.187.0", "gsap": "3.15.1"}
PACKAGES = {
    "three": {
        "package/build/three.module.js": "three.module.js",
        "package/build/three.core.js": "three.core.js",
        "package/LICENSE": "three.LICENSE.txt",
    },
    "gsap": {
        "package/dist/gsap.min.js": "gsap.min.js",
        "package/dist/ScrollTrigger.min.js": "ScrollTrigger.min.js",
        "package/dist/MotionPathPlugin.min.js": "MotionPathPlugin.min.js",
        "package/package.json": "gsap.package.json",
        "package/README.md": "gsap.README.md",
    },
}


def get(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "Runners-local-vendor-setup/1.0"})
    with urlopen(request, timeout=90) as response:
        return response.read()


def verify(data: bytes, integrity: str) -> None:
    for entry in integrity.split():
        algorithm, _, expected = entry.partition("-")
        if algorithm in {"sha512", "sha384", "sha256"}:
            actual = base64.b64encode(hashlib.new(algorithm, data).digest()).decode()
            if actual != expected:
                raise RuntimeError("npm package integrity verification failed")
            return
    raise RuntimeError("npm metadata did not provide a supported integrity digest")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    existing = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    previous = existing.get("packages", {})
    result = {"registry": "https://registry.npmjs.org", "packages": {}}
    VENDOR.mkdir(parents=True, exist_ok=True)

    for name, files in PACKAGES.items():
        version = "latest" if args.refresh else previous.get(name, {}).get("version", PINNED[name])
        metadata_url = f"https://registry.npmjs.org/{name}/{version}"
        metadata = json.loads(get(metadata_url))
        dist = metadata["dist"]
        print(f"Downloading {name}@{metadata['version']} from the npm registry", flush=True)
        archive = get(dist["tarball"])
        verify(archive, dist["integrity"])
        saved = []
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
            for source, destination in files.items():
                try:
                    member = package.getmember(source)
                except KeyError:
                    # Older Three releases embed core; license filename can vary.
                    if source.endswith("three.core.js"):
                        continue
                    raise RuntimeError(f"Expected package member missing: {source}")
                if not member.isfile() or member.size > 20 * 1024 * 1024:
                    raise RuntimeError(f"Invalid package member: {source}")
                stream = package.extractfile(member)
                if stream is None:
                    raise RuntimeError(f"Cannot read package member: {source}")
                content = stream.read()
                (VENDOR / destination).write_bytes(content)
                saved.append(destination)
        if name == "gsap":
            package_metadata = json.loads((VENDOR / "gsap.package.json").read_text(encoding="utf-8"))
            notice = (
                f"GSAP {metadata['version']}\n"
                f"Upstream license declaration: {package_metadata.get('license', metadata.get('license', 'See upstream README'))}\n"
                "The upstream npm package supplies its license declaration in package.json.\n"
                "See gsap.package.json and gsap.README.md for the upstream license reference.\n"
            )
            (VENDOR / "gsap.LICENSE.txt").write_text(notice, encoding="utf-8")
            saved.append("gsap.LICENSE.txt")
        result["packages"][name] = {
            "version": metadata["version"],
            "source": dist["tarball"],
            "integrity": dist["integrity"],
            "files": saved,
        }
    MANIFEST.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Ready: local libraries in {VENDOR}", flush=True)


if __name__ == "__main__":
    main()
