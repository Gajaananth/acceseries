export type PaymentFrequency = 'daily' | 'weekly' | 'monthly'

export type AgreementItemInput = {
  unitPriceCents: number
  quantity: number
}

export type AgreementCalculationInput = {
  items: AgreementItemInput[]
  productDiscount: number
  customerDiscount: number
  downPayment: number
  fixedInterest: number
  frequency: PaymentFrequency
  installmentCount: number
  firstDueDate: string
}

export type AgreementCalculation = {
  subtotal: number
  discounts: number
  finalPrice: number
  remainingPrincipal: number
  totalRepayment: number
  installmentAmount: number
  roundingRemainder: number
  installmentAmounts: number[]
  interestPerInstallment: number[]
}

export type PaymentAllocationType = 'late_fee' | 'interest' | 'principal'

export type OutstandingInstallment = {
  id: string
  lateFeeDueCents: number
  interestDueCents: number
  principalDueCents: number
}

export type PaymentAllocation = {
  installmentId: string
  type: PaymentAllocationType
  amountCents: number
}

export type LateFeeInput = {
  dueDate: string
  asOfDate: string
  gracePeriodDays: number
  fixedFeeCents: number
  dailyFeeCents: number
  maximumFeeCents: number
  alreadyAssessedCents?: number
  fixedFeeAlreadyCharged?: boolean
  fullyPaid?: boolean
}

export type LateFeeAssessment = {
  daysOverdue: number
  chargeableDays: number
  targetFeeCents: number
  fixedFeeToAssessCents: number
  dailyFeeToAssessCents: number
  feeToAssessCents: number
}

export type EarlySettlementQuote = {
  outstandingPrincipalCents: number
  outstandingInterestCents: number
  lateFeesCents: number
  discountCents: number
  settlementAmountCents: number
}

export type EarlySettlementDiscountPolicy =
  | { type: 'fixed'; amountCents: number }
  | { type: 'interest_percentage'; percent: number }

const MAX_LKR_CENTS = 999_999_999_999
export const MAX_INSTALLMENT_COUNT = 1_200
export const DEFAULT_PAYMENT_ALLOCATION_ORDER: readonly PaymentAllocationType[] = [
  'late_fee',
  'interest',
  'principal',
]

export function calculateAgreement(input: AgreementCalculationInput): AgreementCalculation {
  const { items, productDiscount, customerDiscount, downPayment, fixedInterest, installmentCount } = input
  assertNonNegativeCents(productDiscount)
  assertNonNegativeCents(customerDiscount)
  assertNonNegativeCents(downPayment)
  assertNonNegativeCents(fixedInterest)
  assertScheduleCount(installmentCount)
  if (!['daily', 'weekly', 'monthly'].includes(input.frequency)) {
    throw new RangeError('Payment frequency is invalid')
  }
  validateDate(input.firstDueDate)

  const subtotalBigInt = items.reduce((sum, item) => {
    assertNonNegativeCents(item.unitPriceCents)
    assertPositiveInteger(item.quantity, 'Item quantity')
    return sum + BigInt(item.unitPriceCents) * BigInt(item.quantity)
  }, 0n)
  const subtotal = toSafeInteger(subtotalBigInt, 'Subtotal')
  const discountsBigInt = BigInt(productDiscount) + BigInt(customerDiscount)
  if (discountsBigInt > subtotalBigInt) {
    throw new RangeError('Discounts cannot exceed the subtotal')
  }
  const discounts = toSafeInteger(discountsBigInt, 'Discount total')
  const finalPrice = subtotal - discounts
  if (downPayment > finalPrice) {
    throw new RangeError('Down payment cannot exceed the final price')
  }

  const remainingPrincipal = finalPrice - downPayment
  const totalRepaymentBigInt = BigInt(remainingPrincipal) + BigInt(fixedInterest)
  const totalRepayment = toSafeInteger(totalRepaymentBigInt, 'Total repayment')
  const installmentAmounts = totalRepayment > 0
    ? splitCentsRemainderLast(totalRepayment, installmentCount)
    : []
  const interestPerInstallment = totalRepayment > 0
    ? splitCentsRemainderLast(fixedInterest, installmentCount)
    : []
  const hasRepayment = totalRepayment > 0

  return {
    subtotal,
    discounts,
    finalPrice,
    remainingPrincipal,
    totalRepayment,
    installmentAmount: installmentAmounts[0] ?? 0,
    roundingRemainder: hasRepayment ? Number(totalRepaymentBigInt % BigInt(installmentCount)) : 0,
    installmentAmounts,
    interestPerInstallment,
  }
}

