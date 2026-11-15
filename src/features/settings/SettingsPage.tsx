import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { FormField } from '../../components/ui/FormField'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { apiRequest } from '../../lib/api'
import { databaseDecimalToCents } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'

type SettingsResponse = {
  default_daily_interest: string
  default_weekly_interest: string
  default_monthly_interest: string
  default_grace_period_days: number
  fixed_late_fee: string
  daily_late_fee: string
  maximum_late_fee: string
  early_settlement_discount_type: 'fixed' | 'interest_percentage'
  early_settlement_fixed_discount: string
  early_settlement_interest_discount_percent: number
}

const moneyCents = z.number().int().min(0).max(999_999_999_999).nullable()
const settingsFormSchema = z.object({
  default_daily_interest_cents: moneyCents,
  default_weekly_interest_cents: moneyCents,
  default_monthly_interest_cents: moneyCents,
  default_grace_period_days: z.number().int().min(0).max(2_147_483_647),
  fixed_late_fee_cents: moneyCents,
  daily_late_fee_cents: moneyCents,
  maximum_late_fee_cents: moneyCents,
  early_settlement_discount_type: z.enum(['fixed', 'interest_percentage']),
  early_settlement_fixed_discount_cents: z.number().int().min(0).max(999_999_999_999).nullable(),
  early_settlement_interest_discount_percent: z.number().int().min(0).max(100),
})

type SettingsFormValues = z.infer<typeof settingsFormSchema>

const fields = [
  { name: 'default_daily_interest_cents', label: 'Default fixed interest — Daily' },
  { name: 'default_weekly_interest_cents', label: 'Default fixed interest — Weekly' },
  { name: 'default_monthly_interest_cents', label: 'Default fixed interest — Monthly' },
  { name: 'fixed_late_fee_cents', label: 'Fixed late fee' },
  { name: 'daily_late_fee_cents', label: 'Daily late fee' },
  { name: 'maximum_late_fee_cents', label: 'Maximum late fee' },
] as const
const earlySettlementDiscountOptions = [
  { value: 'fixed', label: 'Fixed amount' },
  { value: 'interest_percentage', label: '% of remaining interest' },
] as const

