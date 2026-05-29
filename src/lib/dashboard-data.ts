export type PaymentClassification =
  | 'webinar_only'
  | 'bundle_only'
  | 'combo'
  | 'course'
  | 'other'

export type StoredPayment = {
  paymentId: string
  requestId: string | null
  purpose: string
  amount: number
  createdAt: string
  localCreatedAt: string
  buyerName: string
  buyerEmail: string
  buyerPhone: string
  status: string
  classification: PaymentClassification
  webinarDate: string
  requestCreatedAt: string | null
}

export type WeeklyMetrics = {
  webinarDate: string
  label: string
  registrationWindow: string
  registrations: number
  webinarOnlyRegistrations: number
  comboRegistrations: number
  bundleRegistrations: number
  bundleOnlyRegistrations: number
  coursePurchasesLive: number
  coursePurchasesExtended: number
  courseRevenueLive: number
  courseRevenueExtended: number
  registrationRevenue: number
  totalRevenue: number
  topCoursePurposes: Array<{ purpose: string; count: number; revenue: number }>
  recentPayments: Array<{
    paymentId: string
    localCreatedAt: string
    amount: number
    purpose: string
    classification: PaymentClassification
    buyerName: string
  }>
}

export type DashboardData = {
  generatedAt: string
  timezone: string
  source: {
    paymentRequestCount: number
    paymentCount: number
    successfulPaymentCount: number
  }
  totals: {
    registrations: number
    bundleRegistrations: number
    coursePurchases: number
    totalRevenue: number
  }
  weekly: WeeklyMetrics[]
}
