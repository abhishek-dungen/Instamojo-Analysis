import { addDays, format, previousSunday, startOfDay, subDays } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import type {
  DashboardData,
  DatabaseCourseRow,
  DatabasePersonRow,
  DatabaseSnapshot,
  GatewayId,
  PaymentClassification,
  StoredPayment,
  WeeklyMetrics,
} from "./dashboard-data";

export const TIME_ZONE = "Asia/Kolkata";
export const EXCLUDED_WEBINAR_WEEKS = new Set<string>();

const GATEWAY_LABELS: Record<GatewayId, string> = {
  instamojo: "Instamojo",
  payu: "PayU",
  cashfree: "Cashfree",
  combined: "All Gateways Unique",
};

type RawRequest = {
  id: string;
  phone: string | null;
  email: string | null;
  buyer_name: string | null;
  amount: string;
  purpose: string;
  status: string;
  longurl: string | null;
  created_at: string;
  modified_at: string;
};

type RawPayment = {
  payment_id: string;
  status: string;
  amount: string;
  buyer_name: string | null;
  buyer_phone: string | null;
  buyer_email: string | null;
  payment_request: string | null;
  created_at: string;
};

function asLocal(date: Date) {
  return toZonedTime(date, TIME_ZONE);
}

export function normalizePhone(value: string) {
  return value.replace(/\D/g, "").slice(-10);
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function getPersonIdentityKey(payment: {
  buyerPhone: string;
  buyerEmail: string;
  buyerName: string;
  paymentId: string;
}) {
  const phone = normalizePhone(payment.buyerPhone);
  if (phone) return `phone:${phone}`;

  const email = normalizeEmail(payment.buyerEmail);
  if (email) return `email:${email}`;

  const name = normalizeName(payment.buyerName);
  if (name) return `name:${name}`;

  return `payment:${payment.paymentId}`;
}

function parseLocalDate(dateText: string) {
  return makeLocalDate(dateText, 0, 0);
}

function makeLocalDate(dateText: string, hour: number, minute: number) {
  return fromZonedTime(
    `${dateText}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    TIME_ZONE,
  );
}

function toReportDate(createdAt: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
    .format(new Date(createdAt))
    .replace(/\//g, "-");
}

export function isExcludedWebinarWeek(webinarDate: string) {
  if (EXCLUDED_WEBINAR_WEEKS.has(webinarDate)) {
    return true;
  }

  const monthDay = webinarDate.slice(5);
  return monthDay >= "11-15" || monthDay <= "01-10";
}

function webinarSundayForRegistration(date: Date) {
  const local = asLocal(date);
  const sunday = previousSunday(addDays(startOfDay(local), 1));
  const sundayDate = format(sunday, "yyyy-MM-dd");
  const cutoff = makeLocalDate(sundayDate, 18, 30);
  return date <= cutoff ? sundayDate : format(addDays(sunday, 7), "yyyy-MM-dd");
}

function webinarSundayForCourse(date: Date) {
  const local = asLocal(date);
  const sameWeekSunday = previousSunday(addDays(startOfDay(local), 1));
  const sundayDate = format(sameWeekSunday, "yyyy-MM-dd");
  const liveStart = makeLocalDate(sundayDate, 19, 0);
  return date >= liveStart
    ? sundayDate
    : format(subDays(sameWeekSunday, 7), "yyyy-MM-dd");
}

export function resolveWebinarDateForClassification(
  date: Date,
  classification: PaymentClassification,
) {
  return classification === "course"
    ? webinarSundayForCourse(date)
    : webinarSundayForRegistration(date);
}

export function classifyPayment(
  amount: number,
  purpose: string,
): PaymentClassification {
  const normalized = purpose.toLowerCase();

  if (amount >= 1500) return "course";
  if (amount >= 190 && amount <= 250) return "combo";
  if (amount >= 90 && amount <= 110 && normalized.includes("resource bundle"))
    return "bundle_only";
  if (amount >= 90 && amount <= 110 && normalized.includes("masterclass"))
    return "webinar_only";
  return "other";
}

export function normalizePayments(
  paymentRequests: RawRequest[],
  payments: RawPayment[],
) {
  const requestIndex = new Map(
    paymentRequests.map((request) => [request.id, request]),
  );

  return payments
    .map((payment) => {
      const requestId =
        payment.payment_request?.match(/payment-requests\/([^/]+)\//)?.[1] ??
        null;
      const request = requestId ? requestIndex.get(requestId) : undefined;
      const amount = Number.parseFloat(payment.amount);
      const purpose = request?.purpose ?? "Unknown purpose";
      const classification = classifyPayment(amount, purpose);
      const createdAt = payment.created_at;
      const createdDate = new Date(createdAt);
      const webinarDate = resolveWebinarDateForClassification(
        createdDate,
        classification,
      );

      return {
        paymentId: payment.payment_id,
        requestId,
        purpose,
        amount,
        createdAt,
        localCreatedAt: formatInTimeZone(
          createdAt,
          TIME_ZONE,
          "dd MMM yyyy, hh:mm a",
        ),
        buyerName: payment.buyer_name ?? request?.buyer_name ?? "",
        buyerEmail: payment.buyer_email ?? request?.email ?? "",
        buyerPhone: payment.buyer_phone ?? request?.phone ?? "",
        status: payment.status,
        classification,
        webinarDate,
        requestCreatedAt: request?.created_at ?? null,
        sourceGateway: "instamojo",
        sourceOrderId: null,
      } satisfies StoredPayment;
    })
    .filter((payment) => !isExcludedWebinarWeek(payment.webinarDate));
}

function registrationWindow(webinarDate: string) {
  const weekStart = makeLocalDate(
    format(subDays(parseLocalDate(webinarDate), 7), "yyyy-MM-dd"),
    18,
    31,
  );
  const weekEnd = makeLocalDate(webinarDate, 18, 30);
  return `${formatInTimeZone(weekStart, TIME_ZONE, "dd MMM, hh:mm a")} to ${formatInTimeZone(weekEnd, TIME_ZONE, "dd MMM, hh:mm a")} IST`;
}

function isLiveCoursePayment(payment: StoredPayment) {
  const liveStart = makeLocalDate(payment.webinarDate, 19, 0);
  const liveEnd = makeLocalDate(payment.webinarDate, 23, 59);
  const createdAt = new Date(payment.createdAt);
  return createdAt >= liveStart && createdAt <= liveEnd;
}

function buildWeeklyMetrics(successful: StoredPayment[]) {
  const weeklyMap = new Map<string, WeeklyMetrics>();

  for (const payment of successful) {
    const current =
      weeklyMap.get(payment.webinarDate) ??
      ({
        webinarDate: payment.webinarDate,
        label: `Webinar ${format(parseLocalDate(payment.webinarDate), "dd MMM yyyy")}`,
        registrationWindow: registrationWindow(payment.webinarDate),
        registrations: 0,
        webinarOnlyRegistrations: 0,
        comboRegistrations: 0,
        bundleRegistrations: 0,
        bundleOnlyRegistrations: 0,
        coursePurchasesLive: 0,
        coursePurchasesExtended: 0,
        courseRevenueLive: 0,
        courseRevenueExtended: 0,
        registrationRevenue: 0,
        totalRevenue: 0,
        topCoursePurposes: [],
        recentPayments: [],
      } satisfies WeeklyMetrics);

    current.totalRevenue += payment.amount;

    if (payment.classification === "webinar_only") {
      current.registrations += 1;
      current.webinarOnlyRegistrations += 1;
      current.registrationRevenue += payment.amount;
    }

    if (payment.classification === "bundle_only") {
      current.bundleRegistrations += 1;
      current.bundleOnlyRegistrations += 1;
      current.registrationRevenue += payment.amount;
    }

    if (payment.classification === "combo") {
      current.registrations += 1;
      current.bundleRegistrations += 1;
      current.comboRegistrations += 1;
      current.registrationRevenue += payment.amount;
    }

    if (payment.classification === "course") {
      if (isLiveCoursePayment(payment)) {
        current.coursePurchasesLive += 1;
        current.courseRevenueLive += payment.amount;
      } else {
        current.coursePurchasesExtended += 1;
        current.courseRevenueExtended += payment.amount;
      }
    }

    if (current.recentPayments.length < 12) {
      current.recentPayments.push({
        paymentId: payment.paymentId,
        localCreatedAt: payment.localCreatedAt,
        amount: payment.amount,
        purpose: payment.purpose,
        classification: payment.classification,
        buyerName: payment.buyerName,
      });
    }

    weeklyMap.set(payment.webinarDate, current);
  }

  const courseBreakdown = new Map<
    string,
    Map<string, { count: number; revenue: number }>
  >();
  for (const payment of successful.filter(
    (entry) => entry.classification === "course",
  )) {
    const weekMap = courseBreakdown.get(payment.webinarDate) ?? new Map();
    const current = weekMap.get(payment.purpose) ?? { count: 0, revenue: 0 };
    current.count += 1;
    current.revenue += payment.amount;
    weekMap.set(payment.purpose, current);
    courseBreakdown.set(payment.webinarDate, weekMap);
  }

  return Array.from(weeklyMap.values())
    .sort((left, right) => right.webinarDate.localeCompare(left.webinarDate))
    .map((entry) => ({
      ...entry,
      topCoursePurposes: Array.from(
        courseBreakdown.get(entry.webinarDate)?.entries() ?? [],
      )
        .map(([purpose, value]) => ({ purpose, ...value }))
        .sort((left, right) => right.revenue - left.revenue)
        .slice(0, 5),
    }));
}

type GroupedPersonPayments = {
  webinarOnly?: StoredPayment;
  bundle?: StoredPayment;
  course?: StoredPayment;
};

export function buildCanonicalDatabase(
  payments: StoredPayment[],
): DatabaseSnapshot {
  const sortedPayments = [...payments].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const grouped = new Map<string, GroupedPersonPayments>();

  for (const payment of sortedPayments) {
    const key = getPersonIdentityKey(payment);
    const current = grouped.get(key) ?? {};

    if (payment.classification === "webinar_only" && !current.webinarOnly) {
      current.webinarOnly = payment;
    }

    if (
      (payment.classification === "bundle_only" ||
        payment.classification === "combo") &&
      !current.bundle
    ) {
      current.bundle = payment;
    }

    if (payment.classification === "course" && !current.course) {
      current.course = payment;
    }

    grouped.set(key, current);
  }

  const webinarOnly: DatabasePersonRow[] = [];
  const bundleBuyers: DatabasePersonRow[] = [];
  const courseBuyers: DatabaseCourseRow[] = [];

  for (const entry of grouped.values()) {
    if (entry.bundle) {
      bundleBuyers.push({
        paymentId: entry.bundle.paymentId,
        purpose: entry.bundle.purpose,
        name: entry.bundle.buyerName,
        phone: entry.bundle.buyerPhone,
        email: entry.bundle.buyerEmail,
        date: toReportDate(entry.bundle.createdAt),
        createdAt: entry.bundle.createdAt,
      });
    }

    if (entry.webinarOnly && !entry.bundle) {
      webinarOnly.push({
        paymentId: entry.webinarOnly.paymentId,
        purpose: entry.webinarOnly.purpose,
        name: entry.webinarOnly.buyerName,
        phone: entry.webinarOnly.buyerPhone,
        email: entry.webinarOnly.buyerEmail,
        date: toReportDate(entry.webinarOnly.createdAt),
        createdAt: entry.webinarOnly.createdAt,
      });
    }

    if (entry.course) {
      courseBuyers.push({
        paymentId: entry.course.paymentId,
        purpose: entry.course.purpose,
        name: entry.course.buyerName,
        phone: entry.course.buyerPhone,
        email: entry.course.buyerEmail,
        date: toReportDate(entry.course.createdAt),
        createdAt: entry.course.createdAt,
        amount: entry.course.amount,
      });
    }
  }

  const sortByCreatedAtDesc = <T extends { createdAt: string }>(
    left: T,
    right: T,
  ) => right.createdAt.localeCompare(left.createdAt);

  webinarOnly.sort(sortByCreatedAtDesc);
  bundleBuyers.sort(sortByCreatedAtDesc);
  courseBuyers.sort(sortByCreatedAtDesc);

  return {
    webinarOnly,
    bundleBuyers,
    courseBuyers,
  };
}

export function buildHistoricalSummaryFromDatabase(
  database: DatabaseSnapshot,
  webinarWeeksCount: number,
) {
  const webinarRegistrations = database.webinarOnly.length;
  const bundleRegistrations = database.bundleBuyers.length;
  const coursePurchases = database.courseBuyers.length;

  return {
    webinarRegistrations,
    webinarWeeksCount,
    bundleRegistrations,
    coursePurchases,
    bundleConversionRate:
      webinarRegistrations === 0
        ? 0
        : (bundleRegistrations / webinarRegistrations) * 100,
    courseConversionRate:
      webinarRegistrations === 0
        ? 0
        : (coursePurchases / webinarRegistrations) * 100,
  };
}

function summarizePurposes(
  successful: StoredPayment[],
  classifications: PaymentClassification[],
) {
  const counts = new Map<string, number>();

  for (const payment of successful.filter((entry) =>
    classifications.includes(entry.classification),
  )) {
    counts.set(payment.purpose, (counts.get(payment.purpose) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([purpose, count]) => ({ purpose, count }))
    .sort((left, right) => right.count - left.count);
}

export function emptyDashboardData(
  gateway: GatewayId,
  message: string,
  generatedAt = new Date().toISOString(),
): DashboardData {
  return {
    gateway,
    label: GATEWAY_LABELS[gateway],
    generatedAt,
    timezone: TIME_ZONE,
    source: {
      paymentRequestCount: 0,
      paymentCount: 0,
      successfulPaymentCount: 0,
    },
    syncStatus: {
      state: "error",
      message,
    },
    totals: {
      registrations: 0,
      bundleRegistrations: 0,
      coursePurchases: 0,
      totalRevenue: 0,
    },
    historicalSummary: {
      webinarRegistrations: 0,
      webinarWeeksCount: 0,
      bundleRegistrations: 0,
      coursePurchases: 0,
      bundleConversionRate: 0,
      courseConversionRate: 0,
    },
    classificationSources: {
      webinar: [],
      bundle: [],
      course: [],
    },
    weekly: [],
  };
}

export function buildDashboardDataFromStoredPayments(
  gateway: GatewayId,
  storedPayments: StoredPayment[],
  source: DashboardData["source"],
  generatedAt = new Date().toISOString(),
): DashboardData {
  const successful = storedPayments
    .filter((payment) => payment.status === "Credit")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const weekly = buildWeeklyMetrics(successful);
  const database = buildCanonicalDatabase(successful);
  const historicalSummary = buildHistoricalSummaryFromDatabase(
    database,
    weekly.length,
  );

  return {
    gateway,
    label: GATEWAY_LABELS[gateway],
    generatedAt,
    timezone: TIME_ZONE,
    source,
    syncStatus: {
      state: "ready",
      message: null,
    },
    totals: {
      registrations: historicalSummary.webinarRegistrations,
      bundleRegistrations: historicalSummary.bundleRegistrations,
      coursePurchases: historicalSummary.coursePurchases,
      totalRevenue: weekly.reduce((sum, entry) => sum + entry.totalRevenue, 0),
    },
    historicalSummary,
    classificationSources: {
      webinar: summarizePurposes(successful, ["webinar_only"]),
      bundle: summarizePurposes(successful, ["bundle_only", "combo"]),
      course: summarizePurposes(successful, ["course"]),
    },
    weekly,
  };
}

export function buildDashboardData(
  paymentRequests: RawRequest[],
  payments: RawPayment[],
) {
  const normalized = normalizePayments(paymentRequests, payments);

  return buildDashboardDataFromStoredPayments("instamojo", normalized, {
    paymentRequestCount: paymentRequests.length,
    paymentCount: payments.length,
    successfulPaymentCount: normalized.filter(
      (payment) => payment.status === "Credit",
    ).length,
  });
}
