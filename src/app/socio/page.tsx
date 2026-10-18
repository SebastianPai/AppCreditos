import { Card, EmptyState, Notice, PageHeader, Stat, StatGrid, StatusBadge, TableWrap } from '@/components/ui';
import { friendlyError } from '@/lib/errors';
import { CAPITAL_DEFINITIONS, formatCOP, formatDate, formatDateTime } from '@/lib/finance';
import { WORKFLOW_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Resumen del socio' };

interface PartnerDashboard {
  partner: { id: string; name: string; share_bps: number };
  my_capital: number;
  my_advances: number;
  partners: { name: string; share_bps: number; capital: number }[] | null;
  capital: Record<string, number>;
  loans: { active: number; active_principal: number };
  principal_recovered_total: number;
  interest_collected_total: number;
  my_profit_distributed: number;
  my_profit_paid: number;
  my_unsettled_estimate: number;
  settlements: { id: string; period_start: string; period_end: string; status: string; gross: number | null; advances: number | null; net: number | null; paid_at: string | null }[];
}

export default async function PartnerHome() {
  const db = await userDb();
  const { data, error } = await db.call('partner_dashboard');
  if (error) return <Notice tone="danger">{friendlyError(error)}</Notice>;
  const d = data as PartnerDashboard;
  return (
    <>
      <PageHeader title={d.partner.name} subtitle={`Participación ${d.partner.share_bps / 100} % · solo lectura`} />
      <StatGrid>
        <Stat label="Mi capital aportado" value={formatCOP(d.my_capital)} definition="Aportes menos retiros de capital registrados a su nombre." />
        <Stat label="Mis ganancias distribuidas" value={formatCOP(d.my_profit_distributed)} hint={`Pagado: ${formatCOP(d.my_profit_paid)}`} definition="Participación aprobada en liquidaciones trimestrales." />
        <Stat label="Estimado por liquidar" value={formatCOP(d.my_unsettled_estimate)} definition="Su participación sobre los intereses ya cobrados (netos de comisiones y gastos) desde la última liquidación. No es definitiva hasta aprobarse." />
        <Stat label="Anticipos pendientes" value={formatCOP(d.my_advances)} definition="Anticipos recibidos que se descontarán de su próxima distribución." />
        <Stat label="Préstamos activos" value={d.loans.active} hint={formatCOP(d.loans.active_principal)} />
        <Stat label="Capital recuperado (total)" value={formatCOP(d.principal_recovered_total)} definition="Capital devuelto por los clientes. Vuelve a estar disponible para prestar; no es ganancia." />
        <Stat label="Intereses recaudados (total)" value={formatCOP(d.interest_collected_total)} />
        <Stat label="Capital disponible" value={formatCOP(d.capital.available)} definition={CAPITAL_DEFINITIONS.available} />
      </StatGrid>

      {d.partners && (
        <Card title="Capital por socio" className="mt-5">
          <ul className="divide-y divide-slate-100 text-sm">
            {d.partners.map((p) => (
              <li key={p.name} className="flex justify-between py-2"><span>{p.name} ({p.share_bps / 100} %)</span><strong className="tabular-nums">{formatCOP(p.capital)}</strong></li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Liquidaciones trimestrales" className="mt-4">
        {!d.settlements.length ? (
          <EmptyState>Aún no hay liquidaciones presentadas.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Periodo</th><th>Estado</th><th className="num">Mi ganancia</th><th className="num">Anticipos</th><th className="num">Neto</th><th>Pagada</th><th /></tr></thead>
              <tbody>
                {d.settlements.map((s) => (
                  <tr key={s.id}>
                    <td className="whitespace-nowrap">{formatDate(s.period_start)} – {formatDate(s.period_end)}</td>
                    <td><StatusBadge map={WORKFLOW_STATUS} value={s.status} /></td>
                    <td className="num">{s.gross == null ? '—' : formatCOP(s.gross)}</td>
                    <td className="num">{s.advances == null ? '—' : formatCOP(s.advances)}</td>
                    <td className="num">{s.net == null ? '—' : formatCOP(s.net)}</td>
                    <td>{s.paid_at ? formatDateTime(s.paid_at) : '—'}</td>
                    <td><a href={`/api/export/settlement/${s.id}`} className="text-sm text-brand-700">Excel</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      <p className="mt-4 text-xs text-slate-500">Como socio puede consultar la información, pero no modificar transacciones ni condiciones de préstamos.</p>
    </>
  );
}
