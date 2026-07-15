#!/usr/bin/env bash
#
# sync-mirror.sh — mirror the CANONICAL Bitbucket repo -> the GitHub fork.
#
# Why this exists
# ---------------
# herbe-service has two remotes: Bitbucket `burti/herbe-service` (canonical —
# PRs merge here) and a GitHub fork `elviskvalbergs/herbe-service` (Vercel
# deploys from it). The local `origin` dual-pushes to both, but a PR merged in
# the Bitbucket UI is a SERVER-SIDE commit the local never sees, so it never
# reaches GitHub — the fork (and thus Vercel) silently falls behind. (Observed
# 2026-07-15: GitHub `preview` was 17 commits behind; `main` was missing.)
#
# This force-updates the named GitHub branches to match Bitbucket. Run it after
# any Bitbucket-side merge — or adopt a permanent fix (point Vercel at Bitbucket
# directly, or a CI auto-mirror; see docs / the handoff notes).
#
# Usage:
#   scripts/sync-mirror.sh                # mirrors: preview
#   scripts/sync-mirror.sh preview main   # mirrors the branches you name
#
# NOTE: mirroring `main` triggers a Vercel PRODUCTION deploy — only pass it when
# you intend to deploy production.
set -euo pipefail

BITBUCKET="git@bitbucket.org:burti/herbe-service.git"
GITHUB="git@github-elviskvalbergs:elviskvalbergs/herbe-service.git"
BRANCHES=("${@:-preview}")

for b in "${BRANCHES[@]}"; do
  echo "-> mirroring '$b': Bitbucket -> GitHub"
  git fetch --force "$BITBUCKET" "refs/heads/$b:refs/mirror/$b"
  git push --force "$GITHUB" "refs/mirror/$b:refs/heads/$b"
  git update-ref -d "refs/mirror/$b"
  echo "   done: $b"
done
echo "Mirror sync complete."
