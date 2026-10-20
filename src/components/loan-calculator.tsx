'use client';
import { useActionState, useState } from 'react';
import type { ActionResult } from '@/lib/errors';
import { allowedFrequencies, buildSchedule, formatCOP, formatDate, installmentOptions, parsePesos, type Frequency } from '@/lib/finance';
import { SubmitButton } from './action-form';

type Action = (state: ActionResult, fd: FormData) => Promise<ActionResult>;

const EVERY: Record<Frequency, string> = { weekly: 'cada semana', biweekly: 'cada 15 días' };
const QUICK = [200_000, 300_000, 500_000, 600_000, 1_000_000];

/**
 * Formulario simple de préstamo: monto, número de cuotas y cada cuánto se paga.
 * Muestra solo valores en pesos (sin porcentajes). Con `customers` crea el préstamo;
 * sin ellos funciona como simulador (y con `action` envía la solicitud).
 */
export function LoanCalculator({
  today,
  action,
  submitLabel,
  customers,
  defaultCustomer,
}: {
  today: string;
  action?: Action;
  submitLabel?: string;
  customers?: { id: string; full_name: string }[];
  defaultCustomer?: string;
}) {
  const [text, setText] = useState('');
  const [installments, setInstallments] = useState(4);
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [state, formAction] = useActionState(action ?? (async () => ({ ok: true }) as ActionResult), { ok: true } as ActionResult);

  const principal = parsePesos(text) ?? 0;
  const freqs = principal > 0 ? allowedFrequencies(principal) : (['weekly'] as Frequency[]);
  const freq = freqs.includes(frequency) ? frequency : 'weekly';
  const schedule = principal > 0 ? buildSchedule(principal, installments, freq, today) : [];
  const total = schedule.reduce((s, r) => s + r.total, 0);

  return (
    <form action={formAction} className="space-y-4">
      {customers && (
        <div>
          <label className="label" htmlFor="customer_id">Cliente</label>
          <select id="customer_id" name="customer_id" required defaultValue={defaultCustomer ?? ''} className="input">
            <option value="" disabled>Elija el cliente</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="label" htmlFor="principal">¿Cuánto dinero?</label>
        <input id="principal" name="principal" inputMode="numeric" required placeholder="$ 0" className="input text-lg font-semibold"
          value={text} onChange={(e) => { const v = parsePesos(e.target.value); setText(v ? v.toLocaleString('es-CO') : ''); }} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK.map((v) => (
            <button key={v} type="button" onClick={() => setText(v.toLocaleString('es-CO'))} className="btn-secondary btn-sm">{formatCOP(v)}</button>
          ))}
        </div>
      </div>
      <div>
        <p className="label">¿En cuántas cuotas?</p>
        <div className="grid grid-cols-2 gap-2">
          {installmentOptions().map((n) => (
            <button key={n} type="button" onClick={() => setInstallments(n)} className={n === installments ? 'btn-primary' : 'btn-secondary'}>{n} cuotas</button>
          ))}
        </div>
        <input type="hidden" name="installments" value={installments} />
      </div>
      <div>
        <p className="label">¿Cada cuánto paga?</p>
        <div className="grid grid-cols-2 gap-2">
          {(['weekly', 'biweekly'] as Frequency[]).map((f) => (
            <button key={f} type="button" disabled={!freqs.includes(f)} onClick={() => setFrequency(f)} className={f === freq ? 'btn-primary' : 'btn-secondary'}>
              {f === 'weekly' ? 'Semanal' : 'Quincenal'}
            </button>
          ))}
        </div>
        {!freqs.includes('biweekly') && principal > 0 && <p className="mt-1 text-xs text-slate-500">Quincenal solo desde {formatCOP(500_000)}.</p>}
        <input type="hidden" name="frequency" value={freq} />
        <input type="hidden" name="startDate" value={today} />
      </div>

      {schedule.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="grid grid-cols-2 gap-3 text-center">
            <div>
              <p className="text-xs text-slate-500">Recibe</p>
              <p className="text-lg font-bold tabular-nums">{formatCOP(principal)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Paga en total</p>
              <p className="text-lg font-bold tabular-nums">{formatCOP(total)}</p>
            </div>
          </div>
          <p className="mt-3 text-center text-base">
            <strong className="tabular-nums">{installments} cuotas de {formatCOP(schedule[0].total)}</strong> {EVERY[freq]}
          </p>
          <ul className="mt-3 divide-y divide-slate-200 text-sm">
            {schedule.map((r) => (
              <li key={r.number} className="flex justify-between py-1.5">
                <span>Cuota {r.number} · {formatDate(r.dueDate)}</span>
                <span className="font-medium tabular-nums">{formatCOP(r.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {action && submitLabel && <SubmitButton className="w-full">{submitLabel}</SubmitButton>}
      {!state.ok && <p className="field-error" role="alert">{state.error}</p>}
      {state.ok && 'message' in state && state.message && <p className="text-sm text-slate-700" role="status">{state.message}</p>}
    </form>
  );
}
