/**
 * ============================================================================
 * embed/src/fetch.ts —— 构建时从 Worker 拉评论（fetchComments）
 * ============================================================================
 *
 * 【这个文件在整个系统里的位置】
 *
 *   这是【读路径的第一站】，和 render.ts 一样只在构建时运行：
 *
 *     SSG 构建 ──fetchComments(slug, endpoint)──> GET {endpoint}/comments/{slug}
 *                                                         │
 *                                                         ▼
 *                                          worker/src/comments-api.ts
 *                                                         │
 *                                                         ▼
 *                                                  Cloudflare D1（SQLite）
 *
 *   拿到的 Comment[] 交给 render.ts 拼成 HTML，最后被 SSG 写进 .html。
 *   访客那一步【不经过本文件】—— 他们读的是已经烘焙好的静态文件。
 *
 *   ⚠ 注意区分【两个同名不同命的 fetch.ts】：
 *     · embed/src/fetch.ts      ← 本文件，给 SSG 用的库函数
 *     · embed/src/cli/fetch.ts  ← CLI 子命令 `npx ziscus fetch`，
 *                                 走的是完全不同的通路（见该文件注释）
 *     两者对"转义"和"失败"的处理【不一致】，这是已知的坑。
 *
 * 【⚠ 本文件最重要的一个设计取舍：失败即空数组（fail-open to empty）】
 *
 *   fetchComments() 【捕获所有异常并返回 []】，包括：
 *     · 网络不通 / DNS 失败 / TLS 失败
 *     · 5 秒超时（AbortSignal.timeout）
 *     · Worker 返回 404（slug 写错、endpoint 拼错）或 5xx
 *     · 响应体不是合法 JSON，或 JSON 不是数组
 *
 *   为什么这么设计：
 *     评论是【页面的次要内容】，构建才是主线。若 API 抖一下就让整个站点
 *     构建失败，等于让评论系统有权"让博客发不出去"。对 CI 尤其如此 ——
 *     ziscus 的流水线是"每有新评论就触发 repository_dispatch 重建"，
 *     一次网络抖动会阻塞本该发布的文章更新。所以这里选择降级为空评论区。
 *
 *   ⚠ 代价非常真实，必须知道：
 *     **构建成功 ≠ 评论取到了。** endpoint 打错一个字、slug 大小写不一致、
 *     D1 挂了、5 秒超时，你看到的都是【构建日志干干净净 + 线上评论区空了】。
 *     最坏的情况：一次故障的构建把已经带评论的线上页面覆盖成空评论区，
 *     而且没有任何报错。
 *
 *   ★ 缓解办法（仓库里目前【一个都没有内置】）：
 *     ① 构建脚本里自己判空并告警：
 *          const c = await fetchComments(slug, endpoint);
 *          if (c.length === 0) console.warn(`[ziscus] 0 comments for ${slug}`);
 *        ⚠ 但"真的没评论"和"取数失败"在返回值上无法区分 —— 这正是问题根源。
 *     ② 更彻底：不要用这个函数，自己 fetch 并让非 2xx 抛异常。
 *     ③ 想从类型上区分"失败"和"空"，需要给返回值加 discriminated union
 *        （如 `{ ok: true; comments } | { ok: false; error }`）——
 *        那是 breaking change，得等到大版本。
 *
 * 【⚠ endpoint 末尾斜杠没有被规范化】
 *   这里直接 `${endpoint}/comments/${slug}` 拼，而 `cli/rebuild.ts` 里写的是
 *   `opts.endpoint.replace(/\/$/, "")`。两个文件口径不一致。
 *   于是 `fetchComments("post", "https://x.workers.dev/")` 会请求
 *   `https://x.workers.dev//comments/post`，而 Worker 的路由正则
 *   `^\/comments\/([a-z0-9-]+)\/?$` 匹配不上 → 404 → 【静默返回空数组】。
 *   上面那个"构建成功但评论空了"的场景，最容易就是这么触发的。
 *   ★ 想修：在本函数开头加一行 `endpoint.replace(/\/+$/, "")`。
 *     `npx ziscus init` 写出的 ziscus.config.json 里的 endpoint 已去掉末尾
 *     斜杠，所以走 CLI 的路径踩不到；手写构建脚本的人会踩。
 *
 * 【导出】只有 `fetchComments` 一个（外加包内私有的 D1Comment 类型）。
 */
import { type Comment, unescapeHtml } from "./render.js";

/**
 * Worker 原样透传的 D1 行形状（SQLite 列名是 snake_case）。
 *
 * ⚠ 这个接口描述的是"期望"，运行时【不做任何校验】：
 *   Worker 重新部署后改了列名、或中间夹了一层会改写响应的 CDN，
 *   这里都不会报错，只会静默变成 undefined。
 *
 * `createdAt` 和 `created_at` 两个字段都列出来，是为了兼容后端两种命名
 * —— 同时也说明这份契约【历史上变过】。★ 两边加字段时都要照顾，
 * 想彻底清理就得先确认后端只发一种。
 */
interface D1Comment {
  id: string;
  slug: string;
  author: string;
  body: string;
  status: string;
  created_at?: string;
  createdAt?: string;
  approved_at?: string | null;
}

