export const INSTALLMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente', tone: 'neutral' },
  partial: { label: 'Parcialmente pagada', tone: 'info' },
  paid: { label: 'Pagada', tone: 'success' },
  overdue: { label: 'Vencida', tone: 'danger' },
  in_review: { label: 'En revisión', tone: 'warning' },
};

export const LOAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  approved: { label: 'Aprobado (sin desembolso)', tone: 'warning' },
  active: { label: 'Activo', tone: 'info' },
  paid: { label: 'Pagado', tone: 'success' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
};

export const APPLICATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente de revisión', tone: 'warning' },
  info_requested: { label: 'Información solicitada', tone: 'info' },
  counter_offered: { label: 'Contraoferta enviada', tone: 'info' },
  accepted_by_customer: { label: 'Contraoferta aceptada', tone: 'warning' },
  approved: { label: 'Aprobada', tone: 'success' },
  rejected: { label: 'Rechazada', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};

export const PAYMENT_REQUEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Solicitud de pago', tone: 'neutral' },
  pending_verification: { label: 'Pendiente de verificar', tone: 'warning' },
  confirmed: { label: 'Pago confirmado', tone: 'success' },
  rejected: { label: 'Pago rechazado', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
};

export const WORKFLOW_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Borrador', tone: 'neutral' },
  pending_approval: { label: 'Pendiente de aprobación', tone: 'warning' },
  approved: { label: 'Aprobada', tone: 'info' },
  paid: { label: 'Pagada', tone: 'success' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};

export const PAYMENT_METHOD: Record<string, string> = {
  cash: 'Efectivo',
  transfer: 'Transferencia',
  qr: 'QR',
  gateway: 'Pasarela',
};

export const CUSTOMER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Activo', tone: 'success' },
  inactive: { label: 'Inactivo', tone: 'neutral' },
  blocked: { label: 'Bloqueado', tone: 'danger' },
};

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
