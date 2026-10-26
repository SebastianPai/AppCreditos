-- =============================================================================
-- CAPITAL CONTROL — 0011: eliminar préstamos y solicitudes de eliminación
-- * admin_purge_loan borra un préstamo con todo lo suyo (cuotas, pagos,
--   comisiones, asientos y la solicitud de crédito que lo originó), con las
--   mismas protecciones que la eliminación de clientes (0009).
-- * El cobrador ya no elimina nada: pide la eliminación de un cliente o de un
--   préstamo suyo con un motivo (request_deletion) y la administración la
--   acepta o la rechaza (decide_deletion_request).
-- * Toda eliminación —pedida por el cobrador o hecha directamente por la
--   administración— queda en deletion_requests: quién la pidió, el motivo, quién
--   la aceptó y qué se borró. La tabla no tiene llaves hacia lo eliminado, así
--   que el registro sobrevive; además queda en la auditoría.
-- =============================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create table public.deletion_requests (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('customer', 'loan')),
  customer_id    uuid not null,       -- sin llave foránea: el registro sobrevive a la eliminación
  loan_id        uuid,
  label          text not null,       -- código y nombre al momento de pedirla
  requested_by   uuid not null references public.profiles (id),
  reason         text not null check (length(trim(reason)) >= 5),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by     uuid references public.profiles (id),
  decided_at     timestamptz,
  decision_notes text,
  result         jsonb,
  created_at     timestamptz not null default now(),
  constraint deletion_requests_target_chk check ((kind = 'loan') = (loan_id is not null))
);
create unique index deletion_requests_one_pending on public.deletion_requests (kind, coalesce(loan_id, customer_id)) where status = 'pending';
create index deletion_requests_status_idx on public.deletion_requests (status, created_at desc);

alter table public.deletion_requests enable row level security;
alter table public.deletion_requests force row level security;
create policy deletion_requests_system on public.deletion_requests for all using (public.is_system()) with check (public.is_system());
create policy deletion_requests_select on public.deletion_requests for select
  using (public.is_admin() or requested_by = auth.uid());

create trigger audit_deletion_requests after insert or update or delete on public.deletion_requests
  for each row execute function public.audit_row();

-- Un registro de eliminación no se borra.
create or replace function public._guard_deletion_request()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: el registro de eliminaciones no se borra' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'IMMUTABLE: la solicitud ya fue resuelta' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_deletion_requests before update or delete on public.deletion_requests
  for each row execute function public._guard_deletion_request();

-- ---------------------------------------------------------------------------
-- Borrado de préstamos (uso interno de las funciones de administración)
-- ---------------------------------------------------------------------------
create or replace function public._purge_loans(p_loans uuid[])
returns jsonb language plpgsql as $$
declare
  v_payments uuid[];
  v_txs uuid[];
  v_apps uuid[];
begin
  if not public.is_system() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(array_agg(id), '{}') into v_payments from public.payments where loan_id = any (p_loans);
  select coalesce(array_agg(application_id), '{}') into v_apps from public.loans where id = any (p_loans) and application_id is not null;
  select coalesce(array_agg(distinct id), '{}') into v_txs from (
    select id from public.financial_transactions where loan_id = any (p_loans) or payment_id = any (v_payments)
    union select tx_id from public.payments where id = any (v_payments)
    union select reversal_tx_id from public.payments where id = any (v_payments) and reversal_tx_id is not null
    union select disbursement_tx_id from public.loans where id = any (p_loans) and disbursement_tx_id is not null) t;

  if exists (select 1 from public.collector_commissions
             where (loan_id = any (p_loans) or payment_id = any (v_payments)) and payout_id is not null) then
    raise exception 'INVALID: la comisión de este préstamo ya se pagó al cobrador; no se puede eliminar';
  end if;
  if exists (select 1 from public.financial_transactions t join public.quarterly_settlements s
               on t.occurred_on between s.period_start and s.period_end and s.status in ('approved', 'paid')
             where t.id = any (v_txs)) then
    raise exception 'PERIOD_CLOSED: hay movimientos en un periodo ya liquidado; no se puede eliminar';
  end if;

  perform set_config('app.purge_test_customer', 'on', true);
  delete from public.payment_allocations where payment_id = any (v_payments);
  delete from public.collector_commissions where loan_id = any (p_loans) or payment_id = any (v_payments);
  delete from public.reversal_requests where payment_id = any (v_payments);
  update public.payment_requests set payment_id = null where payment_id = any (v_payments);
  delete from public.payments where id = any (v_payments);
  delete from public.payment_requests where loan_id = any (p_loans);
  delete from public.loan_installments where loan_id = any (p_loans);
  delete from public.loans where id = any (p_loans);
  delete from public.loan_applications where id = any (v_apps);
  delete from public.financial_entries where tx_id = any (v_txs);
  delete from public.financial_transactions where id = any (v_txs);
  perform set_config('app.purge_test_customer', '', true);
  return jsonb_build_object('loans', cardinality(p_loans), 'payments', cardinality(v_payments));
