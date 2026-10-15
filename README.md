# Kanako Progress Hub — Offline

A standalone, offline-capable version of Kanako Progress Hub.

## One-time setup

Upload the downloaded `Kanako_Offline_Workbench.html` file to the repository root. The GitHub Actions workflow accepts either that filename or `index.html`.

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

The `.github/workflows/deploy-pages.yml` workflow prepares the app as `index.html` and deploys it to GitHub Pages when the app source or deployment workflow changes on `main`.

Expected website address:
`https://kanakomaeda.github.io/kanako-offline/`

GitHub Pages must be available for this repository plan, and the repository's **Settings → Pages → Build and deployment → Source** must be set to **GitHub Actions**. If deployment fails with a Pages configuration or plan error, check those repository settings. GitHub Pages sites are publicly reachable even if the source repository is private; don't publish sensitive information in the static app.

The online version is static hosting only. The login and roles run in the browser; workspace records are saved to local browser storage, and PDFs/MP4s to that browser's IndexedDB. They do not sync to a shared account or database. Admin/Superuser permissions in the current offline app are not a secure server-side access-control system. Do not use this deployment to protect sensitive trainee information or confidential media. Real multi-user access across devices requires a server-backed authentication system and database.

## Development workflow

The code committed to this GitHub repository is the development record. Code updates should be committed to this repository and the Actions workflow rebuilds the downloadable package after each push to `main`.

The workflow packages the uploaded standalone HTML. It does not deploy a hosted web app.

## Scope

This is an offline/local-first app. It does not automatically synchronize local records with a cloud database. Any future online sync needs an explicitly configured backend; GitHub repository commits track source code only.