/**
 * ============================================================================
 * worker/src/types.ts —— Worker 的类型契约（尤其是 Env 配置的权威清单）
 * ============================================================================
 *
 * 【这个文件的重要性】
 *   `Env` 就是这个 Worker 的【全部可配置项】。想改行为，先看这里有什么旋钮。
 *   声明了但没配的项，代码里都会走兜底默认值。
 *
 * 【两类配置，来源不同】
 *
 *   ① 绑定（binding）—— 在 wrangler.toml 里声明，由 Cloudflare 注入对象
 *        DB        D1 数据库                     【必填】
 *        ASSETS    静态资源处理器（可选功能）      可选
 *        AI_MOD    Workers AI 绑定（AI 反垃圾）   可选
 *
 *   ② 变量（var/secret）—— 字符串，来自 wrangler.toml 的 [vars] 或
 *      `wrangler secret put`
 *        ALLOWED_ORIGINS  允许提交的域名          必填（否则无法防 CSRF）
 *        GITHUB_REPO / GITHUB_TOKEN   触发重建     可选（不配就无自动重建）
 *        ADMIN_SECRET     管理端点密钥            可选（不配则管理端点全锁）
 *        MODERATION / RATE_LIMIT / MAX_* …        可选（都有默认值）
 *
 *   ★ 关键区分：**绑定是对象，变量是字符串**。
 *     所以所有数值型配置（RATE_LIMIT、MAX_BODY_LENGTH…）都是 string，
 *     读的时候要 parseInt（见 submit.ts 里的 limit() 辅助函数）。
 *
 * ⚠ 【配置错误的典型症状】
 *   - 忘了 ALLOWED_ORIGINS   → 提交评论全部 403 "Invalid origin"
 *   - 忘了 ADMIN_SECRET      → 所有 /admin/* 端点 401（故意锁死，不是 bug）
 *   - 忘了 GITHUB_TOKEN      → 评论能发但站点不重建（面板显示红卡片）
 *   - 写了 RATE_LIMIT=abc    → 走默认 30（不会崩，静默兜底）
 */

/** Worker 运行时环境：绑定对象 + 字符串变量 */
export interface Env {
  DB: D1Database;
  /**
   * 静态资源处理器 —— 只在 Worker 同时托管站点时存在
   * （wrangler.toml 里配了 `[assets]`）。
   *
   * 可选：没有它时 Worker 退化成纯 API，**唯一的损失是
   * "访客提交后立刻看到自己的评论"这个即时预览功能**
   * （见 index.ts 里的 flash cookie 逻辑和 html-rewriter.ts）。
   */
  ASSETS?: Fetcher;
  /** Workers AI 绑定，用于 ai-mod 垃圾评论分类。可选。 */
  AI_MOD?: Ai;
  /** 允许提交评论的域名，逗号分隔，用于 CSRF 防护（校验 Origin/Referer） */
  ALLOWED_ORIGINS: string;
  /** GitHub 仓库（owner/repo），通过 repository_dispatch 触发站点重建 */
  GITHUB_REPO?: string;
  /** 触发 repository_dispatch 用的 GitHub token（需要 Contents: Read and write） */
  GITHUB_TOKEN?: string;
  /** 管理端点的 Bearer 密钥。⚠ 只有只写存储，务必自己备份，丢了要轮换 */
  ADMIN_SECRET?: string;
  /**
   * 新评论是否需要审批："on"（默认）或 "off"。
   *
   * ⚠ 【注意优先级】：这个设置只在【没有绑定 AI_MOD】时生效。
   *   一旦绑定了 AI，状态就由 AI 的判定决定（approve/spam/review），
   *   MODERATION 被忽略。完整优先级见 submit.ts 的 status 解析段。
   */
  MODERATION: string;
  /**
   * 每个 IP 每小时最多能发多少条评论（默认 30）。
   *
   * ⚠ 这里说"每小时"，但 checkRateLimit() 的 windowMinutes 是调用方传的，
   *   submit.ts 用的是默认 60 分钟。改窗口长度要改那边。
   */
  RATE_LIMIT?: string;
  /** 评论正文最大字符数（默认 10000） */
  MAX_BODY_LENGTH?: string;
  /** 评论正文最小字符数（默认 2）—— 挡纯表情/单字符灌水 */
  MIN_BODY_LENGTH?: string;
  /** 昵称最大字符数（默认 100） */
  MAX_AUTHOR_LENGTH?: string;
  /** 正文里允许的 URL 数量上限（默认 3）—— 挡链接堆砌型垃圾 */
  MAX_URLS_IN_BODY?: string;
  /**
   * slug 最大长度（默认 255）。
   * ⚠ slug 还有【格式】限制（只能 [a-z0-9-]+），那段正则在 submit.ts 里
   *   硬编码，不受这里控制。改格式要改代码。
   */
  MAX_SLUG_LENGTH?: string;
}

/**
 * 一次"触发重建"尝试的结果。
 *
 * 同时会以 JSON 形式持久化到 `meta.last_rebuild_result`，
 * 供管理面板和 /admin/stats 展示 —— 所以这是个【跨层的数据契约】，
 * 改字段名要同时看 dashboard.ts 和 admin-api.ts 的读取端。
 */
export interface RebuildResult {
  /** GitHub 是否接受了 repository_dispatch（HTTP 204 算成功） */
  dispatched: boolean;
  /** 是否因为处于防抖窗口内而被跳过（合并多次重建请求） */
  debounced: boolean;
  slug: string;
  /** 尝试时刻，ISO-8601 字符串 */
  at: string;
  /** GitHub 返回的 HTTP 状态码（只在真的发起请求时有值） */
  status?: number;
  /** 机器可读的失败分类。成功或防抖时为 undefined。 */
  code?: "not_configured" | "github_rejected" | "network";
  /** 人类可读的失败原因。成功或防抖时为 undefined。 */
  error?: string;
}

/**
 * 一条评论（驼峰命名，用于 API 出参）。
 *
 * ⚠ 注意和数据库列的命名差异：
 *     SQL 列          →  这个接口
 *     created_at      →  createdAt
 *     approved_at     →  （不在这里）
 *   Worker 内部多数地方直接用 SQL 的蛇形命名（见 html-rewriter.ts），
 *   而这个驼峰版本主要给 `ziscus` 包的 fetchComments() 出参用
 *   （见 embed/src/render.ts 里同名的 `Comment` 接口 —— 那是另一个定义，
 *    两个包各自维护一份，**改字段要同步改两边**）。
 */
export interface Comment {
  id: string;
  slug: string;
  author: string;
  body: string;
  status: "pending" | "approved" | "rejected" | "spam";
  ip_hash: string;
  created_at: string;
  approved_at: string | null;
}
