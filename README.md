# Kanako Progress Hub — Online and Offline Sources

This repository contains two distinct app builds: `index.html` is the cloud-connected Kanako Progress Hub used by the Vercel project, while `Kanako_Offline_Workbench.html` is the separate local-first standalone app. They intentionally have different authentication, storage, and feature behavior; do not copy changes between them blindly.

## One-time setup

Keep `Kanako_Offline_Workbench.html` in the repository root. The package workflow prefers this file and uses `index.html` only as a fallback, so the downloadable ZIP stays the standalone offline app.

- Upload page: https://github.com/kanakomaeda/kanako-offline/upload/main
- After uploading, commit the file to the `main` branch.
- Each subsequent push to `main` runs the package workflow and creates a downloadable ZIP in the Actions run artifacts.

## Use it

1. Download the latest `Kanako_Offline_Workbench_Package.zip` artifact from the Actions run.
2. Extract it and open `Kanako_Offline_Workbench.html` in Chrome or Edge.
3. Use the same browser profile for continued local work. Records and PDF/MP4 evidence files are stored locally in that browser/device.
4. Keep backups and download important evidence files separately.

## Login and access levels

- On first use, create your **Superuser** account with your own username and password. No default password is built into the app.
- The Superuser has full app access and can create, deactivate/reactivate, or reset passwords for Admin accounts; delete records; and import/export backups.
- Admin accounts can view, create, and edit operational records but cannot delete records, import/export backups, or manage accounts.
- Passwords are stored as salted PBKDF2-SHA-256 hashes rather than plain text. Each sign-in session ends when the page is refreshed or the user logs out.
- **Important:** account records and role settings are stored in the local browser, separate from the workspace data. Admin accounts do not automatically appear on another computer or browser. This offline, client-side login is an access gate, not server-enforced security; users with direct access to the browser profile or HTML source may bypass it. Use a server-backed authentication system for secure multi-device or remote access.

## Local data and privacy

- Local records are not uploaded to a server.
- PDF/MP4 evidence files are stored in the browser's IndexedDB when using the supported File Library upload flow.
- The JSON export contains record metadata, not the original PDF/MP4 binary files. Use each file's Download action for a separate copy.
- Do not clear the browser's site data if you need to preserve local files.
- Do not commit personal records, secrets, or QA evidence to this repository.

## Online website (GitHub Pages)

The `.github/workflows/deploy-pages.yml` workflow publishes `Kanako_Offline_Workbench.html` as the GitHub Pages `index.html`. GitHub Pages therefore serves the standalone local-first app, not the Vercel cloud-connected app.

Expected website address:
`https://kanakomaeda.github.io/kanako-offline/`

GitHub Pages must be available for this repository plan, and the repository's **Settings → Pages → Build and deployment → Source** must be set to **GitHub Actions**. If deployment fails with a Pages configuration or plan error, check those repository settings. GitHub Pages sites are publicly reachable even if the source repository is private; don't publish sensitive information in the static app.

GitHub Pages is static hosting for the offline Workbench. Its login and roles run in the browser; workspace records are saved to local browser storage, and PDFs/MP4s to that browser's IndexedDB. They do not sync to a shared account or database. Admin/Superuser permissions in this offline app are not a secure server-side access-control system. Do not use this deployment to protect sensitive trainee information or confidential media. For the cloud-connected Vercel app, consult its configured backend and access controls separately.

## Development workflow

`Kanako_Offline_Workbench.html` is the source for the standalone offline package and GitHub Pages site. `index.html` is the source used by the Vercel cloud-connected app. Keep fixes scoped to the correct build, then intentionally port them only when the behavior should match. The package workflow builds the offline ZIP; the Pages workflow publishes the offline Workbench. Vercel deployments are managed separately.

## Scope

The Workbench is offline/local-first and does not automatically synchronize records with a cloud database. The Vercel app is a separate cloud-connected build. GitHub commits track source code only; they do not synchronize trainee records or evidence files.