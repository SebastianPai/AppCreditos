'use client';
import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/errors';

type Action = (state: ActionResult, formData: FormData) => Promise<ActionResult>;

export function SubmitButton({ children, variant = 'primary', className = '' }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'danger'; className?: string }) {
  const { pending } = useFormStatus();
  const cls = variant === 'danger' ? 'btn-danger' : variant === 'secondary' ? 'btn-secondary' : 'btn-primary';
  return (
    <button type="submit" disabled={pending} className={`${cls} ${className}`}>
      {pending ? 'Procesando…' : children}
    </button>
  );
}

/**
 * Formulario conectado a una Server Action. Muestra errores del servidor y,
 * opcionalmente, pide confirmación antes de enviar (sin diálogos nativos).
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  variant,
  confirmText,
  className = 'space-y-3',
  resetOnSuccess = false,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  variant?: 'primary' | 'secondary' | 'danger';
  confirmText?: string;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, { ok: true } as ActionResult);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && 'message' in state && state.message && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {confirmText && (
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" required className="mt-1 size-4" /> <span>{confirmText}</span>
        </label>
      )}
      <SubmitButton variant={variant}>{submitLabel}</SubmitButton>
      {!state.ok && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && 'message' in state && state.message && (
        <p className="text-sm text-slate-800" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
