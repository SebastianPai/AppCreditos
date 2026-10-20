import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  TermsError,
  PaymentError,
  allocatePayment,
  applyAllocations,
  allowedFrequencies,
  buildSchedule,
  capitalAvailable,
  commissionAccrued,
  computeSettlement,
  computeTerms,
  distributeInterest,
  effectiveAnnualRate,
  paymentCommission,
  splitAmongPartners,
  validateTerms,
  installmentOptions,
  type InstallmentState,
} from '@/lib/finance';

const START = '2026-11-02';
/** Motor genérico (1–5 cuotas) para probar redondeos; la política del negocio solo permite 4 o 5. */
const ANY = { ...DEFAULT_POLICY, minInstallments: 1 };

describe('Reglas del préstamo (20 % único sobre el capital)', () => {
  it('1. $600.000 al 20 % genera $120.000 de interés total', () => {
    expect(computeTerms(600_000, 4, 'weekly', START).interestTotal).toBe(120_000);
  });

  it('2. total contractual de $720.000', () => {
    const t = computeTerms(600_000, 4, 'weekly', START);
    expect(t.totalAmount).toBe(720_000);
    expect(t.schedule.reduce((s, r) => s + r.total, 0)).toBe(720_000);
  });

  it('3. cuatro cuotas de $180.000', () => {
    const s = buildSchedule(600_000, 4, 'weekly', START);
    expect(s.map((r) => r.total)).toEqual([180_000, 180_000, 180_000, 180_000]);
    expect(s.map((r) => r.principal)).toEqual([150_000, 150_000, 150_000, 150_000]);
    expect(s.map((r) => r.interest)).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(s.map((r) => r.balanceAfter)).toEqual([540_000, 360_000, 180_000, 0]);
  });

  it('4. cinco cuotas de $144.000', () => {
    const s = buildSchedule(600_000, 5, 'weekly', START);
    expect(s.map((r) => r.total)).toEqual([144_000, 144_000, 144_000, 144_000, 144_000]);
    expect(s.reduce((a, r) => a + r.interest, 0)).toBe(120_000);
  });

  it('el interés no es por cuota ni compuesto: no cambia con el número de cuotas ni la modalidad', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      for (const f of ['weekly', 'biweekly'] as const) {
        expect(computeTerms(600_000, n, f, START, ANY).interestTotal).toBe(120_000);
      }
    }
  });

  it('5. $600.000 permite modalidad semanal y quincenal con fechas correctas', () => {
    expect(allowedFrequencies(600_000)).toEqual(['weekly', 'biweekly']);
    const weekly = buildSchedule(600_000, 4, 'weekly', START);
    const biweekly = buildSchedule(600_000, 4, 'biweekly', START);
    expect(weekly.map((r) => r.dueDate)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
    expect(biweekly.map((r) => r.dueDate)).toEqual(['2026-11-17', '2026-12-02', '2026-12-17', '2027-01-01']);
    expect(weekly.map((r) => r.total)).toEqual(biweekly.map((r) => r.total));
  });

  it('6. importes inferiores a $500.000 solo admiten modalidad semanal', () => {
    expect(allowedFrequencies(499_999)).toEqual(['weekly']);
    expect(() => validateTerms(499_999, 4, 'biweekly')).toThrow(TermsError);
    expect(() => validateTerms(499_999, 4, 'weekly')).not.toThrow();
    expect(allowedFrequencies(500_000)).toEqual(['weekly', 'biweekly']);
    expect(() => validateTerms(500_000, 4, 'biweekly')).not.toThrow();
  });

  it('solo se permiten 4 o 5 cuotas', () => {
    expect(() => validateTerms(600_000, 6, 'weekly')).toThrow(TermsError);
    for (const n of [0, 1, 2, 3]) expect(() => validateTerms(600_000, n, 'weekly')).toThrow(TermsError);
    expect(() => validateTerms(600_000, 4, 'weekly')).not.toThrow();
    expect(() => validateTerms(600_000, 5, 'biweekly')).not.toThrow();
    expect(installmentOptions()).toEqual([4, 5]);
  });

  it('reparte pesos residuales de forma determinista y exacta', () => {
    for (const principal of [100_001, 333_333, 777_777, 1_234_567, 50_003]) {
      for (const n of [1, 2, 3, 4, 5]) {
        const t = computeTerms(principal, n, 'weekly', START, ANY);
        const s = t.schedule;
        expect(s.reduce((a, r) => a + r.total, 0)).toBe(t.totalAmount);
        expect(s.reduce((a, r) => a + r.principal, 0)).toBe(principal);
        expect(s.reduce((a, r) => a + r.interest, 0)).toBe(t.interestTotal);
        expect(Math.max(...s.map((r) => r.total)) - Math.min(...s.map((r) => r.total))).toBeLessThanOrEqual(1);
        expect(s.every((r) => r.interest >= 0 && r.total === r.principal + r.interest)).toBe(true);
        expect(buildSchedule(principal, n, 'weekly', START)).toEqual(s);
      }
    }
  });

  it('informa la tasa efectiva anual equivalente', () => {
    const t = computeTerms(600_000, 4, 'weekly', START);
    expect(t.effectiveAnnualRate).toBeGreaterThan(10);
    expect(effectiveAnnualRate(600_000, START, [{ total: 600_000, dueDate: '2026-12-02' }])).toBe(0);
  });
});

