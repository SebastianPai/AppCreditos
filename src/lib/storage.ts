import 'server-only';
import type { Db } from '@/lib/db';

const ALLOWED: Record<string, true> = { 'image/jpeg': true, 'image/png': true, 'image/webp': true, 'application/pdf': true };
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/**
 * Guarda un archivo en PostgreSQL (tabla stored_files) con la identidad del
 * usuario: RLS solo permite subir comprobantes de clientes que el usuario puede
 * ver, y QR solo a administradores. Devuelve el id del archivo.
 */
export async function saveFile(
  db: Db,
  uploaderId: string,
  bucket: 'payment-evidence' | 'payment-methods',
  file: File | null,
  customerId: string | null,
  maxBytes = MAX_EVIDENCE_BYTES,
): Promise<{ id: string | null; error?: string }> {
  if (!file || file.size === 0) return { id: null };
  if (!ALLOWED[file.type] || (bucket === 'payment-methods' && file.type === 'application/pdf')) {
    return { id: null, error: 'Formato no permitido. Use JPG, PNG o WEBP (o PDF para comprobantes).' };
  }
  if (file.size > maxBytes) return { id: null, error: `El archivo supera ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  const data = Buffer.from(await file.arrayBuffer());
  const row = await db.one<{ id: string }>(
    `insert into public.stored_files (bucket, customer_id, content_type, size_bytes, data, uploaded_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [bucket, customerId, file.type, file.size, data, uploaderId],
  );
  return { id: row?.id ?? null };
}

/** URL interna del archivo; la ruta /api/archivos/[id] vuelve a verificar permisos con RLS. */
export const fileUrl = (id: string | null | undefined) => (id ? `/api/archivos/${id}` : null);
