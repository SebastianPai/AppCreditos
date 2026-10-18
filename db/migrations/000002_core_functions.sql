-- =============================================================================
-- CAPITAL CONTROL — 0002: funciones base, auditoría, inmutabilidad y contabilidad
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Fechas de negocio
-- ---------------------------------------------------------------------------
create or replace function public.today_bogota()
returns date language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone 'America/Bogota')::date
$$;

-- ---------------------------------------------------------------------------
-- Identidad y permisos (SECURITY DEFINER para evitar recursión de RLS)
-- ---------------------------------------------------------------------------
create or replace function public.current_app_role()
returns public.app_role language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

create or replace function public.has_permission(p_code text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and (
      p.role = 'admin'
      or exists (select 1 from public.role_permissions rp where rp.role = p.role and rp.permission_code = p_code)
      or exists (select 1 from public.user_permissions up where up.user_id = p.id and up.permission_code = p_code)))
$$;

create or replace function public.my_customer_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select c.id from public.customers c
  join public.profiles p on p.id = c.profile_id and p.active
  where c.profile_id = auth.uid()
$$;

create or replace function public.can_view_customer(p_customer_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case public.current_app_role()
    when 'admin' then true
    when 'collector' then exists (select 1 from public.customers c where c.id = p_customer_id and c.collector_id = auth.uid())
                          or public.has_permission('collector.view_all_customers')
    when 'customer' then p_customer_id = public.my_customer_id()
    else false end
$$;

create or replace function public.can_view_loan(p_loan_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case public.current_app_role()
    when 'admin' then true
    when 'partner' then public.has_permission('partner.view_loans')
    when 'collector' then exists (select 1 from public.loans l where l.id = p_loan_id and l.collector_id = auth.uid())
                          or public.has_permission('collector.view_all_customers')
    when 'customer' then exists (select 1 from public.loans l where l.id = p_loan_id and l.customer_id = public.my_customer_id())
    else false end
$$;

-- Lanza un error si el usuario actual no tiene alguno de los roles indicados.
create or replace function public._require_role(variadic p_roles public.app_role[])
returns public.app_role language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role public.app_role := public.current_app_role();
begin
  if v_role is null or not (v_role = any (p_roles)) then
    raise exception 'FORBIDDEN: operación no permitida para el rol %', coalesce(v_role::text, 'anónimo')
      using errcode = '42501';
  end if;
  return v_role;
end $$;

-- ---------------------------------------------------------------------------
-- Alta de perfiles: el rol se toma de app_metadata, que solo puede escribir el
-- servidor con la clave service_role. El registro público nunca crea administradores.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := coalesce(nullif(new.raw_app_meta_data ->> 'role', ''), 'customer')::public.app_role;
  v_name text := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, 'usuario'), '@', 1));
begin
  -- Un administrador nunca nace de un registro: el script de inicialización crea
  -- el primero (solo si no existe ninguno) y los siguientes los crea un
  -- administrador existente mediante admin_create_user (que fija app.allow_admin_create).
  if v_role = 'admin'
     and coalesce(current_setting('app.allow_admin_create', true), '') <> 'on'
     and (coalesce(new.raw_app_meta_data ->> 'bootstrap', '') <> 'true'
          or exists (select 1 from public.profiles where role = 'admin')) then
    raise exception 'BOOTSTRAP_REQUIRED: el primer administrador se crea con el procedimiento de inicialización';
  end if;
  insert into public.profiles (id, role, full_name, phone)
  values (new.id, v_role, left(v_name, 160), nullif(new.raw_user_meta_data ->> 'phone', ''));
  insert into public.notification_preferences (user_id) values (new.id);
  -- Vincula la cuenta a una ficha de cliente cuando la invitación la indica.
  if v_role = 'customer' and (new.raw_app_meta_data ->> 'customer_id') is not null then
    update public.customers set profile_id = new.id
    where id = (new.raw_app_meta_data ->> 'customer_id')::uuid and profile_id is null;
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Auditoría genérica. TG_ARGV contiene columnas sensibles a enmascarar.
-- ---------------------------------------------------------------------------
create or replace function public._mask(p_value text)
returns text language sql immutable as $$
  select case when p_value is null then null
              when length(p_value) <= 4 then repeat('*', length(p_value))
              else repeat('*', length(p_value) - 4) || right(p_value, 4) end
$$;

