import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import crypto from 'node:crypto'
import admin from 'firebase-admin'
import {
  buildDashboardData,
  buildDashboardDataFromStoredPayments,
  classifyPayment,
  emptyDashboardData,
  isExcludedWebinarWeek,
  normalizePayments,
  resolveWebinarDateForClassification,
  TIME_ZONE,
} from '../src/lib/analytics'
import type {
  DashboardSnapshot,
  DatabaseCourseRow,
  DatabasePersonRow,
  GatewayId,
  StoredPayment,
} from '../src/lib/dashboard-data'

type InstamojoPaymentRequest = {
  id: string
  phone: string | null
  email: string | null
  buyer_name: string | null
  amount: string
  purpose: string
  status: string
  longurl: string | null
  created_at: string
  modified_at: string
}

type InstamojoPayment = {
  payment_id: string
  status: string
  amount: string
  buyer_name: string | null
  buyer_phone: string | null
  buyer_email: string | null
  payment_request: string | null
  created_at: string
}

type GatewaySyncResult = {
  dashboard: DashboardSnapshot['gateways'][GatewayId]
  payments: StoredPayment[]
  rawRequestDocs?: Array<{ id: string; data: Record<string, unknown> }>
  backfillState?: Record<string, unknown>
}

const repoRoot = path.resolve(import.meta.dirname, '..')
const publicDir = path.join(repoRoot, 'public')
const INSTAMOJO_API_BASE = 'https://www.instamojo.com/api/1.1'
const PAYU_TOKEN_URL = 'https://accounts.payu.in/oauth/token'
const PAYU_PAYMENT_LINKS_BASE = 'https://oneapi.payu.in/payment-links'
const PAYU_LEGACY_URL = 'https://info.payu.in/merchant/postservice.php?form=2'
const DEFAULT_CASHFREE_RECON_URL = 'https://api.cashfree.com/pg/recon'
const HISTORY_START = '2018-01-01'
const PAYU_LEGACY_WINDOW_DAYS = 7
const PAYU_LEGACY_PAUSE_MS = 3200
const PAYU_LEGACY_RATE_LIMIT_BACKOFF_MS = 15000
const PAYU_LEGACY_MAX_RATE_LIMIT_RETRIES = 3
const PAYU_LEGACY_RECENT_REFRESH_DAYS = 60
const CASHFREE_WINDOW_DAYS = 30
const CASHFREE_MAX_LOOKBACK_DAYS = 700

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || undefined
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, '').slice(-10)
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

function formatGatewaySyncMessage(gateway: GatewayId, error: unknown) {
  const message = error instanceof Error ? error.message : `Unknown ${gateway} sync error`

  if (gateway === 'payu') {
    if (message.includes('Requests limit reached')) {
      return {
        state: 'pending' as const,
        message:
          'PayU is temporarily rate-limiting the historical backfill. The dashboard will retry automatically on the next hourly sync.',
      }
    }

    if (message.includes('merchant ID is required')) {
      return {
        state: 'pending' as const,
        message:
          'PayU needs the merchant ID for the newer API path. The dashboard will keep retrying, but the faster full-history sync depends on that value.',
      }
    }
  }

  if (gateway === 'cashfree' && message.includes('cannot be more than')) {
    return {
      state: 'pending' as const,
      message:
        'Cashfree restricts how much history can be pulled per request. The dashboard is retrying within the provider limits.',
    }
  }

  return {
    state: 'error' as const,
    message,
  }
}

function toLocalText(createdAt: string) {
  return new Date(createdAt).toLocaleString('en-IN', { timeZone: TIME_ZONE })
}

function buildStoredPayment(input: {
  paymentId: string
  requestId?: string | null
  purpose: string
  amount: number
  createdAt: string
  buyerName?: string | null
  buyerEmail?: string | null
  buyerPhone?: string | null
  status: string
  requestCreatedAt?: string | null
  sourceGateway?: GatewayId
  sourceOrderId?: string | null
}) {
  const classification = classifyPayment(input.amount, input.purpose)
  const webinarDate = resolveWebinarDateForClassification(new Date(input.createdAt), classification)

  return {
    paymentId: input.paymentId,
    requestId: input.requestId ?? null,
    purpose: input.purpose,
    amount: input.amount,
    createdAt: input.createdAt,
    localCreatedAt: toLocalText(input.createdAt),
    buyerName: input.buyerName ?? '',
    buyerEmail: input.buyerEmail ?? '',
    buyerPhone: input.buyerPhone ?? '',
    status: input.status,
    classification,
    webinarDate,
    requestCreatedAt: input.requestCreatedAt ?? null,
    sourceGateway: input.sourceGateway,
    sourceOrderId: input.sourceOrderId ?? null,
  } satisfies StoredPayment
}

