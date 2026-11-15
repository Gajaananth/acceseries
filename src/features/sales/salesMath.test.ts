import { describe, expect, it } from 'vitest'
import { findSaleStockIssues } from './salesMath'

describe('sale inventory validation', () => {
  it('allows two units from five and rejects four after three remain', () => {
    const line = [{ productId: 'item-1', quantity: 2 }]
    expect(findSaleStockIssues(line, [{ id: 'item-1', name: 'Bracelet', stock_quantity: 5 }])).toEqual([])

    const issues = findSaleStockIssues(
      [{ productId: 'item-1', quantity: 4 }],
      [{ id: 'item-1', name: 'Bracelet', stock_quantity: 3 }],
    )
    expect(issues).toEqual([{ productId: 'item-1', productName: 'Bracelet', available: 3 }])
  })

  it('adds duplicate product lines before checking available stock', () => {
    const issues = findSaleStockIssues(
      [
        { productId: 'item-1', quantity: 2 },
        { productId: 'item-1', quantity: 2 },
      ],
      [{ id: 'item-1', name: 'Bracelet', stock_quantity: 3 }],
    )
    expect(issues[0]?.available).toBe(3)
  })
})
