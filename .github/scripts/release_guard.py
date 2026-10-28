#!/usr/bin/env python3
"""Release guards for build.yml (run from a full checkout with tags).

  release_guard.py unpublished IMAGE TAG
      Exit 0 if IMAGE:TAG does not exist yet. Exit 1 if it does — published
      version tags are never moved or overwritten (a re-run of a finished
      release stops here and changes nothing). Exit 2 on any other error
      (network, auth): unknown is treated as "don't publish".

  release_guard.py beta-digest IMAGE VERSION COMMIT
      Stable releases promote the beta image that was built from the same
      commit instead of rebuilding. Finds the beta tag(s) [v]VERSION-beta[.N]
      pointing at COMMIT, takes the highest, and checks its published image:
      all expected platforms present, each built from COMMIT
      (org.opencontainers.image.revision) as that beta
      (org.opencontainers.image.version). Prints `beta=` and `digest=` lines
      (also appended to $GITHUB_OUTPUT when set). Exit 1 if anything doesn't
      match — the release is blocked.
"""
import json
import os
import re
import subprocess
import sys

PLATFORMS = {"linux/amd64", "linux/arm64", "linux/arm/v7"}


def fail(msg, code=1):
    print(f"::error::{msg}")
    sys.exit(code)


def inspect(ref, fmt):
    r = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", ref, "--format", fmt],
        capture_output=True, text=True)
    if r.returncode != 0:
        if "not found" in r.stderr:
            return None
        fail(f"could not inspect {ref}: {r.stderr.strip()}", 2)
    return json.loads(r.stdout)


def digest_of(ref):
    m = inspect(ref, "{{json .Manifest}}")
    return m and m["digest"]


def unpublished(image, tag):
    d = digest_of(f"{image}:{tag}")
    if d:
        fail(f"{image}:{tag} is already published ({d}). Published version "
             "tags are immutable — nothing was changed. Release a new version.")
    print(f"{image}:{tag} not published yet")


def version_key(tag):
    m = re.search(r"-beta(?:\.(\d+))?$", tag)
    return int(m.group(1) or 0) if m else -1


def beta_digest(image, version, commit):
    tags = subprocess.run(["git", "tag", "--points-at", commit],
                          capture_output=True, text=True, check=True).stdout.split()
    pat = re.compile(r"^v?" + re.escape(version) + r"-beta(\.\d+)?$")
    betas = sorted((t for t in tags if pat.match(t)), key=version_key)
    if not betas:
        fail(f"no beta tag ([v]{version}-beta[.N]) points at {commit}. Stable "
             "promotes the tested beta image of the same commit — tag and "
             "verify a beta from this commit first.")
    beta = betas[-1]
    print(f"beta tags on {commit[:7]}: {', '.join(betas)} -> using {beta}")

    digest = digest_of(f"{image}:{beta}")
    if not digest:
        fail(f"{image}:{beta} is not published (did its build fail the scan?)")
    images = inspect(f"{image}@{digest}", "{{json .Image}}")
    if not isinstance(images, dict) or set(images) != PLATFORMS:
        got = sorted(images) if isinstance(images, dict) else "single-platform"
        fail(f"{image}:{beta} platforms {got} != {sorted(PLATFORMS)}")
    for platform, img in sorted(images.items()):
        labels = (img.get("config") or {}).get("Labels") or {}
        rev = labels.get("org.opencontainers.image.revision")
        ver = labels.get("org.opencontainers.image.version")
        if rev != commit:
            fail(f"{image}:{beta} [{platform}] was built from revision {rev!r}, "
                 f"not {commit} (betas built before the revision label existed "
                 "can't be promoted)")
        if ver != beta:
            fail(f"{image}:{beta} [{platform}] carries version label {ver!r}, not {beta!r}")
        print(f"  {platform}: revision {rev[:7]}, version {ver} ok")

    print(f"beta={beta}\ndigest={digest}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"beta={beta}\ndigest={digest}\n")


if __name__ == "__main__":
    cmd, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if cmd == "unpublished" and len(args) == 2:
        unpublished(*args)
    elif cmd == "beta-digest" and len(args) == 3:
        beta_digest(*args)
    else:
        fail(__doc__.strip(), 2)
