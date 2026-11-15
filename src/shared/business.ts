export type StockStatus = 'healthy' | 'low' | 'critical'
const MAX_LKR_CENTS = 999_999_999_999
export {
  allocatePaymentCents,
  calculateLateFeeCents,
  calculatePeriodicInstallments,
} from '../lib/installments/calculations'

export function parseLkrToCents(value: string): number | null {
  const match = /^\s*(0|[1-9]\d*)(?:\.(\d{1,2}))?\s*$/.exec(value)
  if (!match) return null

  const rupees = BigInt(match[1])
  const cents = BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  const amount = rupees * 100n + cents
  return amount <= BigInt(MAX_LKR_CENTS) ? Number(amount) : null
}

export function centsToDatabaseDecimal(cents: number): string {
  assertNonNegativeCents(cents)
  if (cents > MAX_LKR_CENTS) throw new RangeError('Amount exceeds numeric(12,2) range')
  const whole = Math.floor(cents / 100)
  const fraction = cents % 100
  return `${whole}.${fraction.toString().padStart(2, '0')}`
}

export function databaseDecimalToCents(value: string): number {
  const cents = parseLkrToCents(value)
  if (cents === null) throw new RangeError('Database returned an invalid LKR amount')
  return cents
}

export function formatLkr(cents: number): string {
  assertNonNegativeCents(cents)
  return new Intl.NumberFormat('en-LK', {
    style: 'currency',
    currency: 'LKR',
  }).format(cents / 100)
}

export function getStockStatus(stockQuantity: number, reorderLevel: number): StockStatus {
  if (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 ||
      !Number.isSafeInteger(reorderLevel) || reorderLevel < 0) {
    throw new RangeError('Stock quantities must be non-negative safe integers')
  }
  if (stockQuantity === 0) return 'critical'
  if (stockQuantity <= reorderLevel) return 'low'
  return 'healthy'
}

function assertNonNegativeCents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('LKR cents must be a non-negative safe integer')
  }
}
