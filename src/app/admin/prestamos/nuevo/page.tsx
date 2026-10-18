import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Card, Notice, PageHeader } from '@/components/ui';
import { formatCOP, policyFromRow, todayBogota } from '@/lib/finance';
import { userDb } from '@/lib/auth';
import { createLoanForCustomer } from '../../actions';

export const metadata = { title: 'Nuevo préstamo' };

export default async function NewLoanPage({ searchParams }: { searchParams: Promise<{ cliente?: string }> }) {
  const { cliente } = await searchParams;
  const db = await userDb();
  const [customers, collectors, policyRow] = await Promise.all([
    db.query<{ id: string; code: string; full_name: string; collector_id: string | null }>(`select id, code, full_name, collector_id from public.customers where status = 'active' order by full_name`),
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' and active order by full_name`),
    db.rpc('get_active_policy'),
  ]);
  const policy = policyFromRow(policyRow as Record<string, unknown>);
  const today = todayBogota();
  return (
    <>
      <Link href="/admin/prestamos" className="mb-3 inline-block text-sm text-brand-700">← Préstamos</Link>
      <PageHeader title="Nuevo préstamo presencial" subtitle="Registra la solicitud a nombre del cliente y la aprueba con estas condiciones. El desembolso se registra después." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <ActionForm action={createLoanForCustomer} submitLabel="Registrar y aprobar" confirmText="El cliente conoce y acepta estas condiciones y la tabla de amortización.">
            <div>
              <label className="label" htmlFor="customer_id">Cliente</label>
              <select id="customer_id" name="customer_id" defaultValue={cliente ?? ''} required className="input">
                <option value="" disabled>Seleccione…</option>
                {customers?.map((c) => <option key={c.id} value={c.id}>{c.full_name} ({c.code})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label" htmlFor="principal">Capital (COP)</label><input id="principal" name="principal" inputMode="numeric" required className="input" placeholder="600.000" /></div>
              <div><label className="label" htmlFor="installments">Cuotas</label>
                <select id="installments" name="installments" defaultValue={4} className="input">{Array.from({ length: policy.maxInstallments }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select>
              </div>
              <div><label className="label" htmlFor="frequency">Modalidad</label>
                <select id="frequency" name="frequency" className="input"><option value="weekly">Semanal</option><option value="biweekly">Quincenal</option></select>
              </div>
              <div><label className="label" htmlFor="start_date">Inicio</label><input id="start_date" type="date" name="start_date" min={today} defaultValue={today} className="input" required /></div>
            </div>
            <div>
              <label className="label" htmlFor="collector_id">Cobrador</label>
              <select id="collector_id" name="collector_id" required className="input" defaultValue="">
                <option value="" disabled>Seleccione…</option>
                {collectors?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </select>
            </div>
          </ActionForm>
        </Card>
        <Notice tone="info" title="Reglas vigentes">
          Interés {policy.interestBps / 100} % total sobre el capital, máximo {policy.maxInstallments} cuotas. Quincenal solo desde {formatCOP(policy.biweeklyMinPrincipal)}.
          Antes de aprobar puede revisar la tabla exacta en el <Link href="/simulador" className="underline">simulador</Link>.
        </Notice>
      </div>
    </>
  );
}
