import { describe, expect, it } from 'vitest'
import {
  allocatePaymentCents,
  calculateLateFeeCents,
  calculatePeriodicInstallments,
  centsToDatabaseDecimal,
  databaseDecimalToCents,
  formatLkr,
  getStockStatus,
  parseLkrToCents,
} from '../src/shared/business.ts'

describe('shared business utilities', () => {
  it('parses and serializes LKR values without floating-point arithmetic', () => {
    expect(parseLkrToCents('14,999.50')).toBeNull()
    expect(parseLkrToCents('14999.5')).toBe(1_499_950)
    expect(parseLkrToCents('14999.50')).toBe(1_499_950)
    expect(parseLkrToCents('1.234')).toBeNull()
    expect(centsToDatabaseDecimal(1_499_950)).toBe('14999.50')
    expect(databaseDecimalToCents('14999.50')).toBe(1_499_950)
    expect(formatLkr(1_499_950)).toMatch(/LKR|Rs/)
  })

  it('derives stock status from stock and reorder threshold', () => {
    expect(getStockStatus(0, 10)).toBe('critical')
    expect(getStockStatus(10, 10)).toBe('low')
    expect(getStockStatus(11, 10)).toBe('healthy')
  })

  it('splits installment cents exactly, retaining all cents', () => {
    const schedule = calculatePeriodicInstallments(1_000, 3)
    expect(schedule).toEqual([334, 333, 333])
    expect(schedule.reduce((sum, amount) => sum + amount, 0)).toBe(1_000)
  })

  it('calculates only chargeable late-fee days and allocates payment by priority', () => {
    expect(calculateLateFeeCents(125, 5, 3)).toBe(250)
    expect(allocatePaymentCents(800, 200, 500)).toEqual({
      lateFeeCents: 200,
      installmentCents: 500,
      unappliedCents: 100,
    })
  })
})
