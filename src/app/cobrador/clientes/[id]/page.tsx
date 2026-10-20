import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { InstallmentsTable } from '@/components/installments-table';
import { PaymentForm } from '@/components/payment-form';
import { LinkButton, MoreSection, Notice } from '@/components/ui';
import { dueStatus, formatCOP, formatDate, todayBogota } from '@/lib/finance';
import { userDb } from '@/lib/auth';
import { creditScore, SCORE_SQL, type ScoreInstallment } from '@/lib/score';
import { collectorCreateAccess, registerPayment, requestReversal } from '../../actions';

export default async function CollectorCustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ creado?: string }> }) {
  const { id } = await params;
  const { creado } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await userDb();
  const customer = await db.one('select c.*, v.document_masked from public.customers c join public.v_customers v on v.id = c.id where c.id = $1', [id]);
  if (!customer) notFound();
  const [loans, installments, payments, scoreRows] = await Promise.all([
    db.query(`select * from public.v_loan_balances where customer_id = $1 and status = 'active' order by created_at desc`, [id]),
    db.query<any>('select * from public.v_installments where customer_id = $1 order by number', [id]),
    db.query('select id, receipt_number, amount, received_on, status from public.payments where customer_id = $1 order by received_at desc limit 20', [id]),
    db.query<ScoreInstallment>(SCORE_SQL, [id]),
  ]);
  const today = todayBogota();
  const score = creditScore(scoreRows ?? [], today);

  return (
    <>
      <Link href="/cobrador/clientes" className="mb-3 inline-block text-sm text-slate-600">← Clientes</Link>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{customer.full_name}</h1>
          <p className="text-sm text-slate-500">CC {customer.document_masked} · Puntaje {score.score}</p>
        </div>
        <a href={`tel:${customer.phone.replace(/\s/g, '')}`} className="btn-secondary btn-sm shrink-0">Llamar</a>
      </div>
      {creado === '1' && <div className="mb-4"><Notice tone="neutral">Préstamo creado. La primera cuota aparece abajo.</Notice></div>}

      {!loans?.length && (
        <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-center">
          <p className="mb-3 text-sm text-slate-500">No tiene préstamo activo.</p>
          <LinkButton href={`/cobrador/prestamos/nuevo?cliente=${id}`}>Crear préstamo</LinkButton>
        </div>
      )}

      {(loans ?? []).map((l) => {
        const rows = (installments ?? []).filter((i) => i.loan_id === l.id);
        const next = rows.find((r) => r.outstanding > 0);
        const st = next ? dueStatus(next.due_date, today) : null;
        return (
          <section key={l.id} className="mb-4 rounded-2xl border border-slate-200 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-slate-500">Debe</p>
                <p className="text-2xl font-bold tabular-nums">{formatCOP(l.outstanding)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Cuota {next?.number ?? '—'} de {l.installments_count}</p>
                <p className="text-2xl font-bold tabular-nums">{next ? formatCOP(next.outstanding) : '—'}</p>
              </div>
            </div>
            {next && st && (
              <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${st.days < 0 ? 'bg-red-50 font-semibold text-red-800' : 'bg-slate-100 text-slate-700'}`}>
                Paga el {formatDate(next.due_date)} · {st.text}
              </p>
            )}
            <div id="pago" className="mt-4">
              <h2 className="mb-2 font-semibold">Registrar pago de hoy</h2>
              <PaymentForm loanId={l.id} outstanding={l.outstanding} nextDue={next?.outstanding ?? 0} action={registerPayment} today={today} />
            </div>
            <MoreSection label="Ver todas las cuotas" className="mt-3">
              <InstallmentsTable rows={rows} showSplit={false} />
            </MoreSection>
          </section>
        );
      })}

      <MoreSection label="Ver más (pagos y datos)">
        <div className="rounded-2xl border border-slate-200 p-4 text-sm">
          <p><span className="text-slate-500">Teléfono:</span> {customer.phone}</p>
          {customer.address && <p><span className="text-slate-500">Dirección:</span> {customer.address}</p>}
          <p><span className="text-slate-500">Usuario de la app:</span> {customer.profile_id ? customer.document_number : 'sin acceso'}</p>
          {!customer.profile_id && (
            <ActionForm action={collectorCreateAccess} submitLabel="Crear acceso a la app" variant="secondary" className="mt-3 space-y-2">
              <input type="hidden" name="customer_id" value={customer.id} />
              <input type="hidden" name="full_name" value={customer.full_name} />
              <input type="hidden" name="phone" value={customer.phone} />
              <input type="hidden" name="document" value={customer.document_number} />
            </ActionForm>
          )}
        </div>
        <div className="rounded-2xl border border-slate-200 p-4">
          <h2 className="mb-2 font-semibold">Pagos</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {(payments ?? []).map((p) => (
              <li key={p.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span>{formatDate(p.received_on)}{p.status === 'reversed' && <span className="ml-1 text-red-700">(anulado)</span>}</span>
                  <Link href={`/comprobantes/${p.id}`} className="font-semibold tabular-nums underline">{formatCOP(p.amount)}</Link>
                </div>
                {p.status === 'confirmed' && p.received_on === today && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-slate-500">¿Se equivocó? Pedir corrección</summary>
                    <ActionForm action={requestReversal} submitLabel="Pedir corrección" variant="secondary" className="mt-2 space-y-2">
                      <input type="hidden" name="payment_id" value={p.id} />
                      <input name="reason" required minLength={5} maxLength={300} className="input" placeholder="Motivo" />
                    </ActionForm>
                  </details>
                )}
              </li>
            ))}
            {!payments?.length && <li className="py-2 text-slate-500">Sin pagos.</li>}
          </ul>
        </div>
      </MoreSection>
    </>
  );
}
