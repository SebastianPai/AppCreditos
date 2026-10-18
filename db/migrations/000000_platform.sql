-- =============================================================================
-- CAPITAL CONTROL — 0000: plataforma (PostgreSQL puro, sin servicios externos)
-- Esquema `auth` propio: usuarios, sesiones y el contexto del usuario actual.
--
-- Modelo de seguridad:
--   * La aplicación se conecta con un único usuario de base de datos (propietario
--     de las tablas, NO superusuario) y todas las tablas usan FORCE ROW LEVEL SECURITY.
--   * En cada petición, el servidor abre una transacción y fija
--     request.jwt.claims = {"sub": <usuario>, "role": "authenticated"}; las
--     políticas RLS y las funciones usan auth.uid() / auth.role().
--   * Las funciones SECURITY DEFINER se ejecutan con
--     application_name = 'capital_control_system' (cláusula SET de la función:
--     parámetro estándar que un usuario no superusuario puede fijar, compatible con
--     Heroku Postgres). Eso les permite operar sobre todas las filas tras verificar
--     permisos; al terminar la función, el valor se restaura automáticamente.
--     El servidor nunca usa ese application_name en su conexión.
-- =============================================================================

create extension if not exists pgcrypto;

create schema if not exists auth;

create table auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  password_hash        text not null,
  must_change_password boolean not null default true,
  failed_attempts      integer not null default 0,
  locked_until         timestamptz,
  raw_app_meta_data    jsonb not null default '{}',
  raw_user_meta_data   jsonb not null default '{}',
  last_sign_in_at      timestamptz,
  created_at           timestamptz not null default now()
);

create table auth.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index sessions_user_idx on auth.sessions (user_id);
create index sessions_expires_idx on auth.sessions (expires_at);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

-- Contexto de sistema: dentro de funciones SECURITY DEFINER o en tareas del
-- servidor (cron, webhooks, inicio de sesión) identificadas como service_role.
create function public.is_system() returns boolean language sql stable as $$
  select current_setting('application_name') = 'capital_control_system' or coalesce(auth.role(), '') = 'service_role'
$$;

alter table auth.users enable row level security;
alter table auth.users force row level security;
alter table auth.sessions enable row level security;
alter table auth.sessions force row level security;
create policy users_system on auth.users for all using (public.is_system()) with check (public.is_system());
create policy users_self on auth.users for select using (id = auth.uid());
create policy sessions_system on auth.sessions for all using (public.is_system()) with check (public.is_system());