create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_col text;
begin
  foreach v_col in array coalesce(tg_argv::text[], '{}') loop
    if v_old ? v_col then v_old := jsonb_set(v_old, array[v_col], coalesce(to_jsonb(public._mask(v_old ->> v_col)), 'null'::jsonb)); end if;
    if v_new ? v_col then v_new := jsonb_set(v_new, array[v_col], coalesce(to_jsonb(public._mask(v_new ->> v_col)), 'null'::jsonb)); end if;
  end loop;
  insert into public.audit_logs (actor_id, actor_role, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), coalesce(public.current_app_role()::text, auth.role()), lower(tg_op), tg_table_name,
          coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'key', v_old ->> 'key', v_new ->> 'user_id', v_old ->> 'user_id'),
          v_old, v_new);
  return coalesce(new, old);
end $$;

create or replace function public._audit(p_action text, p_table text, p_record_id text, p_context jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_logs (actor_id, actor_role, action, table_name, record_id, context)
  values (auth.uid(), coalesce(public.current_app_role()::text, auth.role()), p_action, p_table, p_record_id, p_context)
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'user_permissions', 'app_settings', 'loan_policies', 'partners', 'capital_contributions',
    'expenses', 'loan_applications', 'loans', 'payments', 'payment_requests', 'payment_methods',
    'reversal_requests', 'collector_payouts', 'cash_handovers', 'quarterly_settlements', 'settlement_distributions']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;
create trigger audit_customers after insert or update or delete on public.customers
  for each row execute function public.audit_row('document_number', 'phone', 'address');

-- ---------------------------------------------------------------------------
-- Inmutabilidad: lo confirmado no se borra; se corrige con reversos.
-- ---------------------------------------------------------------------------
create or replace function public._forbid_change()
returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE: los registros de % no se pueden modificar ni borrar; registre un reverso', tg_table_name
    using errcode = '42501';
end $$;

