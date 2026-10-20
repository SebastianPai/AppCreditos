'use client';
import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { formatCOP, parsePesos } from '@/lib/finance';
import type { PaymentResult } from '@/app/cobrador/actions';
import { useOnline } from './pwa';

type Mode = 'cuota' | 'todo' | 'otro';

/**
 * Registro de pago de un toque: por defecto se registra el valor de la cuota.
 * Solo si hace falta se elige «Pagó todo» u «Otro valor» (abono menor o pago adelantado).
 * Clave de idempotencia por intento: si la red falla y se reenvía, el servidor no duplica el pago.
 */
export function PaymentForm({
  loanId,
  outstanding,
  nextDue,
  action,
  admin = false,
  today,
}: {
  loanId: string;
  outstanding: number;
  nextDue: number;
  action: (state: PaymentResult, fd: FormData) => Promise<PaymentResult>;
  admin?: boolean;
  today: string;
}) {
  const [key, setKey] = useState('');
  useEffect(() => setKey(crypto.randomUUID()), []);
  const online = useOnline();
  const [state, formAction, pending] = useActionState(action, { ok: true } as PaymentResult);
  const [mode, setMode] = useState<Mode>('cuota');
  const [text, setText] = useState('');

  useEffect(() => {
    if (state.ok && state.data && !state.data.duplicate) {
      setMode('cuota');
      setText('');
      setKey(crypto.randomUUID()); // nuevo intento = nueva clave
    }
  }, [state]);

  const cuota = nextDue > 0 ? Math.min(nextDue, outstanding) : outstanding;
  const other = parsePesos(text) ?? 0;
  const amount = mode === 'cuota' ? cuota : mode === 'todo' ? outstanding : other;
  const invalid = amount <= 0 || amount > outstanding;
  const label = mode === 'cuota' ? `Pagó la cuota · ${formatCOP(cuota)}` : mode === 'todo' ? `Pagó todo · ${formatCOP(outstanding)}` : `Registrar ${other ? formatCOP(other) : 'pago'}`;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="loan_id" value={loanId} />
      <input type="hidden" name="idempotency_key" value={key} />
      <input type="hidden" name="amount" value={amount} />

      {mode === 'otro' && (
        <div>
          <label className="label" htmlFor={`amount-${loanId}`}>¿Cuánto pagó?</label>
          <input id={`amount-${loanId}`} inputMode="numeric" autoComplete="off" autoFocus placeholder="$ 0" className="input text-lg font-semibold"
            value={text} onChange={(e) => { const n = parsePesos(e.target.value); setText(n ? n.toLocaleString('es-CO') : ''); }} />
          {other > outstanding && <p className="field-error">No puede ser más de lo que debe ({formatCOP(outstanding)}).</p>}
          {other > 0 && other < cuota && <p className="mt-1 text-xs text-slate-500">Queda como abono: faltan {formatCOP(cuota - other)} para completar la cuota.</p>}
          {other > cuota && other < outstanding && <p className="mt-1 text-xs text-slate-500">Lo que pasa de la cuota se abona a las siguientes.</p>}
          <input name="notes" maxLength={300} placeholder="Nota (opcional)" className="input mt-2" aria-label="Nota" />
        </div>
      )}

      {admin && (
        <div className="grid grid-cols-2 gap-2">
          <select name="method" className="input" defaultValue="cash" aria-label="Medio">
            <option value="cash">Efectivo (caja)</option>
            <option value="transfer">Transferencia verificada</option>
            <option value="qr">QR verificado</option>
          </select>
          <input type="date" name="received_on" max={today} defaultValue={today} className="input" aria-label="Fecha" />
        </div>
      )}

      <button type="submit" className="btn-primary !min-h-14 w-full text-base" disabled={pending || !online || !key || invalid}>
        {!online ? 'Sin conexión: no se puede registrar' : pending ? 'Registrando…' : label}
      </button>

      <div className="flex justify-center gap-4 text-sm">
        {mode !== 'cuota' && <button type="button" className="underline" onClick={() => setMode('cuota')}>Solo la cuota</button>}
        {mode !== 'todo' && outstanding > cuota && <button type="button" className="underline" onClick={() => setMode('todo')}>Pagó todo</button>}
        {mode !== 'otro' && <button type="button" className="text-slate-500 underline" onClick={() => setMode('otro')}>Otro valor</button>}
      </div>

      {!state.ok && <p className="field-error" role="alert">{state.error}</p>}
      {state.ok && state.message && (
        <p className="rounded-xl bg-slate-100 p-3 text-sm text-slate-800" role="status">
          {state.message}{' '}
          {state.data && <Link href={`/comprobantes/${state.data.payment_id}`} className="underline">Ver comprobante</Link>}
        </p>
      )}
    </form>
  );
}
