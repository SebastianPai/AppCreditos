import Link from 'next/link';
import { DailyCollectionsChart, MonthlyChart } from '@/components/charts';
import { Card, Notice, PageHeader, Stat, StatGrid, StatusBadge } from '@/components/ui';
import { CAPITAL_DEFINITIONS, formatCOP, formatDate, formatDateTime, FREQUENCY_LABEL, type Frequency } from '@/lib/finance';
import { WORKFLOW_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { uuidOrNull } from '@/lib/validation';

export const metadata = { title: 'Panel administrativo' };

interface AdminDashboard {
  today: string;
  capital: Record<string, number>;
  month: { disbursed: number; interest_collected: number; principal_recovered: number; commissions_accrued: number };
  commissions: { accrued_total: number; pending_payment: number; paid_total: number };
  partners: { partner_id: string; name: string; share_bps: number; capital: number; calculated: number; collected_unsettled: number; distributed: number; paid: number }[];
  portfolio: { active_loans: number; approved_pending_disbursement: number; outstanding: number; overdue: number };
  applications_pending: number;
  payment_requests_pending: number;
  simulations_7d: number;
  today_collections: { count: number; amount: number };
  next_settlement: { period_end: string; status: string | null };
  series_daily: { date: string; amount: number; interest: number }[];
  series_monthly: { month: string; disbursed: number; collected: number; interest: number }[];
}

export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<{ cobrador?: string }> }) {
  const { cobrador } = await searchParams;
  const db = await userDb();
  const [data, collectors, sims, compliance] = await Promise.all([
    db.rpc('admin_dashboard', { p_collector: uuidOrNull(cobrador) }),
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' and active order by full_name`),
    db.query('select id, principal, installments_count, frequency, created_at, customer_id from public.loan_simulations order by created_at desc limit 6'),
    db.one<{ value: unknown }>(`select value from public.app_settings where key = 'compliance'`),
  ]);
  if (!data) return <Notice tone="danger">No fue posible cargar el panel.</Notice>;
  const d = data as AdminDashboard;
  const c = d.capital;
  const comp = compliance?.value as { mode?: string; legal_review_completed?: boolean; usury_rate_valid_until?: string | null } | undefined;
  const demo = comp?.mode === 'demo';
  const complianceOk = demo || comp?.legal_review_completed && comp.usury_rate_valid_until && comp.usury_rate_valid_until >= d.today;

  return (
    <>
      <PageHeader
        title="Panel administrativo"
        subtitle={formatDate(d.today)}
        actions={
          <form className="flex gap-2">
            <select name="cobrador" defaultValue={cobrador ?? ''} className="input !min-h-9 !py-1" aria-label="Filtrar por cobrador">
              <option value="">Todos los cobradores</option>
              {collectors?.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
            </select>
            <button className="btn-secondary btn-sm">Filtrar</button>
          </form>
        }
      />

      {demo && (
        <div className="mb-4">
          <Notice tone="warning" title="Modo demostración">
            Los controles de cumplimiento están desactivados. No use esta instalación con dinero real.{' '}
            <Link href="/admin/configuracion" className="underline">Cambiar</Link>
          </Notice>
        </div>
      )}
      {!complianceOk && (
        <div className="mb-4">
          <Notice tone="danger" title="Aprobaciones bloqueadas por cumplimiento">
            No se pueden aprobar ni desembolsar préstamos hasta registrar la revisión legal y la tasa de usura vigente.{' '}
            <Link href="/admin/configuracion" className="underline">Configurar</Link>
          </Notice>
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-2">
        <Link href="/admin/solicitudes" className="btn-secondary btn-sm">Solicitudes por revisar: <strong>{d.applications_pending}</strong></Link>
        <Link href="/admin/pagos" className="btn-secondary btn-sm">Pagos por verificar: <strong>{d.payment_requests_pending}</strong></Link>
        <Link href="/admin/prestamos?estado=approved" className="btn-secondary btn-sm">Por desembolsar: <strong>{d.portfolio.approved_pending_disbursement}</strong></Link>
      </div>

      <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">Capital</h2>
      <StatGrid>
        <Stat label="Capital total aportado" value={formatCOP(c.partner_capital)} definition={CAPITAL_DEFINITIONS.partner_capital} />
        <Stat label="Capital disponible" value={formatCOP(c.available)} tone={c.available < 0 ? 'danger' : 'success'} definition={CAPITAL_DEFINITIONS.available} />
        <Stat label="Capital comprometido" value={formatCOP(c.committed)} definition={CAPITAL_DEFINITIONS.committed} />
        <Stat label="Capital colocado" value={formatCOP(c.loans_principal)} definition={CAPITAL_DEFINITIONS.loans_principal} />
        <Stat label="Caja administración" value={formatCOP(c.cash_admin)} definition={CAPITAL_DEFINITIONS.cash_admin} />
        <Stat label="Efectivo en cobradores" value={formatCOP(c.cash_collectors)} definition={CAPITAL_DEFINITIONS.cash_collectors} />
        <Stat label="Resultado no liquidado" value={formatCOP(c.unsettled_result)} definition={CAPITAL_DEFINITIONS.unsettled_result} />
        <Stat label="Utilidades por pagar" value={formatCOP(c.partner_profit_payable)} definition={CAPITAL_DEFINITIONS.partner_profit_payable} />
      </StatGrid>

      <h2 className="mt-6 mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">Este mes y cartera</h2>
      <StatGrid>
        <Stat label="Desembolsado este mes" value={formatCOP(d.month.disbursed)} definition="Capital de préstamos desembolsados en el mes calendario actual." />
        <Stat label="Capital recuperado este mes" value={formatCOP(d.month.principal_recovered)} definition="Parte de capital de los pagos confirmados del mes. No es ganancia." />
        <Stat label="Intereses recaudados este mes" value={formatCOP(d.month.interest_collected)} definition="Parte de interés de los pagos confirmados del mes, neta de reversos." />
        <Stat label="Comisiones devengadas (mes)" value={formatCOP(d.month.commissions_accrued)} definition="5 % del capital, devengado en proporción al interés cobrado en el mes." />
        <Stat label="Cartera pendiente" value={formatCOP(d.portfolio.outstanding)} hint={`${d.portfolio.active_loans} préstamos activos`} definition="Capital + interés aún no pagado de préstamos activos." />
        <Stat label="Cartera vencida" value={formatCOP(d.portfolio.overdue)} tone={d.portfolio.overdue ? 'danger' : undefined} definition="Saldo de cuotas con vencimiento anterior a hoy." />
        <Stat label="Cobros de hoy" value={formatCOP(d.today_collections.amount)} hint={`${d.today_collections.count} pagos`} />
        <Stat label="Comisiones por pagar" value={formatCOP(d.commissions.pending_payment)} hint={`Devengado total ${formatCOP(d.commissions.accrued_total)}`} definition={CAPITAL_DEFINITIONS.commission_payable} />
      </StatGrid>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Recaudo diario (30 días)"><DailyCollectionsChart data={d.series_daily} /></Card>
        <Card title="Mensual (12 meses)"><MonthlyChart data={d.series_monthly} /></Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Ganancias de los socios" className="lg:col-span-2">
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="table">
              <thead>
                <tr><th>Socio</th><th className="num">Capital</th><th className="num">Calculada</th><th className="num">Recaudada sin liquidar</th><th className="num">Distribuida</th><th className="num">Pagada</th></tr>
              </thead>
              <tbody>
                {d.partners.map((p) => (
                  <tr key={p.partner_id}>
                    <td>{p.name} ({p.share_bps / 100} %)</td>
                    <td className="num">{formatCOP(p.capital)}</td>
                    <td className="num">{formatCOP(p.calculated)}</td>
                    <td className="num">{formatCOP(p.collected_unsettled)}</td>
                    <td className="num">{formatCOP(p.distributed)}</td>
                    <td className="num">{formatCOP(p.paid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Calculada: participación sobre la bolsa contractual (15 %) de préstamos desembolsados. Recaudada sin liquidar: participación sobre intereses ya
            cobrados, netos de comisiones y gastos. Distribuida: aprobada en liquidaciones. Pagada: entregada al socio.
          </p>
        </Card>
        <Card title="Próxima liquidación">
          <p className="text-2xl font-bold">{formatDate(d.next_settlement.period_end)}</p>
          <p className="mt-1">{d.next_settlement.status ? <StatusBadge map={WORKFLOW_STATUS} value={d.next_settlement.status} /> : <span className="text-sm text-slate-500">Aún no creada</span>}</p>
          <Link href="/admin/liquidaciones" className="btn-secondary btn-sm mt-3">Ir a liquidaciones</Link>
        </Card>
      </div>

      <Card title={`Simulaciones recientes (${d.simulations_7d} en 7 días)`} className="mt-4">
        <ul className="divide-y divide-slate-100 text-sm">
          {sims?.map((s) => (
            <li key={s.id} className="flex justify-between py-2">
              <Link href={`/simulaciones/${s.id}`} className="text-brand-700">
                {formatCOP(s.principal)} · {s.installments_count} cuotas {FREQUENCY_LABEL[s.frequency as Frequency].toLowerCase()}es
              </Link>
              <span className="text-slate-500">{s.customer_id ? 'Cliente' : 'Anónima'} · {formatDateTime(s.created_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
