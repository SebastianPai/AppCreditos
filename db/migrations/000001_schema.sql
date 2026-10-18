-- =============================================================================
-- CAPITAL CONTROL — 0001: esquema relacional
-- Importes monetarios: pesos colombianos (COP) enteros en BIGINT. COP no usa
-- centavos en la operación de cobro, por lo que todos los cálculos son exactos
-- en enteros y los residuos se reparten de forma determinista.
-- Zona horaria de negocio: America/Bogota.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tipos enumerados
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'collector', 'partner', 'customer');
create type public.loan_frequency as enum ('weekly', 'biweekly');
create type public.customer_status as enum ('active', 'inactive', 'blocked');
create type public.application_status as enum (
  'pending', 'info_requested', 'counter_offered', 'accepted_by_customer',
  'approved', 'rejected', 'cancelled'
);
create type public.loan_status as enum ('approved', 'active', 'paid', 'cancelled');
create type public.installment_status as enum ('pending', 'partial', 'paid', 'overdue', 'in_review');
create type public.payment_method_type as enum ('cash', 'transfer', 'qr', 'gateway');
create type public.payment_status as enum ('confirmed', 'reversed');
create type public.payment_request_status as enum (
  'requested', 'pending_verification', 'confirmed', 'rejected', 'cancelled'
);
create type public.workflow_status as enum ('draft', 'pending_approval', 'approved', 'paid', 'cancelled');
create type public.account_kind as enum ('asset', 'liability', 'equity', 'income', 'expense');

-- ---------------------------------------------------------------------------
-- Usuarios, roles y permisos
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.app_role not null default 'customer',
  full_name   text not null check (length(trim(full_name)) between 2 and 160),
  phone       text check (phone is null or phone ~ '^[0-9+ ]{7,20}$'),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index profiles_role_idx on public.profiles (role) where active;

create table public.permissions (
  code        text primary key,
  description text not null
);

create table public.role_permissions (
  role            public.app_role not null,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role, permission_code)
);

-- Permisos explícitos adicionales por usuario (p. ej. un cobrador supervisor).
create table public.user_permissions (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  granted_by      uuid references public.profiles (id),
  granted_at      timestamptz not null default now(),
  primary key (user_id, permission_code)
);

-- ---------------------------------------------------------------------------
-- Configuración
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references public.profiles (id),
  updated_at  timestamptz not null default now()
);

-- Políticas de préstamo versionadas: un cambio crea una versión nueva que solo
-- aplica a préstamos creados después de su activación. Cada préstamo guarda una
-- copia de las tasas con las que se aprobó.
create table public.loan_policies (
  id                       uuid primary key default gen_random_uuid(),
  version                  integer not null unique check (version > 0),
  interest_bps             integer not null check (interest_bps between 0 and 10000),
  collector_commission_bps integer not null check (collector_commission_bps between 0 and 10000),
  partners_bps             integer not null check (partners_bps between 0 and 10000),
  max_installments         integer not null check (max_installments between 1 and 5),
  biweekly_min_principal   bigint  not null check (biweekly_min_principal >= 0),
  min_principal            bigint  not null check (min_principal > 0),
  max_principal            bigint  check (max_principal is null or max_principal >= min_principal),
  weekly_interval_days     integer not null default 7  check (weekly_interval_days = 7),
  biweekly_interval_days   integer not null default 15 check (biweekly_interval_days in (14, 15)),
  status                   text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  notes                    text,
  created_by               uuid references public.profiles (id),
  activated_by             uuid references public.profiles (id),
  activated_at             timestamptz,
  created_at               timestamptz not null default now(),
  constraint loan_policies_split_chk check (collector_commission_bps + partners_bps = interest_bps)
);
create unique index loan_policies_one_active on public.loan_policies ((status)) where status = 'active';