end $$;

-- Cierra las solicitudes pendientes de lo eliminado y deja el registro (si la
-- administración eliminó sin solicitud previa, el registro es suyo).
create or replace function public._record_deletion(p_kind text, p_customer_id uuid, p_loan_id uuid, p_label text,
                                                   p_reason text, p_result jsonb)
returns void language plpgsql as $$
declare v_had_request boolean;
begin
  if not public.is_system() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select exists (select 1 from public.deletion_requests where status = 'pending' and kind = p_kind
                  and customer_id = p_customer_id and loan_id is not distinct from p_loan_id) into v_had_request;
  update public.deletion_requests
     set status = 'approved', decided_by = auth.uid(), decided_at = now(), result = p_result,
         decision_notes = case when kind = p_kind then decision_notes else coalesce(decision_notes, 'Eliminado junto con el cliente') end
   where status = 'pending'
     and ((p_kind = 'customer' and customer_id = p_customer_id) or (p_kind = 'loan' and loan_id = p_loan_id));
  if not v_had_request then
    insert into public.deletion_requests (kind, customer_id, loan_id, label, requested_by, reason, status, decided_by, decided_at, result)
    values (p_kind, p_customer_id, p_loan_id, p_label, auth.uid(), trim(p_reason), 'approved', auth.uid(), now(), p_result);
  end if;
end $$;

