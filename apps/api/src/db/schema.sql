-- 智慧交通检测平台 · 空间数据表
-- 纪律：几何列一律 GIST 索引；轨迹原始点不进这里（去 TDengine），只存抽稀线段。

CREATE TABLE IF NOT EXISTS road (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    level       text NOT NULL DEFAULT 'arterial',
    speed_limit int  NOT NULL DEFAULT 60,
    speed_kph   numeric(5, 1) NOT NULL DEFAULT 60,
    geom        geometry(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_road_geom ON road USING GIST (geom);

CREATE TABLE IF NOT EXISTS checkpoint (
    id        text PRIMARY KEY,
    name      text NOT NULL,
    road_id   text REFERENCES road(id) ON DELETE SET NULL,
    direction text NOT NULL DEFAULT 'up',
    gb_code   text NOT NULL DEFAULT '',
    status    text NOT NULL DEFAULT 'online',
    lanes     int  NOT NULL DEFAULT 3,
    geom      geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_geom ON checkpoint USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_checkpoint_gb ON checkpoint (gb_code);

CREATE TABLE IF NOT EXISTS zone (
    id   text PRIMARY KEY,
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'surveillance',
    geom geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zone_geom ON zone USING GIST (geom);

CREATE TABLE IF NOT EXISTS alarm (
    id            text PRIMARY KEY,
    checkpoint_id text,
    plate_no      text,
    kind          text NOT NULL,
    level         text NOT NULL DEFAULT 'warning',
    ts            timestamptz NOT NULL DEFAULT now(),
    speed_kph     numeric(5, 1),
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    acked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_alarm_ts ON alarm (ts DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_checkpoint ON alarm (checkpoint_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_acked ON alarm (acked_at);

-- 布控规则（单一真源）：重启不丢；多实例经 Redis Pub/Sub 通知各自从库重载
CREATE TABLE IF NOT EXISTS surveillance_rule (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    kind            text NOT NULL DEFAULT 'speeding',
    plate_pattern   text,
    speed_threshold numeric(5, 1),
    zone_id         text,
    active          boolean NOT NULL DEFAULT true,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 城市背景体块（**示意数据**，不是业务对象）：只用于给路网提供空间参照，
-- 真实项目替换为倾斜摄影/白模切片，字段与图层名保持一致即可。
CREATE TABLE IF NOT EXISTS block (
    id     text PRIMARY KEY,
    name   text NOT NULL DEFAULT '',
    height numeric(6, 1) NOT NULL DEFAULT 20,
    kind   text NOT NULL DEFAULT 'context',
    geom   geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_block_geom ON block USING GIST (geom);

-- 抽稀后的轨迹线段（原始点只在 TDengine）
CREATE TABLE IF NOT EXISTS trajectory_segment (
    id         bigserial PRIMARY KEY,
    vehicle_id text NOT NULL,
    plate_no   text,
    started_at timestamptz NOT NULL,
    ended_at   timestamptz NOT NULL,
    points     int NOT NULL DEFAULT 0,
    geom       geometry(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traj_vehicle ON trajectory_segment (vehicle_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_traj_geom ON trajectory_segment USING GIST (geom);
