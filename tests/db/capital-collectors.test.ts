import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { capitalAvailable } from '@/lib/finance';
import { TestDb, enableComplianceForTests, isoDaysFromToday, seedScenario, service, user } from './harness';

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
      p_principal: 500_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      p_simulation_id: null, p_customer_id: s.customerB, p_message: null,
    });
    const big = await db.rpc<string>(A(), 'approve_application', {
      p_application_id: app, p_collector_id: s.collector2, p_principal: 500_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
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

    // El cobrador entrega el TOTAL del efectivo (no se permiten entregas parciales) y administración lo confirma.
    await expect(db.rpc(C1(), 'declare_cash_handover', { p_amount: 100_000, p_notes: null })).rejects.toThrow(/debe entregar el total/);
    const h = await db.rpc<string>(C1(), 'declare_cash_handover', { p_amount: 180_000, p_notes: 'Recaudo del día' });
    await expect(db.rpc(C1(), 'declare_cash_handover', { p_amount: 1, p_notes: null })).rejects.toThrow(/no tiene efectivo pendiente/);
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

describe('Registro de clientes por cobradores', () => {
  const newCustomer = (who: ReturnType<typeof user>, doc: string, collectorId: string | null = null) =>
    db.rpc<string>(who, 'create_customer', {
      p_full_name: 'Pedro Cliente', p_document_type: 'CC', p_document_number: doc, p_phone: '3009998877',
      p_address: null, p_collector_id: collectorId, p_notes: null, p_data_consent: true,
    });

  it('el cobrador registra un cliente (cédula obligatoria) que queda asignado a él', async () => {
    const id = await newCustomer(C1(), '55.444.333', s.collector2);
    const row = (await db.owner<any>('select collector_id, document_number from public.customers where id = $1', [id]))[0];
    expect(row).toEqual({ collector_id: s.collector, document_number: '55444333' });
    await expect(newCustomer(C1(), '')).rejects.toThrow(/cédula es obligatoria/);
    await expect(newCustomer(C1(), '55444333')).rejects.toThrow(/DUPLICATE_CUSTOMER/);
  });

  it('crea la cuenta del cliente sin correo y el cliente ingresa con su cédula', async () => {
    const id = await newCustomer(C1(), '77888999');
    const userId = await db.rpc<string>(C1(), 'admin_create_user', {
      p_email: null, p_password_hash: 'x', p_full_name: 'Pedro Cliente', p_phone: null, p_role: 'customer', p_customer_id: id,
    });
    expect(await db.rpc(service, 'login_user_id', { p_identifier: '77.888.999' })).toBe(userId);
    // Un cobrador no crea cuentas de otros roles ni de clientes ajenos.
    await expect(db.rpc(C1(), 'admin_create_user', { p_email: 'x@y.co', p_password_hash: 'x', p_full_name: 'X', p_phone: null, p_role: 'collector', p_customer_id: null })).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(C1(), 'admin_create_user', { p_email: null, p_password_hash: 'x', p_full_name: 'X', p_phone: null, p_role: 'customer', p_customer_id: s.customerB })).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(C1(), 'login_user_id', { p_identifier: '77888999' })).rejects.toThrow(/FORBIDDEN/);
  });

  it('el administrador puede desactivar la opción (queda auditado)', async () => {
    await db.rpc(A(), 'update_setting', { p_key: 'operations', p_value: { collectors_can_create_customers: false } });
    await expect(newCustomer(C1(), '12121212')).rejects.toThrow(/desactivó/);
    await expect(db.rpc(C1(), 'update_setting', { p_key: 'operations', p_value: { collectors_can_create_customers: true } })).rejects.toThrow(/FORBIDDEN/);
    await db.rpc(A(), 'update_setting', { p_key: 'operations', p_value: { collectors_can_create_customers: true, collectors_can_approve_loans: true } });
    expect(await newCustomer(C1(), '12121212')).toBeTruthy();
  });
});

