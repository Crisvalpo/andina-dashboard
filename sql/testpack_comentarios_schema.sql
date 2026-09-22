-- ================================================================
-- Tabla de Comentarios / Observaciones para Test Packs, Líneas, Spools y Juntas
-- Esquema 'andina' — Supabase self-hosted (lukeserver)
--
-- Aplicar con:
--   docker exec -i supabase-db psql -U postgres < sql/testpack_comentarios_schema.sql
-- ================================================================

create table if not exists andina.testpack_comentarios (
    id uuid primary key default gen_random_uuid(),
    entidad_tipo text not null, -- 'test_pack' | 'linea' | 'spool' | 'junta'
    entidad_id text not null,   -- ej: 'TP-PW-03', '03351-CT-3"-C2-0059-N', '..._SP01', '..._1'
    test_pack text,             -- Test Pack de referencia si aplica
    comentario text not null,
    usuario text not null default 'Supervisor',
    created_at timestamptz not null default now()
);

-- Índices de consulta rápida
create index if not exists idx_tp_comentarios_entidad 
    on andina.testpack_comentarios (entidad_tipo, entidad_id, created_at desc);

create index if not exists idx_tp_comentarios_tp 
    on andina.testpack_comentarios (test_pack);

-- Permisos para PostgREST (service_role bypass RLS)
grant all on andina.testpack_comentarios to service_role;
grant usage on schema andina to anon, authenticated, service_role;
grant select, insert, delete, update on andina.testpack_comentarios to service_role;