-- ---------------------------------------------------------------------------
-- Socios y capital
-- ---------------------------------------------------------------------------
create table public.partners (
  id           uuid primary key default gen_random_uuid(),
  seq          smallint not null unique check (seq > 0),
  profile_id   uuid unique references public.profiles (id),
  display_name text not null,
  share_bps    integer not null check (share_bps between 0 and 10000),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Plan de cuentas (contabilidad por partida doble).
create table public.capital_accounts (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  kind         public.account_kind not null,
  partner_id   uuid references public.partners (id),
  collector_id uuid references public.profiles (id),
  created_at   timestamptz not null default now()
);

create sequence public.tx_number_seq;
create table public.financial_transactions (
  id             uuid primary key default gen_random_uuid(),
  tx_number      bigint not null unique default nextval('public.tx_number_seq'),
  kind           text not null check (kind in (
                   'capital_contribution', 'capital_withdrawal', 'partner_advance',
                   'disbursement', 'payment', 'payment_reversal', 'cash_handover',
                   'commission_payout', 'expense', 'settlement_close',
                   'distribution_payment', 'adjustment')),
  occurred_on    date not null,
  occurred_at    timestamptz not null default now(),
  description    text not null,
  loan_id        uuid,
  payment_id     uuid,
  settlement_id  uuid,
  reverses_tx_id uuid unique references public.financial_transactions (id),
  created_by     uuid references public.profiles (id),
  created_at     timestamptz not null default now()
);
create index financial_transactions_date_idx on public.financial_transactions (occurred_on);
create index financial_transactions_kind_idx on public.financial_transactions (kind, occurred_on);

-- Convención de signos: débito > 0, crédito < 0. La suma por transacción es 0.
create table public.financial_entries (
  id         bigint generated always as identity primary key,
  tx_id      uuid not null references public.financial_transactions (id),
  account_id uuid not null references public.capital_accounts (id),
  amount     bigint not null check (amount <> 0)
);
create index financial_entries_tx_idx on public.financial_entries (tx_id);
create index financial_entries_account_idx on public.financial_entries (account_id);

create table public.capital_contributions (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references public.partners (id),
  kind        text not null check (kind in ('contribution', 'withdrawal', 'advance')),
  amount      bigint not null check (amount > 0),
  occurred_on date not null,
  notes       text,
  tx_id       uuid not null references public.financial_transactions (id),
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now()
);
create index capital_contributions_partner_idx on public.capital_contributions (partner_id, occurred_on);

create table public.expenses (
  id          uuid primary key default gen_random_uuid(),
  amount      bigint not null check (amount > 0),
  category    text not null,
  description text not null,
  occurred_on date not null,
  tx_id       uuid not null references public.financial_transactions (id),
  approved_by uuid not null references public.profiles (id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Clientes
-- ---------------------------------------------------------------------------
create sequence public.customer_code_seq;
create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique default ('CL-' || lpad(nextval('public.customer_code_seq')::text, 6, '0')),
  profile_id      uuid unique references public.profiles (id),
  full_name       text not null check (length(trim(full_name)) between 3 and 160),
  document_type   text not null check (document_type in ('CC', 'CE', 'TI', 'PA', 'PPT', 'NIT')),
  document_number text not null check (document_number ~ '^[0-9A-Za-z]{3,20}$'),
  phone           text not null check (phone ~ '^[0-9+ ]{7,20}$'),
  address         text,
  collector_id    uuid references public.profiles (id),
  status          public.customer_status not null default 'active',
  notes           text,
  data_consent_at timestamptz,        -- autorización de tratamiento de datos (Ley 1581 de 2012)
  registered_at   timestamptz not null default now(),
  created_by      uuid references public.profiles (id),
  constraint customers_document_unique unique (document_type, document_number)
);
create index customers_collector_idx on public.customers (collector_id) where status = 'active';
create index customers_name_idx on public.customers (lower(full_name));

-- ---------------------------------------------------------------------------
-- Simulaciones y solicitudes (separadas de los préstamos reales)
-- ---------------------------------------------------------------------------
create table public.loan_simulations (
  id                         uuid primary key default gen_random_uuid(),
  customer_id                uuid references public.customers (id),
  created_by                 uuid references public.profiles (id),
  policy_id                  uuid not null references public.loan_policies (id),
  principal                  bigint not null check (principal > 0),
  installments_count         integer not null check (installments_count between 1 and 5),
  frequency                  public.loan_frequency not null,
  start_date                 date not null,
  interest_bps               integer not null,
  interest_total             bigint not null,
  total_amount               bigint not null,
  schedule                   jsonb not null,
  effective_annual_rate      numeric(20, 6) not null,
  created_at                 timestamptz not null default now(),
  constraint loan_simulations_total_chk check (total_amount = principal + interest_total)
);
create index loan_simulations_created_idx on public.loan_simulations (created_at desc);
create index loan_simulations_customer_idx on public.loan_simulations (customer_id);

create sequence public.application_code_seq;
create table public.loan_applications (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique default ('SOL-' || lpad(nextval('public.application_code_seq')::text, 6, '0')),
  customer_id          uuid not null references public.customers (id),
  simulation_id        uuid references public.loan_simulations (id),
  requested_principal  bigint not null check (requested_principal > 0),
  requested_installments integer not null check (requested_installments between 1 and 5),
  requested_frequency  public.loan_frequency not null,
  requested_start_date date not null,
  customer_message     text,
  status               public.application_status not null default 'pending',
  admin_notes          text,
  proposed_principal   bigint check (proposed_principal is null or proposed_principal > 0),
  proposed_installments integer check (proposed_installments is null or proposed_installments between 1 and 5),
  proposed_frequency   public.loan_frequency,
  proposed_start_date  date,
  customer_response_at timestamptz,
  decided_by           uuid references public.profiles (id),
  decided_at           timestamptz,
  submitted_by         uuid references public.profiles (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index loan_applications_status_idx on public.loan_applications (status, created_at desc);
create index loan_applications_customer_idx on public.loan_applications (customer_id);

-- ---------------------------------------------------------------------------
-- Préstamos y cuotas
-- ---------------------------------------------------------------------------
create sequence public.loan_code_seq;
create table public.loans (
  id                         uuid primary key default gen_random_uuid(),
  code                       text not null unique default ('PR-' || lpad(nextval('public.loan_code_seq')::text, 6, '0')),
  customer_id                uuid not null references public.customers (id),
  application_id             uuid unique references public.loan_applications (id),
  collector_id               uuid not null references public.profiles (id),
  policy_id                  uuid not null references public.loan_policies (id),
  principal                  bigint not null check (principal > 0),
  interest_bps               integer not null check (interest_bps between 0 and 10000),
  interest_total             bigint not null check (interest_total >= 0),
  total_amount               bigint not null,
  collector_commission_bps   integer not null,
  collector_commission_total bigint not null check (collector_commission_total >= 0),
  partners_pool_total        bigint not null check (partners_pool_total >= 0),
  installments_count         integer not null check (installments_count between 1 and 5),
  frequency                  public.loan_frequency not null,
  start_date                 date not null,
  effective_annual_rate      numeric(20, 6) not null,
  status                     public.loan_status not null default 'approved',
  approved_by                uuid not null references public.profiles (id),
  approved_at                timestamptz not null default now(),
  disbursed_by               uuid references public.profiles (id),
  disbursed_at               timestamptz,
  disbursement_tx_id         uuid references public.financial_transactions (id),
  cancelled_reason           text,
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now(),
  constraint loans_total_chk check (total_amount = principal + interest_total),
  constraint loans_split_chk check (collector_commission_total + partners_pool_total = interest_total)
);
create index loans_customer_idx on public.loans (customer_id);
create index loans_collector_idx on public.loans (collector_id, status);
create index loans_status_idx on public.loans (status);

create table public.loan_installments (
  id               uuid primary key default gen_random_uuid(),
  loan_id          uuid not null references public.loans (id),
  number           integer not null check (number between 1 and 5),
  due_date         date not null,
  principal_amount bigint not null check (principal_amount >= 0),
  interest_amount  bigint not null check (interest_amount >= 0),
  total_amount     bigint not null check (total_amount > 0),
  paid_principal   bigint not null default 0,
  paid_interest    bigint not null default 0,
  status           public.installment_status not null default 'pending',
  paid_at          timestamptz,
  review_note      text,
  constraint loan_installments_number_unique unique (loan_id, number),
  constraint loan_installments_total_chk check (total_amount = principal_amount + interest_amount),
  constraint loan_installments_paid_chk check (
    paid_principal between 0 and principal_amount and paid_interest between 0 and interest_amount)
);
create index loan_installments_due_idx on public.loan_installments (due_date) where status <> 'paid';

-- ---------------------------------------------------------------------------
-- Pagos
-- ---------------------------------------------------------------------------
create table public.payment_methods (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kind              text not null check (kind in ('qr_info', 'bank_transfer', 'gateway')),
  instructions      text not null,
  account_holder    text,
  account_reference text,
  qr_image_path     text,
  active            boolean not null default true,
  created_by        uuid references public.profiles (id),
  created_at        timestamptz not null default now()
);

create sequence public.payment_request_code_seq;
create table public.payment_requests (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique default ('PAG-' || lpad(nextval('public.payment_request_code_seq')::text, 6, '0')),
  customer_id       uuid not null references public.customers (id),
  loan_id           uuid not null references public.loans (id),
  payment_method_id uuid references public.payment_methods (id),
  amount            bigint not null check (amount > 0),
  reference         text,
  evidence_path     text,
  gateway_reference text unique,
  status            public.payment_request_status not null default 'requested',
  submitted_by      uuid references public.profiles (id),
  reviewed_by       uuid references public.profiles (id),
  reviewed_at       timestamptz,
  review_notes      text,
  payment_id        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index payment_requests_status_idx on public.payment_requests (status, created_at);

create sequence public.receipt_number_seq;
create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  receipt_number     bigint not null unique default nextval('public.receipt_number_seq'),
  loan_id            uuid not null references public.loans (id),
  customer_id        uuid not null references public.customers (id),
  collector_id       uuid not null references public.profiles (id),
  amount             bigint not null check (amount > 0),
  principal_amount   bigint not null check (principal_amount >= 0),
  interest_amount    bigint not null check (interest_amount >= 0),
  commission_amount  bigint not null default 0,
  method             public.payment_method_type not null,
  cash_custody       text not null check (cash_custody in ('collector', 'admin')),
  is_partial         boolean not null,
  idempotency_key    text not null unique check (length(idempotency_key) between 8 and 128),
  payment_request_id uuid unique references public.payment_requests (id),
  received_by        uuid references public.profiles (id),
  received_on        date not null,
  received_at        timestamptz not null default now(),
  status             public.payment_status not null default 'confirmed',
  evidence_path      text,
  notes              text,
  tx_id              uuid not null references public.financial_transactions (id),
  reversed_at        timestamptz,
  reversed_by        uuid references public.profiles (id),
  reversal_reason    text,
  reversal_tx_id     uuid references public.financial_transactions (id),
  created_at         timestamptz not null default now(),
  constraint payments_split_chk check (principal_amount + interest_amount = amount),
  constraint payments_received_by_chk check (received_by is not null or method = 'gateway')
);
create index payments_loan_idx on public.payments (loan_id);
create index payments_collector_date_idx on public.payments (collector_id, received_on);
create index payments_date_idx on public.payments (received_on);
alter table public.payment_requests
  add constraint payment_requests_payment_fk foreign key (payment_id) references public.payments (id);

create table public.payment_allocations (
  id               bigint generated always as identity primary key,
  payment_id       uuid not null references public.payments (id),
  installment_id   uuid not null references public.loan_installments (id),
  kind             text not null check (kind in ('payment', 'reversal')),
  principal_amount bigint not null,
  interest_amount  bigint not null,
  created_at       timestamptz not null default now(),
  constraint payment_allocations_sign_chk check (
    (kind = 'payment'  and principal_amount >= 0 and interest_amount >= 0 and principal_amount + interest_amount > 0) or
    (kind = 'reversal' and principal_amount <= 0 and interest_amount <= 0 and principal_amount + interest_amount < 0))
);
create index payment_allocations_payment_idx on public.payment_allocations (payment_id);
create index payment_allocations_installment_idx on public.payment_allocations (installment_id);

create table public.reversal_requests (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references public.payments (id),
  requested_by uuid not null references public.profiles (id),
  reason       text not null check (length(trim(reason)) >= 5),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by   uuid references public.profiles (id),
  decided_at   timestamptz,
  decision_notes text,
  created_at   timestamptz not null default now()
);
create unique index reversal_requests_one_pending on public.reversal_requests (payment_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Cobradores: comisiones, liquidaciones y entregas de efectivo
-- ---------------------------------------------------------------------------
create table public.collector_payouts (
  id           uuid primary key default gen_random_uuid(),
  collector_id uuid not null references public.profiles (id),
  period_end   date not null,
  amount       bigint not null check (amount >= 0),
  status       public.workflow_status not null default 'pending_approval',
  created_by   uuid not null references public.profiles (id),
  approved_by  uuid references public.profiles (id),
  approved_at  timestamptz,
  paid_by      uuid references public.profiles (id),
  paid_at      timestamptz,
  tx_id        uuid references public.financial_transactions (id),
  notes        text,
  created_at   timestamptz not null default now(),
  constraint collector_payouts_no_self_approval check (approved_by is null or approved_by <> collector_id),
  constraint collector_payouts_no_self_payment check (paid_by is null or paid_by <> collector_id)
);

create table public.collector_commissions (
  id           bigint generated always as identity primary key,
  collector_id uuid not null references public.profiles (id),
  loan_id      uuid not null references public.loans (id),
  payment_id   uuid not null references public.payments (id),
  kind         text not null check (kind in ('accrual', 'reversal')),
  amount       bigint not null,
  payout_id    uuid references public.collector_payouts (id),
  created_at   timestamptz not null default now(),
  constraint collector_commissions_sign_chk check (
    (kind = 'accrual' and amount >= 0) or (kind = 'reversal' and amount <= 0))
);
create index collector_commissions_collector_idx on public.collector_commissions (collector_id) where payout_id is null;

create table public.cash_handovers (
  id           uuid primary key default gen_random_uuid(),
  collector_id uuid not null references public.profiles (id),
  amount       bigint not null check (amount > 0),
  status       text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  declared_at  timestamptz not null default now(),
  confirmed_by uuid references public.profiles (id),
  confirmed_at timestamptz,
  tx_id        uuid references public.financial_transactions (id),
  notes        text,
  constraint cash_handovers_no_self_confirm check (confirmed_by is null or confirmed_by <> collector_id)
);

-- ---------------------------------------------------------------------------
-- Liquidaciones trimestrales
-- ---------------------------------------------------------------------------
create table public.quarterly_settlements (
  id              uuid primary key default gen_random_uuid(),
  period_start    date not null,
  period_end      date not null,
  status          public.workflow_status not null default 'draft',
  report          jsonb not null,
  approved_report jsonb,
  approved_hash   text,
  created_by      uuid not null references public.profiles (id),
  submitted_by    uuid references public.profiles (id),
  submitted_at    timestamptz,
  approved_by     uuid references public.profiles (id),
  approved_at     timestamptz,
  paid_at         timestamptz,
  close_tx_id     uuid references public.financial_transactions (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint quarterly_settlements_period_chk check (period_end >= period_start)
);

create table public.settlement_distributions (
  id                uuid primary key default gen_random_uuid(),
  settlement_id     uuid not null references public.quarterly_settlements (id),
  partner_id        uuid not null references public.partners (id),
  share_bps         integer not null,
  gross_amount      bigint not null check (gross_amount >= 0),
  advances_deducted bigint not null check (advances_deducted >= 0),
  net_amount        bigint not null check (net_amount >= 0),
  paid_at           timestamptz,
  paid_by           uuid references public.profiles (id),
  paid_tx_id        uuid references public.financial_transactions (id),
  constraint settlement_distributions_unique unique (settlement_id, partner_id),
  constraint settlement_distributions_net_chk check (net_amount = gross_amount - advances_deducted)
);

-- ---------------------------------------------------------------------------
-- Notificaciones
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  push_enabled        boolean not null default false,
  upcoming_installments boolean not null default true,
  due_today           boolean not null default true,
  payment_confirmed   boolean not null default true,
  balance_updates     boolean not null default true,
  new_applications    boolean not null default true,
  new_assignments     boolean not null default true,
  daily_summary       boolean not null default true,
  settlements         boolean not null default true,
  updated_at          timestamptz not null default now()
);

create table public.notification_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index notification_subscriptions_user_idx on public.notification_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Archivos (comprobantes de pago e imágenes de QR) almacenados en PostgreSQL
-- ---------------------------------------------------------------------------
create table public.stored_files (
  id           uuid primary key default gen_random_uuid(),
  bucket       text not null check (bucket in ('payment-evidence', 'payment-methods')),
  customer_id  uuid references public.customers (id),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  data         bytea not null,
  uploaded_by  uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  constraint stored_files_owner_chk check ((bucket = 'payment-evidence') = (customer_id is not null))
);
create index stored_files_customer_idx on public.stored_files (customer_id);

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  actor_role  text,
  action      text not null,
  table_name  text,
  record_id   text,
  old_data    jsonb,
  new_data    jsonb,
  context     jsonb
);
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);
create index audit_logs_record_idx on public.audit_logs (table_name, record_id);

-- ---------------------------------------------------------------------------
-- Datos iniciales (no financieros)
-- ---------------------------------------------------------------------------
insert into public.permissions (code, description) values
  ('collector.view_all_customers', 'El cobrador puede consultar clientes y préstamos no asignados'),
  ('partner.view_all_contributions', 'El socio puede consultar los aportes del otro socio'),
  ('partner.view_loans', 'El socio puede consultar el listado de préstamos (sin datos personales)');

insert into public.role_permissions (role, permission_code) values
  ('partner', 'partner.view_loans'),
  ('partner', 'partner.view_all_contributions');

-- Política inicial definida por el negocio: 20 % único sobre el capital,
-- 5 % para el cobrador y 15 % para la bolsa de socios, máximo 5 cuotas,
-- quincenal solo desde $500.000.
insert into public.loan_policies (
  version, interest_bps, collector_commission_bps, partners_bps, max_installments,
  biweekly_min_principal, min_principal, max_principal, status, notes, activated_at)
values (1, 2000, 500, 1500, 5, 500000, 1, null, 'active',
        'Política inicial: 20 % total (no por cuota, no compuesto).', now());

insert into public.app_settings (key, value, description) values
  ('compliance', jsonb_build_object(
      'mode', 'enforce',
      'legal_review_completed', false,
      'legal_review_reference', null,
      'usury_rate_ea_percent', null,
      'usury_rate_valid_from', null,
      'usury_rate_valid_until', null),
   'Validación normativa. Mientras no exista revisión legal y una tasa de usura vigente, no se aprueban ni desembolsan préstamos.'),
  ('company', jsonb_build_object('name', 'Capital Control', 'support_phone', null, 'legal_name', null, 'nit', null),
   'Datos visibles en comprobantes e informes.'),
  ('payment_instructions', jsonb_build_object('text', null),
   'Instrucciones generales de pago visibles para clientes.');
