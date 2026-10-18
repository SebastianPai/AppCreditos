import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, PageHeader, Stat, StatGrid, StatusBadge, TableWrap } from '@/components/ui';
import { requireRole } from '@/lib/auth';
import { formatCOP, formatDate, formatDateTime } from '@/lib/finance';
import { WORKFLOW_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { declareHandover } from '../actions';

export const metadata = { title: 'Comisiones y entregas' };

export default async function CollectorCommissionsPage() {
  const profile = await requireRole('collector');
  const db = await userDb();
  const [dash, payouts, handovers, commissions] = await Promise.all([
    db.rpc('collector_dashboard'),
    db.query('select * from public.collector_payouts where collector_id = $1 order by created_at desc', [profile.id]),
    db.query('select * from public.cash_handovers where collector_id = $1 order by declared_at desc limit 20', [profile.id]),
    db.query(`select c.id, c.kind, c.amount, c.created_at, c.payout_id, l.code as loan_code
                from public.collector_commissions c join public.loans l on l.id = c.loan_id
               where c.collector_id = $1 order by c.created_at desc limit 50`, [profile.id]),
  ]);
  const d = dash as { commission_accrued_total: number; commission_pending: number; cash_in_custody: number; handovers_pending: number } | null;

  return (
    <>
      <PageHeader title="Comisiones y entregas" subtitle="Sus comisiones las calcula el sistema; no se pueden editar manualmente." />
      {d && (
        <StatGrid>
          <Stat label="Comisión devengada total" value={formatCOP(d.commission_accrued_total)} />
          <Stat label="Pendiente de pago" value={formatCOP(d.commission_pending)} />
          <Stat label="Efectivo en su poder" value={formatCOP(d.cash_in_custody)} />
          <Stat label="Entregas sin confirmar" value={formatCOP(d.handovers_pending)} />
        </StatGrid>
      )}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card title="Entregar efectivo a administración">
          <ActionForm action={declareHandover} submitLabel="Registrar entrega" resetOnSuccess>
            <div>
              <label className="label" htmlFor="amount">Valor entregado (COP)</label>
              <input id="amount" name="amount" inputMode="numeric" required className="input" />
            </div>
            <input name="notes" maxLength={200} placeholder="Nota (opcional)" className="input" aria-label="Nota" />
          </ActionForm>
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {(handovers ?? []).map((h) => (
              <li key={h.id} className="flex justify-between py-2">
                <span>{formatDateTime(h.declared_at)} · {h.status === 'pending' ? 'Pendiente' : h.status === 'confirmed' ? 'Confirmada' : 'Rechazada'}</span>
                <span className="font-semibold tabular-nums">{formatCOP(h.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Liquidaciones de comisión">
          {!payouts?.length ? (
            <EmptyState>Aún no hay liquidaciones.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {payouts.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <span>Hasta {formatDate(p.period_end)}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge map={WORKFLOW_STATUS} value={p.status} />
                    <strong className="tabular-nums">{formatCOP(p.amount)}</strong>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Movimientos de comisión" className="mt-4">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Fecha</th><th>Préstamo</th><th>Tipo</th><th className="num">Valor</th><th>Liquidada</th></tr></thead>
            <tbody>
              {(commissions ?? []).map((c) => (
                <tr key={c.id}>
                  <td>{formatDateTime(c.created_at)}</td>
                  <td>{c.loan_code}</td>
                  <td>{c.kind === 'accrual' ? 'Devengo' : 'Reverso'}</td>
                  <td className="num">{formatCOP(c.amount)}</td>
                  <td>{c.payout_id ? 'Sí' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}
