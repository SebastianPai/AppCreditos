import Link from 'next/link';
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatusBadge, TableWrap } from '@/components/ui';
import { dueStatus, formatCOP, formatDate, FREQUENCY_LABEL, isIsoDate, todayBogota, type Frequency } from '@/lib/finance';
import { LOAN_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { uuidOrNull } from '@/lib/validation';

export const metadata = { title: 'Préstamos' };

export default async function LoansPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const db = await userDb();
  const estado = ['approved', 'active', 'paid', 'cancelled'].includes(sp.estado ?? '') ? sp.estado : null;
  const modalidad = ['weekly', 'biweekly'].includes(sp.modalidad ?? '') ? sp.modalidad : null;
  const [loans, collectors, customers] = await Promise.all([
    db.query(
      `select * from public.v_loan_balances
        where ($1::loan_status is null or status = $1)
          and ($2::loan_frequency is null or frequency = $2)
          and ($3::uuid is null or collector_id = $3)
          and ($4::date is null or (created_at at time zone 'America/Bogota')::date >= $4)
          and ($5::date is null or (created_at at time zone 'America/Bogota')::date <= $5)
          and (not $6 or overdue_amount > 0)
        order by created_at desc limit 300`,
      [estado, modalidad, uuidOrNull(sp.cobrador), sp.desde && isIsoDate(sp.desde) ? sp.desde : null,
       sp.hasta && isIsoDate(sp.hasta) ? sp.hasta : null, Boolean(sp.vencidos)],
    ),
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' order by full_name`),
    db.query<{ id: string; full_name: string }>('select id, full_name from public.customers'),
  ]);
  const names = new Map((customers ?? []).map((c) => [c.id, c.full_name]));
  const colNames = new Map((collectors ?? []).map((c) => [c.id, c.full_name]));
  const totals = (loans ?? []).reduce((s, l) => ({ principal: s.principal + l.principal, outstanding: s.outstanding + (l.status === 'active' ? l.outstanding : 0), overdue: s.overdue + l.overdue_amount }), { principal: 0, outstanding: 0, overdue: 0 });

  return (
    <>
      <PageHeader title="Préstamos" actions={<LinkButton href="/admin/prestamos/nuevo">Nuevo préstamo</LinkButton>} />
      <form className="card mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7 lg:items-end">
        <div><label className="label">Estado</label>
          <select name="estado" defaultValue={sp.estado ?? ''} className="input">
            <option value="">Todos</option>
            {Object.entries(LOAN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div><label className="label">Modalidad</label>
          <select name="modalidad" defaultValue={sp.modalidad ?? ''} className="input">
            <option value="">Todas</option><option value="weekly">Semanal</option><option value="biweekly">Quincenal</option>
          </select>
        </div>
        <div><label className="label">Cobrador</label>
          <select name="cobrador" defaultValue={sp.cobrador ?? ''} className="input">
            <option value="">Todos</option>
            {collectors?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </select>
        </div>
        <div><label className="label">Desde</label><input type="date" name="desde" defaultValue={sp.desde} className="input" /></div>
        <div><label className="label">Hasta</label><input type="date" name="hasta" defaultValue={sp.hasta} className="input" /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="vencidos" value="1" defaultChecked={!!sp.vencidos} className="size-4" /> Con mora</label>
        <button className="btn-primary">Filtrar</button>
      </form>
      <p className="mb-2 text-sm text-slate-600">
        {loans?.length ?? 0} préstamos · capital {formatCOP(totals.principal)} · cartera activa {formatCOP(totals.outstanding)} · vencido {formatCOP(totals.overdue)}
      </p>
      <Card>
        {!loans?.length ? (
          <EmptyState>No hay préstamos con esos filtros.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Código</th><th>Cliente</th><th>Cobrador</th><th className="num">Capital</th><th>Cuotas</th><th className="num">Saldo</th><th className="num">Vencido</th><th>Próx. venc.</th><th>Estado</th></tr></thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id}>
                    <td><Link href={`/admin/prestamos/${l.id}`} className="font-medium text-brand-700">{l.code}</Link></td>
                    <td>{names.get(l.customer_id)}</td>
                    <td>{colNames.get(l.collector_id)}</td>
                    <td className="num">{formatCOP(l.principal)}</td>
                    <td>{l.installments_paid}/{l.installments_count} · {FREQUENCY_LABEL[l.frequency as Frequency]}</td>
                    <td className="num">{formatCOP(l.outstanding)}</td>
                    <td className={`num ${l.overdue_amount ? 'text-red-700' : ''}`}>{formatCOP(l.overdue_amount)}</td>
                    <td className="whitespace-nowrap">
                      {formatDate(l.next_due_date)}
                      {l.status === 'active' && l.next_due_date && (() => { const st = dueStatus(l.next_due_date, todayBogota()); return <div><Badge tone={st.tone}>{st.text}</Badge></div>; })()}
                    </td>
                    <td><StatusBadge map={LOAN_STATUS} value={l.status} /></td>
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