function filterExcluded(payments: StoredPayment[]) {
  return payments.filter((payment) => !isExcludedWebinarWeek(payment.webinarDate))
}

function scoreDuplicateCandidate(left: StoredPayment, right: StoredPayment) {
  const leftPhone = normalizePhone(left.buyerPhone)
  const rightPhone = normalizePhone(right.buyerPhone)
  const leftEmail = normalizeEmail(left.buyerEmail)
  const rightEmail = normalizeEmail(right.buyerEmail)
  const leftName = normalizeName(left.buyerName)
  const rightName = normalizeName(right.buyerName)
  const timeDiffMs = Math.abs(new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())

  const identityMatch =
    (leftPhone && rightPhone && leftPhone === rightPhone) ||
    (leftEmail && rightEmail && leftEmail === rightEmail) ||
    (leftName && rightName && leftName === rightName)

  return {
    identityMatch,
    amountMatch: left.amount === right.amount,
    classificationMatch: left.classification === right.classification,
    timeDiffMs,
  }
}

function isDeterministicMirrorDuplicate(candidate: StoredPayment, existing: StoredPayment) {
  if (candidate.sourceGateway !== 'cashfree' || existing.sourceGateway !== 'instamojo') {
    return false
  }

  const { identityMatch, amountMatch, timeDiffMs } = scoreDuplicateCandidate(candidate, existing)
  return candidate.purpose.startsWith('MOJ') && identityMatch && amountMatch && timeDiffMs <= 10 * 60 * 1000
}

function isGenericCrossGatewayDuplicate(candidate: StoredPayment, existing: StoredPayment) {
  if (candidate.sourceGateway === existing.sourceGateway) {
    return false
  }

  const { identityMatch, amountMatch, classificationMatch, timeDiffMs } = scoreDuplicateCandidate(
    candidate,
    existing,
  )

  return identityMatch && amountMatch && classificationMatch && timeDiffMs <= 2 * 60 * 1000
}

function dedupeCombinedPayments(payments: StoredPayment[]) {
  const sorted = [...payments].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  )
  const unique: StoredPayment[] = []
  let duplicateCount = 0
  let deterministicMirrorCount = 0
  let heuristicDuplicateCount = 0

  for (const payment of sorted) {
    const match = unique.find((existing) => {
      if (isDeterministicMirrorDuplicate(payment, existing)) return true
      if (isDeterministicMirrorDuplicate(existing, payment)) return true
      return isGenericCrossGatewayDuplicate(payment, existing)
    })

    if (match) {
      duplicateCount += 1
      if (
        isDeterministicMirrorDuplicate(payment, match) ||
        isDeterministicMirrorDuplicate(match, payment)
      ) {
        deterministicMirrorCount += 1
        if (payment.sourceGateway === 'instamojo' && match.sourceGateway === 'cashfree') {
          const index = unique.findIndex((entry) => entry.paymentId === match.paymentId)
          if (index >= 0) {
            unique[index] = payment
          }
        }
      } else {
        heuristicDuplicateCount += 1
      }
      continue
    }

    unique.push(payment)
  }

  return {
    unique,
    duplicateCount,
    deterministicMirrorCount,
    heuristicDuplicateCount,
  }
}

async function readStoredPayments(
  firestore: FirebaseFirestore.Firestore,
  collectionName: string,
) {
  const snapshot = await firestore.collection(collectionName).get()
  return snapshot.docs.map((doc) => doc.data()) as StoredPayment[]
}

async function readBackfillState(
  firestore: FirebaseFirestore.Firestore,
  documentId: string,
) {
  const snapshot = await firestore.collection('dashboardMetadata').doc(documentId).get()
  return snapshot.exists ? (snapshot.data() ?? null) : null
}

function initFirebase() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH

  if (!serviceAccountJson && !serviceAccountPath) {
    throw new Error(
      'Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH before running the sync.',
    )
  }

  const serviceAccount = serviceAccountJson
    ? JSON.parse(serviceAccountJson)
    : JSON.parse(readFileSync(serviceAccountPath!, 'utf8'))

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    })
  }

  return admin.firestore()
}

async function writeCollection(
  firestore: FirebaseFirestore.Firestore,
  collectionName: string,
  docs: Array<{ id: string; data: Record<string, unknown> }>,
) {
  for (let index = 0; index < docs.length; index += 400) {
    const slice = docs.slice(index, index + 400)
    const batch = firestore.batch()
    for (const doc of slice) {
      batch.set(firestore.collection(collectionName).doc(doc.id), doc.data, { merge: true })
    }
    await batch.commit()
  }
}

