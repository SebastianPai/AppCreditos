import { NextResponse } from 'next/server';
import { getSessionProfile, userDb } from '@/lib/auth';
import { settlementWorkbook, type SettlementReport } from '@/lib/excel';
import { WORKFLOW_STATUS } from '@/lib/labels';

/** Liquidación en Excel. RLS limita el acceso a administración y socios (no borradores). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getSessionProfile();
  if (!profile || !['admin', 'partner'].includes(profile.role)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const s = await db.one('select status, report, approved_report, approved_hash, period_start, period_end from public.quarterly_settlements where id = $1', [id]);
  if (!s) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const buffer = await settlementWorkbook((s.approved_report ?? s.report) as SettlementReport, WORKFLOW_STATUS[s.status]?.label ?? s.status, s.approved_hash);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="liquidacion-${s.period_start}-${s.period_end}.xlsx"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
