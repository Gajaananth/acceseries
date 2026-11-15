import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../../components/ui/Modal'
import { FormField } from '../../components/ui/FormField'
import { apiRequest } from '../../lib/api'
import { databaseDecimalToCents, formatLkr } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'

type Customer = {
  id: string
  full_name: string
  phone: string
  current_balance: string
  status: 'active' | 'on_track' | 'overdue'
}

export function CustomersPage({ search }: { search: string }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => apiRequest<Customer[]>('/api/customers'),
  })
  const createCustomer = useMutation({
    mutationFn: (customer: Pick<Customer, 'full_name' | 'phone'>) =>
      apiRequest<Customer>('/api/customers', {
        method: 'POST',
        body: JSON.stringify(customer),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      setName('')
      setPhone('')
      setFormOpen(false)
    },
  })
  const filtered = (customers.data ?? []).filter((customer) =>
    `${customer.full_name} ${customer.phone}`.toLowerCase().includes(search.toLowerCase()),
  )

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    createCustomer.mutate({ full_name: name.trim(), phone: phone.trim() })
  }

  return (
    <div className="space-y-6">
      <PageHeading title="Customers" description="Store customer records used by installment agreements." />
      <div className="flex min-w-0 justify-end">
        <button type="button" onClick={() => setFormOpen(true)} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700">Add customer</button>
      </div>
      <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h3 className="mb-4 text-xl font-extrabold text-slate-900">Customer list</h3>
        {customers.isPending ? <Loading /> : customers.isError ? <ErrorMessage message={customers.error.message} /> : (
          <div className="w-full min-w-0 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead><tr className="border-b border-slate-200 text-slate-500">
                <th className="py-3 pr-4 font-medium">Customer</th><th className="py-3 pr-4 font-medium">Balance (LKR)</th><th className="py-3 pr-4 font-medium">Status</th>
              </tr></thead>
              <tbody>{filtered.map((customer) => (
                <tr key={customer.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-4 pr-4"><p className="font-semibold text-slate-900">{customer.full_name}</p><p className="text-xs text-slate-500">{customer.phone}</p></td>
                  <td className="py-4 pr-4 font-semibold text-slate-900">{formatLkr(databaseDecimalToCents(customer.current_balance))}</td>
                  <td className="py-4 pr-4 capitalize text-slate-600">{customer.status.replace('_', ' ')}</td>
                </tr>
              ))}</tbody>
            </table>
            {filtered.length === 0 && <p className="py-5 text-sm text-slate-500">No matching customers.</p>}
          </div>
        )}
      </section>
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="Add customer"
        description="Enter the customer details used for agreements."
        footer={
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" onClick={() => setFormOpen(false)} className="soft-button">Cancel</button>
            <button form="customer-form" disabled={createCustomer.isPending} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" type="submit">
              {createCustomer.isPending ? 'Saving…' : 'Save customer'}
            </button>
          </div>
        }
      >
        <form id="customer-form" className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
          <FormField label="Full name">
            <input value={name} onChange={(event) => setName(event.target.value)} className="field-input" minLength={2} required />
          </FormField>
          <FormField label="Phone">
            <input value={phone} onChange={(event) => setPhone(event.target.value)} className="field-input" type="tel" minLength={8} required />
          </FormField>
          {createCustomer.isError && <div className="md:col-span-2"><ErrorMessage message={createCustomer.error.message} /></div>}
        </form>
      </Modal>
    </div>
  )
}
