-- =============================================================================
-- CAPITAL CONTROL — 0005: los cobradores pueden registrar clientes (opcional)
-- * Ajuste operations.collectors_can_create_customers (activado por defecto),
--   que el administrador puede desactivar en Configuración.
-- * La cédula (documento) es obligatoria y única; el cliente queda asignado al
--   cobrador que lo registra.
-- * Las cuentas de cliente pueden crearse sin correo: el cliente ingresa con su cédula.
-- =============================================================================

-- Con FORCE RLS activo, las migraciones que escriben datos actúan en contexto de sistema.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.app_settings (key, value, description)
values ('operations', jsonb_build_object('collectors_can_create_customers', true),
        'Opciones operativas (p. ej. si los cobradores pueden registrar clientes).')
on conflict (key) do nothing;

create or replace function public._collectors_can_create_customers()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value ->> 'collectors_can_create_customers')::boolean from public.app_settings where key = 'operations'), false)
$$;

create or replace function public.create_customer(p_full_name text, p_document_type text, p_document_number text,
                                                  p_phone text, p_address text default null, p_collector_id uuid default null,
                                                  p_notes text default null, p_data_consent boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'collector');
  v_id uuid;
  v_doc text := upper(regexp_replace(coalesce(p_document_number, ''), '[^0-9A-Za-z]', '', 'g'));
  v_collector uuid := p_collector_id;
begin
  if v_role = 'collector' then
    if not public._collectors_can_create_customers() then
      raise exception 'FORBIDDEN: la administración desactivó el registro de clientes por cobradores' using errcode = '42501';
    end if;
    v_collector := auth.uid();  -- el cliente queda asignado a quien lo registra
  end if;
  if length(v_doc) < 3 then raise exception 'INVALID: la cédula es obligatoria'; end if;
  if not p_data_consent then
    raise exception 'CONSENT_REQUIRED: se requiere la autorización de tratamiento de datos personales';
  end if;
  if exists (select 1 from public.customers where document_number = v_doc) then
    raise exception 'DUPLICATE_CUSTOMER: ya existe un cliente con esa cédula';
  end if;
  if v_collector is not null and not exists (select 1 from public.profiles where id = v_collector and role = 'collector' and active) then
    raise exception 'INVALID_COLLECTOR: el cobrador no existe o está inactivo';
  end if;
  insert into public.customers (full_name, document_type, document_number, phone, address, collector_id, notes, data_consent_at, created_by)
  values (trim(p_full_name), p_document_type, v_doc, regexp_replace(trim(p_phone), '\s+', ' ', 'g'), p_address, v_collector, p_notes, now(), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- La cédula identifica al cliente: única sin importar el tipo de documento (permite ingresar con ella).
create unique index if not exists customers_document_number_unique on public.customers (document_number);

-- Correo interno para cuentas sin correo (el cliente ingresa con su cédula).
create or replace function public.customer_login_email(p_document text)
returns text language sql immutable as $$
  select lower(regexp_replace(p_document, '[^0-9A-Za-z]', '', 'g')) || '@clientes.capital-control.local'
$$;

create or replace function public.admin_create_user(p_email text, p_password_hash text, p_full_name text, p_phone text,
                                                    p_role public.app_role, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor public.app_role := public._require_role('admin', 'collector');
  v_id uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_doc text;
begin
  if v_actor = 'collector' then
    -- Un cobrador solo crea la cuenta de SUS clientes, y solo si la opción está activada.
    if not public._collectors_can_create_customers() or p_role <> 'customer'
       or not exists (select 1 from public.customers where id = p_customer_id and collector_id = auth.uid()) then
      raise exception 'FORBIDDEN: no puede crear esta cuenta' using errcode = '42501';
    end if;
  end if;
  if p_customer_id is not null and p_role <> 'customer' then
    raise exception 'INVALID: solo un cliente se vincula a una ficha de cliente';
  end if;
  if p_role = 'customer' and p_customer_id is null then
    raise exception 'INVALID: seleccione la ficha del cliente';
  end if;
  if p_customer_id is not null then
    select document_number into v_doc from public.customers where id = p_customer_id;
    if exists (select 1 from public.customers where id = p_customer_id and profile_id is not null) then
      raise exception 'INVALID: el cliente ya tiene una cuenta';
    end if;
    if v_email = '' then v_email := public.customer_login_email(v_doc); end if;
  end if;
  if v_email = '' then raise exception 'INVALID: el correo es obligatorio para este rol'; end if;
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'DUPLICATE_USER: ya existe una cuenta con ese correo';
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

-- Usuario para iniciar sesión: correo o cédula del cliente (solo contexto de sistema).
create or replace function public.login_user_id(p_identifier text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_doc text := upper(regexp_replace(coalesce(p_identifier, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select id into v_id from auth.users where email = lower(trim(p_identifier));
  if v_id is null and length(v_doc) >= 3 then
    select profile_id into v_id from public.customers where document_number = v_doc and profile_id is not null;
  end if;
  return v_id;
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
  if p_key = 'operations' and jsonb_typeof(p_value -> 'collectors_can_create_customers') <> 'boolean' then
    raise exception 'INVALID: valor no válido';
  end if;
  insert into public.app_settings (key, value, updated_by, updated_at) values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- Lectura del ajuste para los cobradores (para mostrar u ocultar el botón).
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select
  using (public.is_admin() or (auth.uid() is not null and key in ('company', 'payment_instructions', 'operations')));

-- Las funciones reemplazadas vuelven a ejecutarse en contexto de sistema.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef loop
    execute format('alter function %s set application_name = %L', f.sig, 'capital_control_system');
  end loop;
end $$;
