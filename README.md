# LinkedIn Puzzle Win Calendar

Track who wins the daily LinkedIn puzzles — **Zip, Pinpoint, Mini Sudoku, Queens, Patches** — you vs your friend.

- 5 calendars (one per game) behind a dropdown, starting **July 2026**
- One winner per game per day: blank → **your green** → friend's color → grey (draw) -> blank
- Per-game score + overall score across all 6 games
- Simple RBAC: **you = editor** (mark wins), **friend = viewer** (look, don't touch)
- Friend picks their own color on first login

> Results can't be auto-fetched from LinkedIn (no public API for games, and automating logins is against their ToS), so the editor marks wins manually.

## Try it locally (no install)

Serve the folder with any static server, e.g.:

```bash
npx serve puzzle-tracker
```

Without a backend it runs in **browser-only mode** — everything (accounts, marks) is stored in that browser's localStorage. Good for testing, but your friend on another device won't see your data.

## Deploy on Netlify (shared logins — recommended)

The included serverless function (`netlify/functions/api.mjs`) + Netlify Blobs gives you real shared storage. Free tier is plenty.

1. Push this folder to a GitHub repo.
2. On [netlify.com](https://netlify.com): **Add new site → Import an existing project** → pick the repo.
3. Build settings are read from `netlify.toml` — just deploy. No env vars needed.
4. Open the site URL: first visit shows the **setup screen** — create your account (editor) and your friend's (viewer), then share the URL + their password with your friend.

> Note: plain drag-and-drop deploys won't install the function's dependency; use the GitHub import (or `netlify deploy --build` with the CLI).

## Roles

| | You (editor) | Friend (viewer) |
|---|---|---|
| View calendars & scores | ✅ | ✅ |
| Mark/unmark wins | ✅ | ❌ |
| Pick own color | fixed green `#057642` | ✅ (first login + anytime via "My color") |
