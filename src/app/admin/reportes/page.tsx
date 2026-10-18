import { CollectorReportView, PeriodFilter, type CollectorReport } from '@/components/collector-report';
import { PrintButton } from '@/components/pwa';
import { Card, KeyValue, Notice, PageHeader } from '@/components/ui';
import { friendlyError } from '@/lib/errors';
import { formatCOP, formatDate, rangeFor, todayBogota } from '@/lib/finance';
import { userDb } from '@/lib/auth';
import { uuidOrNull } from '@/lib/validation';

export const metadata = { title: 'Reportes' };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ periodo?: string; desde?: string; hasta?: string; cobrador?: string }> }) {
  const sp = await searchParams;
  const period = sp.periodo ?? 'day';
  const { from, to } = rangeFor(period, todayBogota(), sp.desde, sp.hasta);
  const db = await userDb();
  const fromTs = `${from}T00:00:00-05:00`;
  const toTs = `${to}T23:59:59.999-05:00`;
  const [collectors, payments, disbursed, expenses, counts] = await Promise.all([
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' order by full_name`),
    db.query<{ amount: number; principal_amount: number; interest_amount: number; commission_amount: number; status: string; is_partial: boolean }>(
      'select amount, principal_amount, interest_amount, commission_amount, status, is_partial from public.payments where received_on between $1 and $2', [from, to]),
    db.query<{ principal: number; interest_total: number }>('select principal, interest_total from public.loans where disbursed_at between $1 and $2', [fromTs, toTs]),
    db.query<{ amount: number }>('select amount from public.expenses where occurred_on between $1 and $2', [from, to]),
    db.one<{ applications: number; simulations: number }>(
      `select (select count(*) from public.loan_applications where created_at between $1 and $2) as applications,
              (select count(*) from public.loan_simulations where created_at between $1 and $2) as simulations`, [fromTs, toTs]),
  ]);
  const applications = counts?.applications ?? 0;
  const simulations = counts?.simulations ?? 0;
  const confirmed = (payments ?? []).filter((p) => p.status === 'confirmed');
  const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + Number(f(r)), 0);

  let collectorReport: CollectorReport | null = null;
  let collectorError = '';
  if (sp.cobrador) {
    const { data, error } = await db.call('collector_report', { p_collector_id: uuidOrNull(sp.cobrador), p_from: from, p_to: to });
    if (error) collectorError = friendlyError(error);
    else collectorReport = data as CollectorReport;
  }
  const qs = new URLSearchParams({ desde: from, hasta: to, cobrador: sp.cobrador ?? '' }).toString();

  return (
    <>
      <PageHeader title="Reportes" subtitle={`${formatDate(from)}${from !== to ? ` – ${formatDate(to)}` : ''}`} actions={<PrintButton />} />
      <PeriodFilter
        action="/admin/reportes"
        period={period}
        from={from}
        to={to}
        extra={
          <div>
            <label className="label" htmlFor="cobrador">Cobrador</label>
            <select id="cobrador" name="cobrador" defaultValue={sp.cobrador ?? ''} className="input">
              <option value="">Resumen general</option>
              {collectors?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
          </div>
        }
      />
      {!sp.cobrador && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Cobros">
            <KeyValue
              items={[
                ['Pagos confirmados', confirmed.length],
                ['Pagos parciales', confirmed.filter((p) => p.is_partial).length],
                ['Total recaudado', formatCOP(sum(confirmed, (p) => p.amount))],
                ['Capital recuperado', formatCOP(sum(confirmed, (p) => p.principal_amount))],
                ['Intereses cobrados', formatCOP(sum(confirmed, (p) => p.interest_amount))],
                ['Comisiones devengadas', formatCOP(sum(confirmed, (p) => p.commission_amount))],
                ['Pagos reversados', (payments ?? []).length - confirmed.length],
              ]}
            />
          </Card>
          <Card title="Colocación y gastos">
            <KeyValue
              items={[
                ['Préstamos desembolsados', disbursed?.length ?? 0],
                ['Capital desembolsado', formatCOP(sum(disbursed ?? [], (l) => l.principal))],
                ['Interés contractual de esos préstamos', formatCOP(sum(disbursed ?? [], (l) => l.interest_total))],
                ['Gastos autorizados', formatCOP(sum(expenses ?? [], (e) => e.amount))],
                ['Solicitudes recibidas', applications ?? 0],
                ['Simulaciones', simulations ?? 0],
              ]}
            />
          </Card>
        </div>
      )}
      {sp.cobrador && (
        <>
          <div className="no-print mb-3"><a href={`/api/export/collector?${qs}`} className="btn-secondary">Descargar Excel</a></div>
          {collectorError ? <Notice tone="danger">{collectorError}</Notice> : collectorReport && <CollectorReportView r={collectorReport} />}
        </>
      )}
    </>
  );
}
