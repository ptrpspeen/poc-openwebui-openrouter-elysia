## Branch Flow (required)

- Feature work starts on `dev`
- Merge order must be:
  1. `dev` -> `main`
  2. `main` -> `prod`

> Direct `dev` -> `prod` is not allowed except approved emergency hotfix.

---

### PR Type
- [ ] Feature
- [ ] Bugfix
- [ ] Refactor
- [ ] Docs
- [ ] Chore
- [ ] Hotfix

### Source / Target
- Source: `<branch>`
- Target: `<branch>`
- [ ] Flow verified (`dev -> main -> prod`)

### Summary
<!-- what and why -->

### Validation
- [ ] Build/tests pass
- [ ] Manual verification done

### Config / Migration
- [ ] None
- [ ] Config change required
- [ ] DB migration required

Details:

### Rollback Plan
<!-- how to rollback safely -->
