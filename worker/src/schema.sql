-- ============================================================================
-- worker/src/schema.sql —— D1（SQLite）表结构
-- ============================================================================
--
-- 【怎么应用这份 schema】
--   npx ziscus deploy     会顺便应用它（第一次部署时）
--   wrangler d1 execute <db-name> --file=worker/src/schema.sql --remote
--   npx ziscus migrate    用于升级已存在的数据库（见 embed/src/cli/migrate.ts）
--
-- ⚠ 所有语句都是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
--   所以【重复执行是安全的】。但这也意味着：**改了已有表的列不会生效** ——
--   IF NOT EXISTS 遇到表已存在就整段跳过。加字段必须走 migrate。
--
-- 【五张表的分工】
--   comments      评论本体（唯一的业务数据）
--   rate_limits   限流计数器（可随时清空，不影响业务）
--   meta          键值配置（评论开关、按页暂停、上次重建结果…）
--   mod_log       操作审计（谁在什么时候对哪条评论做了什么）
--   banned_ips    封禁名单（存 IP 哈希，不存原始 IP）
--
-- 【⚠ 隐私设计：全表只存 IP 的哈希】
--   ip_hash 是 SHA-256 前 16 个十六进制字符（见 submit.ts 的 hashIp）。
--   原始 IP 从不落库。代价是：**你无法从库里反查某条评论来自哪个 IP**，
--   只能拿一个已知 IP 去算哈希再比对。GDPR 删除也是按哈希删。
-- ============================================================================


-- ── 评论本体 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  --                                 ↑ 8 字节随机 → 16 位十六进制字符串。
  --                                   在 SQL 层生成，所以 INSERT 可以不传 id。
  --                                   ⚠ 但 submit.ts 为了写 mod_log 需要提前知道 id，
  --                                     所以它在应用层也生成了一次并显式传入。
  --                                     两处逻辑并存，读代码时别困惑。
  slug       TEXT NOT NULL,
  --            ↑ 页面标识，只能是小写字母/数字/连字符（submit.ts 里用正则校验）。
  --              SSG 调用 fetchComments(slug) 时用它取该页的评论。
  author     TEXT NOT NULL,
  --            ↑ ⚠ 【已 HTML 转义】存储不变量，见 worker/src/html.ts
  body       TEXT NOT NULL,
  --            ↑ ⚠ 同上，已转义
  status     TEXT NOT NULL DEFAULT 'pending',
  --            ↑ 'pending' | 'approved' | 'rejected' | 'spam'
  --              ⚠ SQLite 没有枚举类型，所以这是【约定】而非约束。
  --                 代码里所有比较都是字符串字面量，写错不会报错。
  ip_hash    TEXT NOT NULL DEFAULT '',
  --            ↑ SHA-256 前 16 位十六进制；用于限流、封禁、去重、GDPR 删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  --            ↑ ⚠ 统一用 UTC 的 ISO-8601，结尾带 Z。
  --               渲染端格式化时靠这个字符串判断时区（见 render.ts）。
  --               注意 SQLite 的 strftime 用的是 'now'（UTC），不是 localtime。
  approved_at TEXT
  --            ↑ 可空：只有 approved 状态才有值。用于按审批时间排序/统计
);

-- 这个索引服务于最高频的查询：
--   SELECT ... FROM comments WHERE slug = ? AND status = 'approved' ORDER BY created_at
-- 列顺序 (slug, status, created_at) 是有讲究的：
--   等值条件在前（slug、status），排序字段在后（created_at），
--   这样 SQLite 可以直接走索引，不需要额外的排序步骤。
-- ★ 如果你要按别的维度筛选（比如按 ip_hash 查某个人的所有评论），
--   需要另加索引，否则会全表扫描。
CREATE INDEX IF NOT EXISTS idx_comments_slug_status
  ON comments(slug, status, created_at);


-- ── 限流计数器 ──────────────────────────────────────────────────────────────
-- 一行 = (某个 IP 哈希, 某个时间窗) 的请求次数。
-- 复合主键让"自增"可以用原子 upsert 完成（见 rate-limit.ts）。
-- 这张表可以随时 TRUNCATE —— 清空只会让限流临时重置，不丢业务数据。
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL,
  window  TEXT NOT NULL,
  --        ↑ 窗口起始时刻的 ISO 字符串（绝对时间对齐，不是相对首次请求）
  count   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_hash, window)
  --           ↑ 这个复合主键是 ON CONFLICT 的目标，别删
);


-- ── 键值配置 ────────────────────────────────────────────────────────────────
-- 用字符串前缀区分用途，目前有三种 key：
--
--   'comments_mode'        值是 'on' | 'off' | 'paused'
--                          · on     正常发布（按 MODERATION / AI 决定状态）
--                          · off    全站关闭评论（submit 直接 403）
--                          · paused 全站暂停【但表单还在】，新评论一律 pending
--                          ⚠ 三态语义容易混，注意区分 off 和 paused
--
--   'slug_paused:<slug>'   值为 '1'，表示【某一页】暂停评论。
--                          页面渲染时表单会被替换成"评论已暂停"（见 index.ts）
--
--   'last_rebuild_result'  值是 RebuildResult 的 JSON（见 types.ts），
--                          给管理面板显示"上次重建成功/失败"
--
-- ★ 想加新的运行时配置（不想重新部署 Worker），就放这张表，
--   然后在代码里 env.DB.prepare("SELECT value FROM meta WHERE key = ?") 读。
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);


-- ── 操作审计日志 ────────────────────────────────────────────────────────────
-- 记录每一次管理动作和 AI 判定，用于追溯"这条评论为什么被删/被标记"。
-- action 的取值示例：'approve' | 'reject' | 'spam' | 'delete' | 'ban'
--                     | 'ai_approve' | 'ai_spam' | 'ai_review' | 'import'
-- actor：'admin'（人工）或 'ai'（Workers AI 判定）
-- metadata：JSON 字符串，存放该动作的附加信息
--           （AI 判定会记 model 名和 latency_ms）
CREATE TABLE IF NOT EXISTS mod_log (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'admin',
  comment_id TEXT,
  --           ⚠ 可空，且【没有外键约束】。所以删除评论后日志仍然保留，
  --             但 comment_id 就成了悬空引用。这是有意的（审计要留痕），
  --             代价是 join 时要小心。
  slug       TEXT,
  reason     TEXT NOT NULL DEFAULT '',
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 按时间倒序翻页（管理面板的"最近活动"）
CREATE INDEX IF NOT EXISTS idx_mod_log_created
  ON mod_log(created_at DESC);

-- 按动作类型 + 时间查询（比如"列出所有 AI 判定"）
CREATE INDEX IF NOT EXISTS idx_mod_log_action
  ON mod_log(action, created_at DESC);


-- ── 封禁名单 ────────────────────────────────────────────────────────────────
-- submit.ts 在写评论前会查这张表，命中则直接 403。
-- ⚠ 注意只能封【精确的 IP 哈希】，没有网段/CIDR 支持。
--   这对动态 IP 的用户无效，对 NAT 后的大批用户则可能误伤。
--   本项目把它当作"挡住持续骚扰"的粗粒度工具，不是安全边界。
CREATE TABLE IF NOT EXISTS banned_ips (
  ip_hash   TEXT PRIMARY KEY,
  reason    TEXT NOT NULL DEFAULT '',
  banned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
