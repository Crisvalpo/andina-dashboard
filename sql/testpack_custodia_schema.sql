-- ================================================================
-- Tabla de Custodia de Carpeta Física para Test Packs
-- Esquema 'andina' — Supabase self-hosted (lukeserver)
--
-- Aplicar con:
--   docker exec -i supabase-db psql -U postgres < sql/testpack_custodia_schema.sql
-- ================================================================

create table if not exists andina.testpack_custodia (
    id uuid primary key default gen_random_uuid(),
    test_pack text not null,                      -- Ej: 'TP-CT-22', 'TP-PW-03'
    responsable text not null,                    -- Persona que tiene la carpeta físicamente
    departamento text not null check (departamento in ('Terreno', 'QAQC', 'Oficina Técnica')),
    ubicacion_detalle text default '',            -- Ej: 'Mesón de pruebas', 'Archivador A', 'En terreno con capataz'
    usuario_registro text not null default 'Supervisor', -- Quién registra el movimiento
    fecha_entrega timestamptz not null default now(),    -- Cuándo se entregó la carpeta
    created_at timestamptz not null default now()
);

-- Índices de consulta rápida
create index if not exists idx_tp_custodia_tp_fecha 
    on andina.testpack_custodia (test_pack, fecha_entrega desc);

create index if not exists idx_tp_custodia_depto 
    on andina.testpack_custodia (departamento);

-- Permisos para PostgREST (service_role bypass RLS)
grant all on andina.testpack_custodia to service_role;
grant usage on schema andina to anon, authenticated, service_role;
grant select, insert, delete, update on andina.testpack_custodia to service_role;