describe('Distribución del interés', () => {
  it('9. $120.000 se reparte en $30.000 para el cobrador y $90.000 para socios', () => {
    const d = distributeInterest(600_000);
    expect(d.interestTotal).toBe(120_000);
    expect(d.collectorCommission).toBe(30_000);
    expect(d.partnersPool).toBe(90_000);
  });

  it('10. la bolsa de $90.000 se divide en $45.000 por socio', () => {
    expect(distributeInterest(600_000).partners.map((p) => p.amount)).toEqual([45_000, 45_000]);
  });

  it('residuo impar de la bolsa se asigna de forma determinista al socio 1', () => {
    const split = splitAmongPartners(90_001, [
      { partnerId: 'b', shareBps: 5000, seq: 2 },
      { partnerId: 'a', shareBps: 5000, seq: 1 },
    ]);
    expect(split).toEqual([
      { partnerId: 'a', shareBps: 5000, amount: 45_001 },
      { partnerId: 'b', shareBps: 5000, amount: 45_000 },
    ]);
    expect(() => splitAmongPartners(100, [{ partnerId: 'a', shareBps: 4000, seq: 1 }])).toThrow();
  });

  it('la comisión se devenga en proporción al interés cobrado y suma exactamente el 5 %', () => {
    expect(commissionAccrued(0, 120_000, 30_000)).toBe(0);
    expect(commissionAccrued(30_000, 120_000, 30_000)).toBe(7_500);
    expect(commissionAccrued(120_000, 120_000, 30_000)).toBe(30_000);
    let collected = 0;
    let total = 0;
    for (const step of [16_666, 13_334, 1, 29_999, 60_000]) {
      total += paymentCommission(collected, step, 120_000, 30_000);
      collected += step;
    }
    expect(collected).toBe(120_000);
    expect(total).toBe(30_000);
  });
});

function installmentsFor(principal: number, n: number): InstallmentState[] {
  return buildSchedule(principal, n, 'weekly', START).map((r) => ({
    id: `i${r.number}`,
    number: r.number,
    principal: r.principal,
    interest: r.interest,
    total: r.total,
    paidPrincipal: 0,
    paidInterest: 0,
  }));
}

