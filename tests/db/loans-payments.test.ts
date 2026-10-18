import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeTerms } from '@/lib/finance';
import { TestDb, anon, enableComplianceForTests, isoDaysFromToday, seedScenario, service, user } from './harness';

let db: TestDb;
let s: Awaited<ReturnType<typeof seedScenario>>;
const A = () => user(s.admin);
const C1 = () => user(s.collector);
const C2 = () => user(s.collector2);
const CA = () => user(s.customerUserA);
const CB = () => user(s.customerUserB);
const n = (v: unknown) => Number(v);

async function count(table: string) {
  return n((await db.owner<{ c: number }>(`select count(*)::int c from public.${table}`))[0].c);
}

async function outstanding(loanId: string) {
  return n((await db.owner<{ o: number }>('select outstanding o from public.v_loan_balances where id = $1', [loanId]))[0].o);
}

/** Crea, aprueba y desembolsa un préstamo como administrador. */
async function activeLoan(customerId: string, collectorId: string, principal = 600_000, installments = 4, frequency = 'weekly') {
  const start = isoDaysFromToday(0);
  const app = await db.rpc<string>(A(), 'create_application', {
    p_principal: principal, p_installments: installments, p_frequency: frequency, p_start_date: start,
    p_simulation_id: null, p_customer_id: customerId, p_message: null,
  });
  const loan = await db.rpc<string>(A(), 'approve_application', {
    p_application_id: app, p_collector_id: collectorId, p_principal: principal, p_installments: installments,
    p_frequency: frequency, p_start_date: start,
  });
  await db.rpc(A(), 'disburse_loan', { p_loan_id: loan, p_disbursed_on: null });
  return loan;
}

async function pay(who: ReturnType<typeof user>, loanId: string, amount: number, key = randomUUID(), method = 'cash') {
  return db.rpc<{ payment_id: string; duplicate: boolean; is_partial: boolean; receipt_number: number }>(who, 'register_payment', {
    p_loan_id: loanId, p_amount: amount, p_idempotency_key: key, p_method: method, p_received_on: null, p_notes: null, p_evidence_path: null,
  });
}

beforeAll(async () => {
  db = await TestDb.create();
  s = await seedScenario(db);
  for (const partner of [s.partner1, s.partner2]) {
    await db.rpc(A(), 'record_capital_movement', {
      p_partner_id: partner, p_kind: 'contribution', p_amount: 5_000_000, p_occurred_on: null, p_notes: 'Aporte inicial',
    });
  }
});
afterAll(async () => db?.close());

