import { describe, expect, it } from 'vitest'
import {
  assessLateFee,
  allocatePaymentAcrossInstallments,
  calculateEarlySettlementQuote,
  calculateLateFeeOutstandingCents,
  calculateAgreement,
  generateSchedule,
} from './calculations'

const dueDate = '2025-01-01'

function calculate(
  overrides: Partial<Parameters<typeof calculateAgreement>[0]> = {},
) {
  return calculateAgreement({
    items: [{ unitPriceCents: 10_000_000, quantity: 1 }],
    productDiscount: 500_000,
    customerDiscount: 0,
    downPayment: 2_000_000,
    fixedInterest: 750_000,
    frequency: 'monthly',
    installmentCount: 10,
    firstDueDate: dueDate,
    ...overrides,
  })
}

describe('installment agreement calculations', () => {
  it('does not assess late fees before the due date', () => {
    expect(assessLateFee({
      dueDate: '2026-11-10',
      asOfDate: '2026-11-09',
      gracePeriodDays: 3,
      fixedFeeCents: 20_000,
      dailyFeeCents: 5_000,
      maximumFeeCents: 100_000,
    })).toMatchObject({
      daysOverdue: 0,
      chargeableDays: 0,
      feeToAssessCents: 0,
    })
  })

  it('does not charge during grace and starts on the day after it ends', () => {
    const policy = {
      dueDate: '2026-11-10',
      gracePeriodDays: 3,
      fixedFeeCents: 20_000,
      dailyFeeCents: 5_000,
      maximumFeeCents: 100_000,
    }
    expect(assessLateFee({ ...policy, asOfDate: '2026-11-13' }).chargeableDays).toBe(0)
    expect(assessLateFee({ ...policy, asOfDate: '2026-11-14' })).toMatchObject({
      daysOverdue: 4,
      chargeableDays: 1,
      fixedFeeToAssessCents: 20_000,
      dailyFeeToAssessCents: 5_000,
      feeToAssessCents: 25_000,
    })
  })

  it('assesses fixed-only, daily-only, and combined charges', () => {
    const policy = {
      dueDate: '2026-11-10',
      asOfDate: '2026-11-16',
      gracePeriodDays: 3,
      maximumFeeCents: 100_000,
    }
    expect(assessLateFee({ ...policy, fixedFeeCents: 20_000, dailyFeeCents: 0 }).feeToAssessCents).toBe(20_000)
    expect(assessLateFee({ ...policy, fixedFeeCents: 0, dailyFeeCents: 5_000 }).feeToAssessCents).toBe(15_000)
    expect(assessLateFee({ ...policy, fixedFeeCents: 20_000, dailyFeeCents: 5_000 })).toMatchObject({
      chargeableDays: 3,
      feeToAssessCents: 35_000,
    })
  })

  it('assesses the November 10 example through November 16 inclusively', () => {
    expect(assessLateFee({
      dueDate: '2026-11-10',
      asOfDate: '2026-11-16',
      gracePeriodDays: 3,
      fixedFeeCents: 20_000,
      dailyFeeCents: 5_000,
      maximumFeeCents: 100_000,
    })).toMatchObject({
      chargeableDays: 3,
      feeToAssessCents: 35_000,
    })
  })

  it('caps fees and does not assess duplicates or accrue after full settlement', () => {
    const policy = {
      dueDate: '2026-11-10',
      asOfDate: '2026-11-16',
      gracePeriodDays: 3,
      fixedFeeCents: 20_000,
      dailyFeeCents: 5_000,
      maximumFeeCents: 30_000,
    }
    expect(assessLateFee(policy).feeToAssessCents).toBe(30_000)
    expect(assessLateFee({
      ...policy,
      maximumFeeCents: 100_000,
      alreadyAssessedCents: 35_000,
      fixedFeeAlreadyCharged: true,
    }).feeToAssessCents).toBe(0)
    expect(assessLateFee({
      ...policy,
      maximumFeeCents: 100_000,
      alreadyAssessedCents: 35_000,
      fullyPaid: true,
    }).feeToAssessCents).toBe(0)
  })

  it('keeps daily fees accruing on partial payment and records waivers as offsets', () => {
    expect(assessLateFee({
      dueDate: '2026-11-10',
      asOfDate: '2026-11-16',
      gracePeriodDays: 3,
      fixedFeeCents: 20_000,
      dailyFeeCents: 5_000,
      maximumFeeCents: 100_000,
      fullyPaid: false,
    }).feeToAssessCents).toBe(35_000)
    expect(calculateLateFeeOutstandingCents(35_000, 15_000, 10_000)).toBe(10_000)
  })

  it('allocates a full settlement exactly across every outstanding component', () => {
    const allocations = allocatePaymentAcrossInstallments(15_500, [
      { id: 'one', lateFeeDueCents: 500, interestDueCents: 2_000, principalDueCents: 8_000 },
      { id: 'two', lateFeeDueCents: 0, interestDueCents: 1_000, principalDueCents: 4_000 },
    ])
    expect(allocations.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(15_500)
    expect(allocations).toHaveLength(5)
  })

  it('discounts only remaining interest for fixed and percentage early settlement', () => {
    expect(calculateEarlySettlementQuote(75_000, 7_500, 500, {
      type: 'fixed',
      amountCents: 2_000,
    })).toEqual({
      outstandingPrincipalCents: 75_000,
      outstandingInterestCents: 7_500,
      lateFeesCents: 500,
      discountCents: 2_000,
      settlementAmountCents: 81_000,
    })
    expect(calculateEarlySettlementQuote(75_000, 7_500, 500, {
      type: 'interest_percentage',
      percent: 10,
    }).discountCents).toBe(750)
    expect(calculateEarlySettlementQuote(75_000, 100, 500, {
      type: 'fixed',
      amountCents: 2_000,
    }).discountCents).toBe(100)
  })

  it('calculates the requested agreement totals in cents', () => {
    const result = calculate()
    expect(result).toMatchObject({
      subtotal: 10_000_000,
      discounts: 500_000,
      finalPrice: 9_500_000,
      remainingPrincipal: 7_500_000,
      totalRepayment: 8_250_000,
      installmentAmount: 825_000,
      roundingRemainder: 0,
    })
    expect(result.installmentAmounts).toEqual(Array(10).fill(825_000))
    expect(result.interestPerInstallment).toEqual(Array(10).fill(75_000))
  })

  it('adds any rounding remainder to the last installment only', () => {
    const result = calculate({
      items: [{ unitPriceCents: 8_250_101, quantity: 1 }],
      productDiscount: 0,
      downPayment: 0,
      fixedInterest: 0,
    })
    expect(result.installmentAmounts).toEqual([
      ...Array(9).fill(825_010),
      825_011,
    ])
    expect(result.installmentAmounts.reduce((sum, amount) => sum + amount, 0)).toBe(result.totalRepayment)
  })

  it('splits fixed interest in cents with its remainder on the last installment', () => {
    const result = calculate({ fixedInterest: 101, installmentCount: 10 })
    expect(result.interestPerInstallment).toEqual([
      ...Array(9).fill(10),
      11,
    ])
    expect(result.interestPerInstallment.reduce((sum, amount) => sum + amount, 0)).toBe(101)
  })

  it('clamps monthly dates to each target month without drifting', () => {
    expect(generateSchedule('2025-01-31', 'monthly', 3)).toEqual([
      '2025-01-31',
      '2025-02-28',
      '2025-03-31',
    ])
    expect(generateSchedule('2024-02-29', 'monthly', 3)).toEqual([
      '2024-02-29',
      '2024-03-29',
      '2024-04-29',
    ])
  })

  it('generates daily and weekly dates', () => {
    expect(generateSchedule('2025-01-01', 'daily', 3)).toEqual([
      '2025-01-01',
      '2025-01-02',
      '2025-01-03',
    ])
    expect(generateSchedule('2025-01-01', 'weekly', 3)).toEqual([
      '2025-01-01',
      '2025-01-08',
      '2025-01-15',
    ])
  })

  it('supports zero interest and zero down payment', () => {
    const result = calculate({ fixedInterest: 0, downPayment: 0 })
    expect(result.totalRepayment).toBe(9_500_000)
    expect(result.interestPerInstallment).toEqual(Array(10).fill(0))
  })

  it('does not generate a schedule when the down payment covers the final price', () => {
    const result = calculate({
      productDiscount: 500_000,
      downPayment: 9_500_000,
      fixedInterest: 0,
    })
    expect(result.remainingPrincipal).toBe(0)
    expect(result.totalRepayment).toBe(0)
    expect(result.installmentAmounts).toEqual([])
  })

  it('rejects invalid discounts, down payments, interest, and installment counts', () => {
    expect(() => calculate({ customerDiscount: 10_000_001 })).toThrow(RangeError)
    expect(() => calculate({ downPayment: 9_500_001 })).toThrow(RangeError)
    expect(() => calculate({ fixedInterest: -1 })).toThrow(RangeError)
    expect(() => calculate({ installmentCount: 0 })).toThrow(RangeError)
  })

  it('clears the oldest installment and partially pays the next with an exact allocation ledger', () => {
    const allocations = allocatePaymentAcrossInstallments(15_000, [
      { id: 'one', lateFeeDueCents: 0, interestDueCents: 2_000, principalDueCents: 8_000 },
      { id: 'two', lateFeeDueCents: 0, interestDueCents: 2_000, principalDueCents: 8_000 },
    ])

    expect(allocations).toEqual([
      { installmentId: 'one', type: 'interest', amountCents: 2_000 },
      { installmentId: 'one', type: 'principal', amountCents: 8_000 },
      { installmentId: 'two', type: 'interest', amountCents: 2_000 },
      { installmentId: 'two', type: 'principal', amountCents: 3_000 },
    ])
    expect(allocations.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(15_000)
  })

  it('collects late fees first and rejects amounts above the outstanding balance', () => {
    expect(allocatePaymentAcrossInstallments(500, [
      { id: 'one', lateFeeDueCents: 200, interestDueCents: 100, principalDueCents: 500 },
    ])).toEqual([
      { installmentId: 'one', type: 'late_fee', amountCents: 200 },
      { installmentId: 'one', type: 'interest', amountCents: 100 },
      { installmentId: 'one', type: 'principal', amountCents: 200 },
    ])
    expect(() => allocatePaymentAcrossInstallments(801, [
      { id: 'one', lateFeeDueCents: 200, interestDueCents: 100, principalDueCents: 500 },
    ])).toThrow('Payment exceeds the outstanding agreement balance')
  })
})
