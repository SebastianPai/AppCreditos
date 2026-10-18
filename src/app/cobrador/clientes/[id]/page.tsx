import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { InstallmentsTable } from '@/components/installments-table';
import { PaymentForm } from '@/components/payment-form';
import { Card, KeyValue, PageHeader, StatusBadge } from '@/components/ui';
import { formatCOP, formatDate, todayBogota, FREQUENCY_LABEL, type Frequency } from '@/lib/finance';
import { LOAN_STATUS, PAYMENT_METHOD } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { registerPayment, requestReversal } from '../../actions';

export default async function CollectorCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const customer = await db.one('select * from public.v_customers where id = $1', [id]);
  if (!customer) notFound();
  const [loans, installments, payments] = await Promise.all([
    db.query(`select * from public.v_loan_balances where customer_id = $1 and status in ('active', 'paid') order by created_at desc`, [id]),
    db.query<any>('select * from public.v_installments where customer_id = $1 order by number', [id]),
    db.query('select id, loan_id, receipt_number, amount, method, received_on, status from public.payments where customer_id = $1 order by received_at desc limit 30', [id]),
  ]);
  const today = todayBogota();

  return (
    <>
      <Link href="/cobrador/clientes" className="mb-3 inline-block text-sm text-brand-700">← Mis clientes</Link>
      <PageHeader title={customer.full_name} subtitle={`${customer.code} · ${customer.document_type} ${customer.document_masked}`} actions={<a href={`tel:${customer.phone.replace(/\s/g, '')}`} className="btn-secondary">Llamar {customer.phone}</a>} />

      {(loans ?? []).map((l) => {
        const rows = (installments ?? []).filter((i) => i.loan_id === l.id);
        const next = rows.find((r) => r.outstanding > 0);
        return (
          <Card key={l.id} title={`Préstamo ${l.code}`} action={<StatusBadge map={LOAN_STATUS} value={l.status} />} className="mb-4">
            <KeyValue
              items={[
                ['Condiciones', `${formatCOP(l.principal)} · ${l.installments_count} cuotas ${FREQUENCY_LABEL[l.frequency as Frequency].toLowerCase()}es`],
                ['Total contractual', formatCOP(l.total_amount)],
                ['Pagado', formatCOP(l.paid_total)],
                ['Saldo pendiente', formatCOP(l.outstanding)],
                ['Vencido', formatCOP(l.overdue_amount)],
              ]}
            />
            <div className="mt-3"><InstallmentsTable rows={rows} showSplit={false} /></div>
            {l.status === 'active' && (
              <div id="pago" className="mt-4 rounded-xl border border-brand-100 bg-brand-50/50 p-3">
                <h3 className="mb-2 font-semibold">Registrar pago recibido</h3>
                <PaymentForm loanId={l.id} outstanding={l.outstanding} nextDue={next?.outstanding ?? 0} action={registerPayment} today={today} />
              </div>
            )}
          </Card>
        );
      })}

      <Card title="Historial de pagos">
        <ul className="divide-y divide-slate-100 text-sm">
          {(payments ?? []).map((p) => (
            <li key={p.id} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <span>
                  N.º {p.receipt_number} · {formatDate(p.received_on)} · {PAYMENT_METHOD[p.method]}
                  {p.status === 'reversed' && <span className="ml-1 text-red-700">(reversado)</span>}
                </span>
                <Link href={`/comprobantes/${p.id}`} className="font-semibold text-brand-700 tabular-nums">{formatCOP(p.amount)}</Link>
              </div>
              {p.status === 'confirmed' && p.received_on === today && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-slate-500">¿Error en este pago? Solicitar corrección</summary>
                  <ActionForm action={requestReversal} submitLabel="Solicitar corrección" variant="secondary" className="mt-2 space-y-2">
                    <input type="hidden" name="payment_id" value={p.id} />
                    <input name="reason" required minLength={5} maxLength={300} className="input" placeholder="Motivo de la corrección" />
                  </ActionForm>
                </details>
              )}
            </li>
          ))}
          {!payments?.length && <li className="py-2 text-slate-500">Sin pagos.</li>}
        </ul>
      </Card>
    </>
  );
}
