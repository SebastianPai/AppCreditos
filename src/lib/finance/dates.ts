/** Fechas de negocio como 'YYYY-MM-DD' en la zona America/Bogota. */
export const BUSINESS_TZ = 'America/Bogota';

const isoFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function todayBogota(now: Date = new Date()): string {
  return isoFormatter.format(now);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const longFormatter = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  return longFormatter.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-CO', {
  timeZone: BUSINESS_TZ,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
export function formatDateTime(value: string | null | undefined): string {
  return value ? dateTimeFormatter.format(new Date(value)) : '—';
}

/** Trimestre calendario que contiene la fecha dada. */
export function quarterOf(isoDate: string): { start: string; end: string } {
  const [y, m] = isoDate.split('-').map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const start = `${y}-${String(qStartMonth).padStart(2, '0')}-01`;
  const next = qStartMonth + 3 > 12 ? `${y + 1}-01-01` : `${y}-${String(qStartMonth + 3).padStart(2, '0')}-01`;
  return { start, end: addDays(next, -1) };
}

/** Rango para filtros de informes: día, semana (lunes a domingo), mes, trimestre o personalizado. */
export function rangeFor(period: string | undefined, today: string, from?: string, to?: string): { from: string; to: string } {
  if (period === 'week') {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { from: addDays(today, -dow), to: addDays(today, 6 - dow) };
  }
  if (period === 'month') {
    const start = `${today.slice(0, 7)}-01`;
    const [y, m] = today.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return { from: start, to: addDays(next, -1) };
  }
  if (period === 'quarter') {
    const q = quarterOf(today);
    return { from: q.start, to: q.end };
  }
  if (period === 'custom' && from && to && isIsoDate(from) && isIsoDate(to) && from <= to) return { from, to };
  return { from: today, to: today };
}
