export type Frequency = 'weekly' | 'biweekly';

export interface LoanPolicy {
  interestBps: number;
  collectorCommissionBps: number;
  partnersBps: number;
  maxInstallments: number;
  biweeklyMinPrincipal: number;
  minPrincipal: number;
  maxPrincipal: number | null;
  weeklyIntervalDays: number;
  biweeklyIntervalDays: number;
}

/** Política inicial del negocio (versión 1 en la base de datos). */
export const DEFAULT_POLICY: LoanPolicy = {
  interestBps: 2000,
  collectorCommissionBps: 500,
  partnersBps: 1500,
  maxInstallments: 5,
  biweeklyMinPrincipal: 500_000,
  minPrincipal: 1,
  maxPrincipal: null,
  weeklyIntervalDays: 7,
  biweeklyIntervalDays: 15,
};

export const FREQUENCY_LABEL: Record<Frequency, string> = { weekly: 'Semanal', biweekly: 'Quincenal' };

/** Convierte la fila JSON de get_active_policy() al tipo de dominio. */
export function policyFromRow(row: Record<string, unknown>): LoanPolicy {
  return {
    interestBps: Number(row.interest_bps),
    collectorCommissionBps: Number(row.collector_commission_bps ?? 0),
    partnersBps: Number(row.partners_bps ?? 0),
    maxInstallments: Number(row.max_installments),
    biweeklyMinPrincipal: Number(row.biweekly_min_principal),
    minPrincipal: Number(row.min_principal),
    maxPrincipal: row.max_principal == null ? null : Number(row.max_principal),
    weeklyIntervalDays: Number(row.weekly_interval_days ?? 7),
    biweeklyIntervalDays: Number(row.biweekly_interval_days ?? 15),
  };
}

export function allowedFrequencies(principal: number, policy: LoanPolicy = DEFAULT_POLICY): Frequency[] {
  return principal >= policy.biweeklyMinPrincipal ? ['weekly', 'biweekly'] : ['weekly'];
}

export class TermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TermsError';
  }
}

export function validateTerms(principal: number, installments: number, frequency: Frequency, policy: LoanPolicy = DEFAULT_POLICY): void {
  if (!Number.isSafeInteger(principal) || principal < policy.minPrincipal) {
    throw new TermsError(`El capital mínimo es ${policy.minPrincipal}`);
  }
  if (policy.maxPrincipal !== null && principal > policy.maxPrincipal) {
    throw new TermsError(`El capital máximo es ${policy.maxPrincipal}`);
  }
  if (!Number.isInteger(installments) || installments < 1 || installments > policy.maxInstallments) {
    throw new TermsError(`El número de cuotas debe estar entre 1 y ${policy.maxInstallments}`);
  }
  if (!allowedFrequencies(principal, policy).includes(frequency)) {
    throw new TermsError(`Para importes inferiores a ${policy.biweeklyMinPrincipal} solo se permite la modalidad semanal`);
  }
}
