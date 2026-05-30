# Payment Gateway Analysis

This project backs up webinar payment data into Firebase Firestore and publishes a GitHub Pages dashboard that merges all supported gateways into one deduplicated reporting view:

- `Instamojo`
- `PayU`
- `Cashfree`

The frontend now shows one unified dataset, while the sync pipeline still pulls each source separately and removes overlaps before reporting.

## Reporting logic

- Webinar registrations use a Sunday `6:30 PM IST` cutoff.
- `99`-range webinar-only payments count as webinar registrations when the purpose contains `masterclass`.
- `99`-range bundle-only payments count as bundle registrations when the purpose contains `resource bundle`.
- `198`-range combo payments count as both webinar and bundle registrations.
- Payments `>= 1500` count as course purchases.
- Live course conversions are Sunday `7:00 PM` to `11:59 PM IST`.
- Webinar weeks between `November 15` and `January 10` remain excluded.
- Duplicate Instamojo and Cashfree events are counted only once, with the Instamojo record preferred whenever both sources represent the same payment.

## Local commands

```bash
npm install
npm run sync
npm run build
npm run dev
```

To generate the dashboard snapshot without Firestore writes:

```bash
SKIP_FIREBASE=1 npm run sync
```

## Required environment variables

```bash
INSTAMOJO_API_KEY=
INSTAMOJO_AUTH_TOKEN=
INSTAMOJO_PRIVATE_SALT=
PAYU_KEY=
PAYU_SALT=
PAYU_CLIENT_ID=
PAYU_CLIENT_SECRET=
PAYU_MERCHANT_ID=
CASHFREE_CLIENT_ID=
CASHFREE_CLIENT_SECRET=
FIREBASE_SERVICE_ACCOUNT_PATH=
```

You can also use `FIREBASE_SERVICE_ACCOUNT_JSON` instead of `FIREBASE_SERVICE_ACCOUNT_PATH`.

## Firestore collections

- `instamojoPaymentRequests`
- `instamojoPayments`
- `instamojoWebinarReports`
- `payuPayments`
- `payuWebinarReports`
- `cashfreePayments`
- `cashfreeWebinarReports`
- `dashboardMetadata/latest`
- `dashboardMetadata/instamojo`
- `dashboardMetadata/payu`
- `dashboardMetadata/cashfree`

## GitHub Actions secrets

- `INSTAMOJO_API_KEY`
- `INSTAMOJO_AUTH_TOKEN`
- `INSTAMOJO_PRIVATE_SALT`
- `PAYU_KEY`
- `PAYU_SALT`
- `PAYU_CLIENT_ID`
- `PAYU_CLIENT_SECRET`
- `PAYU_MERCHANT_ID`
- `CASHFREE_CLIENT_ID`
- `CASHFREE_CLIENT_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

## Provider notes

- `PayU` legacy transaction history allows only `7-day` windows and currently rate-limits aggressive backfills. The code surfaces that provider error per gateway instead of breaking the whole dashboard.
- `Cashfree` reconciliation works only with recent history and `30-day` windows per request. The code now chunks that range automatically.

## Deployment

Pushing to `main` deploys the already-committed snapshot to GitHub Pages.

Scheduled and manual workflow runs:

1. pull fresh gateway data
2. back up raw payments to Firestore
3. rebuild `public/dashboard-data.json`
4. build the Vite app
5. deploy the static dashboard to GitHub Pages