describe('Créditos simples creados por el cobrador', () => {
  const terms = (n: number) => ({ p_principal: 400_000, p_installments: n, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0) });

  it('solo se permiten 4 o 5 cuotas', async () => {
    for (const n of [1, 2, 3, 6]) {
      await expect(db.rpc(C1(), 'create_application', { ...terms(n), p_simulation_id: null, p_customer_id: s.customerA, p_message: null })).rejects.toThrow(/entre 4 y 5/);
    }
  });

  it('el cobrador crea y aprueba el crédito de su cliente; el crédito queda a su cargo', async () => {
    const app = await db.rpc<string>(C1(), 'create_application', { ...terms(4), p_simulation_id: null, p_customer_id: s.customerA, p_message: null });
    const loan = await db.rpc<string>(C1(), 'approve_application', { p_application_id: app, p_collector_id: s.collector2, ...terms(4) });
    const l = (await db.owner<any>('select collector_id, approved_by, total_amount, status from public.loans where id = $1', [loan]))[0];
    expect(l).toMatchObject({ collector_id: s.collector, approved_by: s.collector, status: 'approved' });
    expect(Number(l.total_amount)).toBe(480_000);
  });

  it('el cobrador rechaza solicitudes de sus clientes, pero no las de otros cobradores', async () => {
    const appB = await db.rpc<string>(A(), 'create_application', { ...terms(5), p_simulation_id: null, p_customer_id: s.customerB, p_message: null });
    await expect(db.rpc(C1(), 'review_application', { p_application_id: appB, p_action: 'reject', p_notes: 'No' })).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(C1(), 'approve_application', { p_application_id: appB, p_collector_id: s.collector, ...terms(5) })).rejects.toThrow(/FORBIDDEN/);
    await db.rpc(user(s.collector2), 'review_application', { p_application_id: appB, p_action: 'reject', p_notes: 'Sin capacidad de pago' });
    expect((await db.owner<any>('select status, decided_by from public.loan_applications where id = $1', [appB]))[0]).toEqual({ status: 'rejected', decided_by: s.collector2 });
  });

  it('préstamo directo: el cobrador lo crea y queda activo desde hoy, solo para sus clientes', async () => {
    const loan = await db.rpc<string>(C1(), 'create_simple_loan', { p_customer_id: s.customerA, p_principal: 600_000, p_installments: 4, p_frequency: 'weekly' });
    const l = (await db.owner<any>('select collector_id, status, total_amount, disbursed_at from public.loans where id = $1', [loan]))[0];
    expect(l).toMatchObject({ collector_id: s.collector, status: 'active' });
    expect(Number(l.total_amount)).toBe(720_000);
    expect(l.disbursed_at).toBeTruthy();
    const cuotas = await db.owner<any>('select total_amount from public.loan_installments where loan_id = $1 order by number', [loan]);
    expect(cuotas.map((c: any) => Number(c.total_amount))).toEqual([180_000, 180_000, 180_000, 180_000]);
    await expect(db.rpc(C1(), 'create_simple_loan', { p_customer_id: s.customerB, p_principal: 600_000, p_installments: 4, p_frequency: 'weekly' })).rejects.toThrow(/FORBIDDEN/);
  });

  it('el administrador puede quitar al cobrador la facultad de aprobar', async () => {
    await db.rpc(A(), 'update_setting', { p_key: 'operations', p_value: { collectors_can_create_customers: true, collectors_can_approve_loans: false } });
    await expect(db.rpc(C1(), 'create_application', { ...terms(4), p_simulation_id: null, p_customer_id: s.customerA, p_message: null })).rejects.toThrow(/FORBIDDEN/);
    await db.rpc(A(), 'update_setting', { p_key: 'operations', p_value: { collectors_can_create_customers: true, collectors_can_approve_loans: true } });
  });
});

