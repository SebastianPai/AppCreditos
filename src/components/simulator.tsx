'use client';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatCOP, formatDate, FREQUENCY_LABEL, parsePesos, type Frequency, type LoanTerms } from '@/lib/finance';
import type { ActionResult } from '@/lib/errors';
import { isoDate } from '@/lib/validation';
import { SubmitButton } from './action-form';
import { Notice } from './ui';

type Action = (state: ActionResult, fd: FormData) => Promise<ActionResult>;
type PublicTerms = Omit<LoanTerms, 'collectorCommissionTotal' | 'partnersPoolTotal'>;
interface Preview {
  policy: { interestBps: number; maxInstallments: number; biweeklyMinPrincipal: number };
  allowedFrequencies: Frequency[];
  options: Partial<Record<Frequency, PublicTerms>>;
}

const formSchema = z.object({
  principalText: z
    .string()
    .refine((v) => (parsePesos(v) ?? 0) > 0, 'Ingrese el importe que desea solicitar'),
  installments: z.coerce.number().int().min(1).max(5),
  frequency: z.enum(['weekly', 'biweekly']),
  startDate: isoDate,
});
type FormValues = z.input<typeof formSchema>;

export function Simulator({
  today,
  saveAction,
  applyAction,
  canApply,
}: {
  today: string;
  saveAction: Action;
  applyAction?: Action;
  canApply: boolean;
}) {
  const { register, control, setValue, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: { principalText: '600.000', installments: 4, frequency: 'weekly', startDate: today },
  });
  const values = useWatch({ control });
  const principal = parsePesos(values.principalText ?? '') ?? 0;
  const installments = Number(values.installments ?? 4);
  const frequency = (values.frequency ?? 'weekly') as Frequency;
  const startDate = values.startDate ?? today;

  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Recalcula en el servidor cada vez que cambian los campos (con un breve retardo).
  useEffect(() => {
    if (principal <= 0 || !startDate) {
      setPreview(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/simulate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ principal, installments, startDate }),
          signal: ctrl.signal,
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? 'No fue posible calcular');
          setPreview(null);
        } else {
          setError('');
          setPreview(json);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError('Sin conexión con el servidor. La simulación requiere Internet.');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [principal, installments, startDate]);

  const allowed = preview?.allowedFrequencies ?? ['weekly'];
  useEffect(() => {
    if (preview && !allowed.includes(frequency)) setValue('frequency', 'weekly', { shouldValidate: true });
  }, [preview, allowed, frequency, setValue]);

  const terms = preview?.options[frequency] ?? preview?.options.weekly;
  const maxInstallments = preview?.policy.maxInstallments ?? 5;
  const ratePct = preview ? preview.policy.interestBps / 100 : 20;

  const [saveState, save] = useActionState(saveAction, { ok: true } as ActionResult);
  const [applyState, apply] = useActionState(applyAction ?? saveAction, { ok: true } as ActionResult);
  const hidden = useMemo(
    () => (
      <>
        <input type="hidden" name="principal" value={principal} />
        <input type="hidden" name="installments" value={installments} />
        <input type="hidden" name="frequency" value={frequency} />
        <input type="hidden" name="startDate" value={startDate} />
      </>
    ),
    [principal, installments, frequency, startDate],
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_1fr]">
      <form className="card space-y-4" onSubmit={(e) => e.preventDefault()} noValidate>
        <div>
          <label className="label" htmlFor="principal">¿Cuánto dinero necesita?</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-500">$</span>
            <input
              id="principal"
              inputMode="numeric"
              autoComplete="off"
              className="input pl-7 text-lg font-semibold"
              {...register('principalText', {
                onChange: (e) => {
                  const n = parsePesos(e.target.value);
                  e.target.value = n ? new Intl.NumberFormat('es-CO').format(n) : '';
                },
              })}
            />
          </div>
          {formState.errors.principalText && <p className="field-error">{formState.errors.principalText.message}</p>}
        </div>

        <fieldset>
          <legend className="label">Número de cuotas</legend>
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: maxInstallments }, (_, i) => i + 1).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={installments === k}
                onClick={() => setValue('installments', k, { shouldValidate: true })}
                className={`btn-secondary !px-0 ${installments === k ? '!border-brand-600 !bg-brand-50 !text-brand-700' : ''}`}
              >
                {k}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="label">Modalidad de pago</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['weekly', 'biweekly'] as const).map((f) => {
              const disabled = !allowed.includes(f);
              return (
                <label
                  key={f}
                  className={`btn-secondary cursor-pointer ${frequency === f ? '!border-brand-600 !bg-brand-50 !text-brand-700' : ''} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                >
                  <input type="radio" value={f} className="sr-only" disabled={disabled} {...register('frequency')} />
                  {FREQUENCY_LABEL[f]}
                </label>
              );
            })}
          </div>
          {preview && !allowed.includes('biweekly') && (
            <p className="mt-1 text-xs text-slate-500">La modalidad quincenal está disponible desde {formatCOP(preview.policy.biweeklyMinPrincipal)}.</p>
          )}
        </fieldset>

        <div>
          <label className="label" htmlFor="startDate">Fecha de inicio propuesta</label>
          <input id="startDate" type="date" min={today} className="input" {...register('startDate')} />
          <p className="mt-1 text-xs text-slate-500">La primera cuota vence {frequency === 'weekly' ? '7' : '15'} días después.</p>
        </div>
      </form>

      <div className="space-y-4" aria-live="polite">
        {error && <Notice tone="danger">{error}</Notice>}
        {!terms && !error && <div className="card text-sm text-slate-500">{loading ? 'Calculando…' : 'Ingrese un importe para ver la simulación.'}</div>}
        {terms && (
          <>
            <section className={`card ${loading ? 'opacity-60' : ''}`}>
              <h2 className="mb-3 text-base font-semibold">Resultado de la simulación</h2>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Item label="Capital solicitado" value={formatCOP(terms.principal)} />
                <Item label={`Interés total (${ratePct} %)`} value={formatCOP(terms.interestTotal)} />
                <Item label="Total a pagar" value={formatCOP(terms.totalAmount)} strong />
                <Item label="Número de cuotas" value={String(terms.installmentsCount)} />
                <Item
                  label="Valor de cada cuota"
                  value={
                    terms.schedule[0].total === terms.schedule[terms.schedule.length - 1].total
                      ? formatCOP(terms.schedule[0].total)
                      : `${formatCOP(terms.schedule[terms.schedule.length - 1].total)} – ${formatCOP(terms.schedule[0].total)}`
                  }
                  strong
                />
                <Item label="Frecuencia" value={FREQUENCY_LABEL[terms.frequency]} />
              </dl>
            </section>

            <section className="card">
              <h2 className="mb-2 text-base font-semibold">Calendario estimado</h2>
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Vence</th>
                      <th className="num">Capital</th>
                      <th className="num">Interés</th>
                      <th className="num">Cuota</th>
                      <th className="num">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {terms.schedule.map((r) => (
                      <tr key={r.number}>
                        <td>{r.number}</td>
                        <td className="whitespace-nowrap">{formatDate(r.dueDate)}</td>
                        <td className="num">{formatCOP(r.principal)}</td>
                        <td className="num">{formatCOP(r.interest)}</td>
                        <td className="num font-semibold">{formatCOP(r.total)}</td>
                        <td className="num">{formatCOP(r.balanceAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="mt-4 mb-2 text-sm font-semibold text-slate-700">Distribución ilustrativa del interés por cuota</h3>
              <ul className="space-y-1.5">
                {terms.schedule.map((r) => (
                  <li key={r.number} className="flex items-center gap-2 text-xs">
                    <span className="w-14 shrink-0 text-slate-500">Cuota {r.number}</span>
                    <span className="h-2.5 rounded-full bg-brand-500" style={{ width: `${Math.max(4, (r.interest / Math.max(terms.interestTotal, 1)) * 100)}%` }} />
                    <span className="tabular-nums">{formatCOP(r.interest)}</span>
                  </li>
                ))}
              </ul>
            </section>

            {preview && preview.allowedFrequencies.length > 1 && preview.options.weekly && preview.options.biweekly && (
              <section className="card">
                <h2 className="mb-2 text-base font-semibold">Comparar modalidades ({installments} cuotas)</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {(['weekly', 'biweekly'] as const).map((f) => {
                    const t = preview.options[f]!;
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setValue('frequency', f)}
                        className={`rounded-xl border p-3 text-left ${frequency === f ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
                      >
                        <p className="font-semibold">{FREQUENCY_LABEL[f]}</p>
                        <p className="mt-1 text-lg font-bold tabular-nums">{formatCOP(t.schedule[0].total)}</p>
                        <p className="text-xs text-slate-500">por cuota · total {formatCOP(t.totalAmount)}</p>
                        <p className="mt-1 text-xs text-slate-500">Última cuota: {formatDate(t.schedule[t.schedule.length - 1].dueDate)}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <Notice tone="warning" title="Importante">
              Esta simulación es informativa. No representa una aprobación, no crea una deuda, no reserva capital y no implica desembolso. Las condiciones
              finales las aprueba la administración.
            </Notice>

            <div className="no-print flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <form action={save}>
                {hidden}
                <SubmitButton variant="secondary" className="w-full sm:w-auto">Generar informe (imprimir / PDF)</SubmitButton>
              </form>
              {canApply && applyAction ? (
                <form action={apply} className="flex-1 space-y-2">
                  {hidden}
                  <textarea name="message" maxLength={500} rows={2} className="input" placeholder="Mensaje para la administración (opcional)" />
                  <SubmitButton className="w-full sm:w-auto">Solicitar préstamo</SubmitButton>
                </form>
              ) : null}
            </div>
            {!saveState.ok && <p className="field-error">{saveState.error}</p>}
            {!applyState.ok && <p className="field-error">{applyState.error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Item({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${strong ? 'text-lg font-bold text-brand-700' : 'font-semibold'}`}>{value}</dd>
    </div>
  );
}
