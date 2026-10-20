import Link from 'next/link';
import { LinkButton, Notice } from '@/components/ui';
import { requireRole, userDb } from '@/lib/auth';
import { daysBetween, formatCOP, formatDate, todayBogota } from '@/lib/finance';
import { Trend } from '@/components/score-trend';
import { creditScore, SCORE_SQL, type ScoreInstallment } from '@/lib/score';

export const metadata = { title: 'Mi préstamo' };

export default async function CustomerHome() {
  const profile = await requireRole('customer');
  const db = await userDb();
  const today = todayBogota();
  const [customer, loans, installments, scoreRows] = await Promise.all([
    db.one<{ id: string }>('select id from public.v_customers limit 1'),
    db.query(`select * from public.v_loan_balances where status = 'active' order by created_at`),
    db.query<{ loan_id: string; number: number; due_date: string; outstanding: number }>(
      `select loan_id, number, due_date, outstanding from public.v_installments where loan_status = 'active' order by due_date`),
    db.query<ScoreInstallment>(SCORE_SQL, [null]),
  ]);
  const score = creditScore(scoreRows ?? [], today);

  return (
    <>
      <h1 className="mb-4 text-2xl font-bold">Hola, {profile.full_name.split(' ')[0]}</h1>
      {!customer && <Notice tone="warning">Su cuenta aún no está lista. Hable con su cobrador.</Notice>}

      {customer && !loans?.length && (
        <div className="rounded-2xl border border-slate-200 p-5 text-center">
          <p className="text-lg font-semibold">No tiene préstamo</p>
          <p className="mt-1 text-sm text-slate-500">No debe nada.</p>
          <LinkButton href="/cliente/simular" className="mt-4 w-full">Ver cuánto pagaría por un préstamo</LinkButton>
        </div>
      )}

      {(loans ?? []).map((l) => {
        const rows = (installments ?? []).filter((i) => i.loan_id === l.id);
        const next = rows.find((r) => r.outstanding > 0);
        const days = next ? daysBetween(today, next.due_date) : 0;
        const late = rows.filter((r) => r.outstanding > 0 && r.due_date < today);
        return (
          <section key={l.id} className="mb-4 rounded-2xl border border-slate-200 p-5">
            <p className="text-sm text-slate-500">Usted debe</p>
            <p className="text-4xl font-bold tabular-nums">{formatCOP(l.outstanding)}</p>
            {next && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-100 p-3">
                  <p className="text-xs text-slate-500">Próxima cuota</p>
                  <p className="text-lg font-bold tabular-nums">{formatCOP(next.outstanding)}</p>
                  <p className="text-xs text-slate-600">{formatDate(next.due_date)}</p>
                </div>
                <div className={`rounded-xl p-3 ${days < 0 ? 'bg-red-50 text-red-800' : 'bg-slate-100'}`}>
                  <p className="text-xs opacity-70">{days < 0 ? 'Va atrasado' : days === 0 ? 'Paga' : 'Le faltan'}</p>
                  <p className="text-lg font-bold">{days < 0 ? `${-days} día${days === -1 ? '' : 's'}` : days === 0 ? 'Hoy' : `${days} día${days === 1 ? '' : 's'}`}</p>
                  <p className="text-xs opacity-70">{days < 0 ? 'Póngase al día' : 'para pagar'}</p>
                </div>
              </div>
            )}
            {late.length > 1 && <p className="mt-2 text-sm font-semibold text-red-700">Tiene {late.length} cuotas atrasadas.</p>}
            <p className="mt-3 text-sm text-slate-600">Ha pagado {l.installments_paid} de {l.installments_count} cuotas.</p>
            <Link href={`/cliente/prestamos/${l.id}`} className="mt-3 block text-center text-sm font-medium underline">Ver más</Link>
          </section>
        );
      })}

      {customer && (
        <Link href="/cliente/puntaje" className="flex items-center justify-between rounded-2xl border border-slate-200 p-5">
          <span>
            <span className="block text-sm text-slate-500">Mi puntaje</span>
            <span className="text-3xl font-bold tabular-nums">{score.score}</span>
            <span className="ml-2 text-sm text-slate-500">de 100 · {score.level.label}</span>
          </span>
          <Trend change={score.lastChange} />
        </Link>
      )}
    </>
  );
}
