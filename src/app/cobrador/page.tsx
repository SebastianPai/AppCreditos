import Link from 'next/link';
import { LinkPending } from '@/components/loading-screen';
import { requireRole, userDb } from '@/lib/auth';
import { dueStatus, formatCOP, todayBogota } from '@/lib/finance';

export const metadata = { title: 'Inicio' };

export default async function CollectorHome() {
  const profile = await requireRole('collector');
  const db = await userDb();
  const today = todayBogota();
  const [due, totals] = await Promise.all([
    db.query<{ customer_id: string; full_name: string; due_date: string; outstanding: number }>(
      `select i.customer_id, c.full_name, i.due_date, i.outstanding
         from public.v_installments i join public.customers c on c.id = i.customer_id
        where i.collector_id = $1 and i.loan_status = 'active' and i.outstanding > 0 and i.due_date <= $2
        order by i.due_date limit 5`, [profile.id, today]),
    db.one<{ customers: number; owed: number; due_today: number }>(
      `select count(distinct c.id)::int as customers,
              coalesce((select sum(outstanding) from public.v_installments where collector_id = $1 and loan_status = 'active'), 0)::bigint as owed,
              coalesce((select sum(outstanding) from public.v_installments where collector_id = $1 and loan_status = 'active' and due_date <= $2), 0)::bigint as due_today
         from public.customers c where c.collector_id = $1 and c.status = 'active'`, [profile.id, today]),
  ]);

  return (
    <>
      <h1 className="text-2xl font-bold">Hola, {profile.full_name.split(' ')[0]}</h1>
      <p className="mb-5 text-sm text-slate-500">¿Qué quiere hacer?</p>

      <div className="grid gap-3">
        <BigButton href="/cobrador/clientes/nuevo" title="Nuevo cliente" text="Registrar una persona" primary />
        <BigButton href="/cobrador/prestamos/nuevo" title="Crear préstamo" text="Prestar dinero a un cliente" primary />
        <BigButton href="/cobrador/clientes" title="Ver clientes" text={`${totals?.customers ?? 0} clientes · deben ${formatCOP(totals?.owed ?? 0)}`} />
      </div>

      <section className="mt-6">
        <div className="mb-2 flex items-end justify-between">
          <h2 className="font-semibold">Para cobrar hoy</h2>
          <span className="font-semibold tabular-nums">{formatCOP(totals?.due_today ?? 0)}</span>
        </div>
        {!due?.length ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">Nadie tiene cuota para hoy.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
            {due.map((r, i) => {
              const st = dueStatus(r.due_date, today);
              return (
                <li key={i}>
                  <Link href={`/cobrador/clientes/${r.customer_id}`} className="flex items-center justify-between gap-3 px-3 py-3">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.full_name}</span>
                      <span className={`text-xs ${st.days < 0 ? 'font-semibold text-red-700' : 'text-slate-500'}`}>{st.text}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{formatCOP(r.outstanding)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <Link href="/cobrador/clientes" className="mt-2 block text-center text-sm font-medium text-slate-700 underline">Ver todos</Link>
      </section>
    </>
  );
}

function BigButton({ href, title, text, primary = false }: { href: string; title: string; text: string; primary?: boolean }) {
  return (
    <Link href={href} className={`flex items-center justify-between rounded-2xl px-5 py-4 ${primary ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white text-slate-900'}`}>
      <span>
        <span className="block text-lg font-semibold">{title}</span>
        <span className={`text-sm ${primary ? 'text-slate-300' : 'text-slate-500'}`}>{text}</span>
      </span>
      <span aria-hidden className="text-2xl"><LinkPending>›</LinkPending></span>
    </Link>
  );
}
