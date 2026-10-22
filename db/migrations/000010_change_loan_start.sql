-- =============================================================================
-- CAPITAL CONTROL — 0010: corregir la fecha de inicio de un préstamo desembolsado
-- admin_change_loan_start mueve la fecha de inicio de un préstamo activo y
-- recalcula los vencimientos (mismo cálculo que el desembolso; los importes no
-- cambian). Caso típico: se registró con fecha de ayer y el dinero se entregó hoy.
-- * Solo administradores y solo si el préstamo no tiene ningún pago (ni reversado).
-- * La fecha no puede ser futura.
-- * El asiento contable del desembolso no se toca (es inmutable).
-- * Queda registrado en la auditoría con la fecha anterior y la nueva.
-- =============================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create or replace function public._rescheduling() returns boolean language sql stable as $$
  select coalesce(current_setting('app.reschedule_loan', true), '') = 'on'
$$;

create or replace function public._guard_loan_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if public._purging() then return old; end if;
    raise exception 'IMMUTABLE: los préstamos no se borran; cancélelos' using errcode = '42501';
  end if;
  if (new.customer_id, new.principal, new.interest_bps, new.interest_total, new.total_amount,
      new.collector_commission_bps, new.collector_commission_total, new.partners_pool_total,
      new.installments_count, new.frequency, new.policy_id, new.approved_by, new.approved_at)
     is distinct from
     (old.customer_id, old.principal, old.interest_bps, old.interest_total, old.total_amount,
      old.collector_commission_bps, old.collector_commission_total, old.partners_pool_total,
      old.installments_count, old.frequency, old.policy_id, old.approved_by, old.approved_at) then
    raise exception 'IMMUTABLE: las condiciones contractuales de un préstamo aprobado no se modifican' using errcode = '42501';
  end if;
  if new.start_date <> old.start_date and old.status <> 'approved' and not public._rescheduling() then
    raise exception 'IMMUTABLE: la fecha de inicio solo cambia antes del desembolso' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public._guard_installment_update()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status public.loan_status;
begin
  if tg_op = 'DELETE' then
    if public._purging() then return old; end if;
    raise exception 'IMMUTABLE: las cuotas no se borran' using errcode = '42501';
  end if;
  if (new.loan_id, new.number, new.principal_amount, new.interest_amount, new.total_amount)
     is distinct from (old.loan_id, old.number, old.principal_amount, old.interest_amount, old.total_amount) then
    raise exception 'IMMUTABLE: el importe contractual de una cuota no se modifica' using errcode = '42501';
  end if;
  if new.due_date <> old.due_date and not public._rescheduling() then
    select status into v_status from public.loans where id = new.loan_id;
    if v_status <> 'approved' then
      raise exception 'IMMUTABLE: el vencimiento solo cambia antes del desembolso' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public.admin_change_loan_start(p_loan_id uuid, p_start_date date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l public.loans;
  v_policy public.loan_policies;
  v_schedule jsonb;
  r jsonb;
begin
  perform public._require_role('admin');
  select * into l from public.loans where id = p_loan_id for update;
  if l.id is null then raise exception 'NOT_FOUND: préstamo inexistente'; end if;
  if l.status <> 'active' then raise exception 'INVALID_STATE: el préstamo está %', l.status; end if;
  if p_start_date is null then raise exception 'INVALID: indique la nueva fecha de inicio'; end if;
  if p_start_date > public.today_bogota() then raise exception 'INVALID: la fecha de inicio no puede ser futura'; end if;
  if p_start_date = l.start_date then raise exception 'INVALID: el préstamo ya inicia en esa fecha'; end if;
  if exists (select 1 from public.payments where loan_id = l.id)
     or exists (select 1 from public.loan_installments where loan_id = l.id and paid_principal + paid_interest > 0) then
    raise exception 'INVALID_STATE: el préstamo ya tiene pagos; su fecha de inicio no se puede cambiar';
  end if;

  select * into v_policy from public.loan_policies where id = l.policy_id;
  v_schedule := public.build_schedule(l.principal, l.installments_count, l.frequency, p_start_date, v_policy);
  perform public._assert_compliance(public.effective_annual_rate(l.principal, p_start_date, v_schedule));

  perform set_config('app.reschedule_loan', 'on', true);
  update public.loans set start_date = p_start_date where id = l.id;
  for r in select * from jsonb_array_elements(v_schedule) loop
    update public.loan_installments
       set due_date = (r ->> 'due_date')::date,
           status = case when (r ->> 'due_date')::date < public.today_bogota() then 'overdue' else 'pending' end::public.installment_status
     where loan_id = l.id and number = (r ->> 'number')::int;
  end loop;
  perform set_config('app.reschedule_loan', '', true);

  perform public._audit('change_loan_start', 'loans', l.id::text,
    jsonb_build_object('code', l.code, 'from', l.start_date, 'to', p_start_date));
  return jsonb_build_object('from', l.start_date, 'to', p_start_date);
end $$;

alter function public.admin_change_loan_start(uuid, date) set application_name = 'capital_control_system';
alter function public._guard_installment_update() set application_name = 'capital_control_system';
