import Link from 'next/link';
import { Card, EmptyState, PageHeader, Stat, StatGrid, StatusBadge } from '@/components/ui';
import { requireRole } from '@/lib/auth';
import { addDays, formatCOP, formatDate, todayBogota } from '@/lib/finance';
import { INSTALLMENT_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Cobros de hoy' };

interface Dashboard {
  today: string;
  assigned_customers: number;
  due_today: { count: number; amount: number };
  overdue: { count: number; amount: number };
  collected_today: { count: number; amount: number };
  commission_accrued_total: number;
  commission_pending: number;
  cash_in_custody: number;
  handovers_pending: number;
}

export default async function CollectorHome() {
  const profile = await requireRole('collector');
  const db = await userDb();
  const today = todayBogota();
  const [dash, agenda, customers] = await Promise.all([
    db.rpc('collector_dashboard'),
    db.query<{ id: string; loan_id: string; loan_code: string; customer_id: string; number: number; due_date: string; total_amount: number; outstanding: number; effective_status: string }>(
      `select id, loan_id, loan_code, customer_id, number, due_date, total_amount, outstanding, effective_status
         from public.v_installments
        where collector_id = $1 and loan_status = 'active' and outstanding > 0 and due_date <= $2
        order by due_date limit 200`, [profile.id, addDays(today, 7)]),
    db.query<{ id: string; full_name: string; phone: string; address: string | null }>(
      'select id, full_name, phone, address from public.customers where collector_id = $1', [profile.id]),
  ]);
  const d = dash as Dashboard | null;
  const byId = new Map((customers ?? []).map((c) => [c.id, c]));
  const dueNow = (agenda ?? []).filter((i) => i.due_date <= today);
  const upcoming = (agenda ?? []).filter((i) => i.due_date > today);

  return (
    <>
      <PageHeader title="Cobros de hoy" subtitle={formatDate(today)} />
      {d && (
        <StatGrid>
          <Stat label="Por recaudar hoy" value={formatCOP(d.due_today.amount + d.overdue.amount)} hint={`${d.due_today.count} cuotas de hoy · ${d.overdue.count} vencidas`} definition="Saldo pendiente de las cuotas que vencen hoy más las vencidas de sus clientes." />
          <Stat label="Recaudado hoy" value={formatCOP(d.collected_today.amount)} hint={`${d.collected_today.count} pagos registrados`} tone="success" />
          <Stat label="Cuotas vencidas" value={formatCOP(d.overdue.amount)} hint={`${d.overdue.count} cuotas`} tone={d.overdue.count ? 'danger' : undefined} />
          <Stat label="Clientes asignados" value={d.assigned_customers} />
          <Stat label="Efectivo en su poder" value={formatCOP(d.cash_in_custody)} hint={d.handovers_pending ? `${formatCOP(d.handovers_pending)} entregado, sin confirmar` : 'Pendiente de entregar a administración'} definition="Dinero cobrado en efectivo que aún no ha sido entregado y confirmado por administración. No es ganancia suya." />
          <Stat label="Comisión acumulada" value={formatCOP(d.commission_accrued_total)} definition="5 % del capital de cada préstamo, devengado en proporción al interés efectivamente cobrado." />
          <Stat label="Comisión pendiente de pago" value={formatCOP(d.commission_pending)} />
        </StatGrid>
      )}

      <Card title={`Para cobrar hoy (${dueNow.length})`} className="mt-5">
        {!dueNow.length ? <EmptyState>No hay cuotas pendientes para hoy. 🎉</EmptyState> : <AgendaList rows={dueNow} byId={byId} />}
      </Card>
      <Card title="Próximos 7 días" className="mt-4">
        {!upcoming.length ? <EmptyState>Sin vencimientos próximos.</EmptyState> : <AgendaList rows={upcoming} byId={byId} />}
      </Card>
    </>
  );
}

function AgendaList({
  rows,
  byId,
}: {
  rows: { id: string; loan_id: string; loan_code: string; customer_id: string; number: number; due_date: string; outstanding: number; effective_status: string }[];
  byId: Map<string, { id: string; full_name: string; phone: string; address: string | null }>;
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => {
        const c = byId.get(r.customer_id);
        return (
          <li key={r.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{c?.full_name ?? 'Cliente'}</p>
              <p className="text-xs text-slate-500">
                {r.loan_code} · cuota {r.number} · {formatDate(r.due_date)}
                {c?.address && ` · ${c.address}`}
              </p>
              <div className="mt-1"><StatusBadge map={INSTALLMENT_STATUS} value={r.effective_status} /></div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="font-semibold tabular-nums">{formatCOP(r.outstanding)}</span>
              <div className="flex gap-1">
                {c?.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`} className="btn-secondary btn-sm" aria-label="Llamar">📞</a>}
                <Link href={`/cobrador/clientes/${r.customer_id}?prestamo=${r.loan_id}#pago`} className="btn-primary btn-sm">Cobrar</Link>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
