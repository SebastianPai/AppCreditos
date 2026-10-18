-- =============================================================================
-- CAPITAL CONTROL — 0004: Row Level Security
-- La aplicación usa un único usuario de base de datos (propietario, no
-- superusuario). FORCE ROW LEVEL SECURITY hace que las políticas se apliquen
-- también a ese usuario. El usuario de cada petición se identifica con
-- request.jwt.claims (auth.uid()). Las escrituras financieras solo ocurren dentro
-- de funciones SECURITY DEFINER, que corren en contexto de sistema (ver 0000).
-- =============================================================================

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    -- Acceso total solo en contexto de sistema (funciones verificadas o tareas del servidor).
    execute format('create policy %I on public.%I for all using (public.is_system()) with check (public.is_system())', t || '_system', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Políticas de lectura por rol (y escrituras directas puntuales)
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin()
         or (public.current_app_role() = 'partner' and role in ('partner', 'collector', 'admin')));

create policy permissions_select on public.permissions for select using (true);
create policy role_permissions_select on public.role_permissions for select using (true);
create policy user_permissions_select on public.user_permissions for select
  using (user_id = auth.uid() or public.is_admin());

create policy app_settings_select on public.app_settings for select
  using (public.is_admin() or key in ('company', 'payment_instructions'));

create policy loan_policies_select on public.loan_policies for select
  using (public.is_admin() or status = 'active');

-- Capital y contabilidad: administración y socios
create policy partners_select on public.partners for select
  using (public.is_admin() or public.current_app_role() = 'partner');
create policy capital_accounts_select on public.capital_accounts for select using (public.is_admin());
create policy financial_transactions_select on public.financial_transactions for select using (public.is_admin());
create policy financial_entries_select on public.financial_entries for select using (public.is_admin());
create policy capital_contributions_select on public.capital_contributions for select
  using (public.is_admin()
         or (public.current_app_role() = 'partner' and (
               partner_id in (select id from public.partners where profile_id = auth.uid())
               or public.has_permission('partner.view_all_contributions'))));
create policy expenses_select on public.expenses for select
  using (public.is_admin() or public.current_app_role() = 'partner');

-- Clientes
create policy customers_select on public.customers for select using (public.can_view_customer(id));

create policy loan_simulations_select on public.loan_simulations for select
  using (public.is_admin() or created_by = auth.uid() or (customer_id is not null and customer_id = public.my_customer_id()));

create policy loan_applications_select on public.loan_applications for select
  using (public.can_view_customer(customer_id));

-- Préstamos, cuotas y pagos
create policy loans_select on public.loans for select using (public.can_view_loan(id));
create policy loan_installments_select on public.loan_installments for select using (public.can_view_loan(loan_id));
create policy payments_select on public.payments for select using (public.can_view_loan(loan_id));
create policy payment_allocations_select on public.payment_allocations for select
  using (exists (select 1 from public.payments p where p.id = payment_id and public.can_view_loan(p.loan_id)));
create policy reversal_requests_select on public.reversal_requests for select
  using (public.is_admin() or requested_by = auth.uid());

create policy payment_methods_select on public.payment_methods for select using (active or public.is_admin());
create policy payment_methods_insert on public.payment_methods for insert with check (public.is_admin());
create policy payment_methods_update on public.payment_methods for update using (public.is_admin()) with check (public.is_admin());

create policy payment_requests_select on public.payment_requests for select
  using (public.can_view_customer(customer_id));

-- Cobradores
create policy collector_payouts_select on public.collector_payouts for select
  using (public.is_admin() or collector_id = auth.uid());
create policy collector_commissions_select on public.collector_commissions for select
  using (public.is_admin() or collector_id = auth.uid());
create policy cash_handovers_select on public.cash_handovers for select
  using (public.is_admin() or collector_id = auth.uid());

-- Liquidaciones
create policy quarterly_settlements_select on public.quarterly_settlements for select
  using (public.is_admin() or (public.current_app_role() = 'partner' and status <> 'draft'));
create policy settlement_distributions_select on public.settlement_distributions for select
  using (public.is_admin() or partner_id in (select id from public.partners where profile_id = auth.uid())
         or (public.current_app_role() = 'partner' and public.has_permission('partner.view_all_contributions')));

-- Notificaciones (propias)
create policy notification_preferences_select on public.notification_preferences for select using (user_id = auth.uid());
create policy notification_preferences_update on public.notification_preferences for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_subscriptions_select on public.notification_subscriptions for select using (user_id = auth.uid());
create policy notification_subscriptions_insert on public.notification_subscriptions for insert with check (user_id = auth.uid());
create policy notification_subscriptions_delete on public.notification_subscriptions for delete using (user_id = auth.uid());

-- Auditoría
create policy audit_logs_select on public.audit_logs for select using (public.is_admin());


-- Cuentas: el administrador consulta correos y último ingreso (nunca el hash; la app no lo selecciona).
create policy users_admin_select on auth.users for select using (public.is_admin());

-- Archivos: QR visibles para usuarios autenticados; comprobantes solo para quien puede ver al cliente.
create policy stored_files_select on public.stored_files for select
  using (auth.uid() is not null and (bucket = 'payment-methods' or public.can_view_customer(customer_id)));
create policy stored_files_insert on public.stored_files for insert
  with check (uploaded_by = auth.uid() and (
    (bucket = 'payment-methods' and public.is_admin())
    or (bucket = 'payment-evidence' and public.current_app_role() in ('admin', 'collector', 'customer')
        and public.can_view_customer(customer_id))));

-- ---------------------------------------------------------------------------
-- Toda función SECURITY DEFINER corre en contexto de sistema (se restaura al salir).
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef loop
    execute format('alter function %s set application_name = %L', f.sig, 'capital_control_system');
  end loop;
end $$;
