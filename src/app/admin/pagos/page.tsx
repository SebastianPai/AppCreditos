import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { formatCOP, formatDateTime, todayBogota } from '@/lib/finance';
import { PAYMENT_REQUEST_STATUS } from '@/lib/labels';
import { fileUrl } from '@/lib/storage';
import { userDb } from '@/lib/auth';
import { confirmHandover, decideReversal, reviewPaymentRequest } from '../actions';

export const metadata = { title: 'Verificar pagos' };

export default async function VerifyPaymentsPage() {
  const db = await userDb();
  const [requests, reversals, handovers, recent] = await Promise.all([
    db.query(`select r.*, c.full_name, l.code as loan_code, m.name as method_name
                from public.payment_requests r join public.customers c on c.id = r.customer_id join public.loans l on l.id = r.loan_id
                left join public.payment_methods m on m.id = r.payment_method_id
               where r.status in ('pending_verification', 'requested') order by r.created_at`),
    db.query(`select rr.*, p.receipt_number, p.amount, p.loan_id, pr.full_name from public.reversal_requests rr
                join public.payments p on p.id = rr.payment_id join public.profiles pr on pr.id = rr.requested_by
               where rr.status = 'pending' order by rr.created_at`),
    db.query(`select h.*, p.full_name from public.cash_handovers h join public.profiles p on p.id = h.collector_id where h.status = 'pending' order by h.declared_at`),
    db.query(`select r.id, r.code, r.amount, r.status, r.reviewed_at, c.full_name from public.payment_requests r join public.customers c on c.id = r.customer_id
               where r.status in ('confirmed', 'rejected') order by r.reviewed_at desc nulls last limit 10`),
  ]);
  const evidence = requests.map((r) => fileUrl(r.evidence_path));
  const today = todayBogota();

  return (
    <>
      <PageHeader title="Verificar pagos" subtitle="Un comprobante o un QR no prueba que el dinero llegó: confirme contra el extracto bancario antes de aprobar." />

      <Card title={`Comprobantes por verificar (${requests?.length ?? 0})`}>
        {!requests?.length ? (
          <EmptyState>No hay pagos pendientes de verificación.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {requests.map((r, i) => {
              return (
                <li key={r.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{r.code} · {r.full_name} · {r.loan_code}</p>
                    <StatusBadge map={PAYMENT_REQUEST_STATUS} value={r.status} />
                  </div>
                  <p className="text-sm text-slate-600">
                    {formatCOP(r.amount)} · {r.method_name ?? 'Sin medio'} · ref. {r.reference ?? '—'} · {formatDateTime(r.created_at)}
                  </p>
                  {evidence[i] && (
                    <a href={evidence[i]!} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-brand-700 underline">Ver comprobante (enlace temporal)</a>
                  )}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <ActionForm action={reviewPaymentRequest} submitLabel="Confirmar pago recibido" confirmText="Verifiqué el ingreso en el extracto bancario.">
                      <input type="hidden" name="request_id" value={r.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <div><label className="label">Fecha de recepción</label><input type="date" name="received_on" max={today} defaultValue={today} className="input" /></div>
                    </ActionForm>
                    <ActionForm action={reviewPaymentRequest} submitLabel="Rechazar" variant="danger">
                      <input type="hidden" name="request_id" value={r.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <input name="notes" required minLength={3} className="input" placeholder="Motivo del rechazo" />
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`Correcciones solicitadas (${reversals?.length ?? 0})`}>
          {!reversals?.length ? (
            <EmptyState>Sin solicitudes de corrección.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {reversals.map((r) => {
                const p = r;
                return (
                  <li key={r.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
                    <p>
                      Recibo <Link href={`/admin/prestamos/${p.loan_id}`} className="text-brand-700">{p.receipt_number}</Link> · {formatCOP(p.amount)} · por{' '}
                      {r.full_name}
                    </p>
                    <p className="mt-1 text-slate-700">Motivo: {r.reason}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <ActionForm action={decideReversal} submitLabel="Autorizar reverso" variant="danger">
                        <input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="decision" value="approve" />
                      </ActionForm>
                      <ActionForm action={decideReversal} submitLabel="Rechazar" variant="secondary">
                        <input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="decision" value="reject" />
                      </ActionForm>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={`Entregas de efectivo por confirmar (${handovers?.length ?? 0})`}>
          {!handovers?.length ? (
            <EmptyState>Sin entregas pendientes.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {handovers.map((h) => (
                <li key={h.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                  <p className="font-semibold">{formatCOP(h.amount)} · registrada por {h.full_name}</p>
                  <p className="text-slate-500">{formatDateTime(h.declared_at)} {h.notes && `· ${h.notes}`}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <ActionForm action={confirmHandover} submitLabel="Recibí el dinero">
                      <input type="hidden" name="handover_id" value={h.id} /><input type="hidden" name="decision" value="approve" />
                    </ActionForm>
                    <ActionForm action={confirmHandover} submitLabel="No coincide" variant="secondary">
                      <input type="hidden" name="handover_id" value={h.id} /><input type="hidden" name="decision" value="reject" />
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Últimas verificaciones" className="mt-4">
        <ul className="divide-y divide-slate-100 text-sm">
          {(recent ?? []).map((r) => (
            <li key={r.id} className="flex justify-between py-2">
              <span>{r.code} · {r.full_name} · {formatCOP(r.amount)}</span>
              <span className="flex items-center gap-2"><StatusBadge map={PAYMENT_REQUEST_STATUS} value={r.status} /> {formatDateTime(r.reviewed_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
