import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { formatCOP, formatDate, todayBogota } from '@/lib/finance';
import { WORKFLOW_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { createPayout, payoutAction } from '../actions';

export const metadata = { title: 'Cobradores y comisiones' };

export default async function CollectorsAdminPage() {
  const db = await userDb();
  const today = todayBogota();
  const [collectors, commissions, payouts, payments] = await Promise.all([
    db.query<{ id: string; full_name: string; active: boolean }>(`select id, full_name, active from public.profiles where role = 'collector' order by full_name`),
    db.query<{ collector_id: string; amount: number; payout_id: string | null }>('select collector_id, amount, payout_id from public.collector_commissions'),
    db.query(`select o.*, p.full_name from public.collector_payouts o join public.profiles p on p.id = o.collector_id order by o.created_at desc limit 50`),
    db.query<{ collector_id: string; amount: number }>(`select collector_id, amount from public.payments where status = 'confirmed' and received_on = $1`, [today]),
  ]);
  const stats = new Map<string, { accrued: number; unassigned: number; today: number }>();
  for (const c of collectors ?? []) stats.set(c.id, { accrued: 0, unassigned: 0, today: 0 });
  for (const c of commissions ?? []) {
    const s = stats.get(c.collector_id);
    if (!s) continue;
    s.accrued += Number(c.amount);
    if (!c.payout_id) s.unassigned += Number(c.amount);
  }
  for (const p of payments ?? []) {
    const s = stats.get(p.collector_id);
    if (s) s.today += Number(p.amount);
  }

  return (
    <>
      <PageHeader title="Cobradores y comisiones" subtitle="La comisión (5 % del capital) se devenga automáticamente con cada pago; nadie la edita manualmente." />
      <Card title="Resumen por cobrador">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Cobrador</th><th className="num">Recaudado hoy</th><th className="num">Comisión devengada</th><th className="num">Sin liquidar</th><th /></tr></thead>
            <tbody>
              {(collectors ?? []).map((c) => {
                const s = stats.get(c.id)!;
                return (
                  <tr key={c.id}>
                    <td>{c.full_name}{!c.active && <span className="ml-1 text-xs text-red-700">(inactivo)</span>}</td>
                    <td className="num">{formatCOP(s.today)}</td>
                    <td className="num">{formatCOP(s.accrued)}</td>
                    <td className="num">{formatCOP(s.unassigned)}</td>
                    <td className="space-x-2 whitespace-nowrap">
                      <Link href={`/admin/reportes?cobrador=${c.id}`} className="text-sm text-brand-700">Informe</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card title="Liquidar comisiones">
          <ActionForm action={createPayout} submitLabel="Crear liquidación">
            <select name="collector_id" required className="input" aria-label="Cobrador">
              {collectors?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
            <div><label className="label">Comisiones devengadas hasta</label><input type="date" name="period_end" max={today} defaultValue={today} className="input" /></div>
            <input name="notes" placeholder="Nota" className="input" aria-label="Nota" />
          </ActionForm>
          <p className="mt-2 text-xs text-slate-500">Flujo: pendiente de aprobación → aprobada → pagada. Un cobrador nunca aprueba ni paga su propia liquidación.</p>
        </Card>
        <Card title="Liquidaciones de comisión">
          {!payouts?.length ? (
            <EmptyState>Sin liquidaciones.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {payouts.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{p.full_name} · hasta {formatDate(p.period_end)} · <strong>{formatCOP(p.amount)}</strong></span>
                  <span className="flex items-center gap-2">
                    <StatusBadge map={WORKFLOW_STATUS} value={p.status} />
                    {p.status === 'pending_approval' && (
                      <ActionForm action={payoutAction} submitLabel="Aprobar" className="inline">
                        <input type="hidden" name="payout_id" value={p.id} /><input type="hidden" name="op" value="approve" />
                      </ActionForm>
                    )}
                    {p.status === 'approved' && (
                      <ActionForm action={payoutAction} submitLabel="Registrar pago" className="inline">
                        <input type="hidden" name="payout_id" value={p.id} /><input type="hidden" name="op" value="pay" />
                      </ActionForm>
                    )}
                    {['pending_approval', 'approved'].includes(p.status) && (
                      <ActionForm action={payoutAction} submitLabel="Cancelar" variant="secondary" className="inline">
                        <input type="hidden" name="payout_id" value={p.id} /><input type="hidden" name="op" value="cancel" />
                      </ActionForm>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
