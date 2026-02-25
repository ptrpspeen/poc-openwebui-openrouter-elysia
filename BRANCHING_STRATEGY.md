# Branching Strategy

This repository uses a simple 3-branch model:

- `main` = stable integration branch (latest validated code)
- `dev` = active development branch
- `prod` = production release branch (what should be deployed)

## Default Flow

1. Start all feature work from `dev`
2. Open PR: `dev` -> `main` when a feature set is validated
3. Open PR: `main` -> `prod` when release is approved
4. Tag releases from `prod` (e.g. `v1.2.0`)

## Hotfix Flow

1. Create hotfix from `prod`
2. Merge hotfix back to `prod`
3. Back-merge to `main` and `dev` immediately

## Protection Rules (recommended)

Apply branch protection on GitHub:

- `prod`: require PR + 1 review + passing checks
- `main`: require PR + passing checks
- `dev`: allow faster merge, but still via PR when possible
- Disallow force-push on protected branches

## Current Alignment Policy

For now, we keep `main`, `dev`, and `prod` aligned at the same commit baseline.
After this baseline, continue normal flow (`dev` -> `main` -> `prod`).

## Quick Commands

```bash
# sync all branches to current main

git checkout main
git pull

git branch -f dev main
git branch -f prod main

git push origin main dev prod
```

