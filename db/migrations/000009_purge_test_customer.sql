-- =============================================================================
-- CAPITAL CONTROL — 0009: eliminar clientes de prueba
-- admin_purge_test_customer borra un cliente y todo lo suyo (acceso a la app,
-- solicitudes, préstamos, cuotas, pagos, comprobantes, comisiones y asientos
-- contables) para que no afecte saldos ni informes.
-- * Solo administradores, con la palabra ELIMINAR como confirmación.
-- * La auditoría NO se borra: las protecciones solo se levantan, dentro de la
--   función, para las tablas del cliente; audit_logs sigue inmutable y la
--   eliminación queda registrada.
-- * Se rechaza si el cliente ya entró en una liquidación aprobada o en una
--   comisión pagada al cobrador (ya no sería un dato «de prueba»).
-- =============================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create or replace function public._purging() returns boolean language sql stable as $$
  select coalesce(current_setting('app.purge_test_customer', true), '') = 'on'
$$;

create or replace function public._forbid_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and tg_table_name <> 'audit_logs' and public._purging() then return old; end if;
  raise exception 'IMMUTABLE: los registros de % no se pueden modificar ni borrar; registre un reverso', tg_table_name
    using errcode = '42501';
end $$;

create or replace function public._guard_payment_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if public._purging() then return old; end if;
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
  if new.start_date <> old.start_date and old.status <> 'approved' then
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
  if new.due_date <> old.due_date then
    select status into v_status from public.loans where id = new.loan_id;
    if v_status <> 'approved' then
      raise exception 'IMMUTABLE: el vencimiento solo cambia antes del desembolso' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public._guard_commission_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and public._purging() then return old; end if;
  if tg_op = 'DELETE' or (new.collector_id, new.loan_id, new.payment_id, new.kind, new.amount)
     is distinct from (old.collector_id, old.loan_id, old.payment_id, old.kind, old.amount) then
    raise exception 'IMMUTABLE: las comisiones se generan automáticamente y no se alteran' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.admin_purge_test_customer(p_customer_id uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.customers;
  v_loans uuid[];
  v_payments uuid[];
  v_txs uuid[];
begin
  perform public._require_role('admin');
  if upper(trim(coalesce(p_confirm, ''))) <> 'ELIMINAR' then
    raise exception 'INVALID: escriba ELIMINAR para confirmar';
  end if;
  select * into c from public.customers where id = p_customer_id for update;
  if c.id is null then raise exception 'NOT_FOUND: cliente inexistente'; end if;

  select coalesce(array_agg(id), '{}') into v_loans from public.loans where customer_id = c.id;
  select coalesce(array_agg(id), '{}') into v_payments from public.payments where customer_id = c.id or loan_id = any (v_loans);
  select coalesce(array_agg(distinct id), '{}') into v_txs from (
    select id from public.financial_transactions where loan_id = any (v_loans) or payment_id = any (v_payments)
    union select tx_id from public.payments where id = any (v_payments)
    union select reversal_tx_id from public.payments where id = any (v_payments) and reversal_tx_id is not null
    union select disbursement_tx_id from public.loans where id = any (v_loans) and disbursement_tx_id is not null) t;

  if exists (select 1 from public.collector_commissions
             where (loan_id = any (v_loans) or payment_id = any (v_payments)) and payout_id is not null) then
    raise exception 'INVALID: la comisión de este cliente ya se pagó al cobrador; no se puede eliminar';
  end if;
  if exists (select 1 from public.financial_transactions t join public.quarterly_settlements s
               on t.occurred_on between s.period_start and s.period_end and s.status in ('approved', 'paid')
             where t.id = any (v_txs)) then
    raise exception 'PERIOD_CLOSED: el cliente tiene movimientos en un periodo ya liquidado; no se puede eliminar';
  end if;

  perform set_config('app.purge_test_customer', 'on', true);
  delete from public.payment_allocations where payment_id = any (v_payments);
  delete from public.collector_commissions where loan_id = any (v_loans) or payment_id = any (v_payments);
  delete from public.reversal_requests where payment_id = any (v_payments);
  update public.payment_requests set payment_id = null where payment_id = any (v_payments);
  delete from public.payments where id = any (v_payments);
  delete from public.payment_requests where customer_id = c.id or loan_id = any (v_loans);
  delete from public.loan_installments where loan_id = any (v_loans);
  delete from public.loans where id = any (v_loans);
  delete from public.financial_entries where tx_id = any (v_txs);
  delete from public.financial_transactions where id = any (v_txs);
  delete from public.loan_applications where customer_id = c.id or (c.profile_id is not null and submitted_by = c.profile_id);
  delete from public.loan_simulations where customer_id = c.id or (c.profile_id is not null and created_by = c.profile_id);
  delete from public.stored_files where customer_id = c.id or (c.profile_id is not null and uploaded_by = c.profile_id);
  delete from public.customers where id = c.id;
  if c.profile_id is not null then delete from auth.users where id = c.profile_id; end if;
  perform set_config('app.purge_test_customer', '', true);

  perform public._audit('purge_test_customer', 'customers', c.id::text,
    jsonb_build_object('code', c.code, 'loans', cardinality(v_loans), 'payments', cardinality(v_payments)));
  return jsonb_build_object('loans', cardinality(v_loans), 'payments', cardinality(v_payments));
end $$;

alter function public.admin_purge_test_customer(uuid, text) set application_name = 'capital_control_system';
alter function public._guard_installment_update() set application_name = 'capital_control_system';