describe('Cumplimiento normativo', () => {
  it('bloquea la aprobación mientras no exista revisión legal ni tasa de usura vigente', async () => {
    const app = await db.rpc<string>(A(), 'create_application', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      p_simulation_id: null, p_customer_id: s.customerA, p_message: null,
    });
    await expect(
      db.rpc(A(), 'approve_application', {
        p_application_id: app, p_collector_id: s.collector, p_principal: 600_000, p_installments: 4,
        p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      }),
    ).rejects.toThrow(/COMPLIANCE_BLOCKED/);
    await db.rpc(A(), 'review_application', { p_application_id: app, p_action: 'reject', p_notes: 'Prueba' });
  });

  it('bloquea un préstamo cuya tasa efectiva supera la tasa de usura registrada', async () => {
    await db.rpc(A(), 'update_setting', {
      p_key: 'compliance',
      p_value: JSON.stringify({
        legal_review_completed: true, legal_review_reference: 'Concepto 001', usury_rate_ea_percent: 25,
        usury_rate_valid_from: isoDaysFromToday(-10), usury_rate_valid_until: isoDaysFromToday(20),
      }),
    });
    const app = await db.rpc<string>(A(), 'create_application', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      p_simulation_id: null, p_customer_id: s.customerA, p_message: null,
    });
    await expect(
      db.rpc(A(), 'approve_application', {
        p_application_id: app, p_collector_id: s.collector, p_principal: 600_000, p_installments: 4,
        p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      }),
    ).rejects.toThrow(/supera la tasa de usura/);
    await db.rpc(A(), 'review_application', { p_application_id: app, p_action: 'reject', p_notes: 'Usura' });
  });

  it('el modo demostración permite aprobar sin bloqueo y el cambio queda auditado', async () => {
    await db.rpc(A(), 'update_setting', { p_key: 'compliance', p_value: JSON.stringify({ mode: 'demo', legal_review_completed: false }) });
    const app = await db.rpc<string>(A(), 'create_application', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
      p_simulation_id: null, p_customer_id: s.customerA, p_message: null,
    });
    const loan = await db.rpc<string>(A(), 'approve_application', {
      p_application_id: app, p_collector_id: s.collector, p_principal: 600_000, p_installments: 4,
      p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
    });
    await db.rpc(A(), 'cancel_loan', { p_loan_id: loan, p_reason: 'Prueba de modo demo' });
    const log = await db.owner<any>(`select new_data from public.audit_logs where table_name = 'app_settings' and new_data->'value'->>'mode' = 'demo'`);
    expect(log.length).toBe(1);
    await expect(db.rpc(A(), 'update_setting', { p_key: 'compliance', p_value: JSON.stringify({ mode: 'otro', legal_review_completed: false }) })).rejects.toThrow(/modo/);
    await enableComplianceForTests(db, s.admin);
  });
});

