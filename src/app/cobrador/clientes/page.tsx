import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { formatCOP, formatDate } from '@/lib/finance';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Mis clientes' };

export default async function CollectorCustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const db = await userDb();
  const data = await db.query(
    `select * from public.v_customers where status = 'active' and ($1::text is null or full_name ilike $1) order by full_name`,
    [q ? `%${q.replace(/[%_\\]/g, '')}%` : null]);
  return (
    <>
      <PageHeader title="Mis clientes" />
      <form className="mb-4">
        <input name="q" defaultValue={q} placeholder="Buscar por nombre" className="input" aria-label="Buscar cliente" />
      </form>
      <Card>
        {!data?.length ? (
          <EmptyState>No tiene clientes asignados.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((c) => (
              <li key={c.id}>
                <Link href={`/cobrador/clientes/${c.id}`} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium">{c.full_name}</p>
                    <p className="text-xs text-slate-500">{c.code} · {c.phone}{c.next_due_date && ` · vence ${formatDate(c.next_due_date)}`}</p>
                  </div>
                  <span className="font-semibold tabular-nums">{formatCOP(c.outstanding)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
