/** Importes en pesos colombianos (COP) enteros. COP no usa centavos en esta operación. */
export type Pesos = number;

export function assertPesos(value: number, label = 'importe'): asserts value is Pesos {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} debe ser un entero de pesos no negativo`);
  }
}

/** Redondeo half-up en enteros de `amount × bps / 10000` (idéntico a public.round_bps). */
export function roundBps(amount: Pesos, bps: number): Pesos {
  assertPesos(amount);
  return Math.floor((amount * bps + 5000) / 10000);
}

const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

export function formatCOP(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return copFormatter.format(Number.isFinite(n) ? n : 0);
}

export function formatPercent(fraction: number, digits = 2): string {
  return new Intl.NumberFormat('es-CO', { style: 'percent', maximumFractionDigits: digits }).format(fraction);
}

/** Convierte texto de un campo ("600.000", "$ 600000") a pesos enteros, o null si no es válido. */
export function parsePesos(input: string): Pesos | null {
  const digits = input.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
