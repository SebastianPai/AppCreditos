import type { AppRole } from '@/lib/auth';

export const NOTIFICATION_OPTIONS: { key: string; label: string; roles: AppRole[] }[] = [
  { key: 'upcoming_installments', label: 'Próximas cuotas (un día antes)', roles: ['customer'] },
  { key: 'due_today', label: 'Cuotas que vencen hoy', roles: ['customer'] },
  { key: 'payment_confirmed', label: 'Pagos confirmados', roles: ['customer'] },
  { key: 'balance_updates', label: 'Actualizaciones del saldo', roles: ['customer'] },
  { key: 'new_applications', label: 'Nuevas solicitudes de préstamo y pagos por verificar', roles: ['admin'] },
  { key: 'new_assignments', label: 'Nuevos cobros asignados', roles: ['collector'] },
  { key: 'daily_summary', label: 'Resumen diario de cobros', roles: ['collector', 'admin'] },
  { key: 'settlements', label: 'Liquidaciones pendientes de aprobación', roles: ['admin', 'partner'] },
];

export function notificationOptionsFor(role: AppRole) {
  return NOTIFICATION_OPTIONS.filter((o) => o.roles.includes(role));
}