export function splitCentsRemainderLast(amountCents: number, count: number): number[] {
  assertNonNegativeCents(amountCents)
  assertScheduleCount(count)
  const total = BigInt(amountCents)
  const divisor = BigInt(count)
  const base = total / divisor
  const remainder = total % divisor
  return Array.from({ length: count }, (_, index) =>
    Number(base + (index === count - 1 ? remainder : 0n)),
  )
}

export function generateSchedule(
  firstDueDate: string,
  frequency: PaymentFrequency,
  count: number,
): string[] {
  assertScheduleCount(count)
  const [year, month, day] = validateDate(firstDueDate)

  return Array.from({ length: count }, (_, index) => {
    if (frequency === 'daily' || frequency === 'weekly') {
      const intervalDays = frequency === 'daily' ? index : index * 7
      const date = new Date(Date.UTC(year, month - 1, day + intervalDays))
      return formatUtcDate(date)
    }

    if (frequency !== 'monthly') throw new RangeError('Payment frequency is invalid')
    const targetMonth = month - 1 + index
    const targetYear = year + Math.floor(targetMonth / 12)
    const normalizedMonth = targetMonth % 12
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
    return formatUtcDate(new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))))
  })
}

export function calculatePeriodicInstallments(principalCents: number, paymentCount: number): number[] {
  assertNonNegativeCents(principalCents)
  assertPositiveInteger(paymentCount, 'Payment count')
  const count = BigInt(paymentCount)
  const principal = BigInt(principalCents)
  const base = principal / count
  const remainder = principal % count
  return Array.from({ length: paymentCount }, (_, index) =>
    Number(base + (BigInt(index) < remainder ? 1n : 0n)),
  )
}

export function allocatePaymentAcrossInstallments(
  paymentCents: number,
  installments: readonly OutstandingInstallment[],
  order: readonly PaymentAllocationType[] = DEFAULT_PAYMENT_ALLOCATION_ORDER,
): PaymentAllocation[] {
  assertPositiveInteger(paymentCents, 'Payment amount')
  if (paymentCents > MAX_LKR_CENTS) throw new RangeError('Payment amount exceeds numeric(12,2) range')
  if (order.length !== DEFAULT_PAYMENT_ALLOCATION_ORDER.length ||
      new Set(order).size !== DEFAULT_PAYMENT_ALLOCATION_ORDER.length ||
      order.some((type) => !DEFAULT_PAYMENT_ALLOCATION_ORDER.includes(type))) {
    throw new RangeError('Payment allocation order must include late fees, interest, and principal once')
  }

  let remaining = BigInt(paymentCents)
  const allocations: PaymentAllocation[] = []
  for (const installment of installments) {
    const due: Record<PaymentAllocationType, number> = {
      late_fee: installment.lateFeeDueCents,
      interest: installment.interestDueCents,
      principal: installment.principalDueCents,
    }
    for (const type of order) {
      assertNonNegativeCents(due[type])
      const allocated = remaining < BigInt(due[type]) ? remaining : BigInt(due[type])
      if (allocated > 0n) {
        allocations.push({
          installmentId: installment.id,
          type,
          amountCents: Number(allocated),
        })
        remaining -= allocated
      }
      if (remaining === 0n) return allocations
    }
  }
  if (remaining > 0n) throw new RangeError('Payment exceeds the outstanding agreement balance')
  return allocations
}

export function calculateLateFeeCents(
  feePerDayCents: number,
  overdueDays: number,
  graceDays: number,
): number {
  assertNonNegativeCents(feePerDayCents)
  assertNonNegativeInteger(overdueDays, 'Overdue days')
  assertNonNegativeInteger(graceDays, 'Grace days')
  const chargeableDays = Math.max(0, overdueDays - graceDays)
  return toSafeInteger(BigInt(feePerDayCents) * BigInt(chargeableDays), 'Late fee')
}

/**
 * The due date is day zero; chargeable days begin on due date + grace days + 1.
 * The as-of date is included, so a chargeable day is assessed even if payment
 * is recorded later on that same date.
 */
