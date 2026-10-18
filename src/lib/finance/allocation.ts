import { commissionAccrued } from './distribution';

export interface InstallmentState {
  id: string;
  number: number;
  principal: number;
  interest: number;
  total: number;
  paidPrincipal: number;
  paidInterest: number;
}

export interface Allocation {
  installmentId: string;
  principal: number;
  interest: number;
  completes: boolean;
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * Asigna un abono (idéntico a public._apply_payment): cuotas en orden; dentro de
 * cada cuota, capital/interés en la proporción acumulada de la cuota; nunca más
 * que el saldo pendiente.
 */
export function allocatePayment(installments: InstallmentState[], amount: number): Allocation[] {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentError('El importe debe ser un entero positivo');
  const ordered = [...installments].sort((a, b) => a.number - b.number);
  const outstanding = ordered.reduce((s, i) => s + i.total - i.paidPrincipal - i.paidInterest, 0);
  if (amount > outstanding) throw new PaymentError(`El pago (${amount}) supera el saldo pendiente (${outstanding})`);
  const result: Allocation[] = [];
  let remaining = amount;
  for (const i of ordered) {
    if (remaining === 0) break;
    const take = Math.min(i.total - i.paidPrincipal - i.paidInterest, remaining);
    if (take === 0) continue;
    const newPaid = i.paidPrincipal + i.paidInterest + take;
    const cumInterest = Math.floor((newPaid * i.interest) / i.total);
    let di = Math.max(0, Math.min(cumInterest - i.paidInterest, i.interest - i.paidInterest, take));
    let dp = take - di;
    if (dp > i.principal - i.paidPrincipal) {
      dp = i.principal - i.paidPrincipal;
      di = take - dp;
    }
    result.push({ installmentId: i.id, principal: dp, interest: di, completes: newPaid === i.total });
    remaining -= take;
  }
  return result;
}

/** Aplica asignaciones a un estado de cuotas (sin mutarlo) y devuelve el nuevo estado. */
export function applyAllocations(installments: InstallmentState[], allocations: Allocation[]): InstallmentState[] {
  return installments.map((i) => {
    const a = allocations.filter((x) => x.installmentId === i.id);
    return {
      ...i,
      paidPrincipal: i.paidPrincipal + a.reduce((s, x) => s + x.principal, 0),
      paidInterest: i.paidInterest + a.reduce((s, x) => s + x.interest, 0),
    };
  });
}

export function paymentCommission(interestBefore: number, interestOfPayment: number, interestTotal: number, commissionTotal: number) {
  return (
    commissionAccrued(interestBefore + interestOfPayment, interestTotal, commissionTotal) -
    commissionAccrued(interestBefore, interestTotal, commissionTotal)
  );
}
