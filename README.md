# Instamojo Analysis

This project backs up Instamojo payment data into Firebase Firestore and publishes a GitHub Pages dashboard for webinar reporting.

## What it tracks

- Weekly webinar registrations using a Sunday 6:30 PM IST cutoff
- `99` webinar-only registrations
- `99` bundle-only purchases when the purpose contains `Resource Bundle`
- `198` combo registrations that count as both webinar and bundle
- Course purchases above `1500`
- Live webinar course conversions from Sunday 7:00 PM to 11:59 PM IST
- Extended course conversions after the live webinar window

## Stack

- React + Vite frontend
- GitHub Pages for hosting
- Firebase Firestore for raw backup and weekly report storage
- GitHub Actions for scheduled Instamojo sync and deployment

## Local commands

```bash
npm install
npm run sync
npm run build
npm run dev
```

## Required environment variables

```bash
INSTAMOJO_API_KEY=
INSTAMOJO_AUTH_TOKEN=
INSTAMOJO_PRIVATE_SALT=
FIREBASE_SERVICE_ACCOUNT_PATH=
```

You can also use `FIREBASE_SERVICE_ACCOUNT_JSON` instead of `FIREBASE_SERVICE_ACCOUNT_PATH`.

## Firestore collections

- `instamojoPaymentRequests`
- `instamojoPayments`
- `webinarReports`
- `dashboardMetadata/latest`

## GitHub Actions secrets

- `INSTAMOJO_API_KEY`
- `INSTAMOJO_AUTH_TOKEN`
- `INSTAMOJO_PRIVATE_SALT`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

## Deployment

Pushing to `main` triggers the sync-and-deploy workflow. The workflow:

1. Pulls the latest Instamojo data
2. Stores raw and derived data in Firestore
3. Rebuilds `public/dashboard-data.json`
4. Builds the Vite app
5. Deploys the static dashboard to GitHub Pages
