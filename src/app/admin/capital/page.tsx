import { ActionForm } from '@/components/action-form';
import { Card, Notice, PageHeader, Stat, StatGrid, TableWrap } from '@/components/ui';
import { CAPITAL_DEFINITIONS, formatCOP, formatDate, todayBogota } from '@/lib/finance';
import { userDb } from '@/lib/auth';
import { recordAdjustment, recordCapitalMovement, recordExpense } from '../actions';

export const metadata = { title: 'Capital y socios' };

const TX_LABEL: Record<string, string> = {
  capital_contribution: 'Aporte de capital', capital_withdrawal: 'Retiro de capital', partner_advance: 'Anticipo a socio',
  disbursement: 'Desembolso', payment: 'Pago recibido', payment_reversal: 'Reverso de pago', cash_handover: 'Entrega de cobrador',
  commission_payout: 'Pago de comisiones', expense: 'Gasto', settlement_close: 'Cierre de liquidación',
  distribution_payment: 'Pago de utilidades', adjustment: 'Ajuste',
};

export default async function CapitalPage() {
  const db = await userDb();
  const [cap, partners, movements, txs] = await Promise.all([
    db.rpc('capital_summary'),
    db.query('select * from public.partners order by seq'),
    db.query(`select c.*, p.display_name from public.capital_contributions c join public.partners p on p.id = c.partner_id
              order by c.created_at desc limit 20`),
    db.query<{ id: string; tx_number: number; kind: string; occurred_on: string; description: string; cash: number }>(
      `select t.id, t.tx_number, t.kind, t.occurred_on, t.description,
              coalesce(sum(e.amount) filter (where a.code = 'CASH' or a.code like 'COLLECTOR_CASH:%'), 0) as cash
         from public.financial_transactions t
         join public.financial_entries e on e.tx_id = t.id
         join public.capital_accounts a on a.id = e.account_id
        group by t.id order by t.tx_number desc limit 40`),
  ]);
  const c = (cap ?? {}) as Record<string, number>;
  const today = todayBogota();
  const shares = (partners ?? []).filter((p) => p.active).reduce((s, p) => s + p.share_bps, 0);

  return (
    <>
      <PageHeader title="Capital y socios" />
      {shares !== 10000 && <div className="mb-4"><Notice tone="danger">Las participaciones de los socios activos suman {shares / 100} %. Deben sumar 100 % (Configuración → Socios).</Notice></div>}
      <StatGrid>
        <Stat label="Capital aportado" value={formatCOP(c.partner_capital)} definition={CAPITAL_DEFINITIONS.partner_capital} />
        <Stat label="Capital disponible" value={formatCOP(c.available)} tone="success" definition={CAPITAL_DEFINITIONS.available} />
        <Stat label="Caja administración" value={formatCOP(c.cash_admin)} definition={CAPITAL_DEFINITIONS.cash_admin} />
        <Stat label="Capital colocado" value={formatCOP(c.loans_principal)} definition={CAPITAL_DEFINITIONS.loans_principal} />
        <Stat label="Comprometido" value={formatCOP(c.committed)} definition={CAPITAL_DEFINITIONS.committed} />
        <Stat label="En cobradores" value={formatCOP(c.cash_collectors)} definition={CAPITAL_DEFINITIONS.cash_collectors} />
        <Stat label="Anticipos a socios" value={formatCOP(c.partner_advances)} definition="Anticipos de utilidades entregados, que se descuentan en la próxima liquidación." />
        <Stat label="Resultado acumulado" value={formatCOP(c.retained_result)} definition="Resultados de liquidaciones anteriores no distribuidos (negativo = pérdida que se compensa con utilidades futuras)." />
      </StatGrid>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card title="Movimiento de socio">
          <ActionForm action={recordCapitalMovement} submitLabel="Registrar" resetOnSuccess confirmText="Tengo el soporte del movimiento.">
            <select name="partner_id" required className="input" aria-label="Socio">
              {partners?.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
            <select name="kind" className="input" aria-label="Tipo">
              <option value="contribution">Aporte de capital</option>
              <option value="withdrawal">Retiro de capital</option>
              <option value="advance">Anticipo de utilidades</option>
            </select>
            <input name="amount" inputMode="numeric" required placeholder="Valor (COP)" className="input" aria-label="Valor" />
            <input name="occurred_on" type="date" max={today} defaultValue={today} className="input" aria-label="Fecha" />
            <input name="notes" placeholder="Nota" className="input" aria-label="Nota" />
          </ActionForm>
        </Card>
        <Card title="Gasto autorizado">
          <ActionForm action={recordExpense} submitLabel="Registrar gasto" resetOnSuccess>
            <input name="category" required placeholder="Categoría (transporte, papelería…)" className="input" aria-label="Categoría" />
            <input name="description" required placeholder="Descripción" className="input" aria-label="Descripción" />
            <input name="amount" inputMode="numeric" required placeholder="Valor (COP)" className="input" aria-label="Valor" />
            <input name="occurred_on" type="date" max={today} defaultValue={today} className="input" aria-label="Fecha" />
          </ActionForm>
        </Card>
        <Card title="Ajuste de caja">
          <ActionForm action={recordAdjustment} submitLabel="Registrar ajuste" variant="secondary" resetOnSuccess confirmText="El ajuste está autorizado y quedará auditado.">
            <select name="direction" className="input" aria-label="Tipo"><option value="surplus">Sobrante</option><option value="shortage">Faltante</option></select>
            <input name="amount" inputMode="numeric" required placeholder="Valor (COP)" className="input" aria-label="Valor" />
            <input name="description" required minLength={5} placeholder="Motivo" className="input" aria-label="Motivo" />
          </ActionForm>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Movimientos de socios">
          <ul className="divide-y divide-slate-100 text-sm">
            {(movements ?? []).map((m) => (
              <li key={m.id} className="flex justify-between py-2">
                <span>{formatDate(m.occurred_on)} · {m.display_name} · {m.kind === 'contribution' ? 'Aporte' : m.kind === 'withdrawal' ? 'Retiro' : 'Anticipo'}</span>
                <strong className="tabular-nums">{formatCOP(m.amount)}</strong>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Libro contable (últimas transacciones)">
          <TableWrap>
            <table className="table">
              <thead><tr><th>N.º</th><th>Fecha</th><th>Tipo</th><th className="num">Caja</th></tr></thead>
              <tbody>
                {(txs ?? []).map((t) => {
                  const cash = t.cash;
                  return (
                    <tr key={t.id} title={t.description}>
                      <td>{t.tx_number}</td>
                      <td className="whitespace-nowrap">{formatDate(t.occurred_on)}</td>
                      <td>{TX_LABEL[t.kind] ?? t.kind}</td>
                      <td className={`num ${cash < 0 ? 'text-red-700' : 'text-slate-800'}`}>{formatCOP(cash)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          <p className="mt-2 text-xs text-slate-500">Contabilidad por partida doble: cada transacción cuadra en cero y no puede modificarse; las correcciones se registran con reversos.</p>
        </Card>
      </div>
    </>
  );
}
