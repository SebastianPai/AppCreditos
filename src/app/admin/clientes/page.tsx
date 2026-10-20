import Link from 'next/link';
import { Card, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { formatCOP, formatDate } from '@/lib/finance';
import { CUSTOMER_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { uuidOrNull } from '@/lib/validation';

export const metadata = { title: 'Clientes' };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; cobrador?: string; eliminado?: string }> }) {
  const { q, cobrador, eliminado } = await searchParams;
  const db = await userDb();
  const term = q ? `%${q.replace(/[%_\\]/g, '')}%` : null;
  const [data, collectors] = await Promise.all([
    db.query(
      `select * from public.v_customers
        where ($1::text is null or full_name ilike $1 or code ilike $1 or phone ilike $1)
          and ($2::uuid is null or collector_id = $2)
        order by registered_at desc limit 300`,
      [term, uuidOrNull(cobrador)],
    ),
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' order by full_name`),
  ]);
  const colNames = new Map((collectors ?? []).map((c) => [c.id, c.full_name]));
  return (
    <>
      <PageHeader title="Clientes" actions={<LinkButton href="/admin/clientes/nuevo">Nuevo cliente</LinkButton>} />
      {eliminado === '1' && <div className="mb-4"><Notice tone="neutral">Cliente de prueba eliminado.</Notice></div>}
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_220px_auto]">
        <input name="q" defaultValue={q} placeholder="Buscar por nombre, código o teléfono" className="input" aria-label="Buscar" />
        <select name="cobrador" defaultValue={cobrador ?? ''} className="input" aria-label="Cobrador">
          <option value="">Todos los cobradores</option>
          {collectors?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
        </select>
        <button className="btn-secondary">Buscar</button>
      </form>
      <Card>
        {!data?.length ? (
          <EmptyState>No hay clientes.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Código</th><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Cobrador</th><th className="num">Saldo</th><th>Próx. venc.</th><th>Estado</th></tr></thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/admin/clientes/${c.id}`} className="font-medium text-brand-700">{c.code}</Link></td>
                    <td>{c.full_name}</td>
                    <td>{c.document_type} {c.document_masked}</td>
                    <td>{c.phone}</td>
                    <td>{c.collector_id ? colNames.get(c.collector_id) : <span className="text-amber-700">Sin asignar</span>}</td>
                    <td className="num">{formatCOP(c.outstanding)}</td>
                    <td>{formatDate(c.next_due_date)}</td>
                    <td><StatusBadge map={CUSTOMER_STATUS} value={c.status} /></td>
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
