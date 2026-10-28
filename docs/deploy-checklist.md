# TouristQR deploy checklist

Use this when moving **tested** work from GitHub to **touristqr.com** (FTP).  
Day-to-day experiments stay on the **`draft`** branch; **live** matches **`main`**.

## Branches

| Branch | Purpose |
|--------|---------|
| **`main`** | Stable line — deploy this to production. Tagged checkpoints (e.g. V3). |
| **`draft`** | Experiments — push to GitHub only until you merge to `main`. |

## Before you deploy (especially with real customer data)

1. **Site admin:** Download **catalogue backup** (JSON) and store off the server.
2. **Ask sponsors** to use **Download my data** if they changed listings recently.
3. Note current stable commit: `git log -1 --oneline main` (e.g. `85a0523 TouristQR V3 stable checkpoint`).

## Promote draft → live

1. Test locally: `npm start` → http://127.0.0.1:4173/
2. Run tests: `npm test`
3. Merge when ready:
   ```bash
   git checkout main
   git pull origin main
   git merge draft
   ```
4. Tag a restore point (optional but recommended):
   ```bash
   git tag -a v3.1 -m "Short description of what changed"
   git push origin main --tags
   ```
5. **FTP upload** changed files to production (same paths as repo).
6. **Cache bust:** bump `?v=` on `index.html`, `admin.html`, and any edited `js/*.js` script tags.
7. Smoke-test on phone and PC: open a listing, photos, Saved/Tour, admin login, one backup download.

## Roll back production files

1. Check out the last good tag or commit on **`main`** locally.
2. Re-upload those file versions via FTP (or restore host snapshot if your provider has one).
3. Restore catalogue from JSON backup only if a bad deploy corrupted data — not for code-only rollbacks.

## What not to do

- Do not FTP from an unmerged **`draft`** branch to production.
- Do not skip catalogue backup before a deploy once sponsors have live listings.
- Do not commit secrets (`.env`, passwords, SFTP credentials) to GitHub.

## Quick reference

- **Experiment:** `git checkout draft` → edit → commit → `git push origin draft`
- **Go live:** merge `draft` → `main`, tag, FTP from `main`, bump `?v=`
