import { Trend } from '@/components/score-trend';
import { LinkButton, MoreSection } from '@/components/ui';
import { requireRole, userDb } from '@/lib/auth';
import { formatDate, todayBogota } from '@/lib/finance';
import { creditScore, SCORE_SQL, type ScoreInstallment } from '@/lib/score';

export const metadata = { title: 'Mi puntaje' };

export default async function CustomerScorePage() {
  await requireRole('customer');
  const db = await userDb();
  const rows = await db.query<ScoreInstallment>(SCORE_SQL, [null]);
  const score = creditScore(rows ?? [], todayBogota());
  const bar = score.score >= 90 ? 'bg-slate-800' : score.score >= 50 ? 'bg-slate-500' : 'bg-red-600';

  return (
    <>
      <h1 className="mb-4 text-2xl font-bold">Mi puntaje</h1>
      <section className="rounded-2xl border border-slate-200 p-5 text-center">
        <p className="text-6xl font-bold tabular-nums">{score.score}</p>
        <p className="text-sm text-slate-500">de 100 · {score.level.label}</p>
        <div className="mt-3 flex justify-center"><Trend change={score.lastChange} /></div>
        <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          <div className={`h-full ${bar}`} style={{ width: `${score.score}%` }} />
        </div>
        <div className="relative mt-1 h-4 text-[11px] text-slate-400"><span className="absolute left-0">0</span><span className="absolute left-[90%] -translate-x-1/2">90</span><span className="absolute right-0">100</span></div>
        <p className={`mt-4 rounded-xl p-3 text-sm ${score.score >= 90 ? 'bg-slate-800 text-white' : score.score < 50 ? 'bg-red-50 text-red-800' : 'bg-slate-100 text-slate-700'}`}>
          {score.level.message}
        </p>
        {score.score >= 90 && <LinkButton href="/cliente/simular" className="mt-3 w-full">Ver un nuevo préstamo</LinkButton>}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 p-4 text-sm">
        <h2 className="mb-2 font-semibold">¿Cómo sube o baja?</h2>
        <ul className="space-y-1 text-slate-700">
          <li>▲ Pagar una cuota a tiempo: <strong>sube 5</strong></li>
          <li>▲ Terminar de pagar un préstamo: <strong>sube 5</strong></li>
          <li>▼ Pagar tarde: <strong>baja</strong> (más días, más baja)</li>
          <li>▼ Tener cuotas sin pagar vencidas: <strong>baja más</strong></li>
        </ul>
      </section>

      {score.events.length > 0 && (
        <MoreSection label="Ver mis cambios" className="mt-4">
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 text-sm">
            {score.events.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{e.text}</span>
                  <span className="text-xs text-slate-500">{formatDate(e.date)}</span>
                </span>
                <span className={`font-semibold tabular-nums ${e.points < 0 ? 'text-red-700' : ''}`}>{e.points > 0 ? `+${e.points}` : e.points}</span>
              </li>
            ))}
          </ul>
        </MoreSection>
      )}
    </>
  );
}
