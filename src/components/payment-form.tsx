'use client';
import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatCOP, parsePesos } from '@/lib/finance';
import type { PaymentResult } from '@/app/cobrador/actions';
import { useOnline } from './pwa';

const schema = (max: number) =>
  z.object({
    amountText: z.string().refine((v) => {
      const n = parsePesos(v) ?? 0;
      return n > 0 && n <= max;
    }, `Ingrese un valor entre $1 y ${formatCOP(max)}`),
    notes: z.string().max(300).optional(),
  });

/**
 * Registro de pago con clave de idempotencia por intento: si la red falla y se
 * reenvía, el servidor no duplica el pago. Sin conexión no se permite enviar.
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
  const { register, setValue, getValues, trigger, formState, reset } = useForm({
    resolver: zodResolver(schema(outstanding)),
    mode: 'onChange',
    defaultValues: { amountText: '', notes: '' },
  });

  useEffect(() => {
    if (state.ok && state.data && !state.data.duplicate) {
      reset();
      setKey(crypto.randomUUID()); // nuevo intento = nueva clave
    }
  }, [state, reset]);

  const fill = (n: number) => {
    setValue('amountText', new Intl.NumberFormat('es-CO').format(n));
    void trigger('amountText');
  };

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const n = parsePesos(getValues('amountText')) ?? 0;
        if (n <= 0 || n > outstanding) {
          e.preventDefault();
          void trigger('amountText');
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="loan_id" value={loanId} />
      <input type="hidden" name="idempotency_key" value={key} />
      <div className="flex flex-wrap gap-2">
        {nextDue > 0 && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => fill(nextDue)}>
            Cuota: {formatCOP(nextDue)}
          </button>
        )}
        <button type="button" className="btn-secondary btn-sm" onClick={() => fill(outstanding)}>
          Saldo total: {formatCOP(outstanding)}
        </button>
      </div>
      <div>
        <label className="label" htmlFor={`amount-${loanId}`}>Valor recibido (COP)</label>
        <input
          id={`amount-${loanId}`}
          inputMode="numeric"
          autoComplete="off"
          className="input text-lg font-semibold"
          placeholder="0"
          {...register('amountText', {
            onChange: (e) => {
              const n = parsePesos(e.target.value);
              e.target.value = n ? new Intl.NumberFormat('es-CO').format(n) : '';
            },
          })}
          name="amount"
        />
        {formState.errors.amountText && <p className="field-error">{formState.errors.amountText.message}</p>}
        <p className="mt-1 text-xs text-slate-500">Se permiten pagos parciales. No se acepta más que el saldo pendiente.</p>
      </div>
      {admin && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor={`method-${loanId}`}>Medio</label>
            <select id={`method-${loanId}`} name="method" className="input" defaultValue="cash">
              <option value="cash">Efectivo (caja)</option>
              <option value="transfer">Transferencia verificada</option>
              <option value="qr">QR verificado</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`date-${loanId}`}>Fecha</label>
            <input id={`date-${loanId}`} type="date" name="received_on" max={today} defaultValue={today} className="input" />
          </div>
        </div>
      )}
      <div>
        <label className="label" htmlFor={`notes-${loanId}`}>Nota (opcional)</label>
        <input id={`notes-${loanId}`} className="input" maxLength={300} {...register('notes')} name="notes" />
      </div>
      <button type="submit" className="btn-primary w-full" disabled={pending || !online || !key}>
        {!online ? 'Sin conexión: no se puede registrar' : pending ? 'Registrando…' : 'Registrar pago'}
      </button>
      {!state.ok && <p className="field-error" role="alert">{state.error}</p>}
      {state.ok && state.message && (
        <p className="text-sm text-slate-800" role="status">
          {state.message}{' '}
          {state.data && <Link href={`/comprobantes/${state.data.payment_id}`} className="underline">Ver comprobante</Link>}
        </p>
      )}
    </form>
  );
}
