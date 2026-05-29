import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import admin from 'firebase-admin'
import {
  buildDashboardData,
  classifyPayment,
  isExcludedWebinarWeek,
  normalizePayments,
  resolveWebinarDateForClassification,
} from '../src/lib/analytics'

type PaymentRequest = {
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

type Payment = {
  payment_id: string
  status: string
  amount: string
  buyer_name: string | null
  buyer_phone: string | null
  buyer_email: string | null
  payment_request: string | null
  created_at: string
}

type NormalizedRequest = PaymentRequest & {
  amountValue: number
  classification: string
  webinarDate: string
}

const API_BASE = 'https://www.instamojo.com/api/1.1'
const repoRoot = path.resolve(import.meta.dirname, '..')
const publicDir = path.join(repoRoot, 'public')

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function instamojoGet<T>(endpoint: string, page: number, limit = 500): Promise<T> {
  const apiKey = requiredEnv('INSTAMOJO_API_KEY')
  const authToken = requiredEnv('INSTAMOJO_AUTH_TOKEN')
  const url = new URL(`${API_BASE}/${endpoint}/`)
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

async function fetchAllPages<T>(
  endpoint: string,
  key: string,
): Promise<T[]> {
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

function normalizeRequests(paymentRequests: PaymentRequest[]): NormalizedRequest[] {
  return paymentRequests
    .map((request) => {
      const amountValue = Number.parseFloat(request.amount)
      const classification = classifyPayment(amountValue, request.purpose)
      const requestDate = new Date(request.created_at)

      return {
        ...request,
        amountValue,
        classification,
        webinarDate: resolveWebinarDateForClassification(requestDate, classification),
      }
    })
    .filter((request) => !isExcludedWebinarWeek(request.webinarDate))
}

async function main() {
  const firestore = initFirebase()
  const paymentRequests = await fetchAllPages<PaymentRequest>('payment-requests', 'payment_requests')
  const payments = await fetchAllPages<Payment>('payments', 'payments')
  const dashboardData = buildDashboardData(paymentRequests, payments)
  const normalized = normalizePayments(paymentRequests, payments)
  const normalizedRequests = normalizeRequests(paymentRequests)

  await clearCollection(firestore, 'instamojoPaymentRequests')
  await clearCollection(firestore, 'instamojoPayments')
  await clearCollection(firestore, 'webinarReports')
  await firestore.collection('dashboardMetadata').doc('latest').delete().catch(() => undefined)

  await writeCollection(
    firestore,
    'instamojoPaymentRequests',
    normalizedRequests.map((request) => ({
      id: request.id,
      data: {
        ...request,
        syncedAt: new Date().toISOString(),
      },
    })),
  )

  await writeCollection(
    firestore,
    'instamojoPayments',
    normalized.map((payment) => ({
      id: payment.paymentId,
      data: {
        ...payment,
        syncedAt: new Date().toISOString(),
      },
    })),
  )

  await writeCollection(
    firestore,
    'webinarReports',
    dashboardData.weekly.map((week) => ({
      id: week.webinarDate,
      data: {
        ...week,
        generatedAt: dashboardData.generatedAt,
      },
    })),
  )

  await firestore.collection('dashboardMetadata').doc('latest').set(
    {
      ...dashboardData,
      saltConfigured: Boolean(process.env.INSTAMOJO_PRIVATE_SALT),
    },
    { merge: true },
  )

  await mkdir(publicDir, { recursive: true })
  await writeFile(
    path.join(publicDir, 'dashboard-data.json'),
    JSON.stringify(dashboardData, null, 2),
    'utf8',
  )

  console.log(
    JSON.stringify(
      {
        paymentRequests: paymentRequests.length,
        payments: payments.length,
        successful: dashboardData.source.successfulPaymentCount,
        generatedAt: dashboardData.generatedAt,
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
