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

## Local data and privacy

- Local records are not uploaded to a server.
- PDF/MP4 evidence files are stored in the browser's IndexedDB when using the supported File Library upload flow.
- The JSON export contains record metadata, not the original PDF/MP4 binary files. Use each file's Download action for a separate copy.
- Do not clear the browser's site data if you need to preserve local files.
- Do not commit personal records, secrets, or QA evidence to this repository.

## Development workflow

The code committed to this GitHub repository is the development record. Code updates should be committed to this repository and the Actions workflow rebuilds the downloadable package after each push to `main`.

The workflow packages the uploaded standalone HTML. It does not deploy a hosted web app.

## Scope

This is an offline/local-first app. It does not automatically synchronize local records with a cloud database. Any future online sync needs an explicitly configured backend; GitHub repository commits track source code only.