import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { Card, KeyValue, Notice, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { allowedFrequencies, computeTerms, formatCOP, formatDate, formatDateTime, FREQUENCY_LABEL, policyFromRow, todayBogota, type Frequency } from '@/lib/finance';
import { APPLICATION_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { approveApplication, reviewApplication } from '../../actions';

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const a = await db.one('select * from public.loan_applications where id = $1', [id]);
  if (!a) notFound();
  const [collectors, policyRow, history, customerRow] = await Promise.all([
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' and active order by full_name`),
    db.rpc('get_active_policy'),
    db.query('select code, status, principal, outstanding, overdue_amount from public.v_loan_balances where customer_id = $1', [a.customer_id]),
    db.one('select id, code, full_name, phone, collector_id, status from public.customers where id = $1', [a.customer_id]),
  ]);
  const policy = policyFromRow(policyRow as Record<string, unknown>);
  const customer = customerRow as { id: string; code: string; full_name: string; phone: string; collector_id: string | null; status: string };
  const accepted = a.status === 'accepted_by_customer';
  const t = {
    principal: accepted ? a.proposed_principal : a.requested_principal,
    n: accepted ? a.proposed_installments : a.requested_installments,
    f: (accepted ? a.proposed_frequency : a.requested_frequency) as Frequency,
    start: accepted ? a.proposed_start_date : a.requested_start_date,
  };
  const today = todayBogota();
  const startOk = t.start >= today;
  let terms: ReturnType<typeof computeTerms>;
  try {
    terms = computeTerms(t.principal, t.n, t.f, startOk ? t.start : today, policy);
  } catch (e) {
    return (
      <div className="space-y-4">
        <Notice tone="danger">Las condiciones de la solicitud {a.code} no cumplen la política activa: {(e as Error).message}.</Notice>
        <Card title="Rechazar">
          <ActionForm action={reviewApplication} submitLabel="Rechazar solicitud" variant="danger">
            <input type="hidden" name="application_id" value={a.id} />
            <input type="hidden" name="action" value="reject" />
            <textarea name="notes" required rows={2} className="input" defaultValue="Las condiciones no cumplen la política vigente." />
          </ActionForm>
        </Card>
      </div>
    );
  }
  const open = ['pending', 'info_requested', 'accepted_by_customer', 'counter_offered'].includes(a.status);
  const canApprove = ['pending', 'info_requested', 'accepted_by_customer'].includes(a.status);

  return (
    <>
      <Link href="/admin/solicitudes" className="mb-3 inline-block text-sm text-brand-700">← Solicitudes</Link>
      <PageHeader title={`Solicitud ${a.code}`} subtitle={<StatusBadge map={APPLICATION_STATUS} value={a.status} />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cliente">
          <KeyValue
            items={[
              ['Nombre', <Link key="c" href={`/admin/clientes/${customer.id}`} className="text-brand-700">{customer.full_name}</Link>],
              ['Código', customer.code],
              ['Teléfono', customer.phone],
              ['Recibida', formatDateTime(a.created_at)],
              ['Mensaje del cliente', a.customer_message ?? '—'],
              ['Notas de administración', a.admin_notes ?? '—'],
            ]}
          />
          {!!history?.length && (
            <p className="mt-3 text-sm text-slate-600">
              Historial: {history.map((h) => `${h.code} (${h.status}, saldo ${formatCOP(h.outstanding)}${h.overdue_amount ? `, vencido ${formatCOP(h.overdue_amount)}` : ''})`).join(' · ')}
            </p>
          )}
        </Card>
        <Card title={accepted ? 'Condiciones aceptadas por el cliente' : 'Condiciones solicitadas'}>
          <KeyValue
            items={[
              ['Capital', formatCOP(terms.principal)],
              ['Interés total', `${formatCOP(terms.interestTotal)} (${policy.interestBps / 100} %)`],
              ['Total a pagar', formatCOP(terms.totalAmount)],
              ['Cuotas', `${terms.installmentsCount} · ${FREQUENCY_LABEL[terms.frequency]}`],
              ['Comisión cobrador (5 %)', formatCOP(terms.collectorCommissionTotal)],
              ['Bolsa socios (15 %)', formatCOP(terms.partnersPoolTotal)],
              ['Inicio', formatDate(t.start)],
            ]}
          />
          {!startOk && open && <Notice tone="warning">La fecha de inicio solicitada ya pasó: envíe una contraoferta con una fecha nueva.</Notice>}
        </Card>
      </div>

      <Card title="Tabla de amortización" className="mt-4">
        <TableWrap>
          <table className="table">
            <thead><tr><th>#</th><th>Vence</th><th className="num">Capital</th><th className="num">Interés</th><th className="num">Cuota</th><th className="num">Saldo</th></tr></thead>
            <tbody>
              {terms.schedule.map((r) => (
                <tr key={r.number}>
                  <td>{r.number}</td><td>{formatDate(r.dueDate)}</td>
                  <td className="num">{formatCOP(r.principal)}</td><td className="num">{formatCOP(r.interest)}</td>
                  <td className="num font-semibold">{formatCOP(r.total)}</td><td className="num">{formatCOP(r.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        {a.simulation_id && <Link href={`/simulaciones/${a.simulation_id}`} className="mt-2 inline-block text-sm text-brand-700">Ver informe de simulación asociado</Link>}
      </Card>

      {open && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {canApprove && startOk && (
            <Card title="Aprobar y formalizar">
              <ActionForm action={approveApplication} submitLabel="Aprobar préstamo" confirmText="Revisé las condiciones, la capacidad de pago del cliente y la tabla de amortización.">
                <input type="hidden" name="application_id" value={a.id} />
                <input type="hidden" name="principal" value={t.principal} />
                <input type="hidden" name="installments" value={t.n} />
                <input type="hidden" name="frequency" value={t.f} />
                <input type="hidden" name="start_date" value={t.start} />
                <div>
                  <label className="label" htmlFor="collector_id">Cobrador asignado</label>
                  <select id="collector_id" name="collector_id" defaultValue={customer.collector_id ?? ''} required className="input">
                    <option value="" disabled>Seleccione…</option>
                    {collectors?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                  </select>
                </div>
                <p className="text-xs text-slate-500">La aprobación compromete capital. El préstamo queda activo solo al registrar el desembolso.</p>
              </ActionForm>
            </Card>
          )}
          <Card title="Otras acciones">
            <div className="space-y-5">
              <details>
                <summary className="cursor-pointer font-medium text-brand-700">Modificar condiciones (contraoferta)</summary>
                <ActionForm action={reviewApplication} submitLabel="Enviar contraoferta al cliente" className="mt-3 space-y-3">
                  <input type="hidden" name="application_id" value={a.id} />
                  <input type="hidden" name="action" value="counter_offer" />
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="label">Capital</label><input name="principal" defaultValue={t.principal} inputMode="numeric" className="input" required /></div>
                    <div><label className="label">Cuotas</label>
                      <select name="installments" defaultValue={t.n} className="input">{Array.from({ length: policy.maxInstallments }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select>
                    </div>
                    <div><label className="label">Modalidad</label>
                      <select name="frequency" defaultValue={t.f} className="input">
                        {(['weekly', 'biweekly'] as const).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
                      </select>
                    </div>
                    <div><label className="label">Inicio</label><input type="date" name="start_date" min={today} defaultValue={startOk ? t.start : today} className="input" required /></div>
                  </div>
                  <p className="text-xs text-slate-500">Quincenal solo desde {formatCOP(policy.biweeklyMinPrincipal)} ({allowedFrequencies(t.principal, policy).length > 1 ? 'aplica' : 'no aplica'} al capital actual).</p>
                  <textarea name="notes" rows={2} className="input" placeholder="Explicación para el cliente" />
                </ActionForm>
              </details>
              <details>
                <summary className="cursor-pointer font-medium text-brand-700">Solicitar información adicional</summary>
                <ActionForm action={reviewApplication} submitLabel="Solicitar información" variant="secondary" className="mt-3 space-y-3">
                  <input type="hidden" name="application_id" value={a.id} />
                  <input type="hidden" name="action" value="request_info" />
                  <textarea name="notes" required rows={2} className="input" placeholder="¿Qué información necesita?" />
                </ActionForm>
              </details>
              <details>
                <summary className="cursor-pointer font-medium text-red-700">Rechazar</summary>
                <ActionForm action={reviewApplication} submitLabel="Rechazar solicitud" variant="danger" className="mt-3 space-y-3">
                  <input type="hidden" name="application_id" value={a.id} />
                  <input type="hidden" name="action" value="reject" />
                  <textarea name="notes" required rows={2} className="input" placeholder="Motivo" />
                </ActionForm>
              </details>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
