export type SaleStockLine = {
  productId: string
  quantity: number
}

export type SaleInventoryItem = {
  id: string
  name: string
  stock_quantity: number
}

export type SaleStockIssue = {
  productId: string
  productName: string
  available: number
}

export function findSaleStockIssues(
  lines: readonly SaleStockLine[],
  inventory: readonly SaleInventoryItem[],
): SaleStockIssue[] {
  const requested = new Map<string, bigint>()
  for (const line of lines) {
    if (!line.productId || !Number.isSafeInteger(line.quantity) || line.quantity < 1) continue
    requested.set(line.productId, (requested.get(line.productId) ?? 0n) + BigInt(line.quantity))
  }

  const inventoryById = new Map(inventory.map((item) => [item.id, item]))
  const issues: SaleStockIssue[] = []
  for (const [productId, quantity] of requested) {
    const product = inventoryById.get(productId)
    if (!product || quantity > BigInt(product.stock_quantity)) {
      issues.push({
        productId,
        productName: product?.name ?? 'Selected product',
        available: product?.stock_quantity ?? 0,
      })
    }
  }
  return issues
}
