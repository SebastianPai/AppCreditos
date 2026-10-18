-- =============================================================================
-- CAPITAL CONTROL — 0003: operaciones de negocio (RPC)
-- Todas las escrituras financieras pasan por estas funciones SECURITY DEFINER,
-- que verifican rol y propiedad en el servidor y ejecutan cada operación en una
-- única transacción de base de datos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Vistas de lectura (security_invoker: respetan RLS del usuario que consulta)
-- ---------------------------------------------------------------------------
create or replace function public.installment_effective_status(p_status public.installment_status, p_due date,
                                                                p_paid bigint, p_total bigint)
returns public.installment_status language sql stable as $$
  select case
    when p_status = 'in_review' then 'in_review'::public.installment_status
    when p_paid >= p_total then 'paid'
    when p_due < public.today_bogota() then 'overdue'
    when p_paid > 0 then 'partial'
    else 'pending' end
$$;

create view public.v_installments with (security_invoker = true) as
select i.*,
       i.paid_principal + i.paid_interest as paid_total,
       i.total_amount - i.paid_principal - i.paid_interest as outstanding,
       public.installment_effective_status(i.status, i.due_date, i.paid_principal + i.paid_interest, i.total_amount) as effective_status,
       l.code as loan_code, l.customer_id, l.collector_id, l.status as loan_status
from public.loan_installments i
join public.loans l on l.id = i.loan_id;

create view public.v_loan_balances with (security_invoker = true) as
select l.id, l.code, l.customer_id, l.collector_id, l.status, l.frequency, l.installments_count,
       l.principal, l.interest_total, l.total_amount, l.start_date, l.disbursed_at, l.created_at,
       coalesce(sum(i.paid_principal + i.paid_interest), 0)::bigint as paid_total,
       coalesce(sum(i.paid_principal), 0)::bigint as paid_principal,
       coalesce(sum(i.paid_interest), 0)::bigint as paid_interest,
       (l.total_amount - coalesce(sum(i.paid_principal + i.paid_interest), 0))::bigint as outstanding,
       coalesce(sum(i.total_amount - i.paid_principal - i.paid_interest)
                filter (where i.due_date < public.today_bogota()), 0)::bigint as overdue_amount,
       min(i.due_date) filter (where i.paid_principal + i.paid_interest < i.total_amount) as next_due_date,
       count(*) filter (where i.paid_principal + i.paid_interest >= i.total_amount)::int as installments_paid
from public.loans l
left join public.loan_installments i on i.loan_id = l.id
group by l.id;

create view public.v_customers with (security_invoker = true) as
select c.id, c.code, c.full_name, c.document_type, public._mask(c.document_number) as document_masked,
       c.phone, c.status, c.collector_id, c.profile_id, c.registered_at,
       coalesce(sum(b.outstanding) filter (where b.status = 'active'), 0)::bigint as outstanding,
       count(b.id) filter (where b.status = 'active')::int as active_loans,
       min(b.next_due_date) filter (where b.status = 'active') as next_due_date
from public.customers c
left join public.v_loan_balances b on b.customer_id = c.id
group by c.id;

-- ---------------------------------------------------------------------------
-- Política y simulación
-- ---------------------------------------------------------------------------
create or replace function public.get_active_policy()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', id, 'version', version, 'interest_bps', interest_bps, 'max_installments', max_installments,
    'biweekly_min_principal', biweekly_min_principal, 'min_principal', min_principal, 'max_principal', max_principal,
    'weekly_interval_days', weekly_interval_days, 'biweekly_interval_days', biweekly_interval_days,
    'collector_commission_bps', case when public.is_admin() then collector_commission_bps end,
    'partners_bps', case when public.is_admin() then partners_bps end)
  from public.loan_policies where status = 'active'
$$;

create or replace function public._terms(p_principal bigint, p_n integer, p_frequency public.loan_frequency, p_start date,
                                         p_policy public.loan_policies)
returns jsonb language plpgsql stable as $$
declare
  v_schedule jsonb;
  v_interest bigint;
  v_commission bigint;
begin
  perform public._validate_terms(p_principal, p_n, p_frequency, p_policy);
  v_schedule := public.build_schedule(p_principal, p_n, p_frequency, p_start, p_policy);
  v_interest := public.round_bps(p_principal, p_policy.interest_bps);
  v_commission := public.round_bps(p_principal, p_policy.collector_commission_bps);
  return jsonb_build_object(
    'principal', p_principal, 'installments_count', p_n, 'frequency', p_frequency, 'start_date', p_start,
    'interest_bps', p_policy.interest_bps, 'interest_total', v_interest, 'total_amount', p_principal + v_interest,
    'collector_commission_total', v_commission, 'partners_pool_total', v_interest - v_commission,
    'schedule', v_schedule,
    'effective_annual_rate', public.effective_annual_rate(p_principal, p_start, v_schedule),
    'allowed_frequencies', to_jsonb(public.allowed_frequencies(p_principal, p_policy)));
end $$;

