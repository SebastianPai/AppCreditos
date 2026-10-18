import { NextResponse, type NextRequest } from 'next/server';
import { getSessionProfile, userDb } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { isIsoDate, todayBogota } from '@/lib/finance';
import { collectorReportWorkbook } from '@/lib/excel';
import type { CollectorReport } from '@/components/collector-report';
import { uuidOrNull } from '@/lib/validation';

/** Informe del cobrador en Excel. La RPC verifica que un cobrador solo descargue el suyo. */
export async function GET(req: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile || !['admin', 'collector'].includes(profile.role)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const from = sp.get('desde') ?? todayBogota();
  const to = sp.get('hasta') ?? from;
  if (!isIsoDate(from) || !isIsoDate(to)) return NextResponse.json({ error: 'Fechas no válidas' }, { status: 400 });
  const collectorId = profile.role === 'collector' ? profile.id : uuidOrNull(sp.get('cobrador'));
  if (!collectorId) return NextResponse.json({ error: 'Seleccione un cobrador' }, { status: 400 });

  const db = await userDb();
  const { data, error } = await db.call('collector_report', { p_collector_id: collectorId, p_from: from, p_to: to });
  if (error) return NextResponse.json({ error: friendlyError(error) }, { status: 403 });
  const buffer = await collectorReportWorkbook(data as CollectorReport);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="informe-cobro-${from}-${to}.xlsx"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