/**
 * 拉取某个页面【已批准】的评论，并把文本规范化为纯文本。
 *
 * 【输入输出契约】
 *   slug      页面标识。⚠ 必须匹配 `^[a-z0-9-]+$`（只允许小写字母、数字、连字符）。
 *             Worker 的读路由就是这个正则，所以带下划线、大写、中文、空格、
 *             斜杠的 slug 一律 404 → 静默空数组。
 *             ⚠ 从 giscus 迁移进来的 slug 常常是【讨论标题原文】，
 *               极易不匹配（见 `cli/migrate.ts` 的注释）。
 *             ★ 建议：写一个 `slugify()` 同时在"生成页面"和"调用本函数"两侧使用。
 *   endpoint  Worker 的 origin，如 `https://ziscus-comments.you.workers.dev`
 *             ⚠ 不要带末尾斜杠，见文件头说明。
 *   返回       `Comment[]`。任何失败都是 `[]`，本函数【永不抛异常】。
 *
 * 【为什么反转义发生在这里】
 *   存储不变量规定：D1 里的 author / body 是【已 HTML 转义】的
 *   （见 worker/src/html.ts）。而 render.ts 的渲染器是按"输入是纯文本、
 *   我只负责转义一次"来设计的。所以反转义必须发生在
 *   【渲染之前，且整个链路上只发生一次】—— 这里就是那个唯一的位置：
 *
 *       D1（已转义文本）
 *            │  ← 本函数 unescapeHtml()（只此一次）
 *            ▼
 *       Comment（纯文本）
 *            │  ← render.ts 的 escHtml()（只此一次）
 *            ▼
 *       安全的 HTML
 *
 *   ⚠ 别把这一步挪进 render.ts。挪过去之后，任何"绕过 fetchComments
 *     自己构造 Comment"的调用方都会忘记反转义；留在这里，至少
 *     "从本函数拿到的 Comment 就是纯文本"是一条可依赖的规则。
 *   ★ 更好的做法是用 branded type（如 `type PlainText = string & {__plain:true}`）
 *     把这条规则交给编译器守。目前它【只是注释里的约定，没有任何强制】。
 *
 * ⚠ 【createdAt 兜底成 `new Date().toISOString()` 会让构建不可复现】
 *   后端既没给 `createdAt` 也没给 `created_at` 时，会填【当前时刻】。
 *   后果：同一个 commit 在不同时间构建，产出的 HTML 不同 ——
 *   git 里会出现"内容没变但每次重建都有 diff"的噪声，
 *   对"重建后把结果提交回仓库"的流水线尤其难受。
 *   ★ 想消除：改成 `new Date(0).toISOString()`，或干脆在这里抛错。
 *
 * ⚠ 【status 兜底成 `"pending"`，而渲染器只渲染 `"approved"`】
 *   后端返回未知状态值时，该评论被当作 pending → 被
 *   `renderCommentList()` 静默丢掉。也就是"未知状态"在页面上的表现是
 *   【评论消失】，而不是"显示出来但状态奇怪"。
 *   这是偏安全的默认值（宁可少显示，也不误显示未审核内容），
 *   但排查"某条评论不见了"时要想到这一层。
 *
 * ⚠ 【没有任何并发控制 / 重试】
 *   sitemap 里有几千个页面时，调用方要自己限流（比如 p-limit），
 *   否则会瞬间打出几千个并发请求，可能触发 Cloudflare 侧的限流
 *   或把自己的 CI 网络打满。
 *   5 秒超时对单次构建是合理的，但 Worker 冷启动 + 大表时可能不够。
 *   ★ 大批量构建时考虑把超时调大。
 *
 * ⚠ 【唯一的失败信号是 console.error】
 *   它写 stderr，很多 SSG 的构建日志会把它埋在几百行输出里，
 *   而 CI 只在【非零退出码】时才通知你 —— 这里永远返回 0 退出码。
 *   所以"评论静默消失"是非常容易被忽略的故障模式。
 *
 * @param slug     页面标识，必须匹配 `^[a-z0-9-]+$`
 * @param endpoint Worker origin（不带末尾斜杠）
 * @returns 已批准评论数组；任何失败都返回空数组（不 throw、不重试）
 */
export async function fetchComments(
  slug: string,
  endpoint: string,
): Promise<Comment[]> {
  try {
    // 5 秒硬超时：构建期的网络请求必须有个上界，
    // 否则一个挂住的连接会让整个 SSG 构建卡到 CI 的 job 超时上限。
    const res = await fetch(`${endpoint}/comments/${slug}`, {
      signal: AbortSignal.timeout(5000),
    });
    // 404（slug/endpoint 写错）和 5xx（D1 故障）在这里被【一视同仁】地
    // 折成空数组，调用方无法区分。见文件头的 fail-open 说明。
    if (!res.ok) return [];
    const data = await res.json();
    // 防御"返回了 HTML 错误页或 {error:...} 对象"：不是数组就当作没有评论。
    if (!Array.isArray(data)) return [];
    // 白名单式校验：只信任这四个状态，其余一律降级为 pending（→ 不渲染）。
    // 用白名单而不是黑名单，是为了让后端将来新增状态时【默认不可见】，
    // 而不是默认可见 —— 未审核内容泄露比少显示严重得多。
    const validStatuses = ["pending", "approved", "rejected", "spam"];
    return (data as D1Comment[]).map((c) => ({
      id: c.id,
      slug: c.slug,
      // ★ 整个系统"反转义只做一次"的那一次，就在这里。
      author: unescapeHtml(c.author),
      body: unescapeHtml(c.body),
      status: (validStatuses.includes(c.status) ? c.status : "pending") as Comment["status"],
      createdAt: c.createdAt ?? c.created_at ?? new Date().toISOString(),
    }));
  } catch (err) {
    // 唯一的失败信号。⚠ 它不影响退出码，构建仍会"成功"。
    console.error(`[ziscus] fetch failed for "${slug}" from ${endpoint}:`, err instanceof Error ? err.message : err);
    return [];
  }
}
