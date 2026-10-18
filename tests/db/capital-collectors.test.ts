import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { capitalAvailable } from '@/lib/finance';
import { TestDb, enableComplianceForTests, isoDaysFromToday, seedScenario, user } from './harness';

let db: TestDb;
let s: Awaited<ReturnType<typeof seedScenario>>;
const A = () => user(s.admin);
const C1 = () => user(s.collector);
const n = (v: unknown) => Number(v);
const cap = async () => {
  const c = await db.rpc<Record<string, number>>(A(), 'capital_summary');
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, n(v)]));
};

beforeAll(async () => {
  db = await TestDb.create();
  s = await seedScenario(db);
  await enableComplianceForTests(db, s.admin);
});
afterAll(async () => db?.close());

describe('19. Capital disponible', () => {
  let loan: string;

  it('parte de los aportes conciliados', async () => {
    await db.rpc(A(), 'record_capital_movement', { p_partner_id: s.partner1, p_kind: 'contribution', p_amount: 500_000, p_occurred_on: null, p_notes: null });
    await db.rpc(A(), 'record_capital_movement', { p_partner_id: s.partner2, p_kind: 'contribution', p_amount: 500_000, p_occurred_on: null, p_notes: null });
    const c = await cap();
    expect(c).toMatchObject({ partner_capital: 1_000_000, cash_admin: 1_000_000, available: 1_000_000, committed: 0 });
  });

  it('un préstamo aprobado compromete capital; el desembolso lo coloca', async () => {
    const app = await db.rpc<string>(A(), 'create_application', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      p_simulation_id: null, p_customer_id: s.customerA, p_message: null,
    });
    loan = await db.rpc<string>(A(), 'approve_application', {
      p_application_id: app, p_collector_id: s.collector, p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
    });
    expect(await cap()).toMatchObject({ committed: 600_000, available: 400_000, cash_admin: 1_000_000 });
    await db.rpc(A(), 'disburse_loan', { p_loan_id: loan, p_disbursed_on: null });
    expect(await cap()).toMatchObject({ committed: 0, available: 400_000, cash_admin: 400_000, loans_principal: 600_000 });
  });

  it('no se puede desembolsar más capital del disponible', async () => {
    const app = await db.rpc<string>(A(), 'create_application', {
      p_principal: 500_000, p_installments: 2, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      p_simulation_id: null, p_customer_id: s.customerB, p_message: null,
    });
    const big = await db.rpc<string>(A(), 'approve_application', {
      p_application_id: app, p_collector_id: s.collector2, p_principal: 500_000, p_installments: 2, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
    });
    await expect(db.rpc(A(), 'disburse_loan', { p_loan_id: big, p_disbursed_on: null })).rejects.toThrow(/INSUFFICIENT_CAPITAL/);
    await db.rpc(A(), 'cancel_loan', { p_loan_id: big, p_reason: 'Sin capital' });
  });

  it('el efectivo en poder del cobrador y las ganancias no son capital disponible', async () => {
    await db.rpc(C1(), 'register_payment', {
      p_loan_id: loan, p_amount: 180_000, p_idempotency_key: randomUUID(), p_method: 'cash', p_received_on: null, p_notes: null, p_evidence_path: null,
    });
    let c = await cap();
    expect(c).toMatchObject({ cash_admin: 400_000, cash_collectors: 180_000, loans_principal: 450_000, commission_payable: 7_500, unsettled_result: 22_500 });
    expect(c.available).toBe(400_000 - 7_500 - 22_500);

    // El cobrador entrega el efectivo y administración lo confirma.
    const h = await db.rpc<string>(C1(), 'declare_cash_handover', { p_amount: 180_000, p_notes: 'Recaudo del día' });
    await expect(db.rpc(C1(), 'declare_cash_handover', { p_amount: 1, p_notes: null })).rejects.toThrow(/supera el efectivo/);
    await expect(db.rpc(C1(), 'confirm_cash_handover', { p_handover_id: h, p_approve: true, p_notes: null })).rejects.toThrow(/FORBIDDEN/);
    await db.rpc(A(), 'confirm_cash_handover', { p_handover_id: h, p_approve: true, p_notes: null });
    c = await cap();
    expect(c).toMatchObject({ cash_admin: 580_000, cash_collectors: 0 });
    // Solo el capital recuperado (150.000) vuelve a estar disponible; el interés (30.000) no.
    expect(c.available).toBe(550_000);
    expect(c.available).toBe(
      capitalAvailable({ cashAdmin: c.cash_admin, commissionPayable: c.commission_payable, partnerProfitPayable: c.partner_profit_payable, unsettledResult: c.unsettled_result, committed: c.committed }),
    );
    expect(c.partner_capital + c.unsettled_result + c.commission_payable).toBe(c.cash_admin + c.cash_collectors + c.loans_principal);
  });

  it('el retiro de capital no puede superar lo disponible ni lo aportado', async () => {
    await expect(
      db.rpc(A(), 'record_capital_movement', { p_partner_id: s.partner1, p_kind: 'withdrawal', p_amount: 550_001, p_occurred_on: null, p_notes: null }),
    ).rejects.toThrow(/INSUFFICIENT_CAPITAL/);
  });
});

describe('Comisiones del cobrador', () => {
  it('el informe diario distingue recaudo, capital, interés, comisión y entregas', async () => {
    const today = isoDaysFromToday(0);
    const r = await db.rpc<Record<string, any>>(C1(), 'collector_report', { p_collector_id: s.collector, p_from: today, p_to: today });
    expect(n(r.total_received)).toBe(180_000);
    expect(n(r.principal_recovered)).toBe(150_000);
    expect(n(r.interest_collected)).toBe(30_000);
    expect(n(r.commission_accrued)).toBe(7_500);
    expect(n(r.handed_over)).toBe(180_000);
    expect(n(r.payers)).toBe(1);
    await expect(db.rpc(C1(), 'collector_report', { p_collector_id: s.collector2, p_from: today, p_to: today })).rejects.toThrow(/FORBIDDEN/);
  });

  it('la liquidación de comisiones la aprueba y paga administración, nunca el propio cobrador', async () => {
    await expect(db.rpc(C1(), 'create_collector_payout', { p_collector_id: s.collector, p_period_end: isoDaysFromToday(0), p_notes: null })).rejects.toThrow(/FORBIDDEN/);
    const payout = await db.rpc<string>(A(), 'create_collector_payout', { p_collector_id: s.collector, p_period_end: isoDaysFromToday(0), p_notes: null });
    expect(n((await db.owner<any>('select amount from public.collector_payouts where id = $1', [payout]))[0].amount)).toBe(7_500);
    await expect(db.rpc(C1(), 'approve_collector_payout', { p_payout_id: payout })).rejects.toThrow(/FORBIDDEN/);
    await db.rpc(A(), 'approve_collector_payout', { p_payout_id: payout });
    await db.rpc(A(), 'pay_collector_payout', { p_payout_id: payout, p_paid_on: null });
    const c = await cap();
    expect(c.commission_payable).toBe(0);
    expect(c.cash_admin).toBe(572_500);
    const dash = await db.rpc<Record<string, any>>(C1(), 'collector_dashboard');
    expect(n(dash.commission_accrued_total)).toBe(7_500);
    expect(n(dash.commission_pending)).toBe(0);
  });
});
