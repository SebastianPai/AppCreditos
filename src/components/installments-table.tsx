import { dueStatus, formatCOP, formatDate, todayBogota } from '@/lib/finance';
import { Badge, TableWrap } from './ui';

export interface InstallmentRow {
  id: string;
  number: number;
  due_date: string;
  principal_amount: number;
  interest_amount: number;
  total_amount: number;
  paid_total: number;
  outstanding: number;
  effective_status: string;
  review_note?: string | null;
}

/** Tabla de amortización con estado y saldo de cada cuota. */
export function InstallmentsTable({ rows, showSplit = true }: { rows: InstallmentRow[]; showSplit?: boolean }) {
  let balance = rows.reduce((s, r) => s + Number(r.total_amount), 0);
  const today = todayBogota();
  return (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Vence</th>
            {showSplit && <th className="num">Capital</th>}
            {showSplit && <th className="num">Interés</th>}
            <th className="num">Cuota</th>
            <th className="num">Pagado</th>
            <th className="num">Pendiente</th>
            <th className="num">Saldo tras cuota</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            balance -= Number(r.total_amount);
            return (
              <tr key={r.id}>
                <td>{r.number}</td>
                <td className="whitespace-nowrap">{formatDate(r.due_date)}</td>
                {showSplit && <td className="num">{formatCOP(r.principal_amount)}</td>}
                {showSplit && <td className="num">{formatCOP(r.interest_amount)}</td>}
                <td className="num font-semibold">{formatCOP(r.total_amount)}</td>
                <td className="num">{formatCOP(r.paid_total)}</td>
                <td className="num">{formatCOP(r.outstanding)}</td>
                <td className="num">{formatCOP(balance)}</td>
                <td>
                  {(() => {
                    const st = dueStatus(r.due_date, today, Number(r.outstanding) === 0);
                    return r.effective_status === 'in_review' ? <Badge tone="warning">En revisión</Badge> : <Badge tone={st.tone}>{st.text}</Badge>;
                  })()}
                  {Number(r.paid_total) > 0 && Number(r.outstanding) > 0 && <p className="mt-1 text-xs text-sky-700">Abono parcial</p>}
                  {r.review_note && <p className="mt-1 text-xs text-amber-800">{r.review_note}</p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
