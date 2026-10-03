-- 仅用于隔离的 road_catalog_flow_qa 合成测试库，不在用户生产库执行。
CREATE SCHEMA IF NOT EXISTS design;
CREATE TABLE IF NOT EXISTS design.paged_roads (
    id integer PRIMARY KEY,
    route_id text,
    geom geometry(LineString, 32650)
);
INSERT INTO design.paged_roads
SELECT i, 'G10-' || lpad(i::text, 4, '0'),
       ST_GeomFromText('LINESTRING(' || (448000+i)::text || ' 4420000,' || (448000+i)::text || ' 4420100)', 32650)
FROM generate_series(1, 3000) i
ON CONFLICT (id) DO NOTHING;
COMMENT ON COLUMN design.paged_roads.route_id IS '路线编号';
CREATE INDEX IF NOT EXISTS paged_roads_geom_idx ON design.paged_roads USING gist(geom);
GRANT SELECT ON design.paged_roads TO qa_reader;
