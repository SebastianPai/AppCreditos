import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestDb, enableComplianceForTests, isoDaysFromToday, seedScenario, user } from './harness';

let db: TestDb;
let s: Awaited<ReturnType<typeof seedScenario>>;
const A = () => user(s.admin);
const n = (v: unknown) => Number(v);
const START = isoDaysFromToday(-60);
const END = isoDaysFromToday(-1);

beforeAll(async () => {
  db = await TestDb.create();
  s = await seedScenario(db);
  await enableComplianceForTests(db, s.admin);
  for (const p of [s.partner1, s.partner2]) {
    await db.rpc(A(), 'record_capital_movement', { p_partner_id: p, p_kind: 'contribution', p_amount: 1_000_000, p_occurred_on: isoDaysFromToday(-55), p_notes: null });
  }
  // Préstamo de $600.000 desembolsado hace 50 días y pagado completo hace 40 días.
  const app = await db.rpc<string>(A(), 'create_application', {
    p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
    p_simulation_id: null, p_customer_id: s.customerA, p_message: null,
  });
  const loan = await db.rpc<string>(A(), 'approve_application', {
    p_application_id: app, p_collector_id: s.collector, p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
  });
  await db.rpc(A(), 'disburse_loan', { p_loan_id: loan, p_disbursed_on: isoDaysFromToday(-50) });
  await db.rpc(A(), 'register_payment', {
    p_loan_id: loan, p_amount: 720_000, p_idempotency_key: randomUUID(), p_method: 'transfer', p_received_on: isoDaysFromToday(-40), p_notes: null, p_evidence_path: null,
  });
  await db.rpc(A(), 'record_expense', { p_amount: 10_000, p_category: 'Transporte', p_description: 'Movilidad de cobro', p_occurred_on: isoDaysFromToday(-30) });
  await db.rpc(A(), 'record_capital_movement', { p_partner_id: s.partner2, p_kind: 'advance', p_amount: 5_000, p_occurred_on: isoDaysFromToday(-20), p_notes: 'Anticipo' });
});
afterAll(async () => db?.close());

describe('16. Liquidación trimestral', () => {
  let id: string;

  it('el borrador separa capital recuperado de la ganancia distribuible', async () => {
    id = await db.rpc<string>(A(), 'create_settlement', { p_period_start: START, p_period_end: END });
    const r = (await db.owner<any>('select status, report from public.quarterly_settlements where id = $1', [id]))[0];
    expect(r.status).toBe('draft');
    const rep = r.report;
    expect(n(rep.capital_recovered)).toBe(600_000);
    expect(n(rep.new_disbursements)).toBe(600_000);
    expect(n(rep.interest_collected)).toBe(120_000);
    expect(n(rep.collector_commissions)).toBe(30_000);
    expect(n(rep.expenses)).toBe(10_000);
    expect(n(rep.net_distributable)).toBe(80_000);
    expect(n(rep.opening_cash)).toBe(0);
    expect(n(rep.closing_cash)).toBe(2_000_000 - 600_000 + 720_000 - 10_000 - 5_000);
    expect(rep.partners.map((p: any) => [n(p.gross), n(p.advances_deducted), n(p.net)])).toEqual([
      [40_000, 0, 40_000],
      [40_000, 5_000, 35_000],
    ]);
    // Los socios no ven borradores.
    expect(await db.query(user(s.partnerUser1), 'select id from public.quarterly_settlements')).toEqual([]);
    await expect(db.rpc(A(), 'create_settlement', { p_period_start: isoDaysFromToday(-10), p_period_end: END })).rejects.toThrow(/OVERLAP/);
  });

  it('borrador → pendiente → aprobada → pagada, con informe aprobado inmutable', async () => {
    await expect(db.rpc(A(), 'approve_settlement', { p_settlement_id: id })).rejects.toThrow(/pendiente de aprobación/);
    await db.rpc(A(), 'submit_settlement', { p_settlement_id: id });
    await expect(db.rpc(user(s.partnerUser1), 'approve_settlement', { p_settlement_id: id })).rejects.toThrow(/FORBIDDEN/);
    await db.rpc(A(), 'approve_settlement', { p_settlement_id: id });
    const st = (await db.owner<any>('select status, approved_hash, approved_report, close_tx_id from public.quarterly_settlements where id = $1', [id]))[0];
    expect(st.status).toBe('approved');
    expect(st.approved_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(st.close_tx_id).toBeTruthy();
    await expect(db.owner(`update public.quarterly_settlements set approved_report = '{}' where id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);

    // El periodo queda cerrado: no se pueden registrar movimientos con fecha dentro de él.
    await expect(
      db.rpc(A(), 'record_expense', { p_amount: 1_000, p_category: 'x', p_description: 'tarde', p_occurred_on: isoDaysFromToday(-30) }),
    ).rejects.toThrow(/PERIOD_CLOSED/);

    // Tras el cierre: utilidades por pagar 75.000 (80.000 − 5.000 de anticipo), resultado abierto en cero.
    let cap = await db.rpc<Record<string, number>>(A(), 'capital_summary');
    expect([n(cap.partner_profit_payable), n(cap.unsettled_result), n(cap.partner_advances)]).toEqual([75_000, 0, 0]);

    const dists = await db.owner<any>('select id, net_amount from public.settlement_distributions where settlement_id = $1 order by net_amount desc', [id]);
    expect(dists.map((d) => n(d.net_amount))).toEqual([40_000, 35_000]);
    const partnerView = await db.rpc<any>(user(s.partnerUser1), 'partner_dashboard');
    expect(n(partnerView.my_profit_distributed)).toBe(40_000);
    expect(n(partnerView.my_capital)).toBe(1_000_000);

    for (const d of dists) await db.rpc(A(), 'pay_distribution', { p_distribution_id: d.id, p_paid_on: null });
    expect((await db.owner<any>('select status from public.quarterly_settlements where id = $1', [id]))[0].status).toBe('paid');
    cap = await db.rpc<Record<string, number>>(A(), 'capital_summary');
    expect(n(cap.partner_profit_payable)).toBe(0);
    // Caja final: 2.105.000 − 75.000 pagados = 2.030.000; el capital de los socios sigue intacto.
    expect(n(cap.cash_admin)).toBe(2_030_000);
    expect(n(cap.partner_capital)).toBe(2_000_000);
    const unbalanced = await db.owner('select tx_id from public.financial_entries group by tx_id having sum(amount) <> 0');
    expect(unbalanced).toEqual([]);
  });
});
