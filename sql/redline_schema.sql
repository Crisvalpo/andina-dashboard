-- ================================================================
-- Red Line — Registro fotográfico de modificaciones de terreno
-- Esquema 'andina' — Supabase self-hosted (lukeserver)
--
-- Aplicar con:
--   docker exec -i supabase-db psql -U postgres < sql/redline_schema.sql
-- ================================================================

create table if not exists andina.redline_registros (
  id uuid not null default gen_random_uuid (),
  guid text not null,
  spool_tag text null,
  tag_linea text null,
  subsistema text null,
  foto_url text not null,
  foto_path text not null,
  observacion text not null default ''::text,
  tipo_modificacion text not null default 'Red Line'::text,
  usuario text not null default 'Desconocido'::text,
  created_at timestamp with time zone not null default now(),
  guids jsonb not null default '[]'::jsonb,
  constraint redline_registros_pkey primary key (id)
);

-- Asegurar columna guids si la tabla ya existía de versiones anteriores
alter table andina.redline_registros add column if not exists guids jsonb not null default '[]'::jsonb;
update andina.redline_registros set guids = jsonb_build_array(guid) where guids is null or guids = '[]'::jsonb;

-- Índices
create index if not exists idx_redline_guid on andina.redline_registros using btree (guid, created_at desc);

create index if not exists idx_redline_spool on andina.redline_registros using btree (spool_tag)
where (spool_tag is not null);

create index if not exists idx_redline_guids on andina.redline_registros using gin (guids);

-- Permisos para PostgREST (service_role bypass RLS)
grant all on andina.redline_registros to service_role;