async function writeMissingCollection(
  firestore: FirebaseFirestore.Firestore,
  collectionName: string,
  docs: Array<{ id: string; data: Record<string, unknown> }>,
) {
  if (docs.length === 0) return

  const existing = await firestore.collection(collectionName).get()
  const existingIds = new Set(existing.docs.map((doc) => doc.id))
  const missing = docs.filter((doc) => !existingIds.has(doc.id))
  await writeCollection(firestore, collectionName, missing)
}

async function clearCollection(
  firestore: FirebaseFirestore.Firestore,
  collectionName: string,
) {
  while (true) {
    const snapshot = await firestore.collection(collectionName).limit(400).get()
    if (snapshot.empty) break

    const batch = firestore.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
}

function toReportDate(createdAt: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
    .format(new Date(createdAt))
    .replace(/\//g, '-')
}

function identityKey(payment: StoredPayment) {
  const phone = normalizePhone(payment.buyerPhone)
  if (phone) return `phone:${phone}`

  const email = normalizeEmail(payment.buyerEmail)
  if (email) return `email:${email}`

  const name = normalizeName(payment.buyerName)
  if (name) return `name:${name}`

  return `payment:${payment.paymentId}`
}

function toDatabasePersonRow(payment: StoredPayment): DatabasePersonRow {
  return {
    name: payment.buyerName,
    phone: payment.buyerPhone,
    email: payment.buyerEmail,
    date: toReportDate(payment.createdAt),
    createdAt: payment.createdAt,
  }
}

function toDatabaseCourseRow(payment: StoredPayment): DatabaseCourseRow {
  return {
    ...toDatabasePersonRow(payment),
    amount: payment.amount,
  }
}

function buildDatabaseSnapshot(payments: StoredPayment[]) {
  const successful = [...payments]
    .filter((payment) => payment.status === 'Credit')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  const bundleIdentities = new Set<string>()
  const courseIdentities = new Set<string>()

  for (const payment of successful) {
    const key = identityKey(payment)
    if (payment.classification === 'bundle_only' || payment.classification === 'combo') {
      bundleIdentities.add(key)
    }
    if (payment.classification === 'course') {
      courseIdentities.add(key)
    }
  }

  const webinarOnly = new Map<string, DatabasePersonRow>()
  const bundleBuyers = new Map<string, DatabasePersonRow>()
  const courseBuyers = new Map<string, DatabaseCourseRow>()

  for (const payment of successful) {
    const key = identityKey(payment)

    if (
      payment.classification === 'webinar_only' &&
      !bundleIdentities.has(key) &&
      !courseIdentities.has(key) &&
      !webinarOnly.has(key)
    ) {
      webinarOnly.set(key, toDatabasePersonRow(payment))
    }

    if (
      (payment.classification === 'bundle_only' || payment.classification === 'combo') &&
      !bundleBuyers.has(key)
    ) {
      bundleBuyers.set(key, toDatabasePersonRow(payment))
    }

    if (payment.classification === 'course' && !courseBuyers.has(key)) {
      courseBuyers.set(key, toDatabaseCourseRow(payment))
    }
  }

  return {
    webinarOnly: Array.from(webinarOnly.values()),
    bundleBuyers: Array.from(bundleBuyers.values()),
    courseBuyers: Array.from(courseBuyers.values()),
  }
}

async function instamojoGet<T>(endpoint: string, page: number, limit = 500): Promise<T> {
  const apiKey = requiredEnv('INSTAMOJO_API_KEY')
  const authToken = requiredEnv('INSTAMOJO_AUTH_TOKEN')
  const url = new URL(`${INSTAMOJO_API_BASE}/${endpoint}/`)
  url.searchParams.set('page', String(page))
  url.searchParams.set('limit', String(limit))

  const response = await fetch(url, {
    headers: {
      'X-Api-Key': apiKey,
      'X-Auth-Token': authToken,
    },
  })

  if (!response.ok) {
    throw new Error(`Instamojo request failed for ${endpoint}: ${response.status}`)
  }

  return response.json() as Promise<T>
}

async function fetchAllInstamojoPages<T>(endpoint: string, key: string): Promise<T[]> {
  const items: T[] = []
  let page = 1
  let keepGoing = true

  while (keepGoing) {
    const payload = (await instamojoGet<Record<string, unknown>>(endpoint, page)) as Record<
      string,
      unknown
    >
    const pageItems = (payload[key] as T[]) ?? []
    items.push(...pageItems)
    keepGoing = pageItems.length === 500
    page += 1
  }

  return items
}

function normalizeInstamojoRequests(paymentRequests: InstamojoPaymentRequest[]) {
  return paymentRequests
    .map((request) => {
      const amountValue = Number.parseFloat(request.amount)
      const classification = classifyPayment(amountValue, request.purpose)
      const webinarDate = resolveWebinarDateForClassification(new Date(request.created_at), classification)

      return {
        ...request,
        amountValue,
        classification,
        webinarDate,
      }
    })
    .filter((request) => !isExcludedWebinarWeek(request.webinarDate))
}

async function syncInstamojo(generatedAt: string): Promise<GatewaySyncResult> {
  const paymentRequests = await fetchAllInstamojoPages<InstamojoPaymentRequest>(
    'payment-requests',
    'payment_requests',
  )
  const payments = await fetchAllInstamojoPages<InstamojoPayment>('payments', 'payments')
  const normalizedRequests = normalizeInstamojoRequests(paymentRequests)
  const normalizedPayments = filterExcluded(normalizePayments(paymentRequests, payments))
  const dashboard = {
    ...buildDashboardData(paymentRequests, payments),
    generatedAt,
  }

  return {
    dashboard,
    payments: normalizedPayments,
    rawRequestDocs: normalizedRequests.map((request) => ({
      id: request.id,
      data: {
        ...request,
        syncedAt: generatedAt,
      },
    })),
  }
}

function dayRangeWindows(startDate: string, endDate: Date, windowDays: number) {
  const windows: Array<{ start: string; end: string }> = []
  let cursor = new Date(`${startDate}T00:00:00+05:30`)

  while (cursor <= endDate) {
    const start = cursor
    const end = new Date(cursor)
    end.setDate(end.getDate() + windowDays - 1)
    if (end > endDate) {
      end.setTime(endDate.getTime())
    }

    windows.push({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    })

    cursor = new Date(end)
    cursor.setDate(cursor.getDate() + 1)
  }

  return windows
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function clampToHistoryStart(date: Date) {
  const historyStartDate = new Date(`${HISTORY_START}T00:00:00+05:30`)
  return date < historyStartDate ? historyStartDate : date
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getPayuAccessToken() {
  const clientId = optionalEnv('PAYU_CLIENT_ID')
  const clientSecret = optionalEnv('PAYU_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('PayU client ID and client secret are not configured.')
  }

  const response = await fetch(PAYU_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'read_payment_links',
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`PayU token request failed: ${response.status} ${message}`)
  }

  const payload = (await response.json()) as { access_token?: string }
  if (!payload.access_token) {
    throw new Error('PayU token response did not include an access token.')
  }

  return payload.access_token
}

async function fetchPayuPaymentLinksByOauth(generatedAt: string): Promise<GatewaySyncResult> {
  const merchantId = optionalEnv('PAYU_MERCHANT_ID')
  if (!merchantId) {
    throw new Error('PayU merchant ID is required for OAuth payment-link sync.')
  }

  const token = await getPayuAccessToken()
  const today = new Date()
  const links: Array<{
    invoiceNumber: string
    description?: string | null
    createDate?: string
    amount?: number
  }> = []

  for (const window of dayRangeWindows(HISTORY_START, today, 31)) {
    let pageOffset = 0
    let keepGoing = true

    while (keepGoing) {
      const url = new URL(PAYU_PAYMENT_LINKS_BASE)
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('pageOffset', String(pageOffset))
      url.searchParams.set('orderBy', 'addedOn')
      url.searchParams.set('order', 'asc')
      url.searchParams.set('dateFrom', window.start)
      url.searchParams.set('dateTo', window.end)

      const response = await fetch(url, {
        headers: {
          merchantId,
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(`PayU payment-links request failed: ${response.status} ${message}`)
      }

      const payload = (await response.json()) as {
        result?: { paymentLinksList?: Array<{ invoiceNumber: string; description?: string | null; createDate?: string; amount?: number }> }
      }
      const pageItems = payload.result?.paymentLinksList ?? []
      links.push(...pageItems)
      keepGoing = pageItems.length === 100
      pageOffset += pageItems.length
    }
  }

  const payments: StoredPayment[] = []
  const seen = new Set<string>()

  for (const link of links) {
    let pageOffset = 0
    let keepGoing = true

    while (keepGoing) {
      const url = new URL(`${PAYU_PAYMENT_LINKS_BASE}/${link.invoiceNumber}/txns`)
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('pageOffset', String(pageOffset))
      url.searchParams.set('dateFrom', HISTORY_START)
      url.searchParams.set('dateTo', new Date().toISOString().slice(0, 10))

      const response = await fetch(url, {
        headers: {
          merchantId,
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(`PayU transaction-details request failed: ${response.status} ${message}`)
      }

      const payload = (await response.json()) as {
        result?: {
          data?: Array<{
            transactionId?: string
            merchantReferenceId?: string
            customerEmail?: string
            customerName?: string
            customerPhone?: string
            settledAmount?: number
            createdOn?: string
            status?: string
          }>
        }
      }
      const pageItems = payload.result?.data ?? []

      for (const item of pageItems) {
        const paymentId = item.transactionId ?? item.merchantReferenceId
        if (!paymentId || seen.has(paymentId)) continue
        seen.add(paymentId)
        const createdAt = item.createdOn
          ? item.createdOn.replace(' ', 'T').replace('.0', '') + '+05:30'
          : new Date().toISOString()

        payments.push(
          buildStoredPayment({
            paymentId,
            requestId: link.invoiceNumber,
            purpose: link.description?.trim() || 'PayU Payment Link',
            amount: Number(item.settledAmount ?? link.amount ?? 0),
            createdAt,
            buyerName: item.customerName,
            buyerEmail: item.customerEmail,
            buyerPhone: item.customerPhone,
            status: item.status?.toLowerCase() === 'success' ? 'Credit' : item.status ?? 'Failed',
            requestCreatedAt: link.createDate ?? null,
            sourceGateway: 'payu',
            sourceOrderId: link.invoiceNumber,
          }),
        )
      }

      keepGoing = pageItems.length === 100
      pageOffset += pageItems.length
    }
  }

  const filteredPayments = filterExcluded(payments)
  return {
    dashboard: buildDashboardDataFromStoredPayments(
      'payu',
      filteredPayments,
      {
        paymentRequestCount: links.length,
        paymentCount: filteredPayments.length,
        successfulPaymentCount: filteredPayments.filter((payment) => payment.status === 'Credit').length,
      },
      generatedAt,
    ),
    payments: filteredPayments,
  }
}

function parsePayuLegacyTransactions(payload: {
  Transaction_details?: Array<Record<string, unknown>>
  transaction_details?: Record<string, Record<string, unknown>>
}) {
  if (Array.isArray(payload.Transaction_details)) {
    return payload.Transaction_details
  }

  return Object.values(payload.transaction_details ?? {})
}

function normalizePayuStatus(rawStatus: string) {
  const normalized = rawStatus.trim().toLowerCase()
  if (normalized === 'success' || normalized === 'captured') {
    return 'Credit'
  }

  return rawStatus || 'Failed'
}

async function fetchPayuByLegacyBackfill(
  generatedAt: string,
  existingPayments: StoredPayment[],
  nextWindowEnd: string | null,
): Promise<GatewaySyncResult> {
  const key = optionalEnv('PAYU_KEY')
  const salt = optionalEnv('PAYU_SALT')
  if (!key || !salt) {
    throw new Error('PayU key and salt are not configured for legacy transaction sync.')
  }

  const mergedPayments = new Map(existingPayments.map((payment) => [payment.paymentId, payment]))
  const today = new Date()
  const historyStartDate = new Date(`${HISTORY_START}T00:00:00+05:30`)
  const completedBackfill =
    nextWindowEnd === null && existingPayments.length > 0
  let activeWindowEnd = nextWindowEnd ? new Date(`${nextWindowEnd}T00:00:00+05:30`) : today

  if (completedBackfill) {
    activeWindowEnd = today
  }

  let completed = completedBackfill
  let lastFetchedStart = ''
  let lastFetchedEnd = ''
  let rateLimited = false
  let rateLimitRetries = 0

  while (activeWindowEnd >= historyStartDate) {
    let activeWindowStart = addDays(activeWindowEnd, -(PAYU_LEGACY_WINDOW_DAYS - 1))
    activeWindowStart = clampToHistoryStart(activeWindowStart)

    if (completedBackfill) {
      const recentStart = clampToHistoryStart(addDays(today, -(PAYU_LEGACY_RECENT_REFRESH_DAYS - 1)))
      if (activeWindowEnd < recentStart) {
        completed = true
        break
      }
      if (activeWindowStart < recentStart) {
        activeWindowStart = recentStart
      }
    }

    const var1 = activeWindowStart.toISOString().slice(0, 10)
    const var2 = activeWindowEnd.toISOString().slice(0, 10)
    const hash = crypto
      .createHash('sha512')
      .update(`${key}|get_Transaction_Details|${var1}|${salt}`)
      .digest('hex')

    const response = await fetch(PAYU_LEGACY_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        key,
        command: 'get_Transaction_Details',
        var1,
        var2,
        hash,
      }),
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(`PayU legacy request failed: ${response.status} ${message}`)
    }

    const payload = (await response.json()) as {
      status?: number
      msg?: string
      Transaction_details?: Array<Record<string, unknown>>
      transaction_details?: Record<string, Record<string, unknown>>
    }

    if (payload.status === 0) {
      if ((payload.msg ?? '').includes('Requests limit reached')) {
        rateLimitRetries += 1
        if (rateLimitRetries <= PAYU_LEGACY_MAX_RATE_LIMIT_RETRIES) {
          await sleep(PAYU_LEGACY_RATE_LIMIT_BACKOFF_MS)
          continue
        }
        rateLimited = true
        break
      }
      throw new Error(`PayU legacy transaction API error: ${payload.msg ?? 'Unknown error'}`)
    }

    rateLimitRetries = 0

    for (const details of parsePayuLegacyTransactions(payload)) {
      const paymentId = String(details.id ?? details.mihpayid ?? details.txnid ?? '')
      if (!paymentId) continue

      const amount = Number(details.amount ?? details.transaction_fee ?? 0)
      const purpose = String(details.productinfo ?? details.field9 ?? 'PayU Payment')
      const createdAt = String(details.addedon ?? details.created_on ?? '')
      const normalizedCreatedAt = createdAt
        ? createdAt.replace(' ', 'T').replace('.0', '') + '+05:30'
        : new Date().toISOString()
      const status = normalizePayuStatus(String(details.status ?? ''))

      mergedPayments.set(
        paymentId,
        buildStoredPayment({
          paymentId,
          requestId: String(details.txnid ?? ''),
          purpose,
          amount,
          createdAt: normalizedCreatedAt,
          buyerName: [String(details.firstname ?? ''), String(details.lastname ?? '')].join(' ').trim(),
          buyerEmail: String(details.email ?? ''),
          buyerPhone: String(details.phone ?? ''),
          status,
          requestCreatedAt: normalizedCreatedAt,
          sourceGateway: 'payu',
          sourceOrderId: String(details.txnid ?? ''),
        }),
      )
    }

    lastFetchedStart = var1
    lastFetchedEnd = var2

    if (activeWindowStart.getTime() <= historyStartDate.getTime()) {
      completed = true
      break
    }

    activeWindowEnd = addDays(activeWindowStart, -1)
    await sleep(PAYU_LEGACY_PAUSE_MS)
  }

  const filteredPayments = filterExcluded(Array.from(mergedPayments.values()))
  const dashboard = buildDashboardDataFromStoredPayments(
    'payu',
    filteredPayments,
    {
      paymentRequestCount: filteredPayments.length,
      paymentCount: filteredPayments.length,
      successfulPaymentCount: filteredPayments.filter((payment) => payment.status === 'Credit').length,
    },
    generatedAt,
  )

  return {
    dashboard: completed
      ? dashboard
      : {
          ...dashboard,
          syncStatus: {
            state: 'pending',
            message: rateLimited
              ? `PayU returned a temporary rate limit after syncing through ${lastFetchedEnd}. The dashboard will continue from ${lastFetchedStart || 'the next remaining week'} on the next hourly run.`
              : `PayU history is loading week by week. Recent data through ${lastFetchedEnd} is available now, and older weeks will continue syncing automatically every hour.`,
          },
        },
    payments: filteredPayments,
    backfillState: {
      nextWindowEnd: completed ? null : activeWindowEnd.toISOString().slice(0, 10),
      completed,
      lastFetchedStart,
      lastFetchedEnd,
    },
  }
}

async function syncPayu(
  generatedAt: string,
  firestore?: FirebaseFirestore.Firestore,
): Promise<GatewaySyncResult> {
  try {
    return await fetchPayuPaymentLinksByOauth(generatedAt)
  } catch (oauthError) {
    const merchantId = optionalEnv('PAYU_MERCHANT_ID')
    if (merchantId) {
      throw oauthError
    }
  }

  const existingPayments =
    firestore ? await readStoredPayments(firestore, 'payuPayments').catch(() => []) : []
  const progress =
    firestore ? await readBackfillState(firestore, 'payuBackfill').catch(() => null) : null
  const nextWindowEnd =
    typeof progress?.nextWindowEnd === 'string' ? progress.nextWindowEnd : null

  return fetchPayuByLegacyBackfill(generatedAt, existingPayments, nextWindowEnd)
}

async function syncCashfree(generatedAt: string): Promise<GatewaySyncResult> {
  const clientId = requiredEnv('CASHFREE_CLIENT_ID')
  const clientSecret = requiredEnv('CASHFREE_CLIENT_SECRET')
  const reconUrl = optionalEnv('CASHFREE_RECON_URL') ?? DEFAULT_CASHFREE_RECON_URL
  const payments: StoredPayment[] = []
  const cashfreeHistoryStart = new Date()
  cashfreeHistoryStart.setDate(cashfreeHistoryStart.getDate() - CASHFREE_MAX_LOOKBACK_DAYS)
  const effectiveHistoryStart = [
    HISTORY_START,
    cashfreeHistoryStart.toISOString().slice(0, 10),
  ].sort().at(-1) as string
  const windows = dayRangeWindows(effectiveHistoryStart, new Date(), CASHFREE_WINDOW_DAYS)

  for (const window of windows) {
    let cursor: string | null = null

    do {
      const response = await fetch(reconUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-version': '2025-01-01',
          'x-client-id': clientId,
          'x-client-secret': clientSecret,
        },
        body: JSON.stringify({
          pagination: {
            limit: 100,
            cursor,
          },
          filters: {
            start_date: `${window.start}T00:00:00+05:30`,
            end_date: `${window.end}T23:59:59+05:30`,
          },
        }),
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(`Cashfree reconciliation request failed: ${response.status} ${message}`)
      }

      const payload = (await response.json()) as {
        cursor?: string | null
        data?: Array<Record<string, unknown>>
      }

      for (const item of payload.data ?? []) {
        const orderDetails = (item.order_details as Record<string, unknown> | undefined) ?? {}
        const customerDetails = (item.customer_details as Record<string, unknown> | undefined) ?? {}
        const paymentDetails = (item.payment_details as Record<string, unknown> | undefined) ?? {}
        const eventDetails = (item.event_details as Record<string, unknown> | undefined) ?? {}
        const tags = (orderDetails.order_tags as Record<string, unknown> | null | undefined) ?? {}
        const eventType = String(eventDetails.event_type ?? '')
        if (eventType && eventType !== 'PAYMENT') continue

        const purpose =
          String(
            tags.purpose ??
              tags.description ??
              eventDetails.event_remarks ??
              orderDetails.order_note ??
              orderDetails.order_id ??
              item.order_id ??
              'Cashfree Payment',
          )

        const paymentId = String(
          paymentDetails.cf_payment_id ?? item.cf_payment_id ?? paymentDetails.payment_id ?? '',
        )
        if (!paymentId) continue

        const amount = Number(
          paymentDetails.payment_amount ?? eventDetails.event_amount ?? orderDetails.order_amount ?? 0,
        )
        const createdAt = String(
          paymentDetails.payment_time ??
            eventDetails.event_time ??
            orderDetails.order_expiry_time ??
            new Date().toISOString(),
        )
        const paymentStatus = String(
          paymentDetails.payment_status ??
            paymentDetails.status ??
            eventDetails.event_status ??
            item.payment_status ??
            item.status ??
            'FAILED',
        )

        payments.push(
          buildStoredPayment({
            paymentId,
            requestId: String(orderDetails.order_id ?? item.order_id ?? ''),
            purpose,
            amount,
            createdAt,
            buyerName: String(customerDetails.customer_name ?? ''),
            buyerEmail: String(customerDetails.customer_email ?? ''),
            buyerPhone: String(customerDetails.customer_phone ?? ''),
            status: paymentStatus.toUpperCase() === 'SUCCESS' ? 'Credit' : paymentStatus,
            requestCreatedAt: String(orderDetails.order_expiry_time ?? ''),
            sourceGateway: 'cashfree',
            sourceOrderId: String(orderDetails.order_id ?? item.order_id ?? ''),
          }),
        )
      }

      cursor = payload.cursor ?? null
    } while (cursor)
  }

  const filteredPayments = filterExcluded(payments)
  return {
    dashboard: buildDashboardDataFromStoredPayments(
      'cashfree',
      filteredPayments,
      {
        paymentRequestCount: filteredPayments.length,
        paymentCount: filteredPayments.length,
        successfulPaymentCount: filteredPayments.filter((payment) => payment.status === 'Credit').length,
      },
      generatedAt,
    ),
    payments: filteredPayments,
  }
}

async function safeGatewaySync(
  gateway: GatewayId,
  generatedAt: string,
  syncFn: () => Promise<GatewaySyncResult>,
) {
  try {
    return await syncFn()
  } catch (error) {
    const syncStatus = formatGatewaySyncMessage(gateway, error)
    console.error(`${gateway} sync failed`, error)
    return {
      dashboard: {
        ...emptyDashboardData(gateway, syncStatus.message, generatedAt),
        syncStatus,
      },
      payments: [],
    } satisfies GatewaySyncResult
  }
}

async function writeGatewayToFirestore(
  firestore: FirebaseFirestore.Firestore,
  gateway: GatewayId,
  result: GatewaySyncResult,
  generatedAt: string,
) {
  if (result.dashboard.syncStatus.state === 'error' && result.payments.length === 0) {
    await firestore.collection('dashboardMetadata').doc(gateway).set(
      {
        generatedAt,
        syncStatus: result.dashboard.syncStatus,
      },
      { merge: true },
    )
    return
  }

  if (gateway !== 'combined') {
    const paymentCollection = `${gateway}Payments`
    await writeMissingCollection(
      firestore,
      paymentCollection,
      result.payments.map((payment) => ({
        id: payment.paymentId,
        data: {
          ...payment,
          firstSeenAt: generatedAt,
        },
      })),
    )
  }

  if (gateway === 'instamojo' && result.rawRequestDocs) {
    await writeMissingCollection(firestore, 'instamojoPaymentRequests', result.rawRequestDocs)
  }

  await clearCollection(firestore, `${gateway}WebinarReports`)
  await writeCollection(
    firestore,
    `${gateway}WebinarReports`,
    result.dashboard.weekly.map((week) => ({
      id: week.webinarDate,
      data: {
        ...week,
        generatedAt,
      },
    })),
  )

  await firestore.collection('dashboardMetadata').doc(gateway).set(result.dashboard, { merge: true })

  if (gateway === 'payu' && result.backfillState) {
    await firestore.collection('dashboardMetadata').doc('payuBackfill').set(result.backfillState, {
      merge: true,
    })
  }
}

async function main() {
  const generatedAt = new Date().toISOString()
  const skipFirebase = process.env.SKIP_FIREBASE === '1'
  const firestore = skipFirebase ? undefined : initFirebase()

  const [instamojo, payu, cashfree] = await Promise.all([
    safeGatewaySync('instamojo', generatedAt, () => syncInstamojo(generatedAt)),
    safeGatewaySync('payu', generatedAt, () => syncPayu(generatedAt, firestore)),
    safeGatewaySync('cashfree', generatedAt, () => syncCashfree(generatedAt)),
  ])

  const combinedDedupe = dedupeCombinedPayments([
    ...instamojo.payments,
    ...payu.payments,
    ...cashfree.payments,
  ])

  const combined = buildDashboardDataFromStoredPayments(
    'combined',
    combinedDedupe.unique,
    {
      paymentRequestCount:
        instamojo.dashboard.source.paymentRequestCount +
        payu.dashboard.source.paymentRequestCount +
        cashfree.dashboard.source.paymentRequestCount,
      paymentCount: combinedDedupe.unique.length,
      successfulPaymentCount: combinedDedupe.unique.filter((payment) => payment.status === 'Credit').length,
    },
    generatedAt,
  )

  const pendingGateways = [instamojo.dashboard, payu.dashboard, cashfree.dashboard].filter(
    (gateway) => gateway.syncStatus.state === 'pending',
  )

  const combinedMessageParts = [
    `${combinedDedupe.duplicateCount} cross-gateway duplicates removed`,
    `${combinedDedupe.deterministicMirrorCount} deterministic Instamojo/Cashfree mirrors`,
  ]

  if (combinedDedupe.heuristicDuplicateCount > 0) {
    combinedMessageParts.push(`${combinedDedupe.heuristicDuplicateCount} heuristic duplicates`)
  }

  const combinedDashboard =
    pendingGateways.length > 0
      ? {
          ...combined,
          syncStatus: {
            state: 'pending' as const,
            message: `${combinedMessageParts.join(', ')}. ${pendingGateways
              .map((gateway) => gateway.label)
              .join(', ')} still has history loading in the background.`,
          },
        }
      : {
          ...combined,
          syncStatus: {
            state: 'ready' as const,
            message: `${combinedMessageParts.join(', ')}.`,
          },
        }

  const database = buildDatabaseSnapshot(combinedDedupe.unique)

  const snapshot: DashboardSnapshot = {
    generatedAt,
    timezone: TIME_ZONE,
    gateways: {
      instamojo: instamojo.dashboard,
      payu: payu.dashboard,
      cashfree: cashfree.dashboard,
      combined: combinedDashboard,
    },
    database,
  }

  await mkdir(publicDir, { recursive: true })
  await writeFile(path.join(publicDir, 'dashboard-data.json'), JSON.stringify(snapshot, null, 2), 'utf8')

  if (firestore) {
    try {
      await Promise.all([
        writeGatewayToFirestore(firestore, 'instamojo', instamojo, generatedAt),
        writeGatewayToFirestore(firestore, 'payu', payu, generatedAt),
        writeGatewayToFirestore(firestore, 'cashfree', cashfree, generatedAt),
        writeGatewayToFirestore(
          firestore,
          'combined',
          { dashboard: combinedDashboard, payments: combinedDedupe.unique },
          generatedAt,
        ),
      ])

      await firestore.collection('dashboardMetadata').doc('latest').set(snapshot, { merge: true })
    } catch (error) {
      console.error('Firestore backup skipped after snapshot generation', error)
    }
  }

  console.log(
    JSON.stringify(
      {
        generatedAt,
        gateways: {
          instamojo: instamojo.dashboard.syncStatus,
          payu: payu.dashboard.syncStatus,
          cashfree: cashfree.dashboard.syncStatus,
          combined: combinedDashboard.syncStatus,
        },
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