describe('Asignación de pagos', () => {
  it('11. pago parcial de $100.000 sobre la primera cuota de $180.000', () => {
    const inst = installmentsFor(600_000, 4);
    const alloc = allocatePayment(inst, 100_000);
    expect(alloc).toEqual([{ installmentId: 'i1', principal: 83_334, interest: 16_666, completes: false }]);
    const after = applyAllocations(inst, alloc);
    const outstanding = after.reduce((s, i) => s + i.total - i.paidPrincipal - i.paidInterest, 0);
    expect(outstanding).toBe(620_000);
  });

  it('12. pago completo: saldo cero, capital e interés exactos', () => {
    let inst = installmentsFor(600_000, 4);
    inst = applyAllocations(inst, allocatePayment(inst, 100_000));
    const alloc = allocatePayment(inst, 620_000);
    inst = applyAllocations(inst, alloc);
    expect(alloc.every((a) => a.completes)).toBe(true);
    expect(inst.reduce((s, i) => s + i.paidPrincipal, 0)).toBe(600_000);
    expect(inst.reduce((s, i) => s + i.paidInterest, 0)).toBe(120_000);
    expect(inst.every((i) => i.paidPrincipal === i.principal && i.paidInterest === i.interest)).toBe(true);
  });

  it('un abono mayor que la cuota se traslada a las siguientes (pago anticipado)', () => {
    const alloc = allocatePayment(installmentsFor(600_000, 4), 200_000);
    expect(alloc.map((a) => [a.installmentId, a.principal + a.interest])).toEqual([
      ['i1', 180_000],
      ['i2', 20_000],
    ]);
  });

  it('rechaza pagos superiores al saldo, nulos o con decimales', () => {
    const inst = installmentsFor(600_000, 4);
    expect(() => allocatePayment(inst, 720_001)).toThrow(PaymentError);
    expect(() => allocatePayment(inst, 0)).toThrow(PaymentError);
    expect(() => allocatePayment(inst, 10.5)).toThrow(PaymentError);
  });
});

describe('Capital y liquidación', () => {
  it('19. capital disponible no incluye comisiones, utilidades ni capital comprometido', () => {
    expect(
      capitalAvailable({ cashAdmin: 1_120_000, commissionPayable: 30_000, partnerProfitPayable: 0, unsettledResult: 90_000, committed: 0 }),
    ).toBe(1_000_000);
    expect(
      capitalAvailable({ cashAdmin: 1_000_000, commissionPayable: 0, partnerProfitPayable: 0, unsettledResult: -5_000, committed: 600_000 }),
    ).toBe(400_000);
  });

  it('16. liquidación: distribuye solo intereses cobrados netos y descuenta anticipos', () => {
    const r = computeSettlement({
      interestCollected: 120_000,
      collectorCommissions: 30_000,
      expenses: 10_000,
      adjustments: 0,
      priorRetained: 0,
      partners: [
        { partnerId: 'p1', shareBps: 5000, seq: 1, advancesOutstanding: 0 },
        { partnerId: 'p2', shareBps: 5000, seq: 2, advancesOutstanding: 5_000 },
      ],
    });
    expect(r.netDistributable).toBe(80_000);
    expect(r.partners.map((p) => [p.gross, p.advancesDeducted, p.net])).toEqual([
      [40_000, 0, 40_000],
      [40_000, 5_000, 35_000],
    ]);
  });

  it('una pérdida no se distribuye y se arrastra al siguiente periodo', () => {
    const loss = computeSettlement({
      interestCollected: 0, collectorCommissions: 0, expenses: 50_000, adjustments: 0, priorRetained: 0,
      partners: [{ partnerId: 'p1', shareBps: 10_000, seq: 1, advancesOutstanding: 0 }],
    });
    expect(loss.netDistributable).toBe(0);
    expect(loss.lossCarriedForward).toBe(-50_000);
    const next = computeSettlement({
      interestCollected: 90_000, collectorCommissions: 0, expenses: 0, adjustments: 0, priorRetained: -50_000,
      partners: [{ partnerId: 'p1', shareBps: 10_000, seq: 1, advancesOutstanding: 0 }],
    });
    expect(next.netDistributable).toBe(40_000);
  });

  it('la política por defecto suma 5 % + 15 % = 20 %', () => {
    expect(DEFAULT_POLICY.collectorCommissionBps + DEFAULT_POLICY.partnersBps).toBe(DEFAULT_POLICY.interestBps);
  });
});

describe('Días para pagar / atraso', () => {
  it('muestra cuántos días faltan o de atraso', async () => {
    const { dueStatus } = await import('@/lib/finance');
    expect(dueStatus('2026-10-19', '2026-10-18').text).toBe('Falta 1 día');
    expect(dueStatus('2026-10-25', '2026-10-18').text).toBe('Faltan 7 días');
    expect(dueStatus('2026-10-18', '2026-10-18').text).toBe('Vence hoy');
    expect(dueStatus('2026-10-17', '2026-10-18')).toMatchObject({ text: 'Atrasada 1 día', tone: 'danger' });
    expect(dueStatus('2026-10-14', '2026-10-18').text).toBe('Atrasada 4 días');
    expect(dueStatus('2026-10-14', '2026-10-18', true).text).toBe('Pagada');
  });
});
