/**
 * Definición contable del capital disponible (idéntica a public._capital_summary):
 * efectivo conciliado de administración menos lo que ya pertenece a terceros o
 * está comprometido. El efectivo en poder de cobradores no está disponible hasta
 * que se entrega y se confirma.
 */
export interface CapitalInputs {
  cashAdmin: number;
  commissionPayable: number;
  partnerProfitPayable: number;
  unsettledResult: number;
  committed: number;
}

export function capitalAvailable(i: CapitalInputs): number {
  return i.cashAdmin - i.commissionPayable - i.partnerProfitPayable - Math.max(i.unsettledResult, 0) - i.committed;
}

/** Glosario mostrado en los tableros: cada cifra con su definición contable. */
export const CAPITAL_DEFINITIONS: Record<string, string> = {
  partner_capital: 'Aportes de capital de los socios menos retiros de capital.',
  cash_admin: 'Saldo conciliado en caja y bancos de administración (aportes + pagos confirmados + entregas de cobradores − desembolsos − gastos − pagos de comisiones y utilidades).',
  cash_collectors: 'Efectivo recaudado que aún está en poder de los cobradores. No está disponible hasta que administración confirma la entrega.',
  loans_principal: 'Capital colocado: capital desembolsado aún no recuperado. No incluye intereses.',
  committed: 'Capital de préstamos aprobados pendientes de desembolso.',
  commission_payable: 'Comisiones devengadas (sobre intereses efectivamente cobrados) aún no pagadas a cobradores.',
  partner_profit_payable: 'Utilidades aprobadas en liquidaciones y aún no pagadas a los socios.',
  unsettled_result: 'Intereses cobrados − comisiones − gastos ± ajustes desde la última liquidación. Pertenece a los socios y se reserva.',
  available: 'Capital disponible para prestar = caja conciliada − comisiones por pagar − utilidades por pagar − resultado no liquidado − capital comprometido.',
};
