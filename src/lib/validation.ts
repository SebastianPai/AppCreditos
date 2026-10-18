import { z } from 'zod';
import { isIsoDate } from '@/lib/finance/dates';

export const pesos = z.coerce
  .number({ message: 'Ingrese un importe' })
  .int('El importe debe ser un número entero de pesos')
  .positive('El importe debe ser mayor que cero')
  .max(100_000_000_000, 'Importe demasiado alto');

export const isoDate = z.string().refine(isIsoDate, 'Fecha no válida (AAAA-MM-DD)');
export const frequency = z.enum(['weekly', 'biweekly']);
export const uuid = z.string().uuid('Identificador no válido');

export const simulationSchema = z.object({
  principal: pesos,
  installments: z.coerce.number().int().min(1, 'Mínimo 1 cuota').max(5, 'Máximo 5 cuotas'),
  frequency,
  startDate: isoDate,
});
export type SimulationInput = z.infer<typeof simulationSchema>;

export const customerSchema = z.object({
  full_name: z.string().trim().min(3, 'Nombre demasiado corto').max(160),
  document_type: z.enum(['CC', 'CE', 'TI', 'PA', 'PPT', 'NIT']),
  document_number: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^0-9A-Za-z]/g, '').toUpperCase())
    .pipe(z.string().min(3, 'Documento no válido').max(20)),
  phone: z.string().trim().regex(/^[0-9+ ]{7,20}$/, 'Teléfono no válido'),
  address: z.string().trim().max(200).optional().or(z.literal('')),
  collector_id: z.string().uuid().optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  data_consent: z.literal(true, { message: 'Se requiere la autorización de tratamiento de datos (Ley 1581 de 2012)' }),
});
export type CustomerInput = z.input<typeof customerSchema>;

export const paymentSchema = z.object({
  loan_id: uuid,
  amount: pesos,
  idempotency_key: z.string().min(8).max(128),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
});
export type PaymentInput = z.input<typeof paymentSchema>;

export function formString(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export function formOptional(fd: FormData, key: string): string | null {
  return formString(fd, key) || null;
}

/** Pesos escritos con separadores ("600.000") → entero. */
export function formPesos(fd: FormData, key: string): number {
  return Number(formString(fd, key).replace(/[^0-9]/g, ''));
}

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Datos no válidos';
}

/** UUID de la URL o null (evita errores de tipo en consultas con filtros opcionales). */
export function uuidOrNull(v: string | null | undefined): string | null {
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}
