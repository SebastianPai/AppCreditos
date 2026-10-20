import { formatCOP, formatDate, formatDateTime } from '@/lib/finance';
import { Card, KeyValue, Notice, TableWrap } from './ui';

export interface CollectorReport {
  collector: { id: string; full_name: string } | null;
  from: string;
  to: string;
  generated_at: string;
  payers: number;
  payments_count: number;
  installments_touched: number;
  installments_completed: number;
  total_received: number;
  principal_recovered: number;
  interest_collected: number;
  commission_accrued: number;
  commission_paid: number;
  partial_payments: number;
  pending_installments: number;
  pending_amount: number;
  expected: number;
  difference: number;
  handed_over: number;
  cash_in_custody: number;
  payments: { receipt_number: number; received_on: string; customer: string; loan_code: string; amount: number; principal: number; interest: number; commission: number; is_partial: boolean }[];
}

export function PeriodFilter({ action, period, from, to, extra }: { action: string; period: string; from: string; to: string; extra?: React.ReactNode }) {
  return (
    <form action={action} className="no-print card mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5 sm:items-end">
      {extra}
      <div>
        <label className="label" htmlFor="period">Periodo</label>
        <select id="period" name="periodo" defaultValue={period} className="input">
          <option value="day">Día</option>
          <option value="week">Semana</option>
          <option value="month">Mes</option>
          <option value="quarter">Trimestre</option>
          <option value="custom">Rango personalizado</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="from">Desde</label>
        <input id="from" type="date" name="desde" defaultValue={from} className="input" />
      </div>
      <div>
        <label className="label" htmlFor="to">Hasta</label>
        <input id="to" type="date" name="hasta" defaultValue={to} className="input" />
      </div>
      <button className="btn-primary">Consultar</button>
    </form>
  );
}

export function CollectorReportView({ r }: { r: CollectorReport }) {
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-sm text-slate-500">
          Cobrador responsable: <strong className="text-slate-900">{r.collector?.full_name}</strong> · {formatDate(r.from)}
          {r.from !== r.to && ` a ${formatDate(r.to)}`} · generado {formatDateTime(r.generated_at)}
        </p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recaudo">
          <KeyValue
            items={[
              ['Personas que pagaron', r.payers],
              ['Pagos registrados', r.payments_count],
              ['Cuotas con abonos', r.installments_touched],
              ['Cuotas completadas', r.installments_completed],
              ['Pagos parciales', r.partial_payments],
              ['Total de dinero recibido', formatCOP(r.total_received)],
              ['  · Capital recuperado', formatCOP(r.principal_recovered)],
              ['  · Intereses recaudados', formatCOP(r.interest_collected)],
            ]}
          />
        </Card>
        <Card title="Cuadre y comisión">
          <KeyValue
            items={[
              ['Dinero esperado (cuotas que vencían)', formatCOP(r.expected)],
              ['Diferencia recibido − esperado', <span key="d" className={r.difference < 0 ? 'text-red-700' : 'text-slate-800'}>{formatCOP(r.difference)}</span>],
              ['Cuotas que continúan pendientes', `${r.pending_installments} · ${formatCOP(r.pending_amount)}`],
              ['Comisión devengada', formatCOP(r.commission_accrued)],
              ['Comisión pagada', formatCOP(r.commission_paid)],
              ['Dinero entregado a administración', formatCOP(r.handed_over)],
              ['Efectivo aún en poder del cobrador', formatCOP(r.cash_in_custody)],
            ]}
          />
        </Card>
      </div>
      <Notice tone="info">
        El dinero recaudado no es ganancia del cobrador: su comisión es solo el valor devengado. El efectivo en su poder debe entregarse a la administración.
      </Notice>
      <Card title="Detalle de pagos">
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>Recibo</th>
                <th>Fecha</th>
                <th>Cliente</th>
                <th>Préstamo</th>
                <th className="num">Valor</th>
                <th className="num">Capital</th>
                <th className="num">Interés</th>
                <th className="num">Comisión</th>
              </tr>
            </thead>
            <tbody>
              {r.payments.map((p) => (
                <tr key={p.receipt_number}>
                  <td>{p.receipt_number}{p.is_partial && <span className="ml-1 text-xs text-sky-700">parcial</span>}</td>
                  <td className="whitespace-nowrap">{formatDate(p.received_on)}</td>
                  <td>{p.customer}</td>
                  <td>{p.loan_code}</td>
                  <td className="num">{formatCOP(p.amount)}</td>
                  <td className="num">{formatCOP(p.principal)}</td>
                  <td className="num">{formatCOP(p.interest)}</td>
                  <td className="num">{formatCOP(p.commission)}</td>
                </tr>
              ))}
              {!r.payments.length && (
                <tr><td colSpan={8} className="text-center text-slate-500">Sin pagos en el periodo.</td></tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </div>
  );
}
