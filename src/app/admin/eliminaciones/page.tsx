import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { formatCOP, formatDateTime } from '@/lib/finance';
import { DELETION_KIND, DELETION_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { decideDeletion } from '../actions';

export const metadata = { title: 'Eliminaciones' };

export default async function DeletionsPage() {
  const db = await userDb();
  const [pending, history] = await Promise.all([
    db.query(`select r.*, public.staff_name(r.requested_by) as requested_by_name,
                     l.principal, l.status as loan_status, c.code as customer_code,
                     (select count(*) from public.loans x where x.customer_id = r.customer_id) as loans_count,
                     (select count(*) from public.payments p where (r.kind = 'loan' and p.loan_id = r.loan_id) or (r.kind = 'customer' and p.customer_id = r.customer_id)) as payments_count
                from public.deletion_requests r
                left join public.loans l on l.id = r.loan_id
                left join public.customers c on c.id = r.customer_id
               where r.status = 'pending' order by r.created_at`),
    db.query(`select r.*, public.staff_name(r.requested_by) as requested_by_name, public.staff_name(r.decided_by) as decided_by_name
                from public.deletion_requests r where r.status <> 'pending' order by r.decided_at desc nulls last limit 200`),
  ]);

  return (
    <>
      <PageHeader
        title="Eliminaciones"
        subtitle="Los cobradores piden eliminar un cliente o un préstamo con un motivo; nada se borra hasta que la administración lo acepte. Todo queda registrado aquí y en Auditoría."
      />

      <Card title={`Solicitudes por decidir (${pending?.length ?? 0})`}>
        {!pending?.length ? (
          <EmptyState>No hay solicitudes de eliminación pendientes.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.id} className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    {DELETION_KIND[r.kind]}:{' '}
                    <Link href={r.kind === 'loan' ? `/admin/prestamos/${r.loan_id}` : `/admin/clientes/${r.customer_id}`} className="text-brand-700 underline">{r.label}</Link>
                  </p>
                  <span className="text-slate-500">{formatDateTime(r.created_at)}</span>
                </div>
                <p className="mt-1 text-slate-700">Pedido por {r.requested_by_name ?? '—'} · Motivo: {r.reason}</p>
                <p className="mt-1 text-slate-600">
                  {r.kind === 'loan'
                    ? `Capital ${formatCOP(r.principal)} · ${r.payments_count} pago(s) registrados`
                    : `${r.loans_count} préstamo(s) · ${r.payments_count} pago(s) registrados`}
                  . Al aceptar se borra{r.kind === 'customer' ? ' el cliente con todo lo suyo' : ' el préstamo con sus cuotas y pagos'}; no se puede deshacer.
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <ActionForm action={decideDeletion} submitLabel="Aceptar y eliminar" variant="danger" confirmText="Revisé la solicitud y autorizo la eliminación definitiva.">
                    <input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="decision" value="approve" />
                    <input name="notes" maxLength={300} className="input" placeholder="Nota (opcional)" aria-label="Nota" />
                  </ActionForm>
                  <ActionForm action={decideDeletion} submitLabel="Rechazar" variant="secondary">
                    <input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="decision" value="reject" />
                    <input name="notes" maxLength={300} className="input" placeholder="Motivo del rechazo (opcional)" aria-label="Motivo del rechazo" />
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Registro de eliminaciones" className="mt-4">
        {!history?.length ? (
          <EmptyState>Todavía no hay eliminaciones registradas.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Qué</th><th>Pidió</th><th>Motivo</th><th>Decidió</th><th>Estado</th><th>Nota</th></tr></thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{formatDateTime(r.decided_at)}</td>
                    <td>{DELETION_KIND[r.kind]}</td>
                    <td>{r.label}{r.result && r.status === 'approved' && <span className="block text-xs text-slate-500">{r.result.loans ?? 0} préstamo(s) · {r.result.payments ?? 0} pago(s)</span>}</td>
                    <td>{r.requested_by_name ?? '—'}</td>
                    <td className="max-w-xs">{r.reason}</td>
                    <td>{r.decided_by_name ?? '—'}</td>
                    <td><StatusBadge map={DELETION_STATUS} value={r.status} /></td>
                    <td className="max-w-xs">{r.decision_notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
