import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { Card, KeyValue, LinkButton, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { formatCOP, formatDate, formatDateTime } from '@/lib/finance';
import { APPLICATION_STATUS, CUSTOMER_STATUS, LOAN_STATUS, PAYMENT_METHOD } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { assignCollector, createUser, purgeTestCustomer, updateCustomer } from '../../actions';

export default async function AdminCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = await db.one('select * from public.customers where id = $1', [id]);
  if (!c) notFound();
  const [summary, loans, payments, apps, collectors] = await Promise.all([
    db.one('select outstanding, next_due_date, active_loans from public.v_customers where id = $1', [id]),
    db.query('select * from public.v_loan_balances where customer_id = $1 order by created_at desc', [id]),
    db.query('select id, receipt_number, amount, method, received_on, status from public.payments where customer_id = $1 order by received_at desc limit 50', [id]),
    db.query('select id, code, status, requested_principal, created_at from public.loan_applications where customer_id = $1 order by created_at desc', [id]),
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' and active order by full_name`),
  ]);
  const nextDue = (loans ?? []).filter((l) => l.status === 'active' && l.next_due_date).sort((a, b) => a.next_due_date.localeCompare(b.next_due_date))[0];

  return (
    <>
      <Link href="/admin/clientes" className="mb-3 inline-block text-sm text-brand-700">← Clientes</Link>
      <PageHeader title={c.full_name} subtitle={<span>{c.code} · <StatusBadge map={CUSTOMER_STATUS} value={c.status} /></span>} actions={<LinkButton href={`/admin/prestamos/nuevo?cliente=${c.id}`}>Nuevo préstamo</LinkButton>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Ficha">
          <KeyValue
            items={[
              ['Documento', `${c.document_type} ${c.document_number}`],
              ['Teléfono', c.phone],
              ['Dirección', c.address ?? '—'],
              ['Registro', formatDateTime(c.registered_at)],
              ['Autorización de datos', formatDateTime(c.data_consent_at)],
              ['Cuenta en la app', c.profile_id ? 'Activa' : 'Sin cuenta'],
              ['Saldo pendiente', formatCOP(summary?.outstanding)],
              ['Próxima cuota', nextDue ? `${formatDate(nextDue.next_due_date)} (${nextDue.code})` : '—'],
            ]}
          />
        </Card>
        <Card title="Cobrador y cuenta">
          <ActionForm action={assignCollector} submitLabel="Asignar cobrador">
            <input type="hidden" name="customer_id" value={c.id} />
            <select name="collector_id" defaultValue={c.collector_id ?? ''} required className="input" aria-label="Cobrador">
              <option value="" disabled>Seleccione…</option>
              {collectors?.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
            </select>
            <p className="text-xs text-slate-500">También reasigna los préstamos activos y aprobados del cliente.</p>
          </ActionForm>
          {!c.profile_id && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-brand-700">Crear cuenta del cliente en la app</summary>
              <ActionForm action={createUser} submitLabel="Crear cuenta" className="mt-2 space-y-2">
                <input type="hidden" name="role" value="customer" />
                <input type="hidden" name="customer_id" value={c.id} />
                <input type="hidden" name="full_name" value={c.full_name} />
                <input type="hidden" name="phone" value={c.phone} />
                <input name="email" type="email" placeholder="Correo (opcional)" className="input" aria-label="Correo" />
                <p className="text-xs text-slate-500">Sin correo, el cliente ingresa con su cédula ({c.document_number}).</p>
              </ActionForm>
            </details>
          )}
        </Card>
        <Card title="Editar">
          <ActionForm action={updateCustomer} submitLabel="Guardar cambios">
            <input type="hidden" name="customer_id" value={c.id} />
            <input name="full_name" defaultValue={c.full_name} required className="input" aria-label="Nombre" />
            <input name="phone" defaultValue={c.phone} required className="input" aria-label="Teléfono" />
            <input name="address" defaultValue={c.address ?? ''} className="input" aria-label="Dirección" placeholder="Dirección" />
            <select name="status" defaultValue={c.status} className="input" aria-label="Estado">
              {Object.entries(CUSTOMER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <textarea name="notes" defaultValue={c.notes ?? ''} rows={2} className="input" aria-label="Notas" />
          </ActionForm>
        </Card>
      </div>

      <Card title="Historial de préstamos" className="mt-4">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Código</th><th className="num">Capital</th><th className="num">Total</th><th className="num">Pagado</th><th className="num">Saldo</th><th className="num">Vencido</th><th>Estado</th></tr></thead>
            <tbody>
              {(loans ?? []).map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/admin/prestamos/${l.id}`} className="text-brand-700">{l.code}</Link></td>
                  <td className="num">{formatCOP(l.principal)}</td>
                  <td className="num">{formatCOP(l.total_amount)}</td>
                  <td className="num">{formatCOP(l.paid_total)}</td>
                  <td className="num">{formatCOP(l.outstanding)}</td>
                  <td className="num">{formatCOP(l.overdue_amount)}</td>
                  <td><StatusBadge map={LOAN_STATUS} value={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Historial de pagos">
          <ul className="divide-y divide-slate-100 text-sm">
            {(payments ?? []).map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <span>N.º {p.receipt_number} · {formatDate(p.received_on)} · {PAYMENT_METHOD[p.method]}{p.status === 'reversed' && <span className="text-red-700"> (reversado)</span>}</span>
                <Link href={`/comprobantes/${p.id}`} className="font-semibold text-brand-700 tabular-nums">{formatCOP(p.amount)}</Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Solicitudes">
          <ul className="divide-y divide-slate-100 text-sm">
            {(apps ?? []).map((a) => (
              <li key={a.id} className="flex justify-between py-2">
                <Link href={`/admin/solicitudes/${a.id}`} className="text-brand-700">{a.code} · {formatCOP(a.requested_principal)}</Link>
                <StatusBadge map={APPLICATION_STATUS} value={a.status} />
              </li>
            ))}
          </ul>
        </Card>
            </div>

      <section id="eliminar" className="mt-6 scroll-mt-20 rounded-2xl border border-red-200 p-4">
        <h2 className="text-sm font-semibold text-red-700">Eliminar cliente de prueba</h2>
        <p className="mt-2 text-sm text-slate-600">
          Borra este cliente y todo lo suyo: acceso a la app, préstamos, cuotas, pagos y comprobantes. Desaparece de pantallas,
          informes y saldos. No se puede deshacer. La eliminación queda anotada en Auditoría.
        </p>
        <ActionForm action={purgeTestCustomer} submitLabel="Eliminar definitivamente" variant="danger" className="mt-3 space-y-2">
          <input type="hidden" name="customer_id" value={c.id} />
          <input name="confirm" required autoComplete="off" placeholder="Escriba ELIMINAR" className="input" aria-label="Confirmación" />
        </ActionForm>
      </section>
    </>
  );
}
