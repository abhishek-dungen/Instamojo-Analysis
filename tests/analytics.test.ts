import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalDatabase,
  buildHistoricalSummaryFromDatabase,
} from "../src/lib/analytics";
import type { StoredPayment } from "../src/lib/dashboard-data";

function makePayment(
  overrides: Partial<StoredPayment> & Pick<StoredPayment, "paymentId" | "classification" | "createdAt" | "webinarDate">,
): StoredPayment {
  return {
    paymentId: overrides.paymentId,
    requestId: overrides.requestId ?? null,
    purpose: overrides.purpose ?? "Test purpose",
    amount: overrides.amount ?? 99,
    createdAt: overrides.createdAt,
    localCreatedAt: overrides.localCreatedAt ?? "01 Jan 2026, 10:00 AM",
    buyerName: overrides.buyerName ?? "",
    buyerEmail: overrides.buyerEmail ?? "",
    buyerPhone: overrides.buyerPhone ?? "",
    status: overrides.status ?? "Credit",
    classification: overrides.classification,
    webinarDate: overrides.webinarDate,
    requestCreatedAt: overrides.requestCreatedAt ?? null,
    sourceGateway: overrides.sourceGateway ?? "combined",
    sourceOrderId: overrides.sourceOrderId ?? null,
  };
}

test("historical summary matches the unique-person database buckets", () => {
  const payments: StoredPayment[] = [
    makePayment({
      paymentId: "webinar-1",
      classification: "webinar_only",
      createdAt: "2026-05-01T10:00:00+05:30",
      webinarDate: "2026-05-03",
      buyerPhone: "9999990001",
      buyerName: "Webinar Only",
    }),
    makePayment({
      paymentId: "bundle-1",
      classification: "bundle_only",
      createdAt: "2026-05-01T11:00:00+05:30",
      webinarDate: "2026-05-03",
      buyerPhone: "9999990002",
      buyerName: "Bundle Only",
    }),
    makePayment({
      paymentId: "combo-webinar",
      classification: "webinar_only",
      createdAt: "2026-05-01T12:00:00+05:30",
      webinarDate: "2026-05-03",
      buyerPhone: "9999990003",
      buyerName: "Combo Person",
    }),
    makePayment({
      paymentId: "combo-bundle",
      classification: "bundle_only",
      createdAt: "2026-05-01T13:00:00+05:30",
      webinarDate: "2026-05-03",
      buyerPhone: "9999990003",
      buyerName: "Combo Person",
    }),
    makePayment({
      paymentId: "course-1",
      classification: "course",
      amount: 1500,
      createdAt: "2026-05-01T14:00:00+05:30",
      webinarDate: "2026-05-03",
      buyerEmail: "course@example.com",
      buyerName: "Course Buyer",
    }),
  ];

  const database = buildCanonicalDatabase(payments);
  const summary = buildHistoricalSummaryFromDatabase(database, 1);

  assert.equal(summary.webinarRegistrations, database.webinarOnly.length);
  assert.equal(summary.bundleRegistrations, database.bundleBuyers.length);
  assert.equal(summary.coursePurchases, database.courseBuyers.length);
  assert.equal(database.webinarOnly.length, 1);
  assert.equal(database.bundleBuyers.length, 2);
  assert.equal(database.courseBuyers.length, 1);
  assert.match(database.bundleBuyers[0].createdAt, /2026-05-01T13:00:00/);
  assert.equal(
    database.webinarOnly.some((row) => row.paymentId === "combo-webinar"),
    false,
  );
});