describe('Simulación y solicitudes', () => {
  it('el cálculo SQL coincide exactamente con la librería TypeScript', async () => {
    for (const [p, k, f] of [[600_000, 4, 'weekly'], [600_000, 5, 'biweekly'], [123_457, 3, 'weekly'], [999_999, 5, 'biweekly']] as const) {
      const sim = await db.rpc<Record<string, any>>(A(), 'simulate_loan', {
        p_principal: p, p_installments: k, p_frequency: f, p_start_date: isoDaysFromToday(1),
      });
      const ts = computeTerms(p, k, f, isoDaysFromToday(1));
      expect(n(sim.interest_total)).toBe(ts.interestTotal);
      expect(n(sim.total_amount)).toBe(ts.totalAmount);
      expect(sim.schedule.map((r: any) => [r.number, r.due_date, n(r.principal), n(r.interest), n(r.total), n(r.balance_after)])).toEqual(
        ts.schedule.map((r) => [r.number, r.dueDate, r.principal, r.interest, r.total, r.balanceAfter]),
      );
      expect(Math.abs(n(sim.effective_annual_rate) - ts.effectiveAnnualRate)).toBeLessThan(1e-4);
    }
  });

  it('7. simular no crea deuda ni reserva capital', async () => {
    const loansBefore = await count('loans');
    const instBefore = await count('loan_installments');
    const capBefore = await db.rpc<Record<string, number>>(A(), 'capital_summary');
    const sim = await db.rpc<Record<string, any>>(CA(), 'simulate_loan', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'biweekly', p_start_date: null,
    });
    expect(n(sim.total_amount)).toBe(720_000);
    expect(sim.collector_commission_total).toBeUndefined();
    // Sin sesión no se puede simular.
    await expect(db.rpc(anon, 'simulate_loan', { p_principal: 300_000, p_installments: 2, p_frequency: 'weekly', p_start_date: null })).rejects.toThrow(/FORBIDDEN/);
    expect(await count('loans')).toBe(loansBefore);
    expect(await count('loan_installments')).toBe(instBefore);
    expect(await db.rpc(A(), 'capital_summary')).toEqual(capBefore);
    await expect(
      db.rpc(CA(), 'simulate_loan', { p_principal: 300_000, p_installments: 2, p_frequency: 'biweekly', p_start_date: null }),
    ).rejects.toThrow(/solo se permite la modalidad semanal/);
    // El informe de la simulación del cliente A no es visible para el cliente B.
    await expect(db.rpc(CB(), 'get_simulation', { p_id: sim.id })).rejects.toThrow(/FORBIDDEN/);
    expect((await db.rpc<any>(CA(), 'get_simulation', { p_id: sim.id })).customer.code).toMatch(/^CL-/);
  });

  it('8. la solicitud queda pendiente de aprobación y no crea deuda', async () => {
    const loansBefore = await count('loans');
    const sim = await db.rpc<Record<string, any>>(CA(), 'simulate_loan', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(2),
    });
    const app = await db.rpc<string>(CA(), 'create_application', {
      p_principal: 600_000, p_installments: 4, p_frequency: 'weekly', p_start_date: isoDaysFromToday(2),
      p_simulation_id: sim.id, p_customer_id: s.customerB, p_message: 'Necesito capital de trabajo',
    });
    const row = (await db.owner<any>('select status, customer_id, simulation_id from public.loan_applications where id = $1', [app]))[0];
    expect(row).toEqual({ status: 'pending', customer_id: s.customerA, simulation_id: sim.id }); // ignora p_customer_id ajeno
    expect(await count('loans')).toBe(loansBefore);
    await expect(
      db.rpc(CA(), 'approve_application', {
        p_application_id: app, p_collector_id: s.collector, p_principal: 600_000, p_installments: 4,
        p_frequency: 'weekly', p_start_date: isoDaysFromToday(2),
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      db.rpc(CA(), 'create_application', {
        p_principal: 100_000, p_installments: 1, p_frequency: 'weekly', p_start_date: isoDaysFromToday(0),
        p_simulation_id: null, p_customer_id: null, p_message: null,
      }),
    ).rejects.toThrow(/OPEN_APPLICATION/);

    // Cambiar condiciones exige contraoferta y aceptación del cliente.
    const counter = { p_principal: 600_000, p_installments: 4, p_frequency: 'biweekly', p_start_date: isoDaysFromToday(3) };
    await expect(
      db.rpc(A(), 'approve_application', { p_application_id: app, p_collector_id: s.collector, ...counter }),
    ).rejects.toThrow(/TERMS_MISMATCH/);
    await db.rpc(A(), 'review_application', { p_application_id: app, p_action: 'counter_offer', p_notes: 'Quincenal', ...counter });
    await db.rpc(CA(), 'respond_application', { p_application_id: app, p_accept: true, p_message: null });
    const loan = await db.rpc<string>(A(), 'approve_application', { p_application_id: app, p_collector_id: s.collector, ...counter });
    const l = (await db.owner<any>('select status, frequency, total_amount from public.loans where id = $1', [loan]))[0];
    expect(l).toMatchObject({ status: 'approved', frequency: 'biweekly' });
    expect(n(l.total_amount)).toBe(720_000);
    await db.rpc(A(), 'cancel_loan', { p_loan_id: loan, p_reason: 'Prueba' });
  });
});

