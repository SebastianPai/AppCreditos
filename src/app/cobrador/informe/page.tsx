import { CollectorReportView, PeriodFilter, type CollectorReport } from '@/components/collector-report';
import { PrintButton } from '@/components/pwa';
import { Notice, PageHeader } from '@/components/ui';
import { requireRole } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { rangeFor, todayBogota } from '@/lib/finance';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Informe de cobro' };

export default async function CollectorReportPage({ searchParams }: { searchParams: Promise<{ periodo?: string; desde?: string; hasta?: string }> }) {
  const profile = await requireRole('collector');
  const sp = await searchParams;
  const period = sp.periodo ?? 'day';
  const { from, to } = rangeFor(period, todayBogota(), sp.desde, sp.hasta);
  const db = await userDb();
  const { data, error } = await db.call('collector_report', { p_collector_id: profile.id, p_from: from, p_to: to });
  const qs = new URLSearchParams({ desde: from, hasta: to }).toString();
  return (
    <>
      <PageHeader
        title="Informe de cobro"
        actions={
          <>
            <a href={`/api/export/collector?${qs}`} className="btn-secondary">Descargar Excel</a>
            <PrintButton />
          </>
        }
      />
      <PeriodFilter action="/cobrador/informe" period={period} from={from} to={to} />
      {error ? <Notice tone="danger">{friendlyError(error)}</Notice> : <CollectorReportView r={data as CollectorReport} />}
    </>
  );
}
