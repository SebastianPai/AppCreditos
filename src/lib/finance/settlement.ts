import { splitAmongPartners } from './distribution';

export interface SettlementInputs {
  interestCollected: number;
  collectorCommissions: number;
  expenses: number;
  adjustments: number;
  /** Saldo del resultado acumulado al inicio (negativo = pérdida arrastrada). */
  priorRetained: number;
  partners: { partnerId: string; shareBps: number; seq: number; advancesOutstanding: number }[];
}

/**
 * Liquidación (idéntica a public._settlement_report): solo se distribuye el
 * resultado realizado (intereses cobrados − comisiones − gastos ± ajustes), neto
 * de pérdidas arrastradas. El capital recuperado no forma parte de la utilidad.
 */
export function computeSettlement(i: SettlementInputs) {
  const periodResult = i.interestCollected - i.collectorCommissions - i.expenses + i.adjustments;
  const base = periodResult + Math.min(i.priorRetained, 0);
  const netDistributable = Math.max(base, 0);
  const split = splitAmongPartners(netDistributable, i.partners);
  return {
    periodResult,
    netDistributable,
    lossCarriedForward: Math.min(base, 0),
    partners: split.map((s) => {
      const p = i.partners.find((x) => x.partnerId === s.partnerId)!;
      const advancesDeducted = Math.min(p.advancesOutstanding, s.amount);
      return { partnerId: s.partnerId, shareBps: s.shareBps, gross: s.amount, advancesDeducted, net: s.amount - advancesDeducted };
    }),
  };
}
