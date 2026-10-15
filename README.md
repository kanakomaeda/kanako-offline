# Kanako Progress Hub — Offline

A standalone, offline-capable version of Kanako Progress Hub.

## Use it

1. Download `index.html` from the repository (or use the packaged ZIP from the Actions artifacts).
2. Open it in Chrome or Edge.
3. Use the same browser profile for continued local work. Records and PDF/MP4 evidence files are stored locally in that browser/device.
4. Keep backups and download important evidence files separately.

## Local data and privacy

- Local records are not uploaded to a server.
- PDF/MP4 evidence files are stored in the browser's IndexedDB when using the supported File Library upload flow.
- The JSON export contains record metadata, not the original PDF/MP4 binary files. Use each file's Download action for a separate copy.
- Do not clear the browser's site data if you need to preserve local files.
- Do not commit personal records, secrets, or QA evidence to this repository.

## Development

The source of truth is the code committed to this GitHub repository. Each source-code change should be committed here. GitHub Actions builds a downloadable package on every push to the default branch.

## Scope

This is an offline/local-first app. It does not automatically synchronize local records with a cloud database. Any future online sync needs an explicitly configured backend; GitHub repository commits only track source code.