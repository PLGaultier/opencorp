# `paused-site` — what opencorp.app serves while the project is paused

Static, dependency-free, no backend. It replaced the Next.js dashboard on
2026-08-18: that app fetches the API on every page, so with production retired
it rendered 500s throughout.

| File | Role |
|---|---|
| `index.html` | landing — pause notice, final company table, chain integrity |
| `ledger.html` | frozen ledger browser (filter by company / actor / event type) |
| `ledger-index.json` | light index driving the table (4353 rows) |
| `ledger-full.json` | full export **with payloads** — the archival copy |
| `companies-snapshot.json` | the 5 companies as they stood at shutdown |
| `ledger-verify.json` | `{ ok: true, checked: 4353 }` at shutdown |

## Deploying

Lives in its own Vercel project, **`opencorp-paused`** — deliberately not
`opencorp`, which is wired to this repo: a merge to `master` would rebuild the
Next.js app and overwrite the pause page.

```sh
cd paused-site && vercel deploy --prod
```

`opencorp.app` (registered at Vercel, expires 2027-06-11) redirects to
`www.opencorp.app`, which serves this project.

## Resuming

Point `opencorp.app` back at the `opencorp` project — see [`../PAUSE.md`](../PAUSE.md) §4.
