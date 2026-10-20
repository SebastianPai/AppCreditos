import { daysBetween } from '@/lib/finance/dates';

/** Cuota con lo necesario para calcular el puntaje. Fechas AAAA-MM-DD (hora de Bogotá). */
export interface ScoreInstallment {
  loan_id: string;
  number: number;
  due_date: string;
  paid_on: string | null;
  outstanding: number;
}

export interface ScoreEvent {
  date: string;
  text: string;
  points: number;
}

export interface CreditScore {
  score: number;
  /** Cambio del último movimiento: positivo = subió. */
  lastChange: number;
  events: ScoreEvent[];
  level: { label: string; message: string; tone: 'success' | 'info' | 'warning' | 'danger' };
}

export const START_SCORE = 70;

/**
 * Puntaje de 0 a 100. Empieza en 70 y:
 *   +5 por cuota pagada a tiempo,
 *   −3 por cuota pagada tarde (−1 adicional por cada 3 días de atraso, hasta −10),
 *   −10 por cuota vencida sin pagar (−1 adicional por cada 3 días, hasta −20),
 *   +5 por préstamo terminado de pagar.
 */
export function creditScore(rows: ScoreInstallment[], today: string): CreditScore {
  const events: ScoreEvent[] = [];
  for (const r of rows) {
    const due = r.due_date.slice(0, 10);
    if (r.paid_on) {
      const late = daysBetween(due, r.paid_on);
      events.push(late <= 0
        ? { date: r.paid_on, text: `Cuota ${r.number} pagada a tiempo`, points: 5 }
        : { date: r.paid_on, text: `Cuota ${r.number} pagada con ${late} día(s) de atraso`, points: -Math.min(10, 3 + Math.floor(late / 3)) });
    } else if (r.outstanding > 0 && due < today) {
      const late = daysBetween(due, today);
      events.push({ date: today, text: `Cuota ${r.number} atrasada ${late} día(s)`, points: -Math.min(20, 10 + Math.floor(late / 3)) });
    }
  }
  const byLoan = new Map<string, ScoreInstallment[]>();
  for (const r of rows) byLoan.set(r.loan_id, [...(byLoan.get(r.loan_id) ?? []), r]);
  for (const list of byLoan.values()) {
    if (list.every((r) => r.paid_on)) {
      const last = list.map((r) => r.paid_on!).sort().at(-1)!;
      events.push({ date: last, text: 'Préstamo pagado completo', points: 5 });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let score = START_SCORE;
  for (const e of events) score = Math.max(0, Math.min(100, score + e.points));
  return { score, lastChange: events.at(-1)?.points ?? 0, events: events.reverse(), level: levelFor(score) };
}

function levelFor(score: number): CreditScore['level'] {
  if (score >= 90) return { label: 'Excelente', message: 'Tiene muy buenas posibilidades de que le aprueben otro préstamo.', tone: 'success' };
  if (score >= 70) return { label: 'Bueno', message: 'Siga pagando a tiempo para subir a más de 90 y tener más opciones de otro préstamo.', tone: 'info' };
  if (score >= 50) return { label: 'Regular', message: 'Ponerse al día y pagar a tiempo hace que su puntaje suba.', tone: 'warning' };
  return { label: 'Bajo', message: 'Tiene cuotas atrasadas. Póngase al día para recuperar su puntaje.', tone: 'danger' };
}

/** Consulta SQL de las cuotas (respeta los permisos del usuario por RLS). */
export const SCORE_SQL = `select loan_id, number, due_date::text as due_date,
       case when outstanding <= 0 then coalesce((paid_at at time zone 'America/Bogota')::date, due_date)::text end as paid_on,
       outstanding::bigint as outstanding
  from public.v_installments
 where loan_status in ('active', 'paid') and ($1::uuid is null or customer_id = $1)`;
