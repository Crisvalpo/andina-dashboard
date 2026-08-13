-- ================================================================
-- Red Line — Registro fotográfico de modificaciones de terreno
-- Esquema 'andina' — Supabase self-hosted (lukeserver)
--
-- Aplicar con:
--   docker exec -i supabase-db psql -U postgres < sql/redline_schema.sql
-- ================================================================

-- Tabla: historial de fotos y observaciones Red Line por elemento 3D
create table if not exists andina.redline_registros (
    id                  uuid primary key default gen_random_uuid(),
    guid                text not null,                          -- GUID del elemento 3D principal
    guids               jsonb not null default '[]'::jsonb,     -- Lista de todos los GUIDs 3D asociados a esta foto
    spool_tag           text,                                   -- TAG Gestión del Spool asociado
    tag_linea           text,                                   -- TAG de la línea de cañería
    subsistema          text,                                   -- Código del sub-sistema
    foto_url            text not null,                          -- URL pública en Supabase Storage
    foto_path           text not null,                          -- Ruta interna en el bucket (para delete)
    observacion         text not null default '',                -- Descripción de la modificación de terreno
    tipo_modificacion   text not null default 'Red Line',       -- Categoría: Red Line, Interferencia, Desplazamiento, etc.
    usuario             text not null default 'Desconocido',    -- Quién registra el cambio
    created_at          timestamptz not null default now()
);

-- Asegurar columna guids en tabla existente si no existía
alter table andina.redline_registros add column if not exists guids jsonb not null default '[]'::jsonb;
update andina.redline_registros set guids = jsonb_build_array(guid) where guids is null or guids = '[]'::jsonb;

-- Índice para buscar historial por GUID rápidamente
create index if not exists idx_redline_guid
    on andina.redline_registros (guid, created_at desc);

-- Índice GIN para búsquedas en el arreglo de GUIDs asociados
create index if not exists idx_redline_guids
    on andina.redline_registros using gin (guids);

-- Índice para buscar por spool
create index if not exists idx_redline_spool
    on andina.redline_registros (spool_tag)
    where spool_tag is not null;

-- Permisos para PostgREST (service_role bypass RLS)
grant all on andina.redline_registros to service_role;
