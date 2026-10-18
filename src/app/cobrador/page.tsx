import Link from 'next/link';
import { Badge, Card, EmptyState, MoreSection, PageHeader, Stat, StatGrid } from '@/components/ui';
import { requireRole } from '@/lib/auth';
import { addDays, dueStatus, formatCOP, formatDate, todayBogota } from '@/lib/finance';
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
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Por cobrar hoy" value={formatCOP(d.due_today.amount + d.overdue.amount)} hint={`${d.due_today.count + d.overdue.count} cuotas`} definition="Saldo de las cuotas que vencen hoy más las vencidas." />
            <Stat label="Cobrado hoy" value={formatCOP(d.collected_today.amount)} hint={`${d.collected_today.count} pagos`} tone="success" />
          </div>
          <MoreSection className="mt-3">
            <StatGrid>
              <Stat label="Vencido" value={formatCOP(d.overdue.amount)} hint={`${d.overdue.count} cuotas`} tone={d.overdue.count ? 'danger' : undefined} />
              <Stat label="Clientes" value={d.assigned_customers} />
              <Stat label="Efectivo en su poder" value={formatCOP(d.cash_in_custody)} definition="Cobrado en efectivo y aún no entregado a administración. No es ganancia suya." />
              <Stat label="Mi comisión" value={formatCOP(d.commission_accrued_total)} hint={`Por pagar ${formatCOP(d.commission_pending)}`} definition="5 % del capital de cada préstamo, a medida que se cobra el interés." />
            </StatGrid>
          </MoreSection>
        </>
      )}

      <Card title={`Para cobrar hoy (${dueNow.length})`} className="mt-5">
        {!dueNow.length ? <EmptyState>No hay cuotas pendientes para hoy.</EmptyState> : <AgendaList rows={dueNow} byId={byId} />}
      </Card>
      {upcoming.length > 0 && (
        <MoreSection label={`Próximos 7 días (${upcoming.length})`} className="mt-4">
          <Card><AgendaList rows={upcoming} byId={byId} /></Card>
        </MoreSection>
      )}
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
                Cuota {r.number} · {formatDate(r.due_date)}
              </p>
              <div className="mt-1">{(() => { const st = dueStatus(r.due_date, todayBogota()); return <Badge tone={st.tone}>{st.text}</Badge>; })()}</div>
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
