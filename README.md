# Kanako Progress Hub

Kanako Progress Hub is hosted at:

https://kanakomaeda.github.io/kanako-offline/

## Deployment

The GitHub Actions workflow in `.github/workflows/deploy-pages.yml` validates and publishes the root `index.html` file to GitHub Pages whenever `index.html` or the workflow changes on `main`.

GitHub Pages must be enabled for this repository with **Settings → Pages → Build and deployment → Source → GitHub Actions**.

## Backend

The hosted frontend connects to the existing Supabase project for authentication, shared workspace records, and private PDF/MP4 evidence storage. The Supabase Edge Function is `kanako-api`.

The browser stores its session and registered device key locally. Access from another browser or device may require the existing Superuser device-approval process. Keep the Superuser credentials and device approval process secure.

## Data safety

Do not commit trainee records, QA evidence, passwords, service-role keys, or other confidential data to this repository. The public website source contains only the frontend and its public Supabase client configuration. Private records and evidence files belong in the authenticated backend.

## Main application source

The deployed application is `index.html`. Keep the workflow pointed at this file so the deployed site includes the current application features.
