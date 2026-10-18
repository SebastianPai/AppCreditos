import { NextResponse } from 'next/server';
import { getSessionProfile, userDb } from '@/lib/auth';

/** Sirve un comprobante o QR solo si RLS permite al usuario verlo. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionProfile())) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  const db = await userDb();
  const file = await db.one<{ content_type: string; data: Buffer }>('select content_type, data from public.stored_files where id = $1', [id]);
  if (!file) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.content_type,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
