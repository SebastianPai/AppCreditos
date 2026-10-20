import Link from 'next/link';
import { LinkButton } from '@/components/ui';
import { requireRole, userDb } from '@/lib/auth';
import { dueStatus, formatCOP, formatDate, todayBogota } from '@/lib/finance';

export const metadata = { title: 'Clientes' };

interface Row {
  id: string;
  full_name: string;
  owed: number;
  next_due: string | null;
  next_amount: number | null;
}

export default async function CollectorCustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const profile = await requireRole('collector');
  const db = await userDb();
  const today = todayBogota();
  const rows = await db.query<Row>(
    `select c.id, c.full_name,
            coalesce((select sum(i.outstanding) from public.v_installments i
                       where i.customer_id = c.id and i.loan_status = 'active'), 0)::bigint as owed,
            n.due_date as next_due, n.outstanding as next_amount
       from public.customers c
       left join lateral (select i.due_date, i.outstanding from public.v_installments i
                           where i.customer_id = c.id and i.loan_status = 'active' and i.outstanding > 0
                           order by i.due_date limit 1) n on true
      where c.collector_id = $1 and c.status = 'active' and ($2::text is null or c.full_name ilike $2)
      order by n.due_date nulls last, c.full_name`,
    [profile.id, q ? `%${q.replace(/[%_\\]/g, '')}%` : null]);

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Clientes</h1>
        <LinkButton href="/cobrador/clientes/nuevo" className="btn-sm">+ Nuevo</LinkButton>
      </div>
      <form className="mb-3">
        <input name="q" defaultValue={q} placeholder="Buscar por nombre" className="input" aria-label="Buscar cliente" />
      </form>

      {!rows?.length ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          Aún no tiene clientes. Toque «+ Nuevo» para registrar uno.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Cliente</th>
                <th className="px-3 py-2 text-right font-medium">Cuota</th>
                <th className="px-3 py-2 text-right font-medium">Debe</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const st = r.next_due ? dueStatus(r.next_due, today) : null;
                return (
                  <tr key={r.id}>
                    <td className="max-w-0 px-3 py-3">
                      <Link href={`/cobrador/clientes/${r.id}`} className="block truncate font-medium underline-offset-2 hover:underline">{r.full_name}</Link>
                      <span className={`text-xs ${st && st.days < 0 ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
                        {st ? `${formatDate(r.next_due)} · ${st.text}` : 'Sin préstamo'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">{r.next_amount ? formatCOP(r.next_amount) : '—'}</td>
                    <td className="px-3 py-3 text-right font-semibold whitespace-nowrap tabular-nums">{formatCOP(r.owed)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-center text-xs text-slate-500">Toque un nombre para ver más y registrar pagos.</p>
    </>
  );
}