do $$
declare t text;
begin
  foreach t in array array['financial_transactions', 'financial_entries', 'payment_allocations', 'audit_logs', 'capital_contributions', 'expenses', 'stored_files']
  loop
    execute format('create trigger immutable_%1$s before update or delete on public.%1$I
                    for each row execute function public._forbid_change()', t);
  end loop;
end $$;

create or replace function public._guard_payment_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: un pago confirmado no se puede borrar; registre un reverso' using errcode = '42501';
  end if;
  if old.status = 'reversed' then
    raise exception 'IMMUTABLE: el pago ya fue reversado' using errcode = '42501';
  end if;
  if (new.loan_id, new.customer_id, new.collector_id, new.amount, new.principal_amount, new.interest_amount,
      new.commission_amount, new.method, new.idempotency_key, new.received_on, new.received_by, new.tx_id, new.receipt_number)
     is distinct from
     (old.loan_id, old.customer_id, old.collector_id, old.amount, old.principal_amount, old.interest_amount,
      old.commission_amount, old.method, old.idempotency_key, old.received_on, old.received_by, old.tx_id, old.receipt_number)
     or new.status <> 'reversed' then
    raise exception 'IMMUTABLE: solo se permite marcar el pago como reversado' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_payments before update or delete on public.payments
  for each row execute function public._guard_payment_update();

create or replace function public._guard_loan_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
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
  if new.start_date <> old.start_date and old.status <> 'approved' then
    raise exception 'IMMUTABLE: la fecha de inicio solo cambia antes del desembolso' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_loans before update or delete on public.loans
  for each row execute function public._guard_loan_update();

create or replace function public._guard_installment_update()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status public.loan_status;
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: las cuotas no se borran' using errcode = '42501';
  end if;
  if (new.loan_id, new.number, new.principal_amount, new.interest_amount, new.total_amount)
     is distinct from (old.loan_id, old.number, old.principal_amount, old.interest_amount, old.total_amount) then
    raise exception 'IMMUTABLE: el importe contractual de una cuota no se modifica' using errcode = '42501';
  end if;
  if new.due_date <> old.due_date then
    select status into v_status from public.loans where id = new.loan_id;
    if v_status <> 'approved' then
      raise exception 'IMMUTABLE: el vencimiento solo cambia antes del desembolso' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger guard_installments before update or delete on public.loan_installments
  for each row execute function public._guard_installment_update();

create or replace function public._guard_commission_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (new.collector_id, new.loan_id, new.payment_id, new.kind, new.amount)
     is distinct from (old.collector_id, old.loan_id, old.payment_id, old.kind, old.amount) then
    raise exception 'IMMUTABLE: las comisiones se generan automáticamente y no se alteran' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_commissions before update or delete on public.collector_commissions
  for each row execute function public._guard_commission_update();

create or replace function public._guard_settlement_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: las liquidaciones no se borran; cancele el borrador' using errcode = '42501';
  end if;
  if old.status in ('approved', 'paid') and (
       new.approved_report is distinct from old.approved_report or new.approved_hash is distinct from old.approved_hash
       or new.report is distinct from old.report or new.period_start <> old.period_start or new.period_end <> old.period_end) then
    raise exception 'IMMUTABLE: el informe aprobado de la liquidación se conserva sin cambios' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_settlements before update or delete on public.quarterly_settlements
  for each row execute function public._guard_settlement_update();

-- ---------------------------------------------------------------------------
-- Contabilidad por partida doble
-- ---------------------------------------------------------------------------
-- Restricción diferida: cada transacción debe cuadrar (suma = 0) y tener al menos 2 asientos.
create or replace function public._check_tx_balanced()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sum bigint; v_count int;
begin
  select coalesce(sum(amount), 0), count(*) into v_sum, v_count from public.financial_entries where tx_id = new.tx_id;
  if v_sum <> 0 or v_count < 2 then
    raise exception 'UNBALANCED: la transacción % no cuadra (suma %, asientos %)', new.tx_id, v_sum, v_count;
  end if;
  return null;
end $$;
create constraint trigger financial_entries_balanced
  after insert on public.financial_entries deferrable initially deferred
  for each row execute function public._check_tx_balanced();

-- Bloqueo de periodos liquidados.
create or replace function public._check_period_open()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.kind <> 'settlement_close' and exists (
       select 1 from public.quarterly_settlements s
       where s.status in ('approved', 'paid') and new.occurred_on between s.period_start and s.period_end) then
    raise exception 'PERIOD_CLOSED: la fecha % pertenece a un periodo ya liquidado', new.occurred_on;
  end if;
  return new;
end $$;
create trigger financial_transactions_period_open
  before insert on public.financial_transactions for each row execute function public._check_period_open();

create or replace function public._account(p_code text, p_name text, p_kind public.account_kind,
                                           p_partner uuid default null, p_collector uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from public.capital_accounts where code = p_code;
  if v_id is null then
    insert into public.capital_accounts (code, name, kind, partner_id, collector_id)
    values (p_code, p_name, p_kind, p_partner, p_collector)
    on conflict (code) do nothing returning id into v_id;
    if v_id is null then select id into v_id from public.capital_accounts where code = p_code; end if;
  end if;
  return v_id;
end $$;

create or replace function public._acc_cash() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('CASH', 'Caja y bancos de administración', 'asset') $$;
create or replace function public._acc_loans() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('LOANS_RECEIVABLE', 'Capital colocado en préstamos', 'asset') $$;
create or replace function public._acc_interest() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('INTEREST_INCOME', 'Intereses recaudados', 'income') $$;
create or replace function public._acc_commission_expense() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('COMMISSION_EXPENSE', 'Comisiones de cobradores devengadas', 'expense') $$;
create or replace function public._acc_expenses() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('OPERATING_EXPENSES', 'Gastos autorizados', 'expense') $$;
create or replace function public._acc_adjustments() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('ADJUSTMENTS', 'Ajustes autorizados', 'income') $$;
create or replace function public._acc_retained() returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('RETAINED_RESULT', 'Resultado acumulado no distribuido', 'equity') $$;
create or replace function public._acc_collector_cash(p uuid) returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('COLLECTOR_CASH:' || p, 'Efectivo en poder del cobrador', 'asset', null, p) $$;
create or replace function public._acc_commission_payable(p uuid) returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('COMMISSION_PAYABLE:' || p, 'Comisiones por pagar al cobrador', 'liability', null, p) $$;
create or replace function public._acc_partner_capital(p uuid) returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('PARTNER_CAPITAL:' || p, 'Capital aportado por el socio', 'equity', p) $$;
create or replace function public._acc_partner_advances(p uuid) returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('PARTNER_ADVANCES:' || p, 'Anticipos de utilidades al socio', 'asset', p) $$;
create or replace function public._acc_partner_payable(p uuid) returns uuid language sql security definer set search_path = public, pg_temp as
$$ select public._account('PARTNER_PROFIT_PAYABLE:' || p, 'Utilidades por pagar al socio', 'liability', p) $$;

-- Registra una transacción. p_entries: [{"account": uuid, "amount": bigint}, ...]
create or replace function public._post_tx(p_kind text, p_description text, p_occurred_on date, p_entries jsonb,
                                           p_loan uuid default null, p_payment uuid default null,
                                           p_settlement uuid default null, p_reverses uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tx uuid; v_sum bigint;
begin
  select coalesce(sum((e ->> 'amount')::bigint), 0) into v_sum from jsonb_array_elements(p_entries) e;
  if v_sum <> 0 then raise exception 'UNBALANCED: asientos descuadrados (%).', v_sum; end if;
  insert into public.financial_transactions (kind, description, occurred_on, loan_id, payment_id, settlement_id, reverses_tx_id, created_by)
  values (p_kind, p_description, p_occurred_on, p_loan, p_payment, p_settlement, p_reverses, auth.uid())
  returning id into v_tx;
  insert into public.financial_entries (tx_id, account_id, amount)
  select v_tx, (e ->> 'account')::uuid, (e ->> 'amount')::bigint
  from jsonb_array_elements(p_entries) e where (e ->> 'amount')::bigint <> 0;
  return v_tx;
end $$;

create or replace function public._e(p_account uuid, p_amount bigint)
returns jsonb language sql immutable as $$ select jsonb_build_object('account', p_account, 'amount', p_amount) $$;

-- Saldo con signo (débito positivo) de las cuentas cuyo código coincide con el patrón.
create or replace function public._balance(p_code_like text, p_until date default null, p_from date default null)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(e.amount), 0)::bigint
  from public.financial_entries e
  join public.capital_accounts a on a.id = e.account_id
  join public.financial_transactions t on t.id = e.tx_id
  where a.code like p_code_like
    and (p_until is null or t.occurred_on <= p_until)
    and (p_from is null or t.occurred_on >= p_from)
$$;

-- ---------------------------------------------------------------------------
-- Reglas financieras puras (deben coincidir con src/lib/finance)
-- ---------------------------------------------------------------------------
create or replace function public.round_bps(p_amount bigint, p_bps integer)
returns bigint language sql immutable as $$
  -- Redondeo half-up en enteros: floor((monto × bps + 5000) / 10000). Montos siempre >= 0.
  select floor((p_amount::numeric * p_bps + 5000) / 10000)::bigint
$$;

create or replace function public.active_loan_policy()
returns public.loan_policies language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.loan_policies where status = 'active' limit 1
$$;

create or replace function public.allowed_frequencies(p_principal bigint, p_policy public.loan_policies)
returns public.loan_frequency[] language sql immutable as $$
  select case when p_principal >= p_policy.biweekly_min_principal
              then array['weekly', 'biweekly']::public.loan_frequency[]
              else array['weekly']::public.loan_frequency[] end
$$;

-- Valida condiciones contra la política y lanza un error descriptivo.
create or replace function public._validate_terms(p_principal bigint, p_n integer, p_frequency public.loan_frequency,
                                                  p_policy public.loan_policies)
returns void language plpgsql immutable as $$
begin
  if p_policy.id is null then raise exception 'POLICY_MISSING: no hay una política de préstamo activa'; end if;
  if p_principal is null or p_principal < p_policy.min_principal then
    raise exception 'INVALID_TERMS: el capital mínimo es %', p_policy.min_principal; end if;
  if p_policy.max_principal is not null and p_principal > p_policy.max_principal then
    raise exception 'INVALID_TERMS: el capital máximo es %', p_policy.max_principal; end if;
  if p_n is null or p_n < 1 or p_n > p_policy.max_installments then
    raise exception 'INVALID_TERMS: el número de cuotas debe estar entre 1 y %', p_policy.max_installments; end if;
  if not (p_frequency = any (public.allowed_frequencies(p_principal, p_policy))) then
    raise exception 'INVALID_TERMS: para importes inferiores a % solo se permite la modalidad semanal', p_policy.biweekly_min_principal; end if;
end $$;

-- Calendario: total = capital + interés; cuotas iguales con los pesos residuales
-- asignados a las primeras cuotas; el capital se reparte igual y el interés de
-- cada cuota es la diferencia, de modo que todas las sumas cuadran exactamente.
create or replace function public.build_schedule(p_principal bigint, p_n integer, p_frequency public.loan_frequency,
                                                 p_start date, p_policy public.loan_policies)
returns jsonb language plpgsql immutable as $$
declare
  v_interest bigint := public.round_bps(p_principal, p_policy.interest_bps);
  v_total bigint := p_principal + v_interest;
  v_days int := case p_frequency when 'weekly' then p_policy.weekly_interval_days else p_policy.biweekly_interval_days end;
  v_rows jsonb := '[]'::jsonb;
  v_balance bigint := v_total;
  v_inst_total bigint; v_inst_principal bigint;
begin
  for i in 1 .. p_n loop
    v_inst_total := v_total / p_n + case when i <= v_total % p_n then 1 else 0 end;
    v_inst_principal := p_principal / p_n + case when i <= p_principal % p_n then 1 else 0 end;
    v_balance := v_balance - v_inst_total;
    v_rows := v_rows || jsonb_build_object(
      'number', i,
      'due_date', p_start + v_days * i,
      'principal', v_inst_principal,
      'interest', v_inst_total - v_inst_principal,
      'total', v_inst_total,
      'balance_after', v_balance);
  end loop;
  return v_rows;
end $$;

-- Tasa efectiva anual equivalente (TIR diaria por bisección, base 365).
-- Se informa al cliente y se usa en el control de usura.
create or replace function public.effective_annual_rate(p_principal bigint, p_start date, p_schedule jsonb)
returns numeric language plpgsql immutable as $$
declare
  v_lo float8 := 0; v_hi float8 := 1; v_mid float8; v_npv float8; r record;
  v_total bigint := 0;
begin
  select coalesce(sum((x ->> 'total')::bigint), 0) into v_total from jsonb_array_elements(p_schedule) x;
  if v_total <= p_principal then return 0; end if;
  for k in 1 .. 200 loop
    v_mid := (v_lo + v_hi) / 2;
    v_npv := -p_principal;
    for r in select (x ->> 'total')::float8 as amt, ((x ->> 'due_date')::date - p_start) as days from jsonb_array_elements(p_schedule) x loop
      v_npv := v_npv + r.amt / power(1 + v_mid, r.days);
    end loop;
    if v_npv > 0 then v_lo := v_mid; else v_hi := v_mid; end if;
  end loop;
  return round((power(1 + (v_lo + v_hi) / 2, 365) - 1)::numeric, 6);
end $$;

-- Control normativo previo a aprobar o desembolsar.
create or replace function public._assert_compliance(p_ea numeric)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c jsonb := (select value from public.app_settings where key = 'compliance');
  v_cap numeric := nullif(c ->> 'usury_rate_ea_percent', '')::numeric;
  v_until date := nullif(c ->> 'usury_rate_valid_until', '')::date;
begin
  -- Modo demostración (portafolio / pruebas): no bloquea; el cambio de modo queda auditado.
  if coalesce(c ->> 'mode', 'enforce') = 'demo' then
    return;
  end if;
  if coalesce((c ->> 'legal_review_completed')::boolean, false) is not true then
    raise exception 'COMPLIANCE_BLOCKED: falta la revisión legal de las condiciones (Configuración → Cumplimiento)';
  end if;
  if v_cap is null or v_until is null or v_until < public.today_bogota() then
    raise exception 'COMPLIANCE_BLOCKED: registre la tasa de usura vigente certificada por la Superintendencia Financiera';
  end if;
  if p_ea * 100 > v_cap then
    raise exception 'COMPLIANCE_BLOCKED: la tasa efectiva anual del préstamo (% %%) supera la tasa de usura vigente (% %%)',
      round(p_ea * 100, 2), v_cap;
  end if;
end $$;

-- Reparto determinista de un monto entre socios activos según share_bps
-- (residuos de un peso por orden de seq).
create or replace function public.split_among_partners(p_amount bigint)
returns table (partner_id uuid, share_bps integer, amount bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_total_bps int; v_base bigint; v_rem bigint; r record; v_i int := 0;
begin
  select coalesce(sum(p.share_bps), 0) into v_total_bps from public.partners p where p.active;
  if v_total_bps <> 10000 then
    raise exception 'PARTNERS_INVALID: las participaciones de los socios activos deben sumar 100 %% (actual % bps)', v_total_bps;
  end if;
  select p_amount - coalesce(sum(floor(p_amount::numeric * p.share_bps / 10000)::bigint), 0)
    into v_rem from public.partners p where p.active;
  for r in select p.id, p.share_bps from public.partners p where p.active order by p.seq loop
    v_i := v_i + 1;
    v_base := floor(p_amount::numeric * r.share_bps / 10000)::bigint;
    partner_id := r.id; share_bps := r.share_bps;
    amount := v_base + case when v_i <= v_rem then 1 else 0 end;
    return next;
  end loop;
end $$;
