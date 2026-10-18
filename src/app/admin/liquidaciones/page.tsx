import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { addDays, formatCOP, formatDate, quarterOf, todayBogota } from '@/lib/finance';
import { WORKFLOW_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { createSettlement } from '../actions';

export const metadata = { title: 'Liquidaciones trimestrales' };

export default async function SettlementsPage() {
  const db = await userDb();
  const data = await db.query('select id, period_start, period_end, status, report, approved_at from public.quarterly_settlements order by period_start desc');
  const today = todayBogota();
  const current = quarterOf(today);
  const previous = quarterOf(addDays(current.start, -1));
  return (
    <>
      <PageHeader title="Liquidaciones trimestrales" subtitle="Solo se distribuyen intereses efectivamente cobrados, netos de comisiones, gastos y ajustes. El capital recuperado no es ganancia." />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card title="Preparar liquidación">
          <ActionForm action={createSettlement} submitLabel="Crear borrador">
            <div><label className="label">Desde</label><input type="date" name="period_start" defaultValue={previous.start} className="input" required /></div>
            <div><label className="label">Hasta</label><input type="date" name="period_end" defaultValue={previous.end} className="input" required /></div>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-500">
            Trimestre anterior: {formatDate(previous.start)} – {formatDate(previous.end)}. Trimestre en curso termina el {formatDate(current.end)}; solo se aprueba
            un periodo ya terminado.
          </p>
        </Card>
        <Card title="Historial">
          {!data?.length ? (
            <EmptyState>Aún no hay liquidaciones.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.map((s) => (
                <li key={s.id}>
                  <Link href={`/admin/liquidaciones/${s.id}`} className="flex items-center justify-between gap-2 py-3">
                    <span>{formatDate(s.period_start)} – {formatDate(s.period_end)}</span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{formatCOP((s.report as { net_distributable: number }).net_distributable)}</span>
                      <StatusBadge map={WORKFLOW_STATUS} value={s.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
