import Link from 'next/link';
import { Card, EmptyState, Notice, PageHeader, Stat, StatGrid, StatusBadge } from '@/components/ui';
import { requireRole } from '@/lib/auth';
import { formatCOP, formatDate } from '@/lib/finance';
import { APPLICATION_STATUS, LOAN_STATUS, PAYMENT_METHOD } from '@/lib/labels';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Mis préstamos' };

export default async function CustomerHome() {
  const profile = await requireRole('customer');
  const db = await userDb();
  const [customer, loans, payments, apps] = await Promise.all([
    db.one('select * from public.v_customers limit 1'),
    db.query(`select * from public.v_loan_balances where status in ('approved', 'active', 'paid') order by created_at desc`),
    db.query('select id, receipt_number, amount, method, received_on, status from public.payments order by received_at desc limit 5'),
    db.query(`select id, code, status, requested_principal, created_at from public.loan_applications
               where status in ('pending', 'info_requested', 'counter_offered', 'accepted_by_customer')`),
  ]);

  return (
    <>
      <PageHeader title={`Hola, ${profile.full_name.split(' ')[0]}`} subtitle={customer ? `Cliente ${customer.code}` : undefined} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Link href="/cliente/simular" className="btn-primary !min-h-16 text-base shadow-md">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 3h12v18H6zM9 7h6M9 12h1m4 0h1m-6 4h1m4 0h1" /></svg>
          Simular nuevo préstamo
        </Link>
        <Link href="/cliente/pagar" className="btn-secondary !min-h-16 text-base">Pagar</Link>
      </div>

      {!customer && (
        <Notice tone="warning">Su cuenta aún no está vinculada a una ficha de cliente. Contacte a la administración.</Notice>
      )}

      {customer && (
        <StatGrid>
          <Stat label="Saldo pendiente" value={formatCOP(customer.outstanding)} />
          <Stat label="Próximo vencimiento" value={customer.next_due_date ? formatDate(customer.next_due_date) : '—'} />
          <Stat label="Préstamos activos" value={customer.active_loans} />
          <Stat label="Solicitudes en trámite" value={apps?.length ?? 0} />
        </StatGrid>
      )}

      {apps && apps.length > 0 && (
        <div className="mt-5 space-y-2">
          {apps.map((a) => (
            <Link key={a.id} href="/cliente/solicitudes" className="card flex items-center justify-between !p-3">
              <span className="text-sm">
                Solicitud {a.code} · {formatCOP(a.requested_principal)}
              </span>
              <StatusBadge map={APPLICATION_STATUS} value={a.status} />
            </Link>
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card title="Mis préstamos">
          {!loans?.length ? (
            <EmptyState>No tiene préstamos. Puede simular uno y enviar la solicitud.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {loans.map((l) => (
                <li key={l.id}>
                  <Link href={`/cliente/prestamos/${l.id}`} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-medium">{l.code} · {formatCOP(l.principal)}</p>
                      <p className="text-xs text-slate-500">
                        Pagado {formatCOP(l.paid_total)} de {formatCOP(l.total_amount)}
                        {l.next_due_date && ` · vence ${formatDate(l.next_due_date)}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <StatusBadge map={LOAN_STATUS} value={l.status} />
                      <p className="mt-1 text-sm font-semibold tabular-nums">{formatCOP(l.outstanding)}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Últimos pagos">
          {!payments?.length ? (
            <EmptyState>Aún no hay pagos registrados.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <span>
                    {formatDate(p.received_on)} · {PAYMENT_METHOD[p.method]}
                    {p.status === 'reversed' && <span className="ml-1 text-red-700">(reversado)</span>}
                  </span>
                  <Link href={`/comprobantes/${p.id}`} className="font-semibold text-brand-700 tabular-nums">
                    {formatCOP(p.amount)} ↗
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