-- Simula y guarda el informe. No crea deuda ni reserva capital.
create or replace function public.simulate_loan(p_principal bigint, p_installments integer,
                                                p_frequency public.loan_frequency, p_start_date date default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_policy public.loan_policies := public.active_loan_policy();
  v_start date := coalesce(p_start_date, public.today_bogota());
  v_terms jsonb;
  v_id uuid;
  v_customer uuid := public.my_customer_id();
begin
  if auth.uid() is null then raise exception 'FORBIDDEN: inicie sesión para simular' using errcode = '42501'; end if;
  if v_start < public.today_bogota() then raise exception 'INVALID_TERMS: la fecha de inicio no puede ser pasada'; end if;
  if v_start > public.today_bogota() + 90 then raise exception 'INVALID_TERMS: la fecha de inicio supera 90 días'; end if;
  v_terms := public._terms(p_principal, p_installments, p_frequency, v_start, v_policy);
  insert into public.loan_simulations (customer_id, created_by, policy_id, principal, installments_count, frequency, start_date,
                                       interest_bps, interest_total, total_amount, schedule, effective_annual_rate)
  values (v_customer, auth.uid(), v_policy.id, p_principal, p_installments, p_frequency, v_start,
          v_policy.interest_bps, (v_terms ->> 'interest_total')::bigint, (v_terms ->> 'total_amount')::bigint,
          v_terms -> 'schedule', (v_terms ->> 'effective_annual_rate')::numeric)
  returning id into v_id;
  return (v_terms - 'collector_commission_total' - 'partners_pool_total')
         || jsonb_build_object('id', v_id, 'created_at', now(), 'customer_id', v_customer);
end $$;

create or replace function public.get_simulation(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.loan_simulations; v_customer jsonb;
begin
  select * into s from public.loan_simulations where id = p_id;
  if s.id is null then return null; end if;
  if not (public.is_admin()
          or (s.customer_id is null and s.created_by is null)
          or s.created_by = auth.uid()
          or (s.customer_id is not null and s.customer_id = public.my_customer_id())) then
    raise exception 'FORBIDDEN: simulación no disponible' using errcode = '42501';
  end if;
  select jsonb_build_object('code', c.code, 'full_name', c.full_name) into v_customer from public.customers c where c.id = s.customer_id;
  return jsonb_build_object(
    'id', s.id, 'created_at', s.created_at, 'customer', v_customer, 'principal', s.principal,
    'installments_count', s.installments_count, 'frequency', s.frequency, 'start_date', s.start_date,
    'interest_bps', s.interest_bps, 'interest_total', s.interest_total, 'total_amount', s.total_amount,
    'schedule', s.schedule, 'effective_annual_rate', s.effective_annual_rate);
end $$;

-- ---------------------------------------------------------------------------
-- Clientes y usuarios
-- ---------------------------------------------------------------------------
create or replace function public.create_customer(p_full_name text, p_document_type text, p_document_number text,
                                                  p_phone text, p_address text default null, p_collector_id uuid default null,
                                                  p_notes text default null, p_data_consent boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_doc text := upper(regexp_replace(coalesce(p_document_number, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  perform public._require_role('admin');
  if not p_data_consent then
    raise exception 'CONSENT_REQUIRED: se requiere la autorización de tratamiento de datos personales';
  end if;
  if exists (select 1 from public.customers where document_type = p_document_type and document_number = v_doc) then
    raise exception 'DUPLICATE_CUSTOMER: ya existe un cliente con ese documento';
  end if;
  if p_collector_id is not null and not exists (select 1 from public.profiles where id = p_collector_id and role = 'collector' and active) then
    raise exception 'INVALID_COLLECTOR: el cobrador no existe o está inactivo';
  end if;
  insert into public.customers (full_name, document_type, document_number, phone, address, collector_id, notes, data_consent_at, created_by)
  values (trim(p_full_name), p_document_type, v_doc, regexp_replace(trim(p_phone), '\s+', ' ', 'g'), p_address, p_collector_id, p_notes, now(), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_customer(p_customer_id uuid, p_full_name text, p_phone text, p_address text,
                                                  p_status public.customer_status, p_notes text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.customers set full_name = trim(p_full_name), phone = trim(p_phone), address = p_address,
         status = p_status, notes = p_notes where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: cliente inexistente'; end if;
end $$;

create or replace function public.assign_collector(p_customer_id uuid, p_collector_id uuid, p_include_loans boolean default true)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if not exists (select 1 from public.profiles where id = p_collector_id and role = 'collector' and active) then
    raise exception 'INVALID_COLLECTOR: el cobrador no existe o está inactivo';
  end if;
  update public.customers set collector_id = p_collector_id where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: cliente inexistente'; end if;
  if p_include_loans then
    update public.loans set collector_id = p_collector_id where customer_id = p_customer_id and status in ('approved', 'active');
  end if;
end $$;

-- Alta de usuarios por un administrador. La contraseña llega ya cifrada (scrypt)
-- desde el servidor y es temporal: el usuario debe cambiarla al primer ingreso.
create or replace function public.admin_create_user(p_email text, p_password_hash text, p_full_name text, p_phone text,
                                                    p_role public.app_role, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_email text := lower(trim(p_email));
begin
  perform public._require_role('admin');
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'DUPLICATE_USER: ya existe una cuenta con ese correo';
  end if;
  if p_customer_id is not null and p_role <> 'customer' then
    raise exception 'INVALID: solo un cliente se vincula a una ficha de cliente';
  end if;
  if p_role = 'customer' and p_customer_id is null then
    raise exception 'INVALID: seleccione la ficha del cliente';
  end if;
  if p_customer_id is not null and exists (select 1 from public.customers where id = p_customer_id and profile_id is not null) then
    raise exception 'INVALID: la ficha de cliente ya tiene una cuenta';
  end if;
  perform set_config('app.allow_admin_create', 'on', true);
  insert into auth.users (email, password_hash, must_change_password, raw_app_meta_data, raw_user_meta_data)
  values (v_email, p_password_hash, true,
          jsonb_strip_nulls(jsonb_build_object('role', p_role, 'customer_id', p_customer_id)),
          jsonb_strip_nulls(jsonb_build_object('full_name', trim(p_full_name), 'phone', nullif(trim(p_phone), ''))))
  returning id into v_id;
  perform set_config('app.allow_admin_create', '', true);
  perform public._audit('create_user', 'profiles', v_id::text, jsonb_build_object('role', p_role, 'customer_id', p_customer_id));
  return v_id;
end $$;

-- Restablece la contraseña (temporal) y cierra todas las sesiones del usuario.
create or replace function public.admin_reset_password(p_user_id uuid, p_password_hash text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update auth.users set password_hash = p_password_hash, must_change_password = true, failed_attempts = 0, locked_until = null
  where id = p_user_id;
  if not found then raise exception 'NOT_FOUND: usuario inexistente'; end if;
  delete from auth.sessions where user_id = p_user_id;
  perform public._audit('reset_password', 'profiles', p_user_id::text, null);
end $$;

create or replace function public.admin_update_profile(p_user_id uuid, p_role public.app_role, p_active boolean,
                                                       p_full_name text, p_phone text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if p_user_id = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'FORBIDDEN: un administrador no puede degradarse ni desactivarse a sí mismo';
  end if;
  if exists (select 1 from public.customers where profile_id = p_user_id) and p_role <> 'customer' then
    raise exception 'INVALID: la cuenta está vinculada a un cliente';
  end if;
  update public.profiles set role = p_role, active = p_active, full_name = trim(p_full_name), phone = p_phone, updated_at = now()
  where id = p_user_id;
  if not found then raise exception 'NOT_FOUND: usuario inexistente'; end if;
end $$;

create or replace function public.set_user_permission(p_user_id uuid, p_permission text, p_granted boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if p_granted then
    insert into public.user_permissions (user_id, permission_code, granted_by) values (p_user_id, p_permission, auth.uid())
    on conflict do nothing;
  else
    delete from public.user_permissions where user_id = p_user_id and permission_code = p_permission;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Configuración y políticas (auditadas por trigger)
-- ---------------------------------------------------------------------------
create or replace function public.update_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if p_key not in ('compliance', 'company', 'payment_instructions') then
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
  insert into public.app_settings (key, value, updated_by, updated_at) values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

create or replace function public.create_loan_policy(p_interest_bps integer, p_collector_bps integer, p_partners_bps integer,
                                                     p_max_installments integer, p_biweekly_min bigint, p_min_principal bigint,
                                                     p_max_principal bigint, p_notes text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform public._require_role('admin');
  insert into public.loan_policies (version, interest_bps, collector_commission_bps, partners_bps, max_installments,
                                    biweekly_min_principal, min_principal, max_principal, notes, created_by)
  values ((select coalesce(max(version), 0) + 1 from public.loan_policies), p_interest_bps, p_collector_bps, p_partners_bps,
          p_max_installments, p_biweekly_min, p_min_principal, p_max_principal, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Activa una versión: solo afecta préstamos aprobados a partir de ahora.
create or replace function public.activate_loan_policy(p_policy_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if not exists (select 1 from public.loan_policies where id = p_policy_id and status = 'draft') then
    raise exception 'INVALID: solo se activa una política en borrador';
  end if;
  update public.loan_policies set status = 'retired' where status = 'active';
  update public.loan_policies set status = 'active', activated_by = auth.uid(), activated_at = now() where id = p_policy_id;
end $$;

-- ---------------------------------------------------------------------------
-- Solicitudes de préstamo
-- ---------------------------------------------------------------------------
create or replace function public.create_application(p_principal bigint, p_installments integer, p_frequency public.loan_frequency,
                                                     p_start_date date, p_simulation_id uuid default null,
                                                     p_customer_id uuid default null, p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'customer');
  v_customer uuid := case when v_role = 'customer' then public.my_customer_id() else p_customer_id end;
  v_policy public.loan_policies := public.active_loan_policy();
  v_sim public.loan_simulations;
  v_id uuid;
begin
  if v_customer is null then raise exception 'NOT_FOUND: cliente no identificado'; end if;
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
declare a public.loan_applications;
begin
  perform public._require_role('admin');
  select * into a from public.loan_applications where id = p_application_id for update;
  if a.id is null then raise exception 'NOT_FOUND: solicitud inexistente'; end if;
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

create or replace function public.respond_application(p_application_id uuid, p_accept boolean, p_message text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.loan_applications;
begin
  perform public._require_role('customer');
  select * into a from public.loan_applications where id = p_application_id and customer_id = public.my_customer_id() for update;
  if a.id is null then raise exception 'NOT_FOUND: solicitud inexistente'; end if;
  if a.status = 'counter_offered' then
    update public.loan_applications set status = case when p_accept then 'accepted_by_customer' else 'cancelled' end::public.application_status,
           customer_message = coalesce(p_message, customer_message), customer_response_at = now(), updated_at = now()
    where id = a.id;
  elsif a.status = 'info_requested' then
    update public.loan_applications set status = case when p_accept then 'pending' else 'cancelled' end::public.application_status,
           customer_message = coalesce(p_message, customer_message), customer_response_at = now(), updated_at = now()
    where id = a.id;
  elsif a.status = 'pending' and not p_accept then
    update public.loan_applications set status = 'cancelled', updated_at = now() where id = a.id;
  else
    raise exception 'INVALID_STATE: la solicitud está %', a.status;
  end if;
end $$;

-- Aprueba y formaliza el préstamo (estado 'approved': capital comprometido, aún
-- sin desembolso). Si las condiciones difieren de las solicitadas, primero debe
-- enviarse una contraoferta y obtener la aceptación del cliente.
create or replace function public.approve_application(p_application_id uuid, p_collector_id uuid, p_principal bigint,
                                                      p_installments integer, p_frequency public.loan_frequency, p_start_date date)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.loan_applications;
  v_policy public.loan_policies := public.active_loan_policy();
  v_terms jsonb;
  v_loan uuid;
  r jsonb;
begin
  perform public._require_role('admin');
  select * into a from public.loan_applications where id = p_application_id for update;
  if a.id is null then raise exception 'NOT_FOUND: solicitud inexistente'; end if;
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
  if not exists (select 1 from public.profiles where id = p_collector_id and role = 'collector' and active) then
    raise exception 'INVALID_COLLECTOR: el cobrador no existe o está inactivo';
  end if;
  v_terms := public._terms(p_principal, p_installments, p_frequency, p_start_date, v_policy);
  perform public._assert_compliance((v_terms ->> 'effective_annual_rate')::numeric);

  insert into public.loans (customer_id, application_id, collector_id, policy_id, principal, interest_bps, interest_total, total_amount,
                            collector_commission_bps, collector_commission_total, partners_pool_total, installments_count,
                            frequency, start_date, effective_annual_rate, approved_by)
  values (a.customer_id, a.id, p_collector_id, v_policy.id, p_principal, v_policy.interest_bps,
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
  update public.customers set collector_id = p_collector_id where id = a.customer_id and collector_id is null;
  return v_loan;
end $$;

create or replace function public.cancel_loan(p_loan_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.loans set status = 'cancelled', cancelled_reason = p_reason where id = p_loan_id and status = 'approved';
  if not found then raise exception 'INVALID_STATE: solo se cancela un préstamo aprobado y no desembolsado'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Capital
-- ---------------------------------------------------------------------------
-- Definiciones (todas en COP, a la fecha):
--   cash_admin            saldo de CASH: dinero conciliado en caja/bancos de administración.
--   cash_collectors       efectivo recaudado que aún está en poder de cobradores (no disponible).
--   loans_principal       capital colocado: capital de préstamos desembolsados aún no recuperado.
--   committed             capital de préstamos aprobados pendientes de desembolso.
--   commission_payable    comisiones devengadas aún no pagadas a cobradores.
--   partner_profit_payable utilidades aprobadas en liquidaciones aún no pagadas.
--   unsettled_result      intereses cobrados − comisiones − gastos ± ajustes del periodo abierto
--                         (pertenece a los socios; se reserva hasta la liquidación).
--   available             cash_admin − commission_payable − partner_profit_payable
--                         − max(unsettled_result, 0) − committed.
create or replace function public._capital_summary()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cash bigint := public._balance('CASH');
  v_collectors bigint := public._balance('COLLECTOR_CASH:%');
  v_loans bigint := public._balance('LOANS_RECEIVABLE');
  v_capital bigint := -public._balance('PARTNER_CAPITAL:%');
  v_advances bigint := public._balance('PARTNER_ADVANCES:%');
  v_comm bigint := -public._balance('COMMISSION_PAYABLE:%');
  v_profit bigint := -public._balance('PARTNER_PROFIT_PAYABLE:%');
  v_result bigint := -(public._balance('INTEREST_INCOME') + public._balance('COMMISSION_EXPENSE')
                      + public._balance('OPERATING_EXPENSES') + public._balance('ADJUSTMENTS'));
  v_retained bigint := -public._balance('RETAINED_RESULT');
  v_committed bigint := (select coalesce(sum(principal), 0) from public.loans where status = 'approved');
begin
  return jsonb_build_object(
    'partner_capital', v_capital, 'cash_admin', v_cash, 'cash_collectors', v_collectors,
    'loans_principal', v_loans, 'committed', v_committed, 'commission_payable', v_comm,
    'partner_profit_payable', v_profit, 'partner_advances', v_advances, 'unsettled_result', v_result,
    'retained_result', v_retained,
    'available', v_cash - v_comm - v_profit - greatest(v_result, 0) - v_committed);
end $$;

create or replace function public.capital_summary()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin', 'partner');
  return public._capital_summary();
end $$;

create or replace function public.upsert_partner(p_id uuid, p_seq smallint, p_display_name text, p_share_bps integer,
                                                 p_profile_id uuid, p_active boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform public._require_role('admin');
  if p_profile_id is not null and not exists (select 1 from public.profiles where id = p_profile_id and role = 'partner') then
    raise exception 'INVALID: el usuario vinculado debe tener rol socio';
  end if;
  if p_id is null then
    insert into public.partners (seq, display_name, share_bps, profile_id, active)
    values (p_seq, p_display_name, p_share_bps, p_profile_id, p_active) returning id into v_id;
  else
    update public.partners set seq = p_seq, display_name = p_display_name, share_bps = p_share_bps,
           profile_id = p_profile_id, active = p_active where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.record_capital_movement(p_partner_id uuid, p_kind text, p_amount bigint,
                                                          p_occurred_on date, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tx uuid; v_id uuid; v_on date := coalesce(p_occurred_on, public.today_bogota());
begin
  perform public._require_role('admin');
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT: el importe debe ser positivo'; end if;
  if v_on > public.today_bogota() then raise exception 'INVALID: la fecha no puede ser futura'; end if;
  if not exists (select 1 from public.partners where id = p_partner_id) then raise exception 'NOT_FOUND: socio inexistente'; end if;
  perform pg_advisory_xact_lock(hashtext('capital'));
  if p_kind in ('withdrawal', 'advance') and (public._capital_summary() ->> 'available')::bigint < p_amount then
    raise exception 'INSUFFICIENT_CAPITAL: el capital disponible no alcanza';
  end if;
  if p_kind = 'withdrawal' and -public._balance('PARTNER_CAPITAL:' || p_partner_id) < p_amount then
    raise exception 'INSUFFICIENT_CAPITAL: el retiro supera el capital aportado por el socio';
  end if;
  v_tx := case p_kind
    when 'contribution' then public._post_tx('capital_contribution', 'Aporte de capital', v_on,
           jsonb_build_array(public._e(public._acc_cash(), p_amount), public._e(public._acc_partner_capital(p_partner_id), -p_amount)))
    when 'withdrawal' then public._post_tx('capital_withdrawal', 'Retiro de capital', v_on,
           jsonb_build_array(public._e(public._acc_partner_capital(p_partner_id), p_amount), public._e(public._acc_cash(), -p_amount)))
    when 'advance' then public._post_tx('partner_advance', 'Anticipo de utilidades', v_on,
           jsonb_build_array(public._e(public._acc_partner_advances(p_partner_id), p_amount), public._e(public._acc_cash(), -p_amount)))
  end;
  if v_tx is null then raise exception 'INVALID: tipo de movimiento desconocido'; end if;
  insert into public.capital_contributions (partner_id, kind, amount, occurred_on, notes, tx_id, created_by)
  values (p_partner_id, p_kind, p_amount, v_on, p_notes, v_tx, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.record_expense(p_amount bigint, p_category text, p_description text, p_occurred_on date)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tx uuid; v_id uuid; v_on date := coalesce(p_occurred_on, public.today_bogota());
begin
  perform public._require_role('admin');
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT: el importe debe ser positivo'; end if;
  if v_on > public.today_bogota() then raise exception 'INVALID: la fecha no puede ser futura'; end if;
  v_tx := public._post_tx('expense', 'Gasto: ' || p_category, v_on,
            jsonb_build_array(public._e(public._acc_expenses(), p_amount), public._e(public._acc_cash(), -p_amount)));
  insert into public.expenses (amount, category, description, occurred_on, tx_id, approved_by)
  values (p_amount, p_category, p_description, v_on, v_tx, auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- Ajuste autorizado de caja (sobrante > 0 / faltante < 0), siempre con motivo.
create or replace function public.record_adjustment(p_amount bigint, p_description text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  if p_amount = 0 or coalesce(length(trim(p_description)), 0) < 5 then raise exception 'INVALID: importe y motivo obligatorios'; end if;
  return public._post_tx('adjustment', 'Ajuste: ' || p_description, public.today_bogota(),
           jsonb_build_array(public._e(public._acc_cash(), p_amount), public._e(public._acc_adjustments(), -p_amount)));
end $$;

-- ---------------------------------------------------------------------------
-- Desembolso
-- ---------------------------------------------------------------------------
create or replace function public.disburse_loan(p_loan_id uuid, p_disbursed_on date default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l public.loans;
  v_on date := coalesce(p_disbursed_on, public.today_bogota());
  v_policy public.loan_policies;
  v_schedule jsonb;
  v_available bigint;
  v_tx uuid;
  r jsonb;
begin
  perform public._require_role('admin');
  perform pg_advisory_xact_lock(hashtext('capital'));
  select * into l from public.loans where id = p_loan_id for update;
  if l.id is null then raise exception 'NOT_FOUND: préstamo inexistente'; end if;
  if l.status <> 'approved' then raise exception 'INVALID_STATE: el préstamo está %', l.status; end if;
  if v_on > public.today_bogota() then raise exception 'INVALID: la fecha de desembolso no puede ser futura'; end if;
  select * into v_policy from public.loan_policies where id = l.policy_id;
  -- El calendario se fecha a partir del desembolso; los importes no cambian.
  v_schedule := public.build_schedule(l.principal, l.installments_count, l.frequency, v_on, v_policy);
  perform public._assert_compliance(public.effective_annual_rate(l.principal, v_on, v_schedule));
  v_available := (public._capital_summary() ->> 'available')::bigint + l.principal; -- excluye su propio compromiso
  if v_available < l.principal then
    raise exception 'INSUFFICIENT_CAPITAL: capital disponible % insuficiente para desembolsar %', v_available, l.principal;
  end if;
  update public.loans set start_date = v_on where id = l.id;
  for r in select * from jsonb_array_elements(v_schedule) loop
    update public.loan_installments set due_date = (r ->> 'due_date')::date where loan_id = l.id and number = (r ->> 'number')::int;
  end loop;
  v_tx := public._post_tx('disbursement', 'Desembolso préstamo ' || l.code, v_on,
            jsonb_build_array(public._e(public._acc_loans(), l.principal), public._e(public._acc_cash(), -l.principal)), l.id);
  update public.loans set status = 'active', disbursed_by = auth.uid(), disbursed_at = now(), disbursement_tx_id = v_tx where id = l.id;
  return v_tx;
end $$;

-- ---------------------------------------------------------------------------
-- Pagos
-- Política de asignación:
--   1. Se cubren las cuotas en orden (la más antigua primero); un abono mayor que
--      la cuota pendiente se traslada a las siguientes (pago anticipado). El
--      interés contractual no se reduce automáticamente por pago anticipado.
--   2. Dentro de cada cuota, el abono se reparte entre capital e interés en la
--      proporción de la cuota (acumulada), de modo que al completarla coincide
--      exactamente con su capital e interés contractual.
--   3. No se aceptan pagos superiores al saldo pendiente.
--   4. La comisión del cobrador se devenga en proporción al interés recaudado:
--      comisión_acumulada = floor(interés_recaudado × comisión_total / interés_total).
--   5. No hay intereses de mora automáticos: no existe una regla autorizada.
-- ---------------------------------------------------------------------------
create or replace function public._commission_accrued(p_interest_collected bigint, p_interest_total bigint, p_commission_total bigint)
returns bigint language sql immutable as $$
  select case when p_interest_total = 0 then 0
              else floor(p_interest_collected::numeric * p_commission_total / p_interest_total)::bigint end
$$;

create or replace function public._apply_payment(p_loan_id uuid, p_amount bigint, p_method public.payment_method_type,
                                                 p_custody text, p_received_by uuid, p_received_on date, p_idempotency_key text,
                                                 p_request_id uuid, p_evidence_path text, p_notes text)
returns public.payments language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l public.loans;
  i record;
  p public.payments;
  v_id uuid := gen_random_uuid();
  v_outstanding bigint;
  v_interest_before bigint;
  v_remaining bigint := p_amount;
  v_take bigint; v_new_paid bigint; v_cum_int bigint; v_di bigint; v_dp bigint;
  v_principal bigint := 0; v_interest bigint := 0; v_comm bigint;
  v_partial boolean := false;
  v_allocs jsonb := '[]'::jsonb;
  v_custody_acc uuid;
  v_tx uuid;
  a jsonb;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT: el importe debe ser un entero positivo'; end if;
  select * into l from public.loans where id = p_loan_id for update;
  if l.id is null then raise exception 'NOT_FOUND: préstamo inexistente'; end if;

  -- Idempotencia (comprobada con el préstamo bloqueado para serializar reintentos).
  select * into p from public.payments where idempotency_key = p_idempotency_key;
  if p.id is not null then
    if p.loan_id <> p_loan_id or p.amount <> p_amount then
      raise exception 'IDEMPOTENCY_CONFLICT: la clave ya se usó para otro pago';
    end if;
    return p;
  end if;

  if l.status <> 'active' then raise exception 'LOAN_NOT_ACTIVE: el préstamo está %', l.status; end if;
  select coalesce(sum(total_amount - paid_principal - paid_interest), 0), coalesce(sum(paid_interest), 0)
    into v_outstanding, v_interest_before from public.loan_installments where loan_id = l.id;
  if p_amount > v_outstanding then
    raise exception 'AMOUNT_EXCEEDS_BALANCE: el pago (%) supera el saldo pendiente (%)', p_amount, v_outstanding;
  end if;

  for i in select * from public.loan_installments where loan_id = l.id order by number for update loop
    exit when v_remaining = 0;
    v_take := least(i.total_amount - i.paid_principal - i.paid_interest, v_remaining);
    continue when v_take = 0;
    v_new_paid := i.paid_principal + i.paid_interest + v_take;
    v_cum_int := floor(v_new_paid::numeric * i.interest_amount / i.total_amount)::bigint;
    v_di := greatest(0, least(v_cum_int - i.paid_interest, i.interest_amount - i.paid_interest, v_take));
    v_dp := v_take - v_di;
    if v_dp > i.principal_amount - i.paid_principal then
      v_dp := i.principal_amount - i.paid_principal;
      v_di := v_take - v_dp;
    end if;
    update public.loan_installments set
      paid_principal = paid_principal + v_dp,
      paid_interest = paid_interest + v_di,
      status = case when v_new_paid = total_amount then 'paid'
                    when status = 'in_review' then 'in_review'
                    when due_date < public.today_bogota() then 'overdue'
                    else 'partial' end::public.installment_status,
      paid_at = case when v_new_paid = total_amount then now() else null end
    where id = i.id;
    if v_new_paid < i.total_amount then v_partial := true; end if;
    v_allocs := v_allocs || jsonb_build_object('installment_id', i.id, 'principal', v_dp, 'interest', v_di);
    v_principal := v_principal + v_dp;
    v_interest := v_interest + v_di;
    v_remaining := v_remaining - v_take;
  end loop;

  v_comm := public._commission_accrued(v_interest_before + v_interest, l.interest_total, l.collector_commission_total)
          - public._commission_accrued(v_interest_before, l.interest_total, l.collector_commission_total);
  v_custody_acc := case p_custody when 'collector' then public._acc_collector_cash(l.collector_id) else public._acc_cash() end;
  v_tx := public._post_tx('payment', 'Pago préstamo ' || l.code, p_received_on,
            jsonb_build_array(
              public._e(v_custody_acc, p_amount),
              public._e(public._acc_loans(), -v_principal),
              public._e(public._acc_interest(), -v_interest),
              public._e(public._acc_commission_expense(), v_comm),
              public._e(public._acc_commission_payable(l.collector_id), -v_comm)),
            l.id, v_id);

  insert into public.payments (id, loan_id, customer_id, collector_id, amount, principal_amount, interest_amount, commission_amount,
                               method, cash_custody, is_partial, idempotency_key, payment_request_id, received_by, received_on,
                               evidence_path, notes, tx_id)
  values (v_id, l.id, l.customer_id, l.collector_id, p_amount, v_principal, v_interest, v_comm, p_method, p_custody, v_partial,
          p_idempotency_key, p_request_id, p_received_by, p_received_on, p_evidence_path, p_notes, v_tx)
  returning * into p;
  for a in select * from jsonb_array_elements(v_allocs) loop
    insert into public.payment_allocations (payment_id, installment_id, kind, principal_amount, interest_amount)
    values (v_id, (a ->> 'installment_id')::uuid, 'payment', (a ->> 'principal')::bigint, (a ->> 'interest')::bigint);
  end loop;
  if v_comm > 0 then
    insert into public.collector_commissions (collector_id, loan_id, payment_id, kind, amount)
    values (l.collector_id, l.id, v_id, 'accrual', v_comm);
  end if;
  if v_outstanding - p_amount = 0 then
    update public.loans set status = 'paid', paid_at = now() where id = l.id;
  end if;
  return p;
end $$;

create or replace function public.register_payment(p_loan_id uuid, p_amount bigint, p_idempotency_key text,
                                                   p_method public.payment_method_type default 'cash',
                                                   p_received_on date default null, p_notes text default null,
                                                   p_evidence_path text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'collector');
  v_on date := coalesce(p_received_on, public.today_bogota());
  v_before int;
  p public.payments;
begin
  if v_role = 'collector' then
    if not exists (select 1 from public.loans where id = p_loan_id and collector_id = auth.uid()) then
      raise exception 'FORBIDDEN: el préstamo no está asignado a este cobrador' using errcode = '42501';
    end if;
    if p_method <> 'cash' then
      raise exception 'FORBIDDEN: las transferencias y pagos QR se registran como solicitud y los verifica administración';
    end if;
    if v_on <> public.today_bogota() then raise exception 'FORBIDDEN: el cobrador registra pagos con la fecha de hoy'; end if;
  elsif v_on > public.today_bogota() then
    raise exception 'INVALID: la fecha de pago no puede ser futura';
  end if;
  select count(*) into v_before from public.payments where idempotency_key = p_idempotency_key;
  p := public._apply_payment(p_loan_id, p_amount, p_method, case v_role when 'collector' then 'collector' else 'admin' end,
                             auth.uid(), v_on, p_idempotency_key, null, p_evidence_path, p_notes);
  return jsonb_build_object('payment_id', p.id, 'receipt_number', p.receipt_number, 'duplicate', v_before > 0,
                            'principal', p.principal_amount, 'interest', p.interest_amount, 'is_partial', p.is_partial);
end $$;

-- Reverso auditable: no borra; registra asignaciones y asientos opuestos con fecha de hoy.
create or replace function public.reverse_payment(p_payment_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.payments;
  l public.loans;
  a record;
  v_interest_before bigint;
  v_comm bigint;
  v_tx uuid;
  v_custody_acc uuid;
begin
  perform public._require_role('admin');
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'INVALID: indique el motivo del reverso'; end if;
  select * into p from public.payments where id = p_payment_id;
  if p.id is null then raise exception 'NOT_FOUND: pago inexistente'; end if;
  select * into l from public.loans where id = p.loan_id for update;
  select * into p from public.payments where id = p_payment_id for update;
  if p.status <> 'confirmed' then raise exception 'INVALID_STATE: el pago ya fue reversado'; end if;

  select coalesce(sum(paid_interest), 0) into v_interest_before from public.loan_installments where loan_id = l.id;
  for a in select * from public.payment_allocations where payment_id = p.id and kind = 'payment' loop
    update public.loan_installments set
      paid_principal = paid_principal - a.principal_amount,
      paid_interest = paid_interest - a.interest_amount,
      status = case when status = 'in_review' then 'in_review'
                    when paid_principal + paid_interest - a.principal_amount - a.interest_amount = 0 then
                      case when due_date < public.today_bogota() then 'overdue' else 'pending' end
                    when due_date < public.today_bogota() then 'overdue'
                    else 'partial' end::public.installment_status,
      paid_at = null
    where id = a.installment_id;
    insert into public.payment_allocations (payment_id, installment_id, kind, principal_amount, interest_amount)
    values (p.id, a.installment_id, 'reversal', -a.principal_amount, -a.interest_amount);
  end loop;

  v_comm := public._commission_accrued(v_interest_before, l.interest_total, l.collector_commission_total)
          - public._commission_accrued(v_interest_before - p.interest_amount, l.interest_total, l.collector_commission_total);
  v_custody_acc := case p.cash_custody when 'collector' then public._acc_collector_cash(p.collector_id) else public._acc_cash() end;
  v_tx := public._post_tx('payment_reversal', 'Reverso pago recibo ' || p.receipt_number || ': ' || p_reason, public.today_bogota(),
            jsonb_build_array(
              public._e(v_custody_acc, -p.amount),
              public._e(public._acc_loans(), p.principal_amount),
              public._e(public._acc_interest(), p.interest_amount),
              public._e(public._acc_commission_expense(), -v_comm),
              public._e(public._acc_commission_payable(p.collector_id), v_comm)),
            l.id, p.id, null, p.tx_id);
  if v_comm > 0 then
    insert into public.collector_commissions (collector_id, loan_id, payment_id, kind, amount)
    values (p.collector_id, l.id, p.id, 'reversal', -v_comm);
  end if;
  update public.payments set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(),
         reversal_reason = p_reason, reversal_tx_id = v_tx where id = p.id;
  if l.status = 'paid' then update public.loans set status = 'active', paid_at = null where id = l.id; end if;
  update public.reversal_requests set status = 'approved', decided_by = auth.uid(), decided_at = now()
  where payment_id = p.id and status = 'pending';
  return v_tx;
end $$;

create or replace function public.request_reversal(p_payment_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role public.app_role := public._require_role('admin', 'collector'); v_id uuid;
begin
  if not exists (select 1 from public.payments where id = p_payment_id and status = 'confirmed'
                 and (v_role = 'admin' or collector_id = auth.uid() or received_by = auth.uid())) then
    raise exception 'FORBIDDEN: pago no disponible para corrección' using errcode = '42501';
  end if;
  insert into public.reversal_requests (payment_id, requested_by, reason) values (p_payment_id, auth.uid(), p_reason)
  returning id into v_id;
  update public.loan_installments set status = 'in_review', review_note = 'Corrección solicitada: ' || left(p_reason, 200)
  where id in (select installment_id from public.payment_allocations where payment_id = p_payment_id);
  return v_id;
end $$;

create or replace function public.decide_reversal_request(p_request_id uuid, p_approve boolean, p_notes text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.reversal_requests;
begin
  perform public._require_role('admin');
  select * into r from public.reversal_requests where id = p_request_id and status = 'pending' for update;
  if r.id is null then raise exception 'NOT_FOUND: solicitud de corrección inexistente o resuelta'; end if;
  -- Retira la marca de revisión antes de resolver.
  update public.loan_installments set status = public.installment_effective_status('pending', due_date, paid_principal + paid_interest, total_amount),
         review_note = null
  where id in (select installment_id from public.payment_allocations where payment_id = r.payment_id) and status = 'in_review';
  if p_approve then
    perform public.reverse_payment(r.payment_id, r.reason);
    update public.reversal_requests set decision_notes = p_notes where id = r.id;
  else
    update public.reversal_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_notes = p_notes
    where id = r.id;
  end if;
end $$;

create or replace function public.mark_overdue_installments()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.loan_installments i set status = 'overdue'
  from public.loans l
  where l.id = i.loan_id and l.status = 'active' and i.status in ('pending', 'partial')
    and i.due_date < public.today_bogota();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Pagos por QR / transferencia / pasarela: solo una confirmación válida reduce el saldo.
-- ---------------------------------------------------------------------------
create or replace function public.create_payment_request(p_loan_id uuid, p_amount bigint, p_payment_method_id uuid,
                                                         p_reference text default null, p_evidence_path text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_customer uuid := public.my_customer_id(); l public.loans; v_outstanding bigint; v_id uuid;
begin
  perform public._require_role('customer');
  select * into l from public.loans where id = p_loan_id and customer_id = v_customer;
  if l.id is null then raise exception 'NOT_FOUND: préstamo inexistente' using errcode = '42501'; end if;
  if l.status <> 'active' then raise exception 'LOAN_NOT_ACTIVE: el préstamo no admite pagos'; end if;
  select outstanding into v_outstanding from public.v_loan_balances where id = l.id;
  if p_amount is null or p_amount <= 0 or p_amount > v_outstanding then
    raise exception 'INVALID_AMOUNT: el importe debe estar entre 1 y el saldo pendiente (%)', v_outstanding;
  end if;
  if p_evidence_path is not null and not exists (select 1 from public.stored_files f
       where f.id::text = p_evidence_path and f.bucket = 'payment-evidence' and f.customer_id = v_customer) then
    raise exception 'FORBIDDEN: comprobante no pertenece al cliente' using errcode = '42501';
  end if;
  if p_payment_method_id is not null and not exists (select 1 from public.payment_methods where id = p_payment_method_id and active) then
    raise exception 'INVALID: medio de pago no disponible';
  end if;
  insert into public.payment_requests (customer_id, loan_id, payment_method_id, amount, reference, evidence_path, status, submitted_by)
  values (v_customer, l.id, p_payment_method_id, p_amount, p_reference, p_evidence_path,
          (case when p_evidence_path is null then 'requested' else 'pending_verification' end)::public.payment_request_status, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.attach_payment_evidence(p_request_id uuid, p_evidence_path text, p_reference text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_customer uuid := public.my_customer_id();
begin
  perform public._require_role('customer');
  if not exists (select 1 from public.stored_files f
       where f.id::text = p_evidence_path and f.bucket = 'payment-evidence' and f.customer_id = v_customer) then
    raise exception 'FORBIDDEN: comprobante no pertenece al cliente' using errcode = '42501';
  end if;
  update public.payment_requests set evidence_path = p_evidence_path, reference = coalesce(p_reference, reference),
         status = 'pending_verification', updated_at = now()
  where id = p_request_id and customer_id = v_customer and status in ('requested', 'rejected');
  if not found then raise exception 'INVALID_STATE: la solicitud no admite comprobante'; end if;
end $$;

create or replace function public.review_payment_request(p_request_id uuid, p_approve boolean, p_notes text default null,
                                                         p_received_on date default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payment_requests; p public.payments; v_method public.payment_method_type;
begin
  perform public._require_role('admin');
  select * into r from public.payment_requests where id = p_request_id for update;
  if r.id is null then raise exception 'NOT_FOUND: solicitud inexistente'; end if;
  if r.status not in ('requested', 'pending_verification') then raise exception 'INVALID_STATE: la solicitud está %', r.status; end if;
  if not p_approve then
    if coalesce(length(trim(p_notes)), 0) < 3 then raise exception 'INVALID: indique el motivo del rechazo'; end if;
    update public.payment_requests set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes,
           updated_at = now() where id = r.id;
    return jsonb_build_object('status', 'rejected');
  end if;
  select case m.kind when 'qr_info' then 'qr' when 'gateway' then 'gateway' else 'transfer' end::public.payment_method_type
    into v_method from public.payment_methods m where m.id = r.payment_method_id;
  p := public._apply_payment(r.loan_id, r.amount, coalesce(v_method, 'transfer'), 'admin', auth.uid(),
                             coalesce(p_received_on, public.today_bogota()), 'request:' || r.id, r.id, r.evidence_path, p_notes);
  update public.payment_requests set status = 'confirmed', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes,
         payment_id = p.id, updated_at = now() where id = r.id;
  return jsonb_build_object('status', 'confirmed', 'payment_id', p.id, 'receipt_number', p.receipt_number);
end $$;

-- Confirmación desde un webhook de pasarela ya verificado (firma) por el servidor.
create or replace function public.confirm_gateway_payment(p_request_code text, p_amount bigint, p_gateway_reference text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payment_requests; p public.payments;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: solo el servidor confirma pagos de pasarela' using errcode = '42501';
  end if;
  select * into r from public.payment_requests where code = p_request_code for update;
  if r.id is null then raise exception 'NOT_FOUND: referencia desconocida'; end if;
  if r.status = 'confirmed' then return jsonb_build_object('status', 'confirmed', 'payment_id', r.payment_id, 'duplicate', true); end if;
  if r.status not in ('requested', 'pending_verification') then raise exception 'INVALID_STATE: la solicitud está %', r.status; end if;
  if r.amount <> p_amount then raise exception 'AMOUNT_MISMATCH: el importe notificado no coincide'; end if;
  p := public._apply_payment(r.loan_id, r.amount, 'gateway', 'admin', null, public.today_bogota(),
                             'gateway:' || p_gateway_reference, r.id, null, 'Confirmado por pasarela');
  update public.payment_requests set status = 'confirmed', gateway_reference = p_gateway_reference, reviewed_at = now(),
         payment_id = p.id, updated_at = now() where id = r.id;
  return jsonb_build_object('status', 'confirmed', 'payment_id', p.id, 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------------
-- Cobradores: entrega de efectivo y liquidación de comisiones
-- ---------------------------------------------------------------------------
create or replace function public.declare_cash_handover(p_amount bigint, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_custody bigint; v_pending bigint; v_id uuid;
begin
  perform public._require_role('collector');
  v_custody := public._balance('COLLECTOR_CASH:' || auth.uid());
  select coalesce(sum(amount), 0) into v_pending from public.cash_handovers where collector_id = auth.uid() and status = 'pending';
  if p_amount is null or p_amount <= 0 or p_amount > v_custody - v_pending then
    raise exception 'INVALID_AMOUNT: el importe supera el efectivo en custodia (%)', v_custody - v_pending;
  end if;
  insert into public.cash_handovers (collector_id, amount, notes) values (auth.uid(), p_amount, p_notes) returning id into v_id;
  return v_id;
end $$;

create or replace function public.confirm_cash_handover(p_handover_id uuid, p_approve boolean, p_notes text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.cash_handovers; v_tx uuid;
begin
  perform public._require_role('admin');
  select * into h from public.cash_handovers where id = p_handover_id and status = 'pending' for update;
  if h.id is null then raise exception 'NOT_FOUND: entrega inexistente o resuelta'; end if;
  if h.collector_id = auth.uid() then raise exception 'FORBIDDEN: no puede confirmar su propia entrega'; end if;
  if p_approve then
    v_tx := public._post_tx('cash_handover', 'Entrega de efectivo del cobrador', public.today_bogota(),
              jsonb_build_array(public._e(public._acc_cash(), h.amount), public._e(public._acc_collector_cash(h.collector_id), -h.amount)));
  end if;
  update public.cash_handovers set status = case when p_approve then 'confirmed' else 'rejected' end,
         confirmed_by = auth.uid(), confirmed_at = now(), tx_id = v_tx, notes = coalesce(p_notes, notes)
  where id = h.id;
end $$;

create or replace function public.create_collector_payout(p_collector_id uuid, p_period_end date, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_amount bigint;
begin
  perform public._require_role('admin');
  if p_collector_id = auth.uid() then raise exception 'FORBIDDEN: no puede liquidar sus propias comisiones'; end if;
  select coalesce(sum(amount), 0) into v_amount from public.collector_commissions
  where collector_id = p_collector_id and payout_id is null and (created_at at time zone 'America/Bogota')::date <= p_period_end;
  if v_amount <= 0 then raise exception 'NOTHING_TO_PAY: no hay comisiones pendientes en el periodo'; end if;
  insert into public.collector_payouts (collector_id, period_end, amount, created_by, notes)
  values (p_collector_id, p_period_end, v_amount, auth.uid(), p_notes) returning id into v_id;
  update public.collector_commissions set payout_id = v_id
  where collector_id = p_collector_id and payout_id is null and (created_at at time zone 'America/Bogota')::date <= p_period_end;
  return v_id;
end $$;

create or replace function public.approve_collector_payout(p_payout_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.collector_payouts set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_payout_id and status = 'pending_approval' and collector_id <> auth.uid();
  if not found then raise exception 'INVALID_STATE: liquidación no aprobable'; end if;
end $$;

create or replace function public.pay_collector_payout(p_payout_id uuid, p_paid_on date default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.collector_payouts; v_tx uuid;
begin
  perform public._require_role('admin');
  perform pg_advisory_xact_lock(hashtext('capital'));
  select * into o from public.collector_payouts where id = p_payout_id and status = 'approved' for update;
  if o.id is null then raise exception 'INVALID_STATE: la liquidación debe estar aprobada'; end if;
  if public._balance('CASH') < o.amount then raise exception 'INSUFFICIENT_CAPITAL: no hay efectivo suficiente en caja'; end if;
  v_tx := public._post_tx('commission_payout', 'Pago de comisiones', coalesce(p_paid_on, public.today_bogota()),
            jsonb_build_array(public._e(public._acc_commission_payable(o.collector_id), o.amount), public._e(public._acc_cash(), -o.amount)));
  update public.collector_payouts set status = 'paid', paid_by = auth.uid(), paid_at = now(), tx_id = v_tx where id = o.id;
end $$;

create or replace function public.cancel_collector_payout(p_payout_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.collector_payouts set status = 'cancelled' where id = p_payout_id and status in ('pending_approval', 'approved');
  if not found then raise exception 'INVALID_STATE: liquidación no cancelable'; end if;
  update public.collector_commissions set payout_id = null where payout_id = p_payout_id;
end $$;

-- ---------------------------------------------------------------------------
-- Liquidación trimestral de socios
-- Solo se distribuyen intereses efectivamente cobrados (asientos conciliados) netos
-- de comisiones, gastos y ajustes. El capital recuperado nunca es utilidad.
-- ---------------------------------------------------------------------------
create or replace function public._settlement_report(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_interest bigint := -public._balance('INTEREST_INCOME', p_end, p_start);
  v_comm bigint := public._balance('COMMISSION_EXPENSE', p_end, p_start);
  v_exp bigint := public._balance('OPERATING_EXPENSES', p_end, p_start);
  v_adj bigint := -public._balance('ADJUSTMENTS', p_end, p_start);
  v_result bigint;
  v_prior bigint := -public._balance('RETAINED_RESULT', p_start - 1);  -- < 0: pérdida acumulada
  v_distributable bigint;
  v_partners jsonb := '[]'::jsonb;
  v_reversals bigint;
  r record;
  v_adv bigint;
begin
  v_result := v_interest - v_comm - v_exp + v_adj;
  v_distributable := greatest(v_result + least(v_prior, 0), 0);
  select coalesce(sum(p.amount), 0) into v_reversals from public.payments p
  join public.financial_transactions t on t.id = p.reversal_tx_id where t.occurred_on between p_start and p_end;
  for r in select s.partner_id, s.share_bps, s.amount, pa.display_name, pa.seq
           from public.split_among_partners(v_distributable) s join public.partners pa on pa.id = s.partner_id order by pa.seq loop
    v_adv := public._balance('PARTNER_ADVANCES:' || r.partner_id, p_end);
    v_partners := v_partners || jsonb_build_object(
      'partner_id', r.partner_id, 'name', r.display_name, 'seq', r.seq, 'share_bps', r.share_bps,
      'gross', r.amount, 'advances_outstanding', v_adv, 'advances_deducted', least(v_adv, r.amount),
      'net', r.amount - least(v_adv, r.amount),
      'contributions', (select coalesce(sum(amount), 0) from public.capital_contributions
                        where partner_id = r.partner_id and kind = 'contribution' and occurred_on between p_start and p_end),
      'withdrawals', (select coalesce(sum(amount), 0) from public.capital_contributions
                      where partner_id = r.partner_id and kind = 'withdrawal' and occurred_on between p_start and p_end),
      'advances_in_period', (select coalesce(sum(amount), 0) from public.capital_contributions
                             where partner_id = r.partner_id and kind = 'advance' and occurred_on between p_start and p_end));
  end loop;
  return jsonb_build_object(
    'period_start', p_start, 'period_end', p_end, 'generated_at', now(),
    'opening_cash', public._balance('CASH', p_start - 1) + public._balance('COLLECTOR_CASH:%', p_start - 1),
    'capital_recovered', -(select coalesce(sum(e.amount), 0) from public.financial_entries e
                           join public.capital_accounts a on a.id = e.account_id and a.code = 'LOANS_RECEIVABLE'
                           join public.financial_transactions t on t.id = e.tx_id
                           where t.kind in ('payment', 'payment_reversal') and t.occurred_on between p_start and p_end),
    'new_disbursements', (select coalesce(sum(e.amount), 0) from public.financial_entries e
                          join public.capital_accounts a on a.id = e.account_id and a.code = 'LOANS_RECEIVABLE'
                          join public.financial_transactions t on t.id = e.tx_id
                          where t.kind = 'disbursement' and t.occurred_on between p_start and p_end),
    'interest_collected', v_interest,
    'collector_commissions', v_comm,
    'expenses', v_exp,
    'adjustments', v_adj,
    'reversals_amount', v_reversals,
    'period_result', v_result,
    'prior_loss_carried', least(v_prior, 0),
    'net_distributable', v_distributable,
    'loss_carried_forward', least(v_result + least(v_prior, 0), 0),
    'partners', v_partners,
    'distributions_paid_in_period', -(select coalesce(sum(e.amount), 0) from public.financial_entries e
                                      join public.capital_accounts a on a.id = e.account_id and a.code = 'CASH'
                                      join public.financial_transactions t on t.id = e.tx_id
                                      where t.kind = 'distribution_payment' and t.occurred_on between p_start and p_end),
    'closing_cash', public._balance('CASH', p_end) + public._balance('COLLECTOR_CASH:%', p_end));
end $$;

create or replace function public.create_settlement(p_period_start date, p_period_end date)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform public._require_role('admin');
  if p_period_end < p_period_start then raise exception 'INVALID: periodo no válido'; end if;
  if exists (select 1 from public.quarterly_settlements where status <> 'cancelled'
             and daterange(period_start, period_end, '[]') && daterange(p_period_start, p_period_end, '[]')) then
    raise exception 'OVERLAP: ya existe una liquidación para un periodo que se solapa';
  end if;
  insert into public.quarterly_settlements (period_start, period_end, report, created_by)
  values (p_period_start, p_period_end, public._settlement_report(p_period_start, p_period_end), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.refresh_settlement(p_settlement_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.quarterly_settlements set report = public._settlement_report(period_start, period_end), updated_at = now()
  where id = p_settlement_id and status in ('draft', 'pending_approval');
  if not found then raise exception 'INVALID_STATE: la liquidación no admite recálculo'; end if;
end $$;

create or replace function public.submit_settlement(p_settlement_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.quarterly_settlements set status = 'pending_approval', report = public._settlement_report(period_start, period_end),
         submitted_by = auth.uid(), submitted_at = now(), updated_at = now()
  where id = p_settlement_id and status = 'draft';
  if not found then raise exception 'INVALID_STATE: solo se envía un borrador'; end if;
end $$;

create or replace function public.cancel_settlement(p_settlement_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_role('admin');
  update public.quarterly_settlements set status = 'cancelled', updated_at = now()
  where id = p_settlement_id and status in ('draft', 'pending_approval');
  if not found then raise exception 'INVALID_STATE: la liquidación no se puede cancelar'; end if;
end $$;

create or replace function public.approve_settlement(p_settlement_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.quarterly_settlements;
  v_report jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_gross_total bigint := 0;
  v_tx uuid;
  p jsonb;
begin
  perform public._require_role('admin');
  select * into s from public.quarterly_settlements where id = p_settlement_id for update;
  if s.id is null or s.status <> 'pending_approval' then raise exception 'INVALID_STATE: la liquidación debe estar pendiente de aprobación'; end if;
  if s.period_end >= public.today_bogota() then raise exception 'PERIOD_OPEN: el periodo aún no ha terminado'; end if;
  perform pg_advisory_xact_lock(hashtext('capital'));
  v_report := public._settlement_report(s.period_start, s.period_end);

  -- Cierre: se cancelan las cuentas de resultado del periodo contra utilidades por pagar a cada socio.
  v_entries := jsonb_build_array(
    public._e(public._acc_interest(), (v_report ->> 'interest_collected')::bigint),
    public._e(public._acc_commission_expense(), -(v_report ->> 'collector_commissions')::bigint),
    public._e(public._acc_expenses(), -(v_report ->> 'expenses')::bigint),
    public._e(public._acc_adjustments(), (v_report ->> 'adjustments')::bigint));
  for p in select * from jsonb_array_elements(v_report -> 'partners') loop
    v_gross_total := v_gross_total + (p ->> 'gross')::bigint;
    v_entries := v_entries
      || public._e(public._acc_partner_payable((p ->> 'partner_id')::uuid), -(p ->> 'gross')::bigint)
      || public._e(public._acc_partner_payable((p ->> 'partner_id')::uuid), (p ->> 'advances_deducted')::bigint)
      || public._e(public._acc_partner_advances((p ->> 'partner_id')::uuid), -(p ->> 'advances_deducted')::bigint);
  end loop;
  v_entries := v_entries || public._e(public._acc_retained(), -((v_report ->> 'period_result')::bigint - v_gross_total));
  if exists (select 1 from jsonb_array_elements(v_entries) e where (e ->> 'amount')::bigint <> 0) then
    v_tx := public._post_tx('settlement_close', 'Cierre liquidación ' || s.period_start || ' a ' || s.period_end, s.period_end,
                            v_entries, null, null, s.id);
  end if;
  for p in select * from jsonb_array_elements(v_report -> 'partners') loop
    insert into public.settlement_distributions (settlement_id, partner_id, share_bps, gross_amount, advances_deducted, net_amount)
    values (s.id, (p ->> 'partner_id')::uuid, (p ->> 'share_bps')::int, (p ->> 'gross')::bigint,
            (p ->> 'advances_deducted')::bigint, (p ->> 'net')::bigint);
  end loop;
  update public.quarterly_settlements set status = 'approved', report = v_report, approved_report = v_report,
         approved_hash = encode(digest(v_report::text, 'sha256'), 'hex'), approved_by = auth.uid(), approved_at = now(),
         close_tx_id = v_tx, updated_at = now()
  where id = s.id;
  if not exists (select 1 from public.settlement_distributions where settlement_id = s.id and net_amount > 0) then
    update public.quarterly_settlements set status = 'paid', paid_at = now() where id = s.id;
  end if;
  return v_tx;
end $$;

create or replace function public.pay_distribution(p_distribution_id uuid, p_paid_on date default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.settlement_distributions; v_tx uuid; v_status public.workflow_status;
begin
  perform public._require_role('admin');
  perform pg_advisory_xact_lock(hashtext('capital'));
  select * into d from public.settlement_distributions where id = p_distribution_id and paid_at is null for update;
  if d.id is null then raise exception 'INVALID_STATE: distribución inexistente o ya pagada'; end if;
  select status into v_status from public.quarterly_settlements where id = d.settlement_id;
  if v_status <> 'approved' then raise exception 'INVALID_STATE: la liquidación no está aprobada'; end if;
  if d.net_amount > 0 then
    if public._balance('CASH') < d.net_amount then raise exception 'INSUFFICIENT_CAPITAL: no hay efectivo suficiente en caja'; end if;
    v_tx := public._post_tx('distribution_payment', 'Pago de utilidades a socio', coalesce(p_paid_on, public.today_bogota()),
              jsonb_build_array(public._e(public._acc_partner_payable(d.partner_id), d.net_amount), public._e(public._acc_cash(), -d.net_amount)),
              null, null, d.settlement_id);
  end if;
  update public.settlement_distributions set paid_at = now(), paid_by = auth.uid(), paid_tx_id = v_tx where id = d.id;
  if not exists (select 1 from public.settlement_distributions where settlement_id = d.settlement_id and paid_at is null) then
    update public.quarterly_settlements set status = 'paid', paid_at = now() where id = d.settlement_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tableros e informes
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard(p_collector uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date := public.today_bogota();
  v_month date := date_trunc('month', v_today)::date;
  v_q_end date := (date_trunc('quarter', v_today) + interval '3 months - 1 day')::date;
  v_partners jsonb;
begin
  perform public._require_role('admin');
  select coalesce(jsonb_agg(jsonb_build_object(
           'partner_id', pa.id, 'name', pa.display_name, 'share_bps', pa.share_bps,
           'capital', -public._balance('PARTNER_CAPITAL:' || pa.id),
           'calculated', floor((select coalesce(sum(partners_pool_total), 0) from public.loans where status in ('active', 'paid'))::numeric * pa.share_bps / 10000),
           'collected_unsettled', floor(greatest((public._capital_summary() ->> 'unsettled_result')::bigint, 0)::numeric * pa.share_bps / 10000),
           'distributed', (select coalesce(sum(gross_amount), 0) from public.settlement_distributions where partner_id = pa.id),
           'paid', (select coalesce(sum(net_amount), 0) from public.settlement_distributions where partner_id = pa.id and paid_at is not null))
         order by pa.seq), '[]') into v_partners from public.partners pa where pa.active;
  return jsonb_build_object(
    'today', v_today,
    'capital', public._capital_summary(),
    'month', jsonb_build_object(
      'disbursed', (select coalesce(sum(principal), 0) from public.loans
                    where disbursed_at is not null and (disbursed_at at time zone 'America/Bogota')::date >= v_month),
      'interest_collected', -public._balance('INTEREST_INCOME', v_today, v_month),
      'principal_recovered', (select coalesce(sum(case when status = 'confirmed' then principal_amount else 0 end), 0) from public.payments where received_on >= v_month),
      'commissions_accrued', public._balance('COMMISSION_EXPENSE', v_today, v_month)),
    'commissions', jsonb_build_object(
      'accrued_total', (select coalesce(sum(amount), 0) from public.collector_commissions),
      'pending_payment', -public._balance('COMMISSION_PAYABLE:%'),
      'paid_total', (select coalesce(sum(amount), 0) from public.collector_payouts where status = 'paid')),
    'partners', v_partners,
    'portfolio', (select jsonb_build_object(
       'active_loans', count(*) filter (where status = 'active'),
       'approved_pending_disbursement', count(*) filter (where status = 'approved'),
       'outstanding', coalesce(sum(outstanding) filter (where status = 'active'), 0),
       'overdue', coalesce(sum(overdue_amount) filter (where status = 'active'), 0))
       from public.v_loan_balances where p_collector is null or collector_id = p_collector),
    'applications_pending', (select count(*) from public.loan_applications where status in ('pending', 'accepted_by_customer')),
    'payment_requests_pending', (select count(*) from public.payment_requests where status = 'pending_verification'),
    'simulations_7d', (select count(*) from public.loan_simulations where created_at >= now() - interval '7 days'),
    'today_collections', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0))
                          from public.payments where status = 'confirmed' and received_on = v_today
                          and (p_collector is null or collector_id = p_collector)),
    'next_settlement', jsonb_build_object('period_end', v_q_end,
       'status', (select status from public.quarterly_settlements where status <> 'cancelled' and period_end = v_q_end limit 1)),
    'series_daily', (select coalesce(jsonb_agg(jsonb_build_object('date', d::date, 'amount', coalesce(x.amount, 0), 'interest', coalesce(x.interest, 0)) order by d), '[]')
                     from generate_series(v_today - 29, v_today, interval '1 day') d
                     left join (select received_on, sum(amount) amount, sum(interest_amount) interest from public.payments
                                where status = 'confirmed' and received_on > v_today - 30 and (p_collector is null or collector_id = p_collector)
                                group by received_on) x on x.received_on = d::date),
    'series_monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
                         'disbursed', (select coalesce(sum(principal), 0) from public.loans where disbursed_at is not null
                                       and date_trunc('month', disbursed_at at time zone 'America/Bogota') = m
                                       and (p_collector is null or collector_id = p_collector)),
                         'collected', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed'
                                       and date_trunc('month', received_on) = m and (p_collector is null or collector_id = p_collector)),
                         'interest', (select coalesce(sum(interest_amount), 0) from public.payments where status = 'confirmed'
                                      and date_trunc('month', received_on) = m and (p_collector is null or collector_id = p_collector)))
                         order by m), '[]')
                       from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m));
end $$;

create or replace function public.collector_report(p_collector_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role public.app_role := public._require_role('admin', 'collector'); v_expected bigint; v_received bigint;
begin
  if v_role = 'collector' and p_collector_id <> auth.uid() then
    raise exception 'FORBIDDEN: solo puede consultar su propio informe' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 370 then raise exception 'INVALID: rango de fechas no válido'; end if;
  select coalesce(sum(i.total_amount), 0) into v_expected from public.loan_installments i
    join public.loans l on l.id = i.loan_id where l.collector_id = p_collector_id and l.status in ('active', 'paid')
    and i.due_date between p_from and p_to;
  select coalesce(sum(amount), 0) into v_received from public.payments
    where collector_id = p_collector_id and status = 'confirmed' and received_on between p_from and p_to;
  return jsonb_build_object(
    'collector', (select jsonb_build_object('id', id, 'full_name', full_name) from public.profiles where id = p_collector_id),
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'payers', (select count(distinct customer_id) from public.payments where collector_id = p_collector_id and status = 'confirmed' and received_on between p_from and p_to),
    'payments_count', (select count(*) from public.payments where collector_id = p_collector_id and status = 'confirmed' and received_on between p_from and p_to),
    'installments_touched', (select count(distinct a.installment_id) from public.payment_allocations a join public.payments p on p.id = a.payment_id
                             where p.collector_id = p_collector_id and p.status = 'confirmed' and p.received_on between p_from and p_to),
    'installments_completed', (select count(*) from public.loan_installments i join public.loans l on l.id = i.loan_id
                               where l.collector_id = p_collector_id and i.status = 'paid' and (i.paid_at at time zone 'America/Bogota')::date between p_from and p_to),
    'total_received', v_received,
    'principal_recovered', (select coalesce(sum(principal_amount), 0) from public.payments where collector_id = p_collector_id and status = 'confirmed' and received_on between p_from and p_to),
    'interest_collected', (select coalesce(sum(interest_amount), 0) from public.payments where collector_id = p_collector_id and status = 'confirmed' and received_on between p_from and p_to),
    'commission_accrued', (select coalesce(sum(amount), 0) from public.collector_commissions where collector_id = p_collector_id and (created_at at time zone 'America/Bogota')::date between p_from and p_to),
    'commission_paid', (select coalesce(sum(amount), 0) from public.collector_payouts where collector_id = p_collector_id and status = 'paid' and (paid_at at time zone 'America/Bogota')::date between p_from and p_to),
    'partial_payments', (select count(*) from public.payments where collector_id = p_collector_id and status = 'confirmed' and is_partial and received_on between p_from and p_to),
    'pending_installments', (select count(*) from public.loan_installments i join public.loans l on l.id = i.loan_id
                             where l.collector_id = p_collector_id and l.status = 'active' and i.due_date <= p_to and i.paid_principal + i.paid_interest < i.total_amount),
    'pending_amount', (select coalesce(sum(i.total_amount - i.paid_principal - i.paid_interest), 0) from public.loan_installments i join public.loans l on l.id = i.loan_id
                       where l.collector_id = p_collector_id and l.status = 'active' and i.due_date <= p_to),
    'expected', v_expected,
    'difference', v_received - v_expected,
    'handed_over', (select coalesce(sum(amount), 0) from public.cash_handovers where collector_id = p_collector_id and status = 'confirmed' and (confirmed_at at time zone 'America/Bogota')::date between p_from and p_to),
    'cash_in_custody', public._balance('COLLECTOR_CASH:' || p_collector_id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('receipt_number', p.receipt_number, 'received_on', p.received_on, 'customer', c.full_name,
                   'loan_code', l.code, 'amount', p.amount, 'principal', p.principal_amount, 'interest', p.interest_amount,
                   'commission', p.commission_amount, 'is_partial', p.is_partial) order by p.received_at), '[]')
                 from public.payments p join public.customers c on c.id = p.customer_id join public.loans l on l.id = p.loan_id
                 where p.collector_id = p_collector_id and p.status = 'confirmed' and p.received_on between p_from and p_to));
end $$;

create or replace function public.collector_dashboard()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid(); v_today date := public.today_bogota();
begin
  perform public._require_role('collector');
  return jsonb_build_object(
    'today', v_today,
    'assigned_customers', (select count(*) from public.customers where collector_id = v_me and status = 'active'),
    'due_today', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(i.total_amount - i.paid_principal - i.paid_interest), 0))
                  from public.loan_installments i join public.loans l on l.id = i.loan_id
                  where l.collector_id = v_me and l.status = 'active' and i.due_date = v_today and i.paid_principal + i.paid_interest < i.total_amount),
    'overdue', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(i.total_amount - i.paid_principal - i.paid_interest), 0))
                from public.loan_installments i join public.loans l on l.id = i.loan_id
                where l.collector_id = v_me and l.status = 'active' and i.due_date < v_today and i.paid_principal + i.paid_interest < i.total_amount),
    'collected_today', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0))
                        from public.payments where collector_id = v_me and status = 'confirmed' and received_on = v_today),
    'commission_accrued_total', (select coalesce(sum(amount), 0) from public.collector_commissions where collector_id = v_me),
    'commission_pending', -public._balance('COMMISSION_PAYABLE:' || v_me),
    'cash_in_custody', public._balance('COLLECTOR_CASH:' || v_me),
    'handovers_pending', (select coalesce(sum(amount), 0) from public.cash_handovers where collector_id = v_me and status = 'pending'));
end $$;

create or replace function public.partner_dashboard()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pa public.partners; v_all boolean := public.has_permission('partner.view_all_contributions');
begin
  perform public._require_role('partner');
  select * into pa from public.partners where profile_id = auth.uid();
  if pa.id is null then raise exception 'NOT_FOUND: el usuario no está vinculado a un socio'; end if;
  return jsonb_build_object(
    'partner', jsonb_build_object('id', pa.id, 'name', pa.display_name, 'share_bps', pa.share_bps),
    'my_capital', -public._balance('PARTNER_CAPITAL:' || pa.id),
    'my_advances', public._balance('PARTNER_ADVANCES:' || pa.id),
    'partners', case when v_all then (select jsonb_agg(jsonb_build_object('name', display_name, 'share_bps', share_bps,
                   'capital', -public._balance('PARTNER_CAPITAL:' || id)) order by seq) from public.partners where active) end,
    'capital', public._capital_summary(),
    'loans', (select jsonb_build_object('active', count(*) filter (where status = 'active'),
               'active_principal', coalesce(sum(principal) filter (where status = 'active'), 0)) from public.loans),
    'principal_recovered_total', (select coalesce(sum(principal_amount), 0) from public.payments where status = 'confirmed'),
    'interest_collected_total', (select coalesce(sum(interest_amount), 0) from public.payments where status = 'confirmed'),
    'my_profit_distributed', (select coalesce(sum(gross_amount), 0) from public.settlement_distributions where partner_id = pa.id),
    'my_profit_paid', (select coalesce(sum(net_amount), 0) from public.settlement_distributions where partner_id = pa.id and paid_at is not null),
    'my_unsettled_estimate', floor(greatest((public._capital_summary() ->> 'unsettled_result')::bigint, 0)::numeric * pa.share_bps / 10000),
    'settlements', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'period_start', s.period_start, 'period_end', s.period_end,
                      'status', s.status, 'gross', d.gross_amount, 'advances', d.advances_deducted, 'net', d.net_amount, 'paid_at', d.paid_at)
                      order by s.period_start desc), '[]')
                    from public.quarterly_settlements s left join public.settlement_distributions d on d.settlement_id = s.id and d.partner_id = pa.id
                    where s.status in ('pending_approval', 'approved', 'paid')));
end $$;

-- Comprobante de pago (sin documento completo del cliente).
create or replace function public.get_receipt(p_payment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.payments;
begin
  select * into p from public.payments where id = p_payment_id;
  if p.id is null or not public.can_view_loan(p.loan_id) then raise exception 'FORBIDDEN: comprobante no disponible' using errcode = '42501'; end if;
  return jsonb_build_object(
    'receipt_number', p.receipt_number, 'status', p.status, 'amount', p.amount, 'principal', p.principal_amount,
    'interest', p.interest_amount, 'method', p.method, 'received_on', p.received_on, 'received_at', p.received_at,
    'reversal_reason', p.reversal_reason,
    'company', (select value from public.app_settings where key = 'company'),
    'customer', (select jsonb_build_object('code', c.code, 'full_name', c.full_name, 'document', c.document_type || ' ' || public._mask(c.document_number))
                 from public.customers c where c.id = p.customer_id),
    'loan', (select jsonb_build_object('code', l.code, 'total_amount', l.total_amount, 'outstanding', b.outstanding)
             from public.loans l join public.v_loan_balances b on b.id = l.id where l.id = p.loan_id),
    'received_by', (select full_name from public.profiles where id = p.received_by),
    'allocations', (select jsonb_agg(jsonb_build_object('number', i.number, 'principal', a.principal_amount, 'interest', a.interest_amount) order by i.number)
                    from public.payment_allocations a join public.loan_installments i on i.id = a.installment_id
                    where a.payment_id = p.id and a.kind = 'payment'));
end $$;

-- Destinatarios de recordatorios (solo servidor). No incluye importes.
create or replace function public.reminder_targets(p_date date)
returns table (user_id uuid, kind text, items integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
    select c.profile_id, case when i.due_date = p_date then 'due_today' else 'upcoming' end, count(*)::int
    from public.loan_installments i join public.loans l on l.id = i.loan_id join public.customers c on c.id = l.customer_id
    where l.status = 'active' and c.profile_id is not null and i.paid_principal + i.paid_interest < i.total_amount
      and i.due_date in (p_date, p_date + 1)
    group by 1, 2
    union all
    select l.collector_id, 'collector_daily', count(*)::int
    from public.loan_installments i join public.loans l on l.id = i.loan_id
    where l.status = 'active' and i.paid_principal + i.paid_interest < i.total_amount and i.due_date <= p_date
    group by 1;
end $$;