describe('Eliminar cliente de prueba', () => {
  it('borra el cliente y todo lo suyo, deja los saldos como antes y conserva la auditoría', async () => {
    const before = await cap();
    const auditBefore = n((await db.owner<any>('select count(*) as n from public.audit_logs'))[0].n);
    const cust = await db.rpc<string>(C1(), 'create_customer', {
      p_full_name: 'Cliente de Prueba', p_document_type: 'CC', p_document_number: '777000111', p_phone: '3000000000',
      p_address: null, p_collector_id: null, p_notes: null, p_data_consent: true,
    });
    const loan = await db.rpc<string>(C1(), 'create_simple_loan', { p_customer_id: cust, p_principal: 300_000, p_installments: 4, p_frequency: 'weekly' });
    await db.rpc(C1(), 'register_payment', {
      p_loan_id: loan, p_amount: 90_000, p_idempotency_key: randomUUID(), p_method: 'cash', p_received_on: null, p_notes: null, p_evidence_path: null,
    });

    await expect(db.rpc(C1(), 'admin_purge_test_customer', { p_customer_id: cust, p_confirm: 'ELIMINAR' })).rejects.toThrow(/FORBIDDEN|admin/i);
    await expect(db.rpc(A(), 'admin_purge_test_customer', { p_customer_id: cust, p_confirm: 'si' })).rejects.toThrow(/ELIMINAR/);
    await expect(db.rpc(A(), 'admin_purge_test_customer', { p_customer_id: cust, p_confirm: 'ELIMINAR' })).rejects.toThrow(/motivo/);
    await db.rpc(A(), 'admin_purge_test_customer', { p_customer_id: cust, p_confirm: 'eliminar', p_reason: 'Cliente de prueba' });

    expect(await db.owner('select 1 from public.customers where id = $1', [cust])).toHaveLength(0);
    expect(await db.owner('select 1 from public.loans where id = $1', [loan])).toHaveLength(0);
    expect(await db.owner('select 1 from public.payments where loan_id = $1', [loan])).toHaveLength(0);
    expect(await db.owner('select 1 from public.financial_transactions where loan_id = $1', [loan])).toHaveLength(0);
    expect(await cap()).toEqual(before);
    const auditAfter = n((await db.owner<any>('select count(*) as n from public.audit_logs'))[0].n);
    expect(auditAfter).toBeGreaterThan(auditBefore);
    expect(await db.owner(`select 1 from public.audit_logs where action = 'purge_test_customer' and record_id = $1`, [cust])).toHaveLength(1);
    // Las protecciones siguen activas fuera de la función.
    await expect(db.owner('delete from public.audit_logs')).rejects.toThrow(/IMMUTABLE/);
  });
});

