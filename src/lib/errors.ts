/** Convierte errores de la base de datos (códigos de las RPC) en mensajes para el usuario. */
const CODE_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tiene permiso para realizar esta operación.',
  COMPLIANCE_BLOCKED: 'Bloqueado por cumplimiento normativo.',
  INSUFFICIENT_CAPITAL: 'Capital insuficiente.',
  IDEMPOTENCY_CONFLICT: 'Este pago ya se registró con otros datos. Recargue la página.',
  PERIOD_CLOSED: 'La fecha pertenece a un periodo ya liquidado.',
};

export function friendlyError(error: unknown): string {
  const raw =
    typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? '');
  const match = raw.match(/^([A-Z_]+):\s*(.*)$/s);
  if (match) {
    const [, code, detail] = match;
    const base = CODE_MESSAGES[code];
    if (detail) return base && code !== 'FORBIDDEN' ? `${base} ${capitalize(detail)}` : capitalize(detail);
    return base ?? 'No fue posible completar la operación.';
  }
  if (/permission denied|row-level security/i.test(raw)) return CODE_MESSAGES.FORBIDDEN;
  if (/duplicate key/i.test(raw)) return 'El registro ya existe.';
  if (/JWT|session/i.test(raw)) return 'Su sesión expiró. Inicie sesión de nuevo.';
  return 'No fue posible completar la operación. Intente de nuevo.';
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type ActionResult<T = unknown> = { ok: true; message?: string; data?: T } | { ok: false; error: string };

export const initialActionState: ActionResult = { ok: true };