describe('Pagos', () => {
  let loan: string;

  it('11. registra un pago parcial', async () => {
    loan = await activeLoan(s.customerA, s.collector);
    const r = await pay(C1(), loan, 100_000);
    expect(r.is_partial).toBe(true);
    const inst = await db.owner<any>('select number, status, paid_principal, paid_interest from public.loan_installments where loan_id = $1 order by number', [loan]);
    expect(inst[0]).toMatchObject({ status: 'partial' });
    expect([n(inst[0].paid_principal), n(inst[0].paid_interest)]).toEqual([83_334, 16_666]);
    expect(inst.slice(1).every((i) => i.status === 'pending')).toBe(true);
    expect(await outstanding(loan)).toBe(620_000);
    const comm = await db.owner<any>('select amount from public.collector_commissions where payment_id = $1', [r.payment_id]);
    expect(n(comm[0].amount)).toBe(4_166);
  });

  it('13. no duplica un pago reenviado con la misma clave de idempotencia', async () => {
    const key = randomUUID();
    const first = await pay(C1(), loan, 50_000, key);
    const again = await pay(C1(), loan, 50_000, key);
    expect(again.duplicate).toBe(true);
    expect(again.payment_id).toBe(first.payment_id);
    expect(n((await db.owner<any>('select count(*) c from public.payments where idempotency_key = $1', [key]))[0].c)).toBe(1);
    expect(await outstanding(loan)).toBe(570_000);
    await expect(pay(C1(), loan, 60_000, key)).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    await expect(pay(C1(), loan, 570_001)).rejects.toThrow(/AMOUNT_EXCEEDS_BALANCE/);
    await expect(pay(C1(), loan, 0)).rejects.toThrow(/INVALID_AMOUNT/);
  });

  it('12. pago completo: saldo en cero, préstamo pagado y comisión exacta del 5 %', async () => {
    await pay(A(), loan, 570_000);
    expect(await outstanding(loan)).toBe(0);
    const l = (await db.owner<any>('select status from public.loans where id = $1', [loan]))[0];
    expect(l.status).toBe('paid');
    const inst = await db.owner<any>('select status from public.loan_installments where loan_id = $1', [loan]);
    expect(inst.every((i) => i.status === 'paid')).toBe(true);
    const totals = (await db.owner<any>(
      `select sum(principal_amount) p, sum(interest_amount) i, sum(commission_amount) c from public.payments where loan_id = $1 and status = 'confirmed'`, [loan]))[0];
    expect([n(totals.p), n(totals.i), n(totals.c)]).toEqual([600_000, 120_000, 30_000]);
    await expect(pay(A(), loan, 1)).rejects.toThrow(/LOAN_NOT_ACTIVE/);
  });

  it('14. un cliente no puede acceder a datos de otro cliente', async () => {
    const loanB = await activeLoan(s.customerB, s.collector2, 300_000, 3);
    const paymentB = await pay(C2(), loanB, 100_000);
    for (const sql of [
      ['select * from public.customers where id = $1', s.customerB],
      ['select * from public.loans where id = $1', loanB],
      ['select * from public.loan_installments where loan_id = $1', loanB],
      ['select * from public.payments where loan_id = $1', loanB],
      ['select * from public.v_loan_balances where id = $1', loanB],
    ] as const) {
      expect(await db.query(CA(), sql[0], [sql[1]])).toEqual([]);
    }
    expect((await db.query<any>(CA(), 'select id from public.customers')).map((r) => r.id)).toEqual([s.customerA]);
    await expect(db.rpc(CA(), 'get_receipt', { p_payment_id: paymentB.payment_id })).rejects.toThrow(/FORBIDDEN/);
    await expect(
      db.rpc(CA(), 'create_payment_request', { p_loan_id: loanB, p_amount: 1000, p_payment_method_id: null, p_reference: null, p_evidence_path: null }),
    ).rejects.toThrow(/NOT_FOUND/);
    // Contabilidad privada de socios
    expect(await db.query(CA(), 'select * from public.financial_transactions')).toEqual([]);
    expect(await db.query(CA(), 'select * from public.partners')).toEqual([]);
    await expect(db.rpc(CA(), 'capital_summary')).rejects.toThrow(/FORBIDDEN/);
    // Cobradores aislados entre sí
    expect(await db.query(C1(), 'select * from public.loans where id = $1', [loanB])).toEqual([]);
    await expect(pay(C1(), loanB, 1000)).rejects.toThrow(/no está asignado/);
    expect((await db.rpc<any>(CB(), 'get_receipt', { p_payment_id: paymentB.payment_id })).customer.document).toBe('CC ******5432');
  });

  it('15. el cobrador no puede alterar capital, condiciones, comisiones ni pagos', async () => {
    await expect(
      db.rpc(C1(), 'record_capital_movement', { p_partner_id: s.partner1, p_kind: 'withdrawal', p_amount: 1000, p_occurred_on: null, p_notes: null }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(C1(), 'record_expense', { p_amount: 1000, p_category: 'x', p_description: 'x', p_occurred_on: null })).rejects.toThrow(/FORBIDDEN/);
    // Escrituras directas: RLS las rechaza (INSERT) o no deja ninguna fila modificable (UPDATE/DELETE).
    await expect(db.query(C1(), `insert into public.financial_transactions (kind, occurred_on, description) values ('adjustment', current_date, 'x')`)).rejects.toThrow(/row-level security/);
    await expect(db.query(C1(), `insert into public.capital_contributions (partner_id, kind, amount, occurred_on, tx_id) values ($1, 'withdrawal', 1, current_date, gen_random_uuid())`, [s.partner1])).rejects.toThrow(/row-level security/);
    const snapshot = async () => db.owner(`select (select sum(principal) from public.loans) l, (select sum(amount) from public.collector_commissions) c,
      (select count(*) from public.payments) p, (select value from public.app_settings where key = 'compliance') v`);
    const before = await snapshot();
    expect(await db.query(C1(), 'update public.loans set principal = 1 returning id')).toEqual([]);
    expect(await db.query(C1(), 'update public.collector_commissions set amount = 999999 returning id')).toEqual([]);
    expect(await db.query(C1(), 'delete from public.payments returning id')).toEqual([]);
    expect(await db.query(C1(), `update public.app_settings set value = '{}' returning key`)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    await expect(db.rpc(C1(), 'update_setting', { p_key: 'compliance', p_value: '{}' })).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(C1(), 'reverse_payment', { p_payment_id: randomUUID(), p_reason: 'quiero' })).rejects.toThrow(/FORBIDDEN/);
    // Ni siquiera el propietario puede modificar un contrato o una comisión ya generada.
    await expect(db.owner('update public.loans set principal = 1')).rejects.toThrow(/IMMUTABLE/);
    await expect(db.owner('update public.collector_commissions set amount = 1')).rejects.toThrow(/IMMUTABLE/);
    await expect(db.owner('delete from public.financial_entries')).rejects.toThrow(/IMMUTABLE/);
  });

  it('17. reverso autorizado: restaura saldos, comisión y contabilidad sin borrar', async () => {
    const l = await activeLoan(s.customerA, s.collector, 500_000, 5);
    const p = await pay(C1(), l, 120_000);
    expect(await outstanding(l)).toBe(480_000);
    await expect(db.owner('delete from public.payments where id = $1', [p.payment_id])).rejects.toThrow(/IMMUTABLE/);

    // El cobrador solicita la corrección; la cuota queda en revisión; administración la aprueba.
    const req = await db.rpc<string>(C1(), 'request_reversal', { p_payment_id: p.payment_id, p_reason: 'Valor digitado por error' });
    expect((await db.owner<any>('select status from public.loan_installments where loan_id = $1 and number = 1', [l]))[0].status).toBe('in_review');
    await db.rpc(A(), 'decide_reversal_request', { p_request_id: req, p_approve: true, p_notes: 'Autorizado' });

    expect(await outstanding(l)).toBe(600_000);
    const pay1 = (await db.owner<any>('select status, reversal_reason, reversal_tx_id from public.payments where id = $1', [p.payment_id]))[0];
    expect(pay1.status).toBe('reversed');
    expect(pay1.reversal_tx_id).toBeTruthy();
    const allocs = await db.owner<any>('select kind, principal_amount + interest_amount t from public.payment_allocations where payment_id = $1 order by id', [p.payment_id]);
    expect(allocs.map((a) => [a.kind, n(a.t)])).toEqual([['payment', 120_000], ['reversal', -120_000]]);
    const comm = await db.owner<any>('select coalesce(sum(amount), 0) s from public.collector_commissions where payment_id = $1', [p.payment_id]);
    expect(n(comm[0].s)).toBe(0);
    const inst = (await db.owner<any>('select status, paid_principal, paid_interest from public.loan_installments where loan_id = $1 and number = 1', [l]))[0];
    expect([inst.status, n(inst.paid_principal), n(inst.paid_interest)]).toEqual(['pending', 0, 0]);
    await expect(db.rpc(A(), 'reverse_payment', { p_payment_id: p.payment_id, p_reason: 'Otra vez' })).rejects.toThrow(/ya fue reversado/);
    // Cada transacción contable cuadra.
    const unbalanced = await db.owner('select tx_id from public.financial_entries group by tx_id having sum(amount) <> 0');
    expect(unbalanced).toEqual([]);
  });

  it('18. conciliación de pagos por QR y pasarela', async () => {
    const methods = await db.query<any>(A(), `insert into public.payment_methods (name, kind, instructions) values ('QR Nequi negocio', 'qr_info', 'Escanee el QR y adjunte el comprobante') returning id`);
    const methodId = methods[0].id;
    const l = await activeLoan(s.customerA, s.collector, 600_000, 4);
    const upload = async (who: ReturnType<typeof user>, customerId: string, uploader: string) =>
      (await db.query<{ id: string }>(who, `insert into public.stored_files (bucket, customer_id, content_type, size_bytes, data, uploaded_by)
         values ('payment-evidence', $1, 'image/jpeg', 3, '\x010203', $2) returning id`, [customerId, uploader]))[0].id;
    const fileA = await upload(CA(), s.customerA, s.customerUserA);
    const fileA2 = await upload(CA(), s.customerA, s.customerUserA);
    const fileB = await upload(CB(), s.customerB, s.customerUserB);
    // Un cliente no puede subir archivos a nombre de otro ni ver los ajenos.
    await expect(upload(CA(), s.customerB, s.customerUserA)).rejects.toThrow(/row-level security/);
    expect(await db.query(CA(), 'select id from public.stored_files where id = $1', [fileB])).toEqual([]);

    // Comprobante cargado: pendiente de verificar, NO reduce el saldo.
    const req = await db.rpc<string>(CA(), 'create_payment_request', {
      p_loan_id: l, p_amount: 180_000, p_payment_method_id: methodId, p_reference: 'M12345', p_evidence_path: fileA,
    });
    expect((await db.owner<any>('select status from public.payment_requests where id = $1', [req]))[0].status).toBe('pending_verification');
    expect(await outstanding(l)).toBe(720_000);
    await expect(
      db.rpc(CA(), 'create_payment_request', { p_loan_id: l, p_amount: 1000, p_payment_method_id: methodId, p_reference: null, p_evidence_path: fileB }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(CA(), 'review_payment_request', { p_request_id: req, p_approve: true, p_notes: null, p_received_on: null })).rejects.toThrow(/FORBIDDEN/);

    // Confirmación válida por administración: ahora sí reduce el saldo.
    const ok = await db.rpc<any>(A(), 'review_payment_request', { p_request_id: req, p_approve: true, p_notes: 'Verificado en extracto', p_received_on: null });
    expect(ok.status).toBe('confirmed');
    expect(await outstanding(l)).toBe(540_000);
    const pm = (await db.owner<any>('select method, cash_custody from public.payments where id = $1', [ok.payment_id]))[0];
    expect(pm).toEqual({ method: 'qr', cash_custody: 'admin' });
    await expect(db.rpc(A(), 'review_payment_request', { p_request_id: req, p_approve: true, p_notes: null, p_received_on: null })).rejects.toThrow(/INVALID_STATE/);

    // Rechazo: no reduce el saldo.
    const req2 = await db.rpc<string>(CA(), 'create_payment_request', { p_loan_id: l, p_amount: 50_000, p_payment_method_id: methodId, p_reference: null, p_evidence_path: fileA2 });
    await db.rpc(A(), 'review_payment_request', { p_request_id: req2, p_approve: false, p_notes: 'No aparece en el extracto', p_received_on: null });
    expect(await outstanding(l)).toBe(540_000);

    // Pasarela: importe y referencia verificados; reintentos idempotentes; solo el servidor confirma.
    const req3 = await db.rpc<string>(CA(), 'create_payment_request', { p_loan_id: l, p_amount: 180_000, p_payment_method_id: null, p_reference: null, p_evidence_path: null });
    const code = (await db.owner<any>('select code, status from public.payment_requests where id = $1', [req3]))[0];
    expect(code.status).toBe('requested');
    await expect(db.rpc(CA(), 'confirm_gateway_payment', { p_request_code: code.code, p_amount: 180_000, p_gateway_reference: 'tx-1' })).rejects.toThrow(/FORBIDDEN/);
    await expect(db.rpc(service, 'confirm_gateway_payment', { p_request_code: code.code, p_amount: 1_000, p_gateway_reference: 'tx-1' })).rejects.toThrow(/AMOUNT_MISMATCH/);
    const g1 = await db.rpc<any>(service, 'confirm_gateway_payment', { p_request_code: code.code, p_amount: 180_000, p_gateway_reference: 'tx-1' });
    const g2 = await db.rpc<any>(service, 'confirm_gateway_payment', { p_request_code: code.code, p_amount: 180_000, p_gateway_reference: 'tx-1' });
    expect([g1.duplicate, g2.duplicate]).toEqual([false, true]);
    expect(await outstanding(l)).toBe(360_000);
  });

  it('20. audita movimientos y cambios de configuración sin exponer documentos', async () => {
    const before = await count('audit_logs');
    await db.rpc(A(), 'update_setting', { p_key: 'company', p_value: JSON.stringify({ name: 'Capital Control SAS', support_phone: null, legal_name: null, nit: null }) });
    const log = (await db.owner<any>(`select actor_id, actor_role, action, old_data, new_data from public.audit_logs where table_name = 'app_settings' order by id desc limit 1`))[0];
    expect(log).toMatchObject({ actor_id: s.admin, actor_role: 'admin', action: 'update' });
    expect(log.old_data.value.name).toBe('Capital Control');
    expect(log.new_data.value.name).toBe('Capital Control SAS');
    expect(await count('audit_logs')).toBeGreaterThan(before);

    const paymentsLogged = await db.owner<any>(`select count(*) c from public.audit_logs where table_name = 'payments' and action = 'insert'`);
    expect(n(paymentsLogged[0].c)).toBeGreaterThan(0);
    const customerLog = await db.owner<any>(`select new_data from public.audit_logs where table_name = 'customers' and action = 'insert' limit 1`);
    expect(customerLog[0].new_data.document_number).toMatch(/^\*+\d{4}$/);

    expect(await db.query(C1(), 'select * from public.audit_logs')).toEqual([]);
    expect(await db.query(CA(), 'select * from public.audit_logs')).toEqual([]);
    expect((await db.query(A(), 'select id from public.audit_logs limit 1')).length).toBe(1);
    await expect(db.owner('update public.audit_logs set action = $1', ['x'])).rejects.toThrow(/IMMUTABLE/);
    await expect(db.owner('delete from public.audit_logs')).rejects.toThrow(/IMMUTABLE/);
  });

  it('el registro público nunca crea administradores', async () => {
    await expect(db.createUser('admin', 'Intruso')).rejects.toThrow(/BOOTSTRAP_REQUIRED/);
    const id = (await db.owner<any>(`insert into auth.users (email, password_hash, raw_user_meta_data) values ('x@y.z', 'x', '{"role":"admin","full_name":"Xavier"}') returning id`))[0].id;
    expect((await db.owner<any>('select role from public.profiles where id = $1', [id]))[0].role).toBe('customer');
  });
});