describe('Eliminar préstamos y solicitudes de eliminación', () => {
  const newCustomer = (doc: string) => db.rpc<string>(C1(), 'create_customer', {
    p_full_name: 'Cliente Solicitud', p_document_type: 'CC', p_document_number: doc, p_phone: '3000000000',
    p_address: null, p_collector_id: null, p_notes: null, p_data_consent: true,
  });
  const newLoan = async (cust: string) => {
    const loan = await db.rpc<string>(C1(), 'create_simple_loan', { p_customer_id: cust, p_principal: 200_000, p_installments: 4, p_frequency: 'weekly' });
    await db.rpc(C1(), 'register_payment', {
      p_loan_id: loan, p_amount: 60_000, p_idempotency_key: randomUUID(), p_method: 'cash', p_received_on: null, p_notes: null, p_evidence_path: null,
    });
    return loan;
  };
  const request = (id: string) => db.owner<any>('select * from public.deletion_requests where id = $1', [id]).then((r) => r[0]);

  it('el administrador elimina un préstamo directamente y queda registrado', async () => {
    const cust = await newCustomer('777000222');
    const before = await cap();
    const loan = await newLoan(cust);
    await expect(db.rpc(C1(), 'admin_purge_loan', { p_loan_id: loan, p_confirm: 'ELIMINAR', p_reason: 'Prueba' })).rejects.toThrow(/FORBIDDEN|admin/i);
    await db.rpc(A(), 'admin_purge_loan', { p_loan_id: loan, p_confirm: 'ELIMINAR', p_reason: 'Préstamo duplicado' });
    expect(await db.owner('select 1 from public.loans where id = $1', [loan])).toHaveLength(0);
    expect(await db.owner('select 1 from public.payments where loan_id = $1', [loan])).toHaveLength(0);
    expect(await db.owner('select 1 from public.customers where id = $1', [cust])).toHaveLength(1);
    expect(await cap()).toEqual(before);
    const rec = await db.owner<any>(`select * from public.deletion_requests where loan_id = $1`, [loan]);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ kind: 'loan', status: 'approved', requested_by: s.admin, decided_by: s.admin, reason: 'Préstamo duplicado' });
    expect(await db.owner(`select 1 from public.audit_logs where action = 'purge_loan' and record_id = $1`, [loan])).toHaveLength(1);
  });

  it('el cobrador pide eliminar un préstamo; solo se borra cuando el administrador acepta', async () => {
    const cust = await newCustomer('777000333');
    const loan = await newLoan(cust);
    await expect(db.rpc(C1(), 'request_deletion', { p_kind: 'loan', p_target_id: loan, p_reason: 'x' })).rejects.toThrow(/motivo/);
    await expect(db.rpc(user(s.collector2), 'request_deletion', { p_kind: 'loan', p_target_id: loan, p_reason: 'No es mío' })).rejects.toThrow(/FORBIDDEN|no puede/);
    const req = await db.rpc<string>(C1(), 'request_deletion', { p_kind: 'loan', p_target_id: loan, p_reason: 'Lo registré dos veces' });
    await expect(db.rpc(C1(), 'request_deletion', { p_kind: 'loan', p_target_id: loan, p_reason: 'Otra vez lo mismo' })).rejects.toThrow(/pendiente/);
    await expect(db.rpc(C1(), 'decide_deletion_request', { p_request_id: req, p_approve: true, p_notes: null })).rejects.toThrow(/FORBIDDEN|admin/i);
    expect(await db.owner('select 1 from public.loans where id = $1', [loan])).toHaveLength(1);

    await db.rpc(A(), 'decide_deletion_request', { p_request_id: req, p_approve: true, p_notes: 'Ok' });
    expect(await db.owner('select 1 from public.loans where id = $1', [loan])).toHaveLength(0);
    expect(await request(req)).toMatchObject({ status: 'approved', requested_by: s.collector, decided_by: s.admin, decision_notes: 'Ok' });
    expect(await db.owner('select 1 from public.deletion_requests where loan_id = $1', [loan])).toHaveLength(1);
    await expect(db.owner('delete from public.deletion_requests where id = $1', [req])).rejects.toThrow(/IMMUTABLE/);
  });

  it('el administrador puede rechazar; al eliminar un cliente se cierran sus solicitudes', async () => {
    const cust = await newCustomer('777000444');
    const loan = await newLoan(cust);
    const rejected = await db.rpc<string>(C1(), 'request_deletion', { p_kind: 'customer', p_target_id: cust, p_reason: 'Cliente de prueba' });
    await db.rpc(A(), 'decide_deletion_request', { p_request_id: rejected, p_approve: false, p_notes: 'Es real' });
    expect(await request(rejected)).toMatchObject({ status: 'rejected', decided_by: s.admin, decision_notes: 'Es real' });
    expect(await db.owner('select 1 from public.customers where id = $1', [cust])).toHaveLength(1);

    const loanReq = await db.rpc<string>(C1(), 'request_deletion', { p_kind: 'loan', p_target_id: loan, p_reason: 'Préstamo de prueba' });
    const custReq = await db.rpc<string>(C1(), 'request_deletion', { p_kind: 'customer', p_target_id: cust, p_reason: 'Ahora sí es de prueba' });
    await db.rpc(A(), 'decide_deletion_request', { p_request_id: custReq, p_approve: true, p_notes: null });
    expect(await db.owner('select 1 from public.customers where id = $1', [cust])).toHaveLength(0);
    expect(await request(custReq)).toMatchObject({ status: 'approved', reason: 'Ahora sí es de prueba' });
    expect(await request(loanReq)).toMatchObject({ status: 'approved', decision_notes: 'Eliminado junto con el cliente' });
    expect((await db.owner(`select context from public.audit_logs where action = 'purge_test_customer' and record_id = $1`, [cust]))).toHaveLength(1);
  });
});
