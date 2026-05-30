export type PaymentClassification =
  | 'webinar_only'
  | 'bundle_only'
  | 'combo'
  | 'course'
  | 'other'

export type GatewayId = 'instamojo' | 'payu' | 'cashfree' | 'combined'

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
  sourceGateway?: GatewayId
  sourceOrderId?: string | null
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

export type HistoricalSummary = {
  webinarRegistrations: number
  webinarWeeksCount: number
  bundleRegistrations: number
  coursePurchases: number
  bundleConversionRate: number
  courseConversionRate: number
}

export type DashboardData = {
  gateway: GatewayId
  label: string
  generatedAt: string
  timezone: string
  source: {
    paymentRequestCount: number
    paymentCount: number
    successfulPaymentCount: number
  }
  syncStatus: {
    state: 'ready' | 'error' | 'pending'
    message: string | null
  }
  totals: {
    registrations: number
    bundleRegistrations: number
    coursePurchases: number
    totalRevenue: number
  }
  historicalSummary: HistoricalSummary
  classificationSources: {
    webinar: Array<{ purpose: string; count: number }>
    bundle: Array<{ purpose: string; count: number }>
    course: Array<{ purpose: string; count: number }>
  }
  weekly: WeeklyMetrics[]
}

export type DashboardSnapshot = {
  generatedAt: string
  timezone: string
  gateways: Record<GatewayId, DashboardData>
}
