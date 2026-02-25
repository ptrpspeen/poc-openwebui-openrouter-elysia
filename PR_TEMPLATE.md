# Pull Request Template

## Branch Flow (required)

- Feature work: `dev`
- Integration/validation: `main`
- Release/deploy: `prod`

Expected promotion order:
1. `dev` -> `main`
2. `main` -> `prod`

> Do not open `dev` -> `prod` directly except emergency hotfix policy.

---

## PR Type

- [ ] Feature
- [ ] Bugfix
- [ ] Refactor
- [ ] Docs
- [ ] Chore
- [ ] Hotfix

## Source / Target

- Source branch: `<dev|main|hotfix/...>`
- Target branch: `<main|prod|...>`
- Flow check:
  - [ ] This PR follows `dev -> main -> prod`
  - [ ] If not, reason is documented below

## Summary

Describe what changed and why.

## Changes

- 
- 
- 

## Validation

- [ ] Local tests/build pass
- [ ] Relevant endpoints verified
- [ ] No breaking config changes (or documented below)

Validation notes:

## Config / Migration Impact

- [ ] No config changes
- [ ] Requires config update
- [ ] Requires DB migration

Details:

## Rollback Plan

How to rollback safely if needed.

## Checklist

- [ ] CI checks pass
- [ ] Reviewer assigned
- [ ] Docs updated (if needed)
- [ ] Release notes updated (for `main -> prod`)
