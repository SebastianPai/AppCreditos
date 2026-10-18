import { roundBps } from './money';
import { DEFAULT_POLICY, type LoanPolicy } from './policy';

export interface PartnerShare {
  partnerId: string;
  shareBps: number;
  seq: number;
}

/**
 * Reparte un monto entre socios según share_bps (idéntico a public.split_among_partners):
 * parte entera para cada uno y los pesos residuales, uno a uno, por orden de seq.
 */
export function splitAmongPartners(amount: number, partners: PartnerShare[]) {
  const totalBps = partners.reduce((s, p) => s + p.shareBps, 0);
  if (totalBps !== 10_000) throw new RangeError('Las participaciones deben sumar 100 %');
  const ordered = [...partners].sort((a, b) => a.seq - b.seq);
  const bases = ordered.map((p) => Math.floor((amount * p.shareBps) / 10_000));
  let remainder = amount - bases.reduce((s, b) => s + b, 0);
  return ordered.map((p, i) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { partnerId: p.partnerId, shareBps: p.shareBps, amount: bases[i] + extra };
  });
}

export const EQUAL_PARTNERS: PartnerShare[] = [
  { partnerId: 'socio-1', shareBps: 5000, seq: 1 },
  { partnerId: 'socio-2', shareBps: 5000, seq: 2 },
];

/** Distribución contractual (calculada) del interés de un préstamo. */
export function distributeInterest(principal: number, policy: LoanPolicy = DEFAULT_POLICY, partners = EQUAL_PARTNERS) {
  const interestTotal = roundBps(principal, policy.interestBps);
  const collectorCommission = roundBps(principal, policy.collectorCommissionBps);
  const partnersPool = interestTotal - collectorCommission;
  return { interestTotal, collectorCommission, partnersPool, partners: splitAmongPartners(partnersPool, partners) };
}

/** Comisión devengada acumulada en proporción al interés efectivamente recaudado. */
export function commissionAccrued(interestCollected: number, interestTotal: number, commissionTotal: number): number {
  if (interestTotal === 0) return 0;
  return Math.floor((interestCollected * commissionTotal) / interestTotal);
}
