# Release procedure

Written after the 2026.9.1 release, which found and closed the gap between
"push to main" and "clients get an update" — read §"Why this exists" below
before changing the pipeline.

## Pipeline

```
push main            → CI (tsc + unit tests) + build.yml → GHCR :dev
                        Never touched by production Hubs.

bump version          package.json / config.yaml / src/agent.ts's
                        AGENT_VERSION must all match. Add a CHANGELOG.md
                        entry (and, for a significant release, a matching
                        README.md "## Changelog" entry).

tag vX.Y.Z-beta        → build.yml builds+pushes GHCR :vX.Y.Z-beta and :beta
                        (channel=beta, since the tag contains "-beta").
                        Does NOT touch :stable, :vX.Y.Z, or the minor-alias
                        tag — no real install can pull this by accident.

verify the RC          Don't trust the manifest alone — pull and RUN each
                        platform and check real content, e.g.:
                          docker run --rm --platform linux/amd64  IMAGE:vX.Y.Z-beta sh -c 'uname -m && cloudflared --version'
                          docker run --rm --platform linux/arm64  IMAGE:vX.Y.Z-beta sh -c 'uname -m && cloudflared --version'
                          docker run --rm --platform linux/arm/v7 IMAGE:vX.Y.Z-beta sh -c 'uname -m && cloudflared --version'
                        (arm64/arm/v7 need QEMU registered on the build
                        host: `docker run --rm --privileged tonistiigi/binfmt --install all`)
                        This is exactly the check that would have caught
                        the 2026.8.1–2026.8.3 bug where every non-amd64
                        build silently shipped amd64 content.
                        Also run Trivy directly against the image (the
                        SARIF-format scan in build.yml doesn't print a
                        human-readable summary in the Actions log — pull
                        and scan it yourself for a real answer):
                          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
                            aquasec/trivy:latest image --severity CRITICAL,HIGH IMAGE:vX.Y.Z-beta

promote to stable      tag vX.Y.Z (no -beta) on the SAME commit as the beta
                        tag → build.yml rebuilds from that commit and
                        pushes :vX.Y.Z, :X.Y (minor alias), and :stable —
                        all three land on one identical multiarch manifest.
                        This IS a rebuild, not a copy of the beta artifact
                        (do not try to `docker buildx imagetools create`
                        a manual promotion — that needs write:packages on
                        whatever token is logged in locally, which a
                        personal `gh auth token` does NOT have; only the
                        workflow's own `secrets.GITHUB_TOKEN`, scoped via
                        `permissions: packages: write` in build.yml, is
                        meant to publish these tags). Since it's a fresh
                        build, re-run the same real-execution verification
                        against the actual :vX.Y.Z tag afterward — don't
                        assume it's identical to the beta digest (it isn't;
                        confirm the digests differ, then re-verify content).

confirm all three tags  docker manifest inspect IMAGE:vX.Y.Z
                        docker manifest inspect IMAGE:X.Y
                        docker manifest inspect IMAGE:stable
                        — all three must report the identical per-platform
                        digests. Record the manifest-list digest
                        (`docker pull` prints it as "Digest: sha256:...")
                        as the immutable reference for this release.
```

## Why this exists

Before 2026.9.1, "push main → clients update" worked because an older
CI/CD setup built and published a production image on every push to main.
That coupling was removed (correctly — a single unreviewed commit should
never become the production Agent), but nothing documented the new,
correct pipeline, so the first release attempt after the gap (2026.9.1)
had to rediscover it live: a manual `docker buildx imagetools create`
promotion attempt failed with `403 permission_denied` (personal tokens
don't carry `write:packages` for this org's package — only the workflow's
own `GITHUB_TOKEN` does), and the actual stable tags only appeared once
the real `git tag` → CI → GHCR path ran end to end.

## Getting an update to an actual client Hub

**There is no central "push update to client" mechanism, by design** — this
is a Home Assistant Add-on. Home Assistant's own Supervisor is what checks
`config.yaml`'s `version` against what's installed and offers `Update` in
the Hub's own admin UI (`version`, `version_latest`, `update_available` —
these are HA Supervisor concepts, not something Tinta Core computes or
pushes). Publishing a new `:stable` image and a bumped `config.yaml` on
the App Repository is necessary but not sufficient — the client (or Tinta
Lab support, using the existing temporary support-access flow, with the
client's own consent via the toggle) still has to actually click Update on
that specific Hub.

Roll out to one Hub first, verify, then the rest — never all Hubs at once
off one untested release. Suggested first-Hub checklist after an update:

- Agent reports the new version (self-reported `agentVersion`, visible via
  the backend's `AgentSession`/admin Hubs view — no client-side access
  needed to check this one).
- Home Assistant itself stays reachable throughout (the update restarts
  the add-on container, not HA Core, but confirm anyway).
- Agent reconnects to Tinta Core (WS `register` succeeds, heartbeat
  resumes).
- Cloudflare Tunnel comes back up (self-managed since 2026.9.1 — confirm
  the public hub-*.tinta-lab.de URL responds again).
- Support access grant/revoke still works end to end (grant, use, revoke,
  confirm the HA user is actually removed).
- The post-support security audit (new in 2026.9.1) doesn't false-positive
  on a clean session.
- Agent survives a real restart (not just the update's own restart) and
  recovers all of the above without manual intervention.

Only move to the next Hub once all of that holds.