create or replace function public._require_deletion_reason(p_reason text) returns void language plpgsql as $$
begin
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'INVALID: escriba el motivo de la eliminación (mínimo 5 caracteres)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Eliminación directa por la administración
-- ---------------------------------------------------------------------------
drop function if exists public.admin_purge_test_customer(uuid, text);
create or replace function public.admin_purge_test_customer(p_customer_id uuid, p_confirm text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.customers;
  v_loans uuid[];
  v_result jsonb;
begin
  perform public._require_role('admin');
  if upper(trim(coalesce(p_confirm, ''))) <> 'ELIMINAR' then
    raise exception 'INVALID: escriba ELIMINAR para confirmar';
  end if;
  select * into c from public.customers where id = p_customer_id for update;
  if c.id is null then raise exception 'NOT_FOUND: cliente inexistente'; end if;
  if p_reason is null then
    -- Aprobación de una solicitud: el motivo es el del cobrador.
    select reason into p_reason from public.deletion_requests where status = 'pending' and kind = 'customer' and customer_id = c.id;
  end if;
  perform public._require_deletion_reason(p_reason);

  select coalesce(array_agg(id), '{}') into v_loans from public.loans where customer_id = c.id;
  v_result := public._purge_loans(v_loans);

  perform set_config('app.purge_test_customer', 'on', true);
  delete from public.payment_requests where customer_id = c.id;
  delete from public.loan_applications where customer_id = c.id or (c.profile_id is not null and submitted_by = c.profile_id);
  delete from public.loan_simulations where customer_id = c.id or (c.profile_id is not null and created_by = c.profile_id);
  delete from public.stored_files where customer_id = c.id or (c.profile_id is not null and uploaded_by = c.profile_id);
  delete from public.customers where id = c.id;
  if c.profile_id is not null then delete from auth.users where id = c.profile_id; end if;
  perform set_config('app.purge_test_customer', '', true);

  perform public._record_deletion('customer', c.id, null, c.code || ' · ' || c.full_name, p_reason, v_result);
  perform public._audit('purge_test_customer', 'customers', c.id::text,
    jsonb_build_object('code', c.code, 'reason', p_reason) || v_result);
  return v_result;
end $$;

create or replace function public.admin_purge_loan(p_loan_id uuid, p_confirm text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l public.loans;
  v_name text;
  v_result jsonb;
begin
  perform public._require_role('admin');
  if upper(trim(coalesce(p_confirm, ''))) <> 'ELIMINAR' then
    raise exception 'INVALID: escriba ELIMINAR para confirmar';
  end if;
  select * into l from public.loans where id = p_loan_id for update;
  if l.id is null then raise exception 'NOT_FOUND: préstamo inexistente'; end if;
  if p_reason is null then
    select reason into p_reason from public.deletion_requests where status = 'pending' and kind = 'loan' and loan_id = l.id;
  end if;
  perform public._require_deletion_reason(p_reason);
  select full_name into v_name from public.customers where id = l.customer_id;

  v_result := public._purge_loans(array[l.id]) || jsonb_build_object('principal', l.principal, 'status', l.status);

  perform public._record_deletion('loan', l.customer_id, l.id, l.code || ' · ' || v_name, p_reason, v_result);
  perform public._audit('purge_loan', 'loans', l.id::text,
    jsonb_build_object('code', l.code, 'customer_id', l.customer_id, 'reason', p_reason) || v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Solicitudes del cobrador y decisión de la administración
-- ---------------------------------------------------------------------------
create or replace function public.request_deletion(p_kind text, p_target_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'collector');
  v_customer uuid;
  v_loan uuid;
  v_label text;
  v_id uuid;
begin
  perform public._require_deletion_reason(p_reason);
  if p_kind = 'customer' then
    select c.id, c.code || ' · ' || c.full_name into v_customer, v_label
      from public.customers c where c.id = p_target_id and (v_role = 'admin' or c.collector_id = auth.uid());
  elsif p_kind = 'loan' then
    select l.customer_id, l.id, l.code || ' · ' || c.full_name into v_customer, v_loan, v_label
      from public.loans l join public.customers c on c.id = l.customer_id
     where l.id = p_target_id and (v_role = 'admin' or l.collector_id = auth.uid());
  else
    raise exception 'INVALID: tipo de eliminación desconocido';
  end if;
  if v_customer is null then raise exception 'FORBIDDEN: no puede pedir esta eliminación' using errcode = '42501'; end if;
  if exists (select 1 from public.deletion_requests where status = 'pending' and kind = p_kind
              and customer_id = v_customer and loan_id is not distinct from v_loan) then
    raise exception 'INVALID: ya hay una solicitud pendiente; la administración la está revisando';
  end if;
  insert into public.deletion_requests (kind, customer_id, loan_id, label, requested_by, reason)
  values (p_kind, v_customer, v_loan, v_label, auth.uid(), trim(p_reason))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.decide_deletion_request(p_request_id uuid, p_approve boolean, p_notes text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.deletion_requests;
begin
  perform public._require_role('admin');
  select * into r from public.deletion_requests where id = p_request_id and status = 'pending' for update;
  if r.id is null then raise exception 'NOT_FOUND: solicitud de eliminación inexistente o resuelta'; end if;
  if not p_approve then
    update public.deletion_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_notes = nullif(trim(p_notes), '')
    where id = r.id;
    return null;
  end if;
  update public.deletion_requests set decision_notes = nullif(trim(p_notes), '') where id = r.id;
  if r.kind = 'customer' then
    return public.admin_purge_test_customer(r.customer_id, 'ELIMINAR', r.reason);
  end if;
  return public.admin_purge_loan(r.loan_id, 'ELIMINAR', r.reason);
end $$;

alter function public.admin_purge_test_customer(uuid, text, text) set application_name = 'capital_control_system';
alter function public.admin_purge_loan(uuid, text, text) set application_name = 'capital_control_system';
alter function public.request_deletion(text, uuid, text) set application_name = 'capital_control_system';
alter function public.decide_deletion_request(uuid, boolean, text) set application_name = 'capital_control_system';
