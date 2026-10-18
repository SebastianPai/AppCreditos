'use client';
import { startTransition, useActionState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ActionResult } from '@/lib/errors';
import { customerSchema, type CustomerInput } from '@/lib/validation';

export function CustomerForm({
  action,
  collectors,
}: {
  action: (s: ActionResult, fd: FormData) => Promise<ActionResult>;
  collectors: { id: string; full_name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { ok: true } as ActionResult);
  const ref = useRef<HTMLFormElement>(null);
  const { register, formState, handleSubmit } = useForm<CustomerInput>({
    resolver: zodResolver(customerSchema),
    mode: 'onTouched',
    defaultValues: { document_type: 'CC', collector_id: '', address: '', notes: '' },
  });
  const e = formState.errors;
  return (
    <form
      ref={ref}
      // Valida en el cliente con Zod y, si todo es correcto, envía a la Server Action (que vuelve a validar).
      onSubmit={handleSubmit(() => startTransition(() => formAction(new FormData(ref.current!))))}
      className="space-y-3"
      noValidate
    >
      <div>
        <label className="label" htmlFor="full_name">Nombre completo</label>
        <input id="full_name" className="input" autoComplete="off" {...register('full_name')} />
        {e.full_name && <p className="field-error">{e.full_name.message}</p>}
      </div>
      <div className="grid grid-cols-[110px_1fr] gap-2">
        <div>
          <label className="label" htmlFor="document_type">Tipo</label>
          <select id="document_type" className="input" {...register('document_type')}>
            {['CC', 'CE', 'TI', 'PA', 'PPT', 'NIT'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="document_number">Número de documento</label>
          <input id="document_number" className="input" inputMode="numeric" autoComplete="off" {...register('document_number')} />
          {e.document_number && <p className="field-error">{e.document_number.message}</p>}
        </div>
      </div>
      <div>
        <label className="label" htmlFor="phone">Teléfono</label>
        <input id="phone" className="input" inputMode="tel" {...register('phone')} />
        {e.phone && <p className="field-error">{e.phone.message}</p>}
      </div>
      <div>
        <label className="label" htmlFor="address">Dirección (para la ruta de cobro)</label>
        <input id="address" className="input" {...register('address')} />
      </div>
      <div>
        <label className="label" htmlFor="collector_id">Cobrador asignado</label>
        <select id="collector_id" className="input" {...register('collector_id')}>
          <option value="">Sin asignar</option>
          {collectors.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="notes">Notas internas</label>
        <textarea id="notes" rows={2} className="input" {...register('notes')} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 size-4" {...register('data_consent')} />
        <span>El cliente autorizó por escrito el tratamiento de sus datos personales (Ley 1581 de 2012) y conservo el soporte.</span>
      </label>
      {e.data_consent && <p className="field-error">{e.data_consent.message}</p>}
      <button className="btn-primary" disabled={pending}>{pending ? 'Guardando…' : 'Crear cliente'}</button>
      {!state.ok && <p className="field-error" role="alert">{state.error}</p>}
    </form>
  );
}
