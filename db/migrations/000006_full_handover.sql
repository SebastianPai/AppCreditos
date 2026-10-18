-- =============================================================================
-- CAPITAL CONTROL — 0006: la entrega de efectivo del cobrador es siempre por el TOTAL
-- en su poder (sin entregas parciales), y queda registrado quién la hizo y quién la confirmó.
-- =============================================================================

create or replace function public.declare_cash_handover(p_amount bigint, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_custody bigint; v_pending bigint; v_available bigint; v_id uuid;
begin
  perform public._require_role('collector');
  perform pg_advisory_xact_lock(hashtext('handover:' || auth.uid()));
  v_custody := public._balance('COLLECTOR_CASH:' || auth.uid());
  select coalesce(sum(amount), 0) into v_pending from public.cash_handovers where collector_id = auth.uid() and status = 'pending';
  v_available := v_custody - v_pending;
  if v_available <= 0 then
    raise exception 'INVALID_AMOUNT: no tiene efectivo pendiente de entregar';
  end if;
  if p_amount is distinct from v_available then
    raise exception 'INVALID_AMOUNT: debe entregar el total del efectivo en su poder (%)', v_available;
  end if;
  insert into public.cash_handovers (collector_id, amount, notes) values (auth.uid(), v_available, p_notes) returning id into v_id;
  return v_id;
end $$;

alter function public.declare_cash_handover(bigint, text) set application_name = 'capital_control_system';

-- Nombre visible de quien registró una operación. Solo revela nombres del personal
-- (administración, cobradores, socios), nunca de clientes, y solo a usuarios autenticados.
create or replace function public.staff_name(p_user_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select full_name from public.profiles
  where id = p_user_id and role in ('admin', 'collector', 'partner') and auth.uid() is not null
$$;
alter function public.staff_name(uuid) set application_name = 'capital_control_system';
