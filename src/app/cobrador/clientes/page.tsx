import Link from 'next/link';
import { Badge, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { dueStatus, formatCOP, todayBogota } from '@/lib/finance';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Mis clientes' };

export default async function CollectorCustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const db = await userDb();
  const ops = await db.one<{ value: { collectors_can_create_customers?: boolean } }>(`select value from public.app_settings where key = 'operations'`);
  const canCreate = ops?.value.collectors_can_create_customers ?? false;
  const data = await db.query(
    `select * from public.v_customers where status = 'active' and ($1::text is null or full_name ilike $1) order by full_name`,
    [q ? `%${q.replace(/[%_\\]/g, '')}%` : null]);
  return (
    <>
      <PageHeader title="Mis clientes" actions={canCreate ? <LinkButton href="/cobrador/clientes/nuevo">Nuevo cliente</LinkButton> : undefined} />
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
                    <p className="text-xs text-slate-500">{c.code} · {c.phone}</p>
                    {c.next_due_date && (() => { const st = dueStatus(c.next_due_date, todayBogota()); return <div className="mt-1"><Badge tone={st.tone}>{st.text}</Badge></div>; })()}
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
