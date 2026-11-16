-- 只做「数据库自身的准备」；表结构与演示数据由 pnpm db:seed 负责（可重复执行）
CREATE EXTENSION IF NOT EXISTS postgis;

-- 用于 KNN / 距离排序
CREATE EXTENSION IF NOT EXISTS btree_gist;
