-- =============================================================================
-- CAPITAL CONTROL — 0007: créditos simples
-- * Solo 4 o 5 cuotas: nueva versión de la política (mínimo 4, máximo 5).
-- * Los cobradores pueden crear, aprobar y rechazar créditos de SUS clientes
--   (ajuste operations.collectors_can_approve_loans, activado por defecto).
-- =============================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

alter table public.loan_policies add column if not exists min_installments integer not null default 1;
alter table public.loan_policies add constraint loan_policies_min_installments_chk
  check (min_installments >= 1 and min_installments <= max_installments);

-- Nueva versión de la política: iguales tasas, cuotas 4 o 5 (aplica a créditos nuevos).
insert into public.loan_policies (version, interest_bps, collector_commission_bps, partners_bps, max_installments, min_installments,
                                  biweekly_min_principal, min_principal, max_principal, status, notes)
select (select max(version) + 1 from public.loan_policies), interest_bps, collector_commission_bps, partners_bps, 5, 4,
       biweekly_min_principal, min_principal, max_principal, 'draft', 'Solo 4 o 5 cuotas.'
from public.loan_policies where status = 'active';
update public.loan_policies set status = 'retired' where status = 'active';
update public.loan_policies set status = 'active', activated_at = now() where status = 'draft' and notes = 'Solo 4 o 5 cuotas.';

update public.app_settings set value = value || '{"collectors_can_approve_loans": true}'::jsonb where key = 'operations';

create or replace function public._validate_terms(p_principal bigint, p_n integer, p_frequency public.loan_frequency,
                                                  p_policy public.loan_policies)
returns void language plpgsql immutable as $$
begin
  if p_policy.id is null then raise exception 'POLICY_MISSING: no hay una política de préstamo activa'; end if;
  if p_principal is null or p_principal < p_policy.min_principal then
    raise exception 'INVALID_TERMS: el capital mínimo es %', p_policy.min_principal; end if;
  if p_policy.max_principal is not null and p_principal > p_policy.max_principal then
    raise exception 'INVALID_TERMS: el capital máximo es %', p_policy.max_principal; end if;
  if p_n is null or p_n < p_policy.min_installments or p_n > p_policy.max_installments then
    raise exception 'INVALID_TERMS: el número de cuotas debe estar entre % y %', p_policy.min_installments, p_policy.max_installments; end if;
  if not (p_frequency = any (public.allowed_frequencies(p_principal, p_policy))) then
    raise exception 'INVALID_TERMS: para importes inferiores a % solo se permite la modalidad semanal', p_policy.biweekly_min_principal; end if;
end $$;

create or replace function public.get_active_policy()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', id, 'version', version, 'interest_bps', interest_bps, 'max_installments', max_installments,
    'min_installments', min_installments,
    'biweekly_min_principal', biweekly_min_principal, 'min_principal', min_principal, 'max_principal', max_principal,
    'weekly_interval_days', weekly_interval_days, 'biweekly_interval_days', biweekly_interval_days,
    'collector_commission_bps', case when public.is_admin() then collector_commission_bps end,
    'partners_bps', case when public.is_admin() then partners_bps end)
  from public.loan_policies where status = 'active'
$$;

drop function if exists public.create_loan_policy(integer, integer, integer, integer, bigint, bigint, bigint, text);
create or replace function public.create_loan_policy(p_interest_bps integer, p_collector_bps integer, p_partners_bps integer,
                                                     p_max_installments integer, p_biweekly_min bigint, p_min_principal bigint,
                                                     p_max_principal bigint, p_notes text, p_min_installments integer default 1)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform public._require_role('admin');
  insert into public.loan_policies (version, interest_bps, collector_commission_bps, partners_bps, max_installments, min_installments,
                                    biweekly_min_principal, min_principal, max_principal, notes, created_by)
  values ((select coalesce(max(version), 0) + 1 from public.loan_policies), p_interest_bps, p_collector_bps, p_partners_bps,
          p_max_installments, p_min_installments, p_biweekly_min, p_min_principal, p_max_principal, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public._collector_can_approve(p_customer_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value ->> 'collectors_can_approve_loans')::boolean from public.app_settings where key = 'operations'), false)
     and exists (select 1 from public.customers where id = p_customer_id and collector_id = auth.uid())
$$;

create or replace function public.create_application(p_principal bigint, p_installments integer, p_frequency public.loan_frequency,
                                                     p_start_date date, p_simulation_id uuid default null,
                                                     p_customer_id uuid default null, p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'customer', 'collector');
  v_customer uuid := case when v_role = 'customer' then public.my_customer_id() else p_customer_id end;
  v_policy public.loan_policies := public.active_loan_policy();
  v_sim public.loan_simulations;
  v_id uuid;
