import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeTerms, policyFromRow, TermsError, todayBogota, type Frequency } from '@/lib/finance';
import { getSessionProfile, userDb } from '@/lib/auth';
import { firstIssue, isoDate, pesos } from '@/lib/validation';

const body = z.object({
  principal: pesos,
  installments: z.coerce.number().int().min(1).max(5),
  startDate: isoDate,
});

/**
 * Vista previa del simulador calculada en el servidor con la política activa.
 * No guarda nada: el informe oficial se crea con la RPC simulate_loan.
 * Devuelve ambas modalidades (cuando están permitidas) para compararlas.
 */
export async function POST(req: Request) {
  if (!(await getSessionProfile())) return NextResponse.json({ error: 'Inicie sesión para simular' }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  const { principal, installments, startDate } = parsed.data;
  const today = todayBogota();
  if (startDate < today) return NextResponse.json({ error: 'La fecha de inicio no puede ser pasada' }, { status: 400 });

  const db = await userDb();
  const row = await db.rpc('get_active_policy');
  if (!row) return NextResponse.json({ error: 'No hay una política de préstamo activa' }, { status: 503 });
  const policy = policyFromRow(row as Record<string, unknown>);

  try {
    const options: Partial<Record<Frequency, ReturnType<typeof publicTerms>>> = {};
    const base = computeTerms(principal, installments, 'weekly', startDate, policy);
    for (const f of base.allowedFrequencies) options[f] = publicTerms(computeTerms(principal, installments, f, startDate, policy));
    return NextResponse.json(
      {
        policy: { interestBps: policy.interestBps, maxInstallments: policy.maxInstallments, biweeklyMinPrincipal: policy.biweeklyMinPrincipal },
        allowedFrequencies: base.allowedFrequencies,
        options,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof TermsError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}

/** El cliente no ve la distribución interna (comisión/socios). */
function publicTerms(t: ReturnType<typeof computeTerms>) {
  const { collectorCommissionTotal: _c, partnersPoolTotal: _p, ...rest } = t;
  return rest;
}
