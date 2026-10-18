import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { formatCOP, formatDateTime } from '@/lib/finance';
import { PAYMENT_REQUEST_STATUS } from '@/lib/labels';
import { fileUrl } from '@/lib/storage';
import { userDb } from '@/lib/auth';
import { wompiConfig } from '@/lib/wompi';
import { startGatewayPayment, submitPaymentRequest } from '../actions';

export const metadata = { title: 'Pagar' };

export default async function PayPage({ searchParams }: { searchParams: Promise<{ prestamo?: string; pasarela?: string }> }) {
  const { prestamo, pasarela } = await searchParams;
  const db = await userDb();
  const [loans, methods, settings, requests] = await Promise.all([
    db.query<{ id: string; code: string; outstanding: number; next_due_date: string | null }>(
      `select id, code, outstanding, next_due_date from public.v_loan_balances where status = 'active'`),
    db.query('select * from public.payment_methods where active order by created_at'),
    db.one<{ value: unknown }>(`select value from public.app_settings where key = 'payment_instructions'`),
    db.query('select id, code, amount, status, created_at, review_notes from public.payment_requests order by created_at desc limit 10'),
  ]);
  const qrUrls = methods.map((m) => fileUrl(m.qr_image_path));
  const generalText = (settings?.value as { text?: string | null } | null)?.text;
  const gateway = wompiConfig().enabled;

  return (
    <>
      <PageHeader title="Pagar" subtitle="Consulte cómo pagar y envíe su comprobante. El saldo se actualiza solo cuando el pago se confirma." />
      {pasarela && <div className="mb-4"><Notice tone="info">Recibimos su regreso desde la pasarela. El pago aparecerá como confirmado cuando la pasarela lo notifique.</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Instrucciones de pago">
            {generalText && <p className="mb-3 text-sm whitespace-pre-line text-slate-700">{generalText}</p>}
            {!methods?.length ? (
              <EmptyState>La administración aún no ha configurado medios de pago. Pague a su cobrador asignado y solicite el comprobante.</EmptyState>
            ) : (
              <ul className="space-y-4">
                {methods.map((m, i) => (
                  <li key={m.id} className="rounded-xl border border-slate-200 p-3">
                    <p className="font-semibold">{m.name}</p>
                    {m.account_holder && <p className="text-sm text-slate-600">Titular: {m.account_holder}</p>}
                    {m.account_reference && <p className="text-sm text-slate-600">Cuenta / referencia: {m.account_reference}</p>}
                    <p className="mt-1 text-sm whitespace-pre-line text-slate-700">{m.instructions}</p>
                    {qrUrls[i] && <img src={qrUrls[i]!} alt={`Código QR de ${m.name}`} className="mt-3 w-56 max-w-full rounded-lg border" />}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Escanear un QR o subir un comprobante no confirma el pago por sí mismo. La administración verifica que el dinero se haya recibido.
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Enviar comprobante">
            {!loans?.length ? (
              <EmptyState>No tiene préstamos activos.</EmptyState>
            ) : (
              <ActionForm action={submitPaymentRequest} submitLabel="Enviar para verificación" resetOnSuccess>
                <LoanSelect loans={loans} selected={prestamo} />
                <div>
                  <label className="label" htmlFor="amount">Valor pagado (COP)</label>
                  <input id="amount" name="amount" inputMode="numeric" required className="input" placeholder="180.000" />
                </div>
                {!!methods?.length && (
                  <div>
                    <label className="label" htmlFor="payment_method_id">Medio utilizado</label>
                    <select id="payment_method_id" name="payment_method_id" className="input">
                      {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="label" htmlFor="reference">Número de transacción / referencia</label>
                  <input id="reference" name="reference" maxLength={80} className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="evidence">Comprobante (JPG, PNG, WEBP o PDF, máx. 5 MB)</label>
                  <input id="evidence" name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" required className="input" />
                </div>
              </ActionForm>
            )}
          </Card>

          {gateway && !!loans?.length && (
            <Card title="Pagar en línea">
              <ActionForm action={startGatewayPayment} submitLabel="Ir a la pasarela segura">
                <LoanSelect loans={loans} selected={prestamo} />
                <div>
                  <label className="label" htmlFor="amount-online">Valor a pagar (COP)</label>
                  <input id="amount-online" name="amount" inputMode="numeric" required className="input" />
                </div>
              </ActionForm>
            </Card>
          )}

          <Card title="Mis pagos enviados">
            {!requests?.length ? (
              <EmptyState>No ha enviado comprobantes.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {requests.map((r) => (
                  <li key={r.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span>{r.code} · {formatCOP(r.amount)}</span>
                      <StatusBadge map={PAYMENT_REQUEST_STATUS} value={r.status} />
                    </div>
                    <p className="text-xs text-slate-500">{formatDateTime(r.created_at)}{r.review_notes ? ` · ${r.review_notes}` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function LoanSelect({ loans, selected }: { loans: { id: string; code: string; outstanding: number }[]; selected?: string }) {
  return (
    <div>
      <label className="label">Préstamo</label>
      <select name="loan_id" defaultValue={selected ?? loans[0].id} className="input" required>
        {loans.map((l) => (
          <option key={l.id} value={l.id}>{l.code} · saldo {formatCOP(l.outstanding)}</option>
        ))}
      </select>
    </div>
  );
}