export function SettingsPage() {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['application-settings'],
    queryFn: () => apiRequest<SettingsResponse>('/api/application-settings'),
  })
  const {
    control,
    handleSubmit,
    register,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      default_daily_interest_cents: null,
      default_weekly_interest_cents: null,
      default_monthly_interest_cents: null,
      default_grace_period_days: 0,
      fixed_late_fee_cents: null,
      daily_late_fee_cents: null,
      maximum_late_fee_cents: null,
      early_settlement_discount_type: 'fixed',
      early_settlement_fixed_discount_cents: null,
      early_settlement_interest_discount_percent: 0,
    },
  })
  const watchedEarlySettlementType = useWatch({
    control,
    name: 'early_settlement_discount_type',
  })
  const saveSettings = useMutation({
    mutationFn: (values: SettingsFormValues) => apiRequest<SettingsResponse>('/api/application-settings', {
      method: 'PUT',
      body: JSON.stringify({
        ...values,
        default_daily_interest_cents: values.default_daily_interest_cents ?? 0,
        default_weekly_interest_cents: values.default_weekly_interest_cents ?? 0,
        default_monthly_interest_cents: values.default_monthly_interest_cents ?? 0,
        fixed_late_fee_cents: values.fixed_late_fee_cents ?? 0,
        daily_late_fee_cents: values.daily_late_fee_cents ?? 0,
        maximum_late_fee_cents: values.maximum_late_fee_cents ?? 0,
        early_settlement_discount_type: values.early_settlement_discount_type,
        early_settlement_fixed_discount_cents: values.early_settlement_fixed_discount_cents ?? 0,
        early_settlement_interest_discount_percent: values.early_settlement_interest_discount_percent,
      }),
    }),
    onSuccess: async (saved) => {
      reset({
        default_daily_interest_cents: databaseDecimalToCents(saved.default_daily_interest),
        default_weekly_interest_cents: databaseDecimalToCents(saved.default_weekly_interest),
        default_monthly_interest_cents: databaseDecimalToCents(saved.default_monthly_interest),
        default_grace_period_days: saved.default_grace_period_days,
        fixed_late_fee_cents: databaseDecimalToCents(saved.fixed_late_fee),
        daily_late_fee_cents: databaseDecimalToCents(saved.daily_late_fee),
        maximum_late_fee_cents: databaseDecimalToCents(saved.maximum_late_fee),
        early_settlement_discount_type: saved.early_settlement_discount_type,
        early_settlement_fixed_discount_cents: databaseDecimalToCents(saved.early_settlement_fixed_discount),
        early_settlement_interest_discount_percent: saved.early_settlement_interest_discount_percent,
      })
      await queryClient.invalidateQueries({ queryKey: ['agreement-defaults'] })
      await queryClient.invalidateQueries({ queryKey: ['application-settings'] })
    },
  })

  useEffect(() => {
    if (!settings.data || isDirty) return
    reset({
      default_daily_interest_cents: databaseDecimalToCents(settings.data.default_daily_interest),
      default_weekly_interest_cents: databaseDecimalToCents(settings.data.default_weekly_interest),
      default_monthly_interest_cents: databaseDecimalToCents(settings.data.default_monthly_interest),
      default_grace_period_days: settings.data.default_grace_period_days,
      fixed_late_fee_cents: databaseDecimalToCents(settings.data.fixed_late_fee),
      daily_late_fee_cents: databaseDecimalToCents(settings.data.daily_late_fee),
      maximum_late_fee_cents: databaseDecimalToCents(settings.data.maximum_late_fee),
      early_settlement_discount_type: settings.data.early_settlement_discount_type,
      early_settlement_fixed_discount_cents: databaseDecimalToCents(settings.data.early_settlement_fixed_discount),
      early_settlement_interest_discount_percent: settings.data.early_settlement_interest_discount_percent,
    })
  }, [isDirty, reset, settings.data])

  if (settings.isPending) return <Loading />
  if (settings.isError) return <ErrorMessage message={settings.error.message} />

  return (
    <div className="space-y-6">
      <PageHeading title="Settings" description="Set owner-managed agreement interest and late-fee defaults." />
      <form className="min-w-0 space-y-6" onSubmit={handleSubmit((values) => saveSettings.mutate(values))}>
        <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <h3 className="text-lg font-extrabold text-slate-900">Default fixed interest</h3>
          <p className="mt-1 text-sm text-slate-500">Each agreement saves its own interest amount when created.</p>
          <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            {fields.slice(0, 3).map(({ name, label }) => (
              <Controller
                key={name}
                name={name}
                control={control}
                render={({ field }) => (
                  <FormField label={label} error={errors[name]?.message}>
                    <MoneyInput cents={field.value} onChange={field.onChange} />
                  </FormField>
                )}
              />
            ))}
          </div>
        </section>
        <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <h3 className="text-lg font-extrabold text-slate-900">Early settlement discount</h3>
          <p className="mt-1 text-sm text-slate-500">The discount is capped at outstanding scheduled interest. Principal and paid interest are never discounted or refunded.</p>
          <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="Discount method">
              <Controller
                name="early_settlement_discount_type"
                control={control}
                render={({ field }) => (
                  <SegmentedControl
                    value={field.value}
                    onChange={field.onChange}
                    ariaLabel="Early settlement discount method"
                    options={earlySettlementDiscountOptions}
                  />
                )}
              />
            </FormField>
            {watchedEarlySettlementType === 'fixed' ? (
              <Controller
                name="early_settlement_fixed_discount_cents"
                control={control}
                render={({ field }) => (
                  <FormField label="Fixed discount (LKR)" error={errors.early_settlement_fixed_discount_cents?.message}>
                    <MoneyInput cents={field.value} onChange={field.onChange} />
                  </FormField>
                )}
              />
            ) : (
              <FormField label="Percentage of remaining interest" error={errors.early_settlement_interest_discount_percent?.message}>
                <input type="number" min={0} max={100} step={1} className="field-input" {...register('early_settlement_interest_discount_percent', { valueAsNumber: true })} />
              </FormField>
            )}
          </div>
        </section>
        <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <h3 className="text-lg font-extrabold text-slate-900">Late-fee policy</h3>
          <p className="mt-1 text-sm text-slate-500">These values are snapshotted onto new agreements and do not alter existing ones.</p>
          <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="Default grace period (days)" error={errors.default_grace_period_days?.message}>
              <input
                type="number"
                min={0}
                step={1}
                className="field-input"
                {...register('default_grace_period_days', { valueAsNumber: true })}
              />
            </FormField>
            {fields.slice(3).map(({ name, label }) => (
              <Controller
                key={name}
                name={name}
                control={control}
                render={({ field }) => (
                  <FormField label={label} error={errors[name]?.message}>
                    <MoneyInput cents={field.value} onChange={field.onChange} />
                  </FormField>
                )}
              />
            ))}
          </div>
        </section>
        {saveSettings.isError && <ErrorMessage message={saveSettings.error.message} />}
        {saveSettings.isSuccess && <p role="status" className="text-sm font-medium text-emerald-700">Settings saved.</p>}
        <div className="flex justify-end">
          <button type="submit" disabled={saveSettings.isPending} className="rounded-2xl bg-[#247BDB] px-5 py-3 text-sm font-semibold text-white disabled:opacity-60">
            {saveSettings.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  )
}