begin
  if v_customer is null then raise exception 'NOT_FOUND: cliente no identificado'; end if;
  if v_role = 'collector' and not public._collector_can_approve(v_customer) then
    raise exception 'FORBIDDEN: no puede crear créditos para este cliente' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers where id = v_customer and status = 'active') then
    raise exception 'INVALID: el cliente no está activo';
  end if;
  if exists (select 1 from public.loan_applications where customer_id = v_customer
             and status in ('pending', 'info_requested', 'counter_offered', 'accepted_by_customer')) then
    raise exception 'OPEN_APPLICATION: ya existe una solicitud en trámite para este cliente';
  end if;
  if p_start_date < public.today_bogota() then raise exception 'INVALID_TERMS: la fecha de inicio no puede ser pasada'; end if;
  perform public._validate_terms(p_principal, p_installments, p_frequency, v_policy);
  if p_simulation_id is not null then
    select * into v_sim from public.loan_simulations where id = p_simulation_id;
    if v_sim.id is null or (v_sim.customer_id is not null and v_sim.customer_id <> v_customer) then
      raise exception 'INVALID: simulación no válida para este cliente';
    end if;
  else
    insert into public.loan_simulations (customer_id, created_by, policy_id, principal, installments_count, frequency, start_date,
                                         interest_bps, interest_total, total_amount, schedule, effective_annual_rate)
    select v_customer, auth.uid(), v_policy.id, p_principal, p_installments, p_frequency, p_start_date, v_policy.interest_bps,
           (t ->> 'interest_total')::bigint, (t ->> 'total_amount')::bigint, t -> 'schedule', (t ->> 'effective_annual_rate')::numeric
    from public._terms(p_principal, p_installments, p_frequency, p_start_date, v_policy) t
    returning id into p_simulation_id;
  end if;
  insert into public.loan_applications (customer_id, simulation_id, requested_principal, requested_installments, requested_frequency,
                                        requested_start_date, customer_message, submitted_by)
  values (v_customer, p_simulation_id, p_principal, p_installments, p_frequency, p_start_date, p_message, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.review_application(p_application_id uuid, p_action text, p_notes text,
                                                     p_principal bigint default null, p_installments integer default null,
                                                     p_frequency public.loan_frequency default null, p_start_date date default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.loan_applications; v_role public.app_role := public._require_role('admin', 'collector');
begin
  select * into a from public.loan_applications where id = p_application_id for update;
  if a.id is null then raise exception 'NOT_FOUND: solicitud inexistente'; end if;
  if v_role = 'collector' and (p_action = 'counter_offer' or not public._collector_can_approve(a.customer_id)) then
    raise exception 'FORBIDDEN: no puede gestionar esta solicitud' using errcode = '42501';
  end if;
  if a.status not in ('pending', 'info_requested', 'accepted_by_customer', 'counter_offered') then
    raise exception 'INVALID_STATE: la solicitud está %', a.status;
  end if;
  case p_action
    when 'reject' then
      update public.loan_applications set status = 'rejected', admin_notes = p_notes, decided_by = auth.uid(), decided_at = now(), updated_at = now()
      where id = a.id;
    when 'request_info' then
      update public.loan_applications set status = 'info_requested', admin_notes = p_notes, updated_at = now() where id = a.id;
    when 'counter_offer' then
      perform public._validate_terms(p_principal, p_installments, p_frequency, public.active_loan_policy());
      if p_start_date is null or p_start_date < public.today_bogota() then raise exception 'INVALID_TERMS: fecha de inicio no válida'; end if;
      update public.loan_applications set status = 'counter_offered', admin_notes = p_notes, proposed_principal = p_principal,
             proposed_installments = p_installments, proposed_frequency = p_frequency, proposed_start_date = p_start_date,
             customer_response_at = null, updated_at = now()
      where id = a.id;
    else raise exception 'INVALID: acción desconocida';
  end case;
end $$;

create or replace function public.approve_application(p_application_id uuid, p_collector_id uuid, p_principal bigint,
                                                      p_installments integer, p_frequency public.loan_frequency, p_start_date date)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'collector');
  a public.loan_applications;
  v_policy public.loan_policies := public.active_loan_policy();
  v_terms jsonb;
  v_loan uuid;
  v_collector uuid := p_collector_id;
  r jsonb;
begin
  select * into a from public.loan_applications where id = p_application_id for update;
  if a.id is null then raise exception 'NOT_FOUND: solicitud inexistente'; end if;
  if v_role = 'collector' then
    if not public._collector_can_approve(a.customer_id) then
      raise exception 'FORBIDDEN: no puede aprobar créditos de este cliente' using errcode = '42501';
    end if;
    v_collector := auth.uid();  -- el crédito queda a cargo de quien lo aprueba
  end if;
  if a.status = 'accepted_by_customer' then
    if (p_principal, p_installments, p_frequency, p_start_date) is distinct from
       (a.proposed_principal, a.proposed_installments, a.proposed_frequency, a.proposed_start_date) then
      raise exception 'TERMS_MISMATCH: las condiciones no coinciden con la contraoferta aceptada';
    end if;
  elsif a.status in ('pending', 'info_requested') then
    if (p_principal, p_installments, p_frequency, p_start_date) is distinct from
       (a.requested_principal, a.requested_installments, a.requested_frequency, a.requested_start_date) then
      raise exception 'TERMS_MISMATCH: para cambiar las condiciones envíe una contraoferta y espere la aceptación del cliente';
    end if;
  else
    raise exception 'INVALID_STATE: la solicitud está %', a.status;
  end if;
  if p_start_date < public.today_bogota() then raise exception 'INVALID_TERMS: la fecha de inicio no puede ser pasada'; end if;
  if not exists (select 1 from public.profiles where id = v_collector and role = 'collector' and active) then
    raise exception 'INVALID_COLLECTOR: el cobrador no existe o está inactivo';
  end if;
  v_terms := public._terms(p_principal, p_installments, p_frequency, p_start_date, v_policy);
  perform public._assert_compliance((v_terms ->> 'effective_annual_rate')::numeric);

  insert into public.loans (customer_id, application_id, collector_id, policy_id, principal, interest_bps, interest_total, total_amount,
                            collector_commission_bps, collector_commission_total, partners_pool_total, installments_count,
                            frequency, start_date, effective_annual_rate, approved_by)
  values (a.customer_id, a.id, v_collector, v_policy.id, p_principal, v_policy.interest_bps,
          (v_terms ->> 'interest_total')::bigint, (v_terms ->> 'total_amount')::bigint, v_policy.collector_commission_bps,
          (v_terms ->> 'collector_commission_total')::bigint, (v_terms ->> 'partners_pool_total')::bigint,
          p_installments, p_frequency, p_start_date, (v_terms ->> 'effective_annual_rate')::numeric, auth.uid())
  returning id into v_loan;
  for r in select * from jsonb_array_elements(v_terms -> 'schedule') loop
    insert into public.loan_installments (loan_id, number, due_date, principal_amount, interest_amount, total_amount)
    values (v_loan, (r ->> 'number')::int, (r ->> 'due_date')::date, (r ->> 'principal')::bigint,
            (r ->> 'interest')::bigint, (r ->> 'total')::bigint);
  end loop;
  update public.loan_applications set status = 'approved', decided_by = auth.uid(), decided_at = now(), updated_at = now()
  where id = a.id;
  update public.customers set collector_id = v_collector where id = a.customer_id and collector_id is null;
  return v_loan;
end $$;

create or replace function public.update_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if p_key not in ('compliance', 'company', 'payment_instructions', 'operations') then
    raise exception 'INVALID: clave de configuración desconocida';
  end if;
  if p_key = 'compliance' then
    if coalesce(p_value ->> 'mode', 'enforce') not in ('enforce', 'demo') then
      raise exception 'INVALID: modo de cumplimiento desconocido'; end if;
    if jsonb_typeof(p_value -> 'legal_review_completed') <> 'boolean' then
      raise exception 'INVALID: legal_review_completed debe ser booleano'; end if;
    if (p_value ->> 'legal_review_completed')::boolean and coalesce(trim(p_value ->> 'legal_review_reference'), '') = '' then
      raise exception 'INVALID: indique la referencia del concepto legal'; end if;
    if p_value ->> 'usury_rate_ea_percent' is not null and (p_value ->> 'usury_rate_ea_percent')::numeric <= 0 then
      raise exception 'INVALID: tasa de usura no válida'; end if;
  end if;
  if p_key = 'operations' and (jsonb_typeof(p_value -> 'collectors_can_create_customers') <> 'boolean'
     or coalesce(jsonb_typeof(p_value -> 'collectors_can_approve_loans'), 'boolean') <> 'boolean') then
    raise exception 'INVALID: valor no válido';
  end if;
  insert into public.app_settings (key, value, updated_by, updated_at) values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef loop
    execute format('alter function %s set application_name = %L', f.sig, 'capital_control_system');
  end loop;
end $$;
