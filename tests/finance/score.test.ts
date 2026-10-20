import { describe, expect, it } from 'vitest';
import { creditScore } from '@/lib/score';

const row = (number: number, due_date: string, paid_on: string | null, outstanding = 0) => ({ loan_id: 'L1', number, due_date, paid_on, outstanding });

describe('Puntaje crediticio', () => {
  it('un cliente nuevo empieza en 70', () => {
    expect(creditScore([], '2026-10-20').score).toBe(70);
  });

  it('sube al pagar a tiempo y al terminar el préstamo (máximo 100)', () => {
    const rows = [row(1, '2026-09-01', '2026-09-01'), row(2, '2026-09-08', '2026-09-07'), row(3, '2026-09-15', '2026-09-15'), row(4, '2026-09-22', '2026-09-20')];
    const s = creditScore(rows, '2026-10-20');
    expect(s.score).toBe(95);
    expect(s.level.label).toBe('Excelente');
    expect(s.lastChange).toBe(5);
  });

  it('baja con cuotas vencidas sin pagar', () => {
    const s = creditScore([row(1, '2026-10-01', '2026-10-01'), row(2, '2026-10-08', null, 180_000)], '2026-10-20');
    expect(s.score).toBe(70 + 5 - 14);
    expect(s.lastChange).toBeLessThan(0);
  });
});
