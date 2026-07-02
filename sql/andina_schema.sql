-- ================================================================
-- Esquema 'andina' — Bot WhatsApp del Dashboard Andina
-- Supabase self-hosted (lukeserver). Mismo patrón que 'maquinaria'.
--
-- Aplicar con:
--   docker exec -i supabase-db psql -U postgres < andina_schema.sql
-- Y luego exponer el esquema en PostgREST:
--   PGRST_DB_SCHEMAS=public,storage,graphql_public,maquinaria,andina
--   docker restart supabase-rest
-- ================================================================

create schema if not exists andina;

grant usage on schema andina to anon, authenticated, service_role;

-- Usuarios autorizados a interactuar con el bot (resueltos por número WhatsApp)
create table if not exists andina.bot_usuarios (
    id          uuid primary key default gen_random_uuid(),
    telefono    text unique not null,          -- solo dígitos, ej: 569XXXXXXXX
    nombre      text not null default 'Desconocido',
    rol         text not null default 'Terreno',  -- Terreno | Supervisor | Admin
    activo      boolean not null default false,   -- los nuevos quedan pendientes de aprobación
    created_at  timestamptz not null default now()
);

-- Memoria conversacional (historial que se entrega a Gemini)
create table if not exists andina.bot_mensajes (
    id          uuid primary key default gen_random_uuid(),
    telefono    text not null,
    emisor      text not null check (emisor in ('usuario', 'bot')),
    tipo        text not null default 'texto',    -- texto | audio | imagen | ubicacion
    mensaje     text,
    metadata    jsonb not null default '{}',
    created_at  timestamptz not null default now()
);
create index if not exists idx_bot_mensajes_tel_fecha
    on andina.bot_mensajes (telefono, created_at desc);

-- Auditoría de avances registrados en AppSheet vía bot
create table if not exists andina.bot_registros (
    id                  uuid primary key default gen_random_uuid(),
    telefono            text not null,
    spool_tag           text,
    id_spool            text,
    status              text,
    observacion         text,
    mts_montados        numeric,
    appsheet_ok         boolean not null default false,
    metadata            jsonb not null default '{}',
    created_at          timestamptz not null default now()
);

-- Configuración runtime del bot (editable desde el panel del dashboard)
-- Los SECRETOS no viven aquí: solo en el .env del servidor.
create table if not exists andina.bot_config (
    clave       text primary key,
    valor       text,
    descripcion text,
    updated_at  timestamptz not null default now()
);

-- Permisos para PostgREST (service_role bypass RLS)
grant all on all tables in schema andina to service_role;
grant all on all sequences in schema andina to service_role;
alter default privileges in schema andina grant all on tables to service_role;
alter default privileges in schema andina grant all on sequences to service_role;
