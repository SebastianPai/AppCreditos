import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstallmentsTable } from '@/components/installments-table';
import { Card, KeyValue, LinkButton, PageHeader, StatusBadge } from '@/components/ui';
import { formatCOP, formatDate, FREQUENCY_LABEL, type Frequency } from '@/lib/finance';
import { LOAN_STATUS, PAYMENT_METHOD } from '@/lib/labels';
import { userDb } from '@/lib/auth';

export default async function CustomerLoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const loan = await db.one('select * from public.loans where id = $1', [id]);
  if (!loan) notFound();
  const [balance, installments, payments] = await Promise.all([
    db.one('select * from public.v_loan_balances where id = $1', [id]),
    db.query<any>('select * from public.v_installments where loan_id = $1 order by number', [id]),
    db.query('select id, receipt_number, amount, method, received_on, status, public.staff_name(received_by) as received_by_name from public.payments where loan_id = $1 order by received_at desc', [id]),
  ]);

  return (
    <>
      <Link href="/cliente" className="mb-3 inline-block text-sm text-brand-700">← Mis préstamos</Link>
      <PageHeader title={`Préstamo ${loan.code}`} subtitle={<StatusBadge map={LOAN_STATUS} value={loan.status} />} actions={loan.status === 'active' ? <LinkButton href={`/cliente/pagar?prestamo=${loan.id}`}>Pagar</LinkButton> : undefined} />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Condiciones">
          <KeyValue
            items={[
              ['Capital', formatCOP(loan.principal)],
              ['Interés total', `${formatCOP(loan.interest_total)} (${loan.interest_bps / 100} %)`],
              ['Total a pagar', formatCOP(loan.total_amount)],
              ['Cuotas', `${loan.installments_count} · ${FREQUENCY_LABEL[loan.frequency as Frequency]}`],
              ['Pagado', formatCOP(balance?.paid_total)],
              ['Saldo pendiente', formatCOP(balance?.outstanding)],
              ['Próximo vencimiento', formatDate(balance?.next_due_date)],
            ]}
          />
        </Card>
        <Card title="Cuotas">
          <InstallmentsTable rows={installments ?? []} />
        </Card>
      </div>
      <Card title="Pagos registrados" className="mt-4">
        <ul className="divide-y divide-slate-100 text-sm">
          {(payments ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between py-2">
              <span>
                N.º {p.receipt_number} · {formatDate(p.received_on)} · {PAYMENT_METHOD[p.method]} · recibió {p.received_by_name ?? 'pasarela'}
                {p.status === 'reversed' && <span className="ml-1 text-red-700">(reversado)</span>}
              </span>
              <Link href={`/comprobantes/${p.id}`} className="font-semibold text-brand-700 tabular-nums">{formatCOP(p.amount)} · comprobante</Link>
            </li>
          ))}
          {!payments?.length && <li className="py-2 text-slate-500">Sin pagos.</li>}
        </ul>
      </Card>
    </>
  );
}