export function assessLateFee(input: LateFeeInput): LateFeeAssessment {
  const dueDate = parseUtcDate(input.dueDate)
  const asOfDate = parseUtcDate(input.asOfDate)
  assertNonNegativeInteger(input.gracePeriodDays, 'Grace period')
  assertNonNegativeCents(input.fixedFeeCents)
  assertNonNegativeCents(input.dailyFeeCents)
  assertNonNegativeCents(input.maximumFeeCents)
  const alreadyAssessedCents = input.alreadyAssessedCents ?? 0
  assertNonNegativeCents(alreadyAssessedCents)

  const daysOverdue = Math.max(0, Math.floor((asOfDate.getTime() - dueDate.getTime()) / 86_400_000))
  const chargeableDays = Math.max(0, daysOverdue - input.gracePeriodDays)
  const fixedFeeToAssessCents = !input.fullyPaid &&
    chargeableDays > 0 &&
    !input.fixedFeeAlreadyCharged
    ? Math.min(input.fixedFeeCents, input.maximumFeeCents)
    : 0
  const desiredTarget = input.fullyPaid
    ? alreadyAssessedCents
    : BigInt(input.fixedFeeCents) * BigInt(chargeableDays > 0 ? 1 : 0) +
      BigInt(input.dailyFeeCents) * BigInt(chargeableDays)
  const cappedTarget = desiredTarget > BigInt(input.maximumFeeCents)
    ? input.maximumFeeCents
    : Number(desiredTarget)
  const targetFeeCents = Math.max(alreadyAssessedCents, cappedTarget)
  const feeToAssessCents = Math.max(0, targetFeeCents - alreadyAssessedCents)
  const boundedFixedFee = Math.min(fixedFeeToAssessCents, feeToAssessCents)
  const dailyFeeToAssessCents = feeToAssessCents - boundedFixedFee

  return {
    daysOverdue,
    chargeableDays,
    targetFeeCents,
    fixedFeeToAssessCents: boundedFixedFee,
    dailyFeeToAssessCents,
    feeToAssessCents,
  }
}

export function calculateLateFeeOutstandingCents(
  assessedCents: number,
  waivedCents: number,
  paidCents: number,
): number {
  assertNonNegativeCents(assessedCents)
  assertNonNegativeCents(waivedCents)
  assertNonNegativeCents(paidCents)
  return Math.max(0, assessedCents - waivedCents - paidCents)
}

export function calculateEarlySettlementQuote(
  outstandingPrincipalCents: number,
  outstandingInterestCents: number,
  lateFeesCents: number,
  policy: EarlySettlementDiscountPolicy,
): EarlySettlementQuote {
  assertNonNegativeCents(outstandingPrincipalCents)
  assertNonNegativeCents(outstandingInterestCents)
  assertNonNegativeCents(lateFeesCents)
  let requestedDiscount: number
  if (policy.type === 'fixed') {
    assertNonNegativeCents(policy.amountCents)
    requestedDiscount = policy.amountCents
  } else {
    assertNonNegativeInteger(policy.percent, 'Interest discount percent')
    if (policy.percent > 100) throw new RangeError('Interest discount percent cannot exceed 100')
    requestedDiscount = Number(BigInt(outstandingInterestCents) * BigInt(policy.percent) / 100n)
  }
  const discountCents = Math.min(requestedDiscount, outstandingInterestCents)
  const settlementAmountCents = toSafeInteger(
    BigInt(outstandingPrincipalCents) +
      BigInt(outstandingInterestCents) +
      BigInt(lateFeesCents) -
      BigInt(discountCents),
    'Early settlement amount',
  )

  return {
    outstandingPrincipalCents,
    outstandingInterestCents,
    lateFeesCents,
    discountCents,
    settlementAmountCents,
  }
}

export function allocatePaymentCents(
  paymentCents: number,
  lateFeeCents: number,
  installmentCents: number,
): { lateFeeCents: number; installmentCents: number; unappliedCents: number } {
  assertNonNegativeCents(paymentCents)
  assertNonNegativeCents(lateFeeCents)
  assertNonNegativeCents(installmentCents)
  const lateFeePaid = Math.min(paymentCents, lateFeeCents)
  const remainder = paymentCents - lateFeePaid
  const installmentPaid = Math.min(remainder, installmentCents)
  return {
    lateFeeCents: lateFeePaid,
    installmentCents: installmentPaid,
    unappliedCents: remainder - installmentPaid,
  }
}

function assertNonNegativeCents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LKR_CENTS) {
    throw new RangeError('LKR cents must fit numeric(12,2)')
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`)
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`)
}

function assertScheduleCount(value: number): void {
  assertPositiveInteger(value, 'Installment count')
  if (value > MAX_INSTALLMENT_COUNT) {
    throw new RangeError(`Installment count cannot exceed ${MAX_INSTALLMENT_COUNT}`)
  }
}

function toSafeInteger(value: bigint, label: string): number {
  if (value > BigInt(MAX_LKR_CENTS)) throw new RangeError(`${label} exceeds numeric(12,2) range`)
  return Number(value)
}

function validateDate(value: string): [number, number, number] {
  const date = parseUtcDate(value)
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
}

function parseUtcDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new RangeError('Date must be a valid YYYY-MM-DD value')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError('Date must be a valid YYYY-MM-DD value')
  }
  return date
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`
}
