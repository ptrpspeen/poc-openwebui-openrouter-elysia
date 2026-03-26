# AGENT_CONTEXT.md

Implementation map for the control-plane admin/report codebase.

## Goal
Use this file as the first orientation point before editing the admin dashboard or reporting features.

## High-level structure

- `middleware/src/index.ts`
  - Main backend entrypoint
  - Admin APIs (`/admin/*`)
  - Reporting APIs (`/admin/reports/*`)
  - Proxy path (`/v1/*`)
  - Runtime config loading
  - Request logging / quota denial logging

- `middleware/src/db.ts`
  - PostgreSQL schema init / migrations
  - Policy columns
  - Request log columns
  - Usage / request log table evolution

- `middleware/public/index.html`
  - Main admin shell HTML
  - Alpine markup/templates only (target state)
  - Avoid large inline JS here

- `middleware/public/js/admin.js`
  - Root dashboard state composition
  - Shared helpers used across modules
  - Non-report/non-policy generic UI glue

- `middleware/public/js/reports.js`
  - Reports state
  - Reports filters
  - Metric toggle logic
  - Drill-down modal behavior
  - Detail modal formatting (`last_used` / `last_seen`)
  - Breakdown helpers for `user-models` and `model-users`
  - CSV export helpers for reports

- `middleware/public/js/policies.js`
  - Policy editor state
  - Policy preview logic
  - Policy formatting helpers
  - Group-policy mapping UI helpers

## If you want to implement X, edit here

### Reporting / dashboard analytics
- Backend aggregates/endpoints: `middleware/src/index.ts`
- Report UI behavior/state: `middleware/public/js/reports.js`
- Report markup/cards/tables: `middleware/public/index.html`
- Current report-specific additions:
  - detail modal summary + timeline
  - `last_used` / `last_seen` rendering in drill-down views
  - dedicated `/admin/reports/user-models`
  - dedicated `/admin/reports/model-users`
  - direct tables in Reports for `User Model Breakdown` and `Model User Breakdown`

### Quota policy logic
- Database schema: `middleware/src/db.ts`
- Policy evaluation / enforcement: `middleware/src/index.ts`
- Policy editor UI/state/helpers: `middleware/public/js/policies.js`
- Policy layout/markup: `middleware/public/index.html`

### User / group views
- API payloads: `middleware/src/index.ts`
- HTML sections: `middleware/public/index.html`
- Shared page glue: `middleware/public/js/admin.js`

### Fixing code leak / frontend stability
- Prefer moving JS out of `index.html`
- Add new UI logic into `public/js/*.js` modules, not inline script blocks
- Keep `index.html` as markup-first
- If adding a new module, also add a serving route in `middleware/src/index.ts`

## Refactor direction
Current target architecture is still single-page admin, but split into modules:
1. `admin.js` = root composition + shared helpers
2. `reports.js` = reports module
3. `policies.js` = policies/quota module
4. future: `users.js`, `system.js`, `utils.js`

## Guardrails
- Do not append JS after `</html>`
- Prefer new files under `middleware/public/js/`
- After frontend edits:
  - run `bunx tsc --noEmit`
  - rebuild middleware
  - verify `/js/*.js` routes return `200`

## Quick validation checklist
- `docker compose up -d --build middleware`
- `curl http://127.0.0.1:8081/js/admin.js`
- `curl http://127.0.0.1:8081/js/reports.js`
- check browser/admin page for code leak
- test relevant `/admin/...` endpoint
