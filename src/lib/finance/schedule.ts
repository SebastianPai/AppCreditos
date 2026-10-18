import { addDays, daysBetween } from './dates';
import { roundBps } from './money';
import { DEFAULT_POLICY, type Frequency, type LoanPolicy, allowedFrequencies, validateTerms } from './policy';

export interface ScheduleRow {
  number: number;
  dueDate: string;
  principal: number;
  interest: number;
  total: number;
  balanceAfter: number;
}

export interface LoanTerms {
  principal: number;
  installmentsCount: number;
  frequency: Frequency;
  startDate: string;
  interestBps: number;
  interestTotal: number;
  totalAmount: number;
  collectorCommissionTotal: number;
  partnersPoolTotal: number;
  schedule: ScheduleRow[];
  effectiveAnnualRate: number;
  allowedFrequencies: Frequency[];
}

/**
 * Calendario de cuotas (idéntico a public.build_schedule):
 * - interés total = capital × tasa, aplicado una sola vez (no por cuota, no compuesto);
 * - cuotas iguales del total; los pesos residuales van a las primeras cuotas;
 * - el capital se reparte igual (residuos a las primeras) y el interés de cada
 *   cuota es la diferencia, de modo que las sumas coinciden exactamente.
 */
export function buildSchedule(
  principal: number,
  installments: number,
  frequency: Frequency,
  startDate: string,
  policy: LoanPolicy = DEFAULT_POLICY,
): ScheduleRow[] {
  const interest = roundBps(principal, policy.interestBps);
  const total = principal + interest;
  const days = frequency === 'weekly' ? policy.weeklyIntervalDays : policy.biweeklyIntervalDays;
  const rows: ScheduleRow[] = [];
  let balance = total;
  for (let i = 1; i <= installments; i++) {
    const instTotal = Math.floor(total / installments) + (i <= total % installments ? 1 : 0);
    const instPrincipal = Math.floor(principal / installments) + (i <= principal % installments ? 1 : 0);
    balance -= instTotal;
    rows.push({
      number: i,
      dueDate: addDays(startDate, days * i),
      principal: instPrincipal,
      interest: instTotal - instPrincipal,
      total: instTotal,
      balanceAfter: balance,
    });
  }
  return rows;
}

/** Tasa efectiva anual equivalente (TIR diaria por bisección, base 365). Fracción: 0.25 = 25 %. */
export function effectiveAnnualRate(principal: number, startDate: string, schedule: Pick<ScheduleRow, 'total' | 'dueDate'>[]): number {
  const totalPaid = schedule.reduce((s, r) => s + r.total, 0);
  if (totalPaid <= principal) return 0;
  const flows = schedule.map((r) => ({ amount: r.total, days: daysBetween(startDate, r.dueDate) }));
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const npv = flows.reduce((s, f) => s + f.amount / Math.pow(1 + mid, f.days), -principal);
    if (npv > 0) lo = mid;
    else hi = mid;
  }
  return Math.round((Math.pow(1 + (lo + hi) / 2, 365) - 1) * 1e6) / 1e6;
}

export function computeTerms(
  principal: number,
  installments: number,
  frequency: Frequency,
  startDate: string,
  policy: LoanPolicy = DEFAULT_POLICY,
): LoanTerms {
  validateTerms(principal, installments, frequency, policy);
  const interestTotal = roundBps(principal, policy.interestBps);
  const collectorCommissionTotal = roundBps(principal, policy.collectorCommissionBps);
  const schedule = buildSchedule(principal, installments, frequency, startDate, policy);
  return {
    principal,
    installmentsCount: installments,
    frequency,
    startDate,
    interestBps: policy.interestBps,
    interestTotal,
    totalAmount: principal + interestTotal,
    collectorCommissionTotal,
    partnersPoolTotal: interestTotal - collectorCommissionTotal,
    schedule,
    effectiveAnnualRate: effectiveAnnualRate(principal, startDate, schedule),
    allowedFrequencies: allowedFrequencies(principal, policy),
  };
}
