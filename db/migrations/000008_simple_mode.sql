-- =============================================================================
-- CAPITAL CONTROL — 0008: modo sencillo
-- * El personal puede ingresar con un nombre de usuario (p. ej. tatiana.rodriguez)
--   además del correo.
-- * create_simple_loan: el cobrador (o el administrador) crea el préstamo de un
--   cliente en un solo paso: queda aprobado, entregado y activo desde hoy.
-- =============================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

alter table auth.users drop constraint if exists users_email_check;
alter table auth.users drop constraint if exists users_login_chk;
alter table auth.users add constraint users_login_chk
  check (email = lower(email) and (email ~ '^[^@\s]+@[^@\s]+$' or email ~ '^[a-z0-9._-]{3,60}$'));

create or replace function public.create_simple_loan(p_customer_id uuid, p_principal bigint, p_installments integer,
                                                     p_frequency public.loan_frequency, p_collector_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role := public._require_role('admin', 'collector');
  v_today date := public.today_bogota();
  v_collector uuid;
  v_app uuid;
  v_loan uuid;
  v_tx uuid;
  l public.loans;
begin
  if v_role = 'collector' then
    if not exists (select 1 from public.customers where id = p_customer_id and collector_id = auth.uid()) then
      raise exception 'FORBIDDEN: el cliente no es suyo' using errcode = '42501';
    end if;
    v_collector := auth.uid();
  else
    v_collector := coalesce(p_collector_id, (select collector_id from public.customers where id = p_customer_id));
    if v_collector is null then raise exception 'INVALID: elija el cobrador del préstamo'; end if;
  end if;
  -- Una solicitud abierta anterior impediría crear la nueva: se cierra.
  update public.loan_applications set status = 'rejected', admin_notes = 'Reemplazada por un préstamo directo',
         decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where customer_id = p_customer_id and status in ('pending', 'info_requested', 'counter_offered', 'accepted_by_customer');

  v_app := public.create_application(p_principal, p_installments, p_frequency, v_today, null, p_customer_id, null);
  v_loan := public.approve_application(v_app, v_collector, p_principal, p_installments, p_frequency, v_today);

  -- Entrega inmediata del dinero (mismo asiento que disburse_loan).
  select * into l from public.loans where id = v_loan for update;
  v_tx := public._post_tx('disbursement', 'Desembolso préstamo ' || l.code, v_today,
            jsonb_build_array(public._e(public._acc_loans(), l.principal), public._e(public._acc_cash(), -l.principal)), l.id);
  update public.loans set status = 'active', disbursed_by = auth.uid(), disbursed_at = now(), disbursement_tx_id = v_tx
   where id = l.id;
  perform public._audit('create_simple_loan', 'loans', v_loan::text,
                        jsonb_build_object('principal', p_principal, 'installments', p_installments, 'frequency', p_frequency));
  return v_loan;
end $$;

alter function public.create_simple_loan(uuid, bigint, integer, public.loan_frequency, uuid)
  set application_name = 'capital_control_system';
