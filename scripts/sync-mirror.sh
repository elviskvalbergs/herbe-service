#!/usr/bin/env bash
#
# sync-mirror.sh — mirror the CANONICAL Bitbucket repo -> the GitHub fork.
#
# Why this exists
# ---------------
# Bitbucket `burti/herbe-service` is canonical (PRs merge here; Vercel deploys
# from it). GitHub `elviskvalbergs/herbe-service` is a read-only mirror (AI/tool
# access). A PR merged in the Bitbucket UI is a SERVER-SIDE commit the local
# never sees, so the GitHub mirror drifts. (Observed 2026-07-15: GitHub `preview`
# was 17 commits behind; `main` was missing entirely.)
#
# Local remotes are now: `origin` = Bitbucket (canonical, fetch+push),
# `github` = the mirror. This force-updates the named branches on GitHub to match
# Bitbucket. Run it after any Bitbucket-side merge — or set up a CI auto-mirror
# for full automation. (Vercel deploys from Bitbucket, so the mirror never blocks
# deploys; this just keeps the read-only fork current.)
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
