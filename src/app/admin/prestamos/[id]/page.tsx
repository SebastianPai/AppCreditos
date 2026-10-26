import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { InstallmentsTable } from '@/components/installments-table';
import { PaymentForm } from '@/components/payment-form';
import { Card, KeyValue, Notice, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { formatCOP, formatDate, formatDateTime, FREQUENCY_LABEL, todayBogota, type Frequency } from '@/lib/finance';
import { LOAN_STATUS, PAYMENT_METHOD } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { registerPayment } from '@/app/cobrador/actions';
import { cancelLoan, changeLoanStart, decideDeletion, disburseLoan, purgeLoan, reversePayment } from '../../actions';

export default async function AdminLoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const loan = await db.one(
    `select l.*, c.code as customer_code, c.full_name as customer_name, p.full_name as collector_name
       from public.loans l join public.customers c on c.id = l.customer_id left join public.profiles p on p.id = l.collector_id
      where l.id = $1`, [id]);
  if (!loan) notFound();
  const [balance, installments, payments, capital, commissions, deletionRequest] = await Promise.all([
    db.one('select * from public.v_loan_balances where id = $1', [id]),
    db.query<any>('select * from public.v_installments where loan_id = $1 order by number', [id]),
    db.query('select p.*, public.staff_name(p.received_by) as received_by_name from public.payments p where p.loan_id = $1 order by p.received_at desc', [id]),
    db.rpc('capital_summary'),
    db.query<{ amount: number }>('select amount from public.collector_commissions where loan_id = $1', [id]),
    db.one(`select r.*, public.staff_name(r.requested_by) as requested_by_name from public.deletion_requests r where r.loan_id = $1 and r.status = 'pending'`, [id]),
  ]);
  const customer = { id: loan.customer_id as string, code: loan.customer_code as string, full_name: loan.customer_name as string };
  const collector = loan.collector_name ? { full_name: loan.collector_name as string } : null;
  const today = todayBogota();
  const next = (installments ?? []).find((i) => i.outstanding > 0);
  const commissionAccrued = (commissions ?? []).reduce((s, c) => s + Number(c.amount), 0);
  const available = (capital as { available: number } | null)?.available ?? 0;

  return (
    <>
      <Link href="/admin/prestamos" className="mb-3 inline-block text-sm text-brand-700">← Préstamos</Link>
      <PageHeader title={`Préstamo ${loan.code}`} subtitle={<StatusBadge map={LOAN_STATUS} value={loan.status} />} />
      {deletionRequest && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-semibold text-red-800">{deletionRequest.requested_by_name ?? 'Un cobrador'} pidió eliminar este préstamo</p>
          <p className="mt-1 text-slate-700">Motivo: {deletionRequest.reason}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <ActionForm action={decideDeletion} submitLabel="Aceptar y eliminar" variant="danger" confirmText="Autorizo la eliminación definitiva de este préstamo.">
              <input type="hidden" name="request_id" value={deletionRequest.id} /><input type="hidden" name="decision" value="approve" />
            </ActionForm>
            <ActionForm action={decideDeletion} submitLabel="Rechazar" variant="secondary">
              <input type="hidden" name="request_id" value={deletionRequest.id} /><input type="hidden" name="decision" value="reject" />
            </ActionForm>
          </div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Contrato">
          <KeyValue
            items={[
              ['Cliente', <Link key="c" href={`/admin/clientes/${customer.id}`} className="text-brand-700">{customer.full_name} ({customer.code})</Link>],
              ['Cobrador', collector?.full_name ?? '—'],
              ['Capital', formatCOP(loan.principal)],
              ['Interés total', `${formatCOP(loan.interest_total)} (${loan.interest_bps / 100} %)`],
              ['Total contractual', formatCOP(loan.total_amount)],
              ['Cuotas', `${loan.installments_count} · ${FREQUENCY_LABEL[loan.frequency as Frequency]}`],
              ['Aprobado', formatDateTime(loan.approved_at)],
              ['Desembolsado', formatDateTime(loan.disbursed_at)],
            ]}
          />
        </Card>
        <Card title="Saldos y distribución">
          <KeyValue
            items={[
              ['Pagado', formatCOP(balance?.paid_total)],
              ['  · capital recuperado', formatCOP(balance?.paid_principal)],
              ['  · interés cobrado', formatCOP(balance?.paid_interest)],
              ['Saldo pendiente', formatCOP(balance?.outstanding)],
              ['Vencido', formatCOP(balance?.overdue_amount)],
              ['Comisión cobrador calculada / devengada', `${formatCOP(loan.collector_commission_total)} / ${formatCOP(commissionAccrued)}`],
              ['Bolsa socios calculada / recaudada', `${formatCOP(loan.partners_pool_total)} / ${formatCOP((balance?.paid_interest ?? 0) - commissionAccrued)}`],
            ]}
          />
        </Card>
      </div>

      {loan.status === 'approved' && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title="Registrar desembolso">
            <p className="mb-3 text-sm text-slate-600">
              Capital disponible: <strong>{formatCOP(available + loan.principal)}</strong> (incluye el compromiso de este préstamo). Las fechas de las cuotas se
              recalculan desde la fecha de desembolso.
            </p>
            <ActionForm action={disburseLoan} submitLabel={`Desembolsar ${formatCOP(loan.principal)}`} confirmText="Entregué el dinero al cliente y conservo el soporte.">
              <input type="hidden" name="loan_id" value={loan.id} />
              <div><label className="label" htmlFor="disbursed_on">Fecha de desembolso</label><input id="disbursed_on" type="date" name="disbursed_on" max={today} defaultValue={today} className="input" /></div>
            </ActionForm>
          </Card>
          <Card title="Cancelar (antes del desembolso)">
            <ActionForm action={cancelLoan} submitLabel="Cancelar préstamo" variant="danger">
              <input type="hidden" name="loan_id" value={loan.id} />
              <input name="reason" required minLength={5} className="input" placeholder="Motivo" />
            </ActionForm>
          </Card>
        </div>
      )}

      <Card title="Calendario de cuotas" className="mt-4">
        <InstallmentsTable rows={installments ?? []} />
        {loan.status === 'active' && (payments ?? []).length === 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-brand-700">Corregir fecha de inicio (inicia {formatDate(loan.start_date)})</summary>
            <p className="mt-2 text-sm text-slate-600">Solo mientras no tenga pagos. Las cuotas se recalculan desde la nueva fecha; los valores no cambian.</p>
            <ActionForm action={changeLoanStart} submitLabel="Guardar nueva fecha" className="mt-2 max-w-xs space-y-2">
              <input type="hidden" name="loan_id" value={loan.id} />
              <div><label className="label" htmlFor="start_date">Nueva fecha de inicio</label><input id="start_date" type="date" name="start_date" required max={today} defaultValue={today} className="input" /></div>
            </ActionForm>
          </details>
        )}
      </Card>

      {loan.status === 'active' && (
        <Card title="Registrar pago (administración)" className="mt-4">
          <Notice tone="info">Use esta opción para pagos recibidos directamente por administración (efectivo en caja o transferencias ya verificadas en el banco).</Notice>
          <div className="mt-3 max-w-md">
            <PaymentForm loanId={loan.id} outstanding={balance?.outstanding ?? 0} nextDue={next?.outstanding ?? 0} action={registerPayment} admin today={today} />
          </div>
        </Card>
      )}

      <Card title="Pagos" className="mt-4">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Recibo</th><th>Fecha</th><th>Registró</th><th>Medio</th><th className="num">Valor</th><th className="num">Capital</th><th className="num">Interés</th><th className="num">Comisión</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {(payments ?? []).map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/comprobantes/${p.id}`} className="text-brand-700">{p.receipt_number}</Link></td>
                  <td className="whitespace-nowrap">{formatDate(p.received_on)}</td>
                  <td>{p.received_by_name ?? 'Pasarela'}</td>
                  <td>{PAYMENT_METHOD[p.method]}</td>
                  <td className="num">{formatCOP(p.amount)}</td>
                  <td className="num">{formatCOP(p.principal_amount)}</td>
                  <td className="num">{formatCOP(p.interest_amount)}</td>
                  <td className="num">{formatCOP(p.commission_amount)}</td>
                  <td>{p.status === 'reversed' ? <span className="text-red-700" title={p.reversal_reason ?? ''}>Reversado</span> : 'Confirmado'}</td>
                  <td>
                    {p.status === 'confirmed' && (
                      <details>
                        <summary className="cursor-pointer text-xs text-red-700">Reversar</summary>
                        <ActionForm action={reversePayment} submitLabel="Confirmar reverso" variant="danger" className="mt-2 w-56 space-y-2">
                          <input type="hidden" name="payment_id" value={p.id} />
                          <input name="reason" required minLength={5} className="input" placeholder="Motivo (queda auditado)" />
                        </ActionForm>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <section id="eliminar" className="mt-6 scroll-mt-20 rounded-2xl border border-red-200 p-4">
        <h2 className="text-sm font-semibold text-red-700">Eliminar préstamo</h2>
        <p className="mt-2 text-sm text-slate-600">
          Borra este préstamo con sus cuotas, pagos, comisiones y asientos: desaparece de pantallas, informes y saldos. El cliente se
          conserva. No se puede deshacer. Queda en el registro de Eliminaciones y en Auditoría.
        </p>
        <ActionForm action={purgeLoan} submitLabel="Eliminar definitivamente" variant="danger" className="mt-3 space-y-2">
          <input type="hidden" name="loan_id" value={loan.id} />
          <input name="reason" required minLength={5} maxLength={300} defaultValue={deletionRequest?.reason ?? ''} className="input" placeholder="Motivo (queda registrado)" aria-label="Motivo" />
          <input name="confirm" required autoComplete="off" placeholder="Escriba ELIMINAR" className="input" aria-label="Confirmación" />
        </ActionForm>
      </section>
    </>
  );
}
