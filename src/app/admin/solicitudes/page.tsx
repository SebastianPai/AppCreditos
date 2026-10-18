import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { formatCOP, formatDateTime, FREQUENCY_LABEL, type Frequency } from '@/lib/finance';
import { APPLICATION_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Solicitudes' };

const OPEN = ['pending', 'info_requested', 'counter_offered', 'accepted_by_customer'];

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado = 'abiertas' } = await searchParams;
  const db = await userDb();
  const statuses = estado === 'abiertas' ? OPEN : estado === 'todas' ? null : [estado];
  const data = await db.query(
    `select a.id, a.code, a.status, a.requested_principal, a.requested_installments, a.requested_frequency, a.created_at,
            c.full_name, c.code as customer_code
       from public.loan_applications a join public.customers c on c.id = a.customer_id
      where ($1::text[] is null or a.status::text = any($1))
      order by a.created_at desc limit 200`, [statuses]);
  return (
    <>
      <PageHeader title="Solicitudes de préstamo" />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {[['abiertas', 'En trámite'], ['approved', 'Aprobadas'], ['rejected', 'Rechazadas'], ['cancelled', 'Canceladas'], ['todas', 'Todas']].map(([k, l]) => (
          <Link key={k} href={`/admin/solicitudes?estado=${k}`} className={`btn-sm rounded-full border px-3 ${estado === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 bg-white'}`}>{l}</Link>
        ))}
      </div>
      <Card>
        {!data?.length ? (
          <EmptyState>No hay solicitudes.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Código</th><th>Cliente</th><th className="num">Capital</th><th>Condiciones</th><th>Fecha</th><th>Estado</th></tr></thead>
              <tbody>
                {data.map((a) => {
                  const c = { full_name: a.full_name as string, code: a.customer_code as string };
                  return (
                    <tr key={a.id}>
                      <td><Link href={`/admin/solicitudes/${a.id}`} className="font-medium text-brand-700">{a.code}</Link></td>
                      <td>{c?.full_name} <span className="text-xs text-slate-500">{c?.code}</span></td>
                      <td className="num">{formatCOP(a.requested_principal)}</td>
                      <td>{a.requested_installments} · {FREQUENCY_LABEL[a.requested_frequency as Frequency]}</td>
                      <td className="whitespace-nowrap">{formatDateTime(a.created_at)}</td>
                      <td><StatusBadge map={APPLICATION_STATUS} value={a.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
