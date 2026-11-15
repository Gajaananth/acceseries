import { jsPDF } from 'jspdf'
import { useQuery } from '@tanstack/react-query'
import { Download, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { apiRequest } from '../../lib/api'
import { useAuth } from '../auth/authContext'
import { ErrorMessage, PageHeading } from '../dashboard/DashboardPage'

const reportOptions = [
  ['sales', 'Sales by period'],
  ['balances', 'Outstanding balances'],
  ['late_fees', 'Late-fee collections'],
  ['overdue', 'Overdue installments'],
  ['collections', 'Collections'],
  ['inventory', 'Inventory valuation'],
  ['low_stock', 'Low stock'],
  ['discounts', 'Discount approvals'],
  ['expenses', 'Expenses'],
  ['profit', 'Estimated profit'],
] as const

type ReportType = typeof reportOptions[number][0]
type ReportColumn = { key: string; label: string; format: 'date' | 'money' | 'number' | 'text' }
type ReportData = { report_type: ReportType; from: string; to: string; columns: ReportColumn[]; rows: Record<string, unknown>[] }
const reportCurrency = new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR' })

function localDate(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function cellValue(value: unknown, format: ReportColumn['format']): string {
  if (value === null || value === undefined || value === '') return '—'
  if (format === 'money') {
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value))
    if (!match) return 'Invalid amount'
    const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0')
    const signedCents = match[1] === '-' ? -cents : cents
    const signedNumber = Number(signedCents)
    if (!Number.isSafeInteger(signedNumber)) return 'Amount out of range'
    return reportCurrency.format(signedNumber / 100)
  }
  if (format === 'date') return new Date(String(value)).toLocaleDateString('en-LK')
  if (typeof value === 'number') return value.toLocaleString('en-LK')
  return String(value)
}

function csvEscape(value: unknown): string {
  const rawText = value === null || value === undefined ? '' : String(value)
  const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText
  return `"${text.replace(/"/g, '""')}"`
}

export function ReportsPage() {
  const { user } = useAuth()
  const permittedReports = useMemo(
    () => reportOptions.filter(([type]) => user?.permissions.includes(`reports:${type}`) || user?.role === 'owner'),
    [user],
  )
  const [reportType, setReportType] = useState<ReportType>(permittedReports[0]?.[0] ?? 'sales')
  const [from, setFrom] = useState(() => {
    const now = new Date()
    return localDate(new Date(now.getFullYear(), now.getMonth(), 1))
  })
  const [to, setTo] = useState(() => localDate(new Date()))
  const report = useQuery({
    queryKey: ['reports', reportType, from, to],
    queryFn: () => apiRequest<ReportData>(`/api/reports?type=${reportType}&from=${from}&to=${to}`),
    enabled: permittedReports.some(([type]) => type === reportType) && from <= to,
  })

  const exportCsv = () => {
    if (!report.data) return
    const lines = [
      report.data.columns.map((column) => csvEscape(column.label)).join(','),
      ...report.data.rows.map((row) => report.data!.columns.map((column) => csvEscape(row[column.key])).join(',')),
    ]
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${reportType}-${from}-to-${to}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportPdf = () => {
    if (!report.data) return
    const pdf = new jsPDF({ orientation: report.data.columns.length > 5 ? 'landscape' : 'portrait' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    pdf.setFontSize(16)
    pdf.text(reportOptions.find(([type]) => type === reportType)?.[1] ?? 'Report', 14, 18)
    pdf.setFontSize(9)
    pdf.text(`${from} to ${to}`, 14, 25)
    const columnWidth = (pageWidth - 28) / report.data.columns.length
    let y = 35
    const drawHeaders = () => {
      pdf.setFont('helvetica', 'bold')
      report.data!.columns.forEach((column, index) => {
        pdf.text(column.label.slice(0, 24), 14 + index * columnWidth, y, { maxWidth: columnWidth - 2 })
      })
      pdf.setFont('helvetica', 'normal')
      y += 7
    }
    drawHeaders()
    for (const row of report.data.rows) {
      const cells = report.data.columns.map((column) => cellValue(row[column.key], column.format))
      const wrapped = cells.map((value) => pdf.splitTextToSize(value, columnWidth - 2) as string[])
      const rowHeight = Math.max(7, ...wrapped.map((lines) => lines.length * 4))
      if (y + rowHeight > pdf.internal.pageSize.getHeight() - 12) {
        pdf.addPage()
        y = 15
        drawHeaders()
      }
      wrapped.forEach((lines, index) => {
        pdf.text(lines, 14 + index * columnWidth, y, { maxWidth: columnWidth - 2 })
      })
      y += rowHeight
    }
    pdf.save(`${reportType}-${from}-to-${to}.pdf`)
  }

  return (
    <div className="space-y-6">
      <PageHeading title="Reports" description="Operational and financial reports from your store records." />
      {permittedReports.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-600">Your account does not have permission to view reports.</p>
      ) : (
        <>
          <section className="glass-panel grid min-w-0 gap-4 rounded-[26px] p-5 sm:grid-cols-2 xl:grid-cols-4">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Report
              <select value={reportType} onChange={(event) => setReportType(event.target.value as ReportType)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base">
                {permittedReports.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">From<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base" /></label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">To<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base" /></label>
            <div className="flex items-end gap-2">
              <button type="button" disabled={!report.data} onClick={exportCsv} className="soft-button inline-flex min-h-11 items-center gap-2 disabled:opacity-50"><Download size={16} /> CSV</button>
              <button type="button" disabled={!report.data} onClick={exportPdf} className="soft-button inline-flex min-h-11 items-center gap-2 disabled:opacity-50"><FileText size={16} /> PDF</button>
            </div>
          </section>
          {from > to && <p role="alert" className="text-sm text-red-700">Choose a valid date range.</p>}
          {report.isPending && <div className="h-48 animate-pulse rounded-[26px] bg-slate-200" />}
          {report.isError && <ErrorMessage message={report.error.message} />}
          {report.data && (
            <section className="glass-panel min-w-0 rounded-[26px] p-5">
              <h3 className="mb-4 font-bold text-slate-900">{reportOptions.find(([type]) => type === reportType)?.[1]} <span className="font-normal text-slate-500">· {from} – {to}</span></h3>
              {report.data.rows.length === 0 ? (
                <p className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">No records match this report and date range.</p>
              ) : (
                <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr>{report.data.columns.map((column) => <th key={column.key} className="whitespace-nowrap px-4 py-3">{column.label}</th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">{report.data.rows.map((row, index) => <tr key={index} className="bg-white">{report.data!.columns.map((column) => <td key={column.key} className="max-w-64 px-4 py-3 text-slate-700">{cellValue(row[column.key], column.format)}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
