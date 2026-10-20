import { formatCOP, formatDate } from '@/lib/finance';
import type { SettlementReport } from '@/lib/excel';
import { Card, KeyValue, TableWrap } from './ui';

export function SettlementReportView({ r }: { r: SettlementReport }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Movimiento de caja del periodo">
          <KeyValue
            items={[
              ['Saldo inicial (caja + cobradores)', formatCOP(r.opening_cash)],
              ['Capital recuperado', formatCOP(r.capital_recovered)],
              ['Nuevos desembolsos', formatCOP(r.new_disbursements)],
              ['Reversos registrados', formatCOP(r.reversals_amount)],
              ['Distribuciones pagadas en el periodo', formatCOP(r.distributions_paid_in_period)],
              ['Saldo final (caja + cobradores)', formatCOP(r.closing_cash)],
            ]}
          />
        </Card>
        <Card title="Resultado distribuible">
          <KeyValue
            items={[
              ['Intereses efectivamente cobrados', formatCOP(r.interest_collected)],
              ['− Comisiones del cobrador', formatCOP(r.collector_commissions)],
              ['− Gastos autorizados', formatCOP(r.expenses)],
              ['± Ajustes', formatCOP(r.adjustments)],
              ['= Resultado del periodo', formatCOP(r.period_result)],
              ['Pérdida arrastrada', formatCOP(r.prior_loss_carried)],
              ['Ganancia neta distribuible', <strong key="n" className="text-slate-800">{formatCOP(r.net_distributable)}</strong>],
              ['Pérdida que pasa al siguiente periodo', formatCOP(r.loss_carried_forward)],
            ]}
          />
        </Card>
      </div>
      <Card title="Participación de cada socio">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Socio</th><th className="num">%</th><th className="num">Ganancia</th><th className="num">Anticipos descontados</th><th className="num">Neto a pagar</th><th className="num">Aportes</th><th className="num">Retiros</th><th className="num">Anticipos del periodo</th></tr></thead>
            <tbody>
              {r.partners.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td><td className="num">{p.share_bps / 100}</td>
                  <td className="num">{formatCOP(p.gross)}</td><td className="num">{formatCOP(p.advances_deducted)}</td>
                  <td className="num font-semibold">{formatCOP(p.net)}</td><td className="num">{formatCOP(p.contributions)}</td>
                  <td className="num">{formatCOP(p.withdrawals)}</td><td className="num">{formatCOP(p.advances_in_period)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="mt-2 text-xs text-slate-500">Periodo {formatDate(r.period_start)} – {formatDate(r.period_end)}.</p>
      </Card>
    </div>
  );
}
