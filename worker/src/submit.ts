/**
 * ============================================================================
 * worker/src/submit.ts —— 访客提交评论的主流程（POST /submit）
 * ============================================================================
 *
 * 【这是整个系统唯一的"写入"入口，也是安全防线的集中地】
 *
 * 处理顺序是【刻意设计】的，每一步都在为后面的步骤省钱或挡攻击：
 *
 *   ┌─ 1. 方法校验（非 POST 直接 405）
 *   ├─ 2. 读运行时限制（env 覆盖默认值）
 *   ├─ 3. 全局开关：mode === 'off' → 403
 *   ├─ 4. 解析表单
 *   ├─ 5. ★ CSRF：校验 Origin/Referer 是否属于 ALLOWED_ORIGINS
 *   ├─ 6. 按页暂停检查        ← 放在 CSRF【之后】，防止伪造请求探测暂停状态
 *   ├─ 7. 必填字段校验
 *   ├─ 8. slug 格式 + 各字段长度 + URL 数量
 *   ├─ 9. 结构过滤（Layer 0：明显的恶意载荷）
 *   ├─ 10. 限流（对 IP 哈希计数）
 *   ├─ 11. 封禁检查
 *   ├─ 12. AI 分类（可选的 Layer 1）
 *   ├─ 13. HTML 转义  ← ★ 存储不变量，见 worker/src/html.ts
 *   ├─ 14. 决定 status（模式 / AI / MODERATION 三者优先级）
 *   ├─ 15. 5 分钟内同内容去重
 *   ├─ 16. 插入 D1 + 写审计日志
 *   ├─ 17. 若自动批准 → 触发（防抖的）站点重建
 *   └─ 18. PRG 重定向 + flash cookie
 *
 * 【⚠ 为什么第 5 步（CSRF）必须排在第 6 步（暂停检查）之前】
 *   看源码注释："after CSRF so a forged request can't even probe pause state"。
 *   如果顺序反了，攻击者可以用伪造的跨站请求【探测】某个 slug 是否被暂停
 *   （根据返回是 303 还是继续走到别处）。先验 Origin 就把这条路堵了。
 *
 * 【⚠ status 的优先级（第 14 步），这是最容易看错的一段】
 *
 *     mode === 'paused'
 *         → 一律 'pending'（暂停期间全部人工审）
 *     否则若绑定了 AI_MOD
 *         → AI 说了算：'spam'→spam，'approve'→approved，其它→pending
 *           ⚠ 此时 MODERATION 设置【被完全忽略】
 *     否则（没 AI）
 *         → 看 MODERATION：'on'→pending，其它→approved
 *
 *   也就是说：**AI 一旦绑定就是唯一的审核者**，MODERATION 只作为无 AI 时的兜底。
 *   ★ 想改成"AI 建议 + MODERATION 最终决定"，就改这一段。
 */
import type { Env } from "./types.js";
import { checkRateLimit } from "./rate-limit.js";
import { triggerRebuild } from "./debounce.js";
import { classifyComment } from "./classify.js";
import { logModAction } from "./mod-log.js";
import { structuralFilter } from "./structural-filter.js";
import { escHtml } from "./html.js";

/**
 * 从 env 读一个整数限制，读不出来就用默认值。
 *
 * 【为什么需要这个函数】
 *   Env 里所有配置项都是 string（Cloudflare 变量只能是字符串），
 *   所以 RATE_LIMIT、MAX_BODY_LENGTH 这些都要 parse。
 *
 * 【兜底规则】
 *   - undefined 或空串 → 用默认值
 *   - 能 parse 出有限数 → 用那个值
 *   - parse 不出来（比如配了 "abc"）→ 【静默】用默认值
 *
 * ⚠ 第三种情况是静默失败：用户以为把限制设成了 "abc" 的意图是什么，
 *   实际什么都不生效，也不报错。★ 如果你想更严格，可以在这里
 *   遇到非法值时抛出（部署时立刻发现），代价是配置错误会导致 500。
 */
function limit(envValue: string | undefined, defaultValue: number): number {
  if (envValue === undefined || envValue === "") return defaultValue;
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * 把 IP 哈希成 16 位十六进制字符串，用于限流/封禁/去重。
 *
 * 【隐私设计】
 *   原始 IP **从不落库**。只存这个哈希（SHA-256 的前 8 字节）。
 *   这样即使数据库泄露，也无法直接还原访客 IP。
 *
 * ⚠ 这不是加密，是【单向摘要】，而且**没有加盐**：
 *   因为 IPv4 空间只有 2^32，攻击者可以暴力枚举所有 IPv4 生成彩虹表，
 *   用哈希反查真实 IP。
 *   ★ 如果你在意这点，给 digest 前拼一个站点级 secret 盐
 *     （但那样就不能跨部署比对了，且迁移旧数据时对不上）。
 *   ⚠ 另外注意：**哈希截断到 16 个字符（64 bit）**，
 *     截断降低了碰撞难度，但对"限流"这种用途足够。
 *
 * @returns 16 位小写十六进制字符串
 */
async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * 安全地解析"提交后跳回哪里"，防【开放重定向】（open redirect）攻击。
 *
 * 【漏洞原理】
 *   表单里有个隐藏字段 `redirect`，本来是为了让访客提交后回到原页面。
 *   但如果直接信任它，攻击者可以构造：
 *     POST /submit  … redirect=https://evil.com
 *   于是你的站点会把访客 303 跳到一个钓鱼站 ——
 *   而且 URL 里带的是【你信任的域名】，非常有说服力。
 *
 * 【白名单规则】只接受两类：
 *
 *   ① 路径相对 URL（以 "/" 开头）
 *      ⚠ 但要拒绝 "//evil.com" 和 "/\evil.com" ——
 *        浏览器会把这两个解析成【协议相对】的绝对地址（跳去 evil.com）！
 *        这就是为什么代码要检查 `candidate[1] !== "/" && candidate[1] !== "\\"`。
 *        这是本函数最容易写漏的一行。
 *
 *   ② 绝对 URL，且 hostname 匹配 ALLOWED_ORIGINS 里的某一项
 *      · 精确匹配：`blog.example.com` === `blog.example.com`
 *      · 子域匹配：`a.blog.example.com`.endsWith(".blog.example.com")
 *      ⚠ 用 endsWith("." + h) 而不是 endsWith(h)：
 *        `endsWith("example.com")` 会错误地放过 `evil-example.com`！
 *        前面加个点才是正确的域后缀判断。
 *
 * 其它一律回退到 "/"：包括 javascript:、data:、file:、解析失败的串。
 *
 * @param candidate   表单里的 redirect 值（不可信输入）
 * @param allowedHosts 来自 ALLOWED_ORIGINS 的 host 列表
 */
export function safeRedirect(candidate: string, allowedHosts: string[]): string {
  if (!candidate) return "/";
  // Path-relative — first char must be "/" and second char must NOT be "/" or "\"
  if (candidate.startsWith("/") && candidate[1] !== "/" && candidate[1] !== "\\") {
    return candidate;
  }
  // Absolute URL: must parse, must be http(s), must match an allowed host
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "/";
    const host = u.hostname.toLowerCase();
    if (
      allowedHosts.some(
        (h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase()),
      )
    ) {
      return candidate;
    }
  } catch {
    // not a parseable URL — fall through
  }
  return "/";
}

export async function handleSubmit(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Resolve runtime-configurable limits (env vars override hardcoded defaults).
  const maxBodyLength = limit(env.MAX_BODY_LENGTH, 10000);
  const minBodyLength = limit(env.MIN_BODY_LENGTH, 2);
  const maxAuthorLength = limit(env.MAX_AUTHOR_LENGTH, 100);
  const maxUrlsInBody = limit(env.MAX_URLS_IN_BODY, 3);
  const maxSlugLength = limit(env.MAX_SLUG_LENGTH, 255);

  // Mode check
  const modeRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'comments_mode'").first<{ value: string }>();
  const mode = modeRow?.value ?? "on";
  if (mode === "off") {
    return new Response("Comments are disabled", { status: 403 });
  }

  const formData = await request.formData();
  const slug = formData.get("slug")?.toString().trim() ?? "";
  const author = formData.get("author")?.toString().trim() ?? "";
  const body = formData.get("body")?.toString().trim() ?? "";
  const redirectUrl = formData.get("redirect")?.toString().trim() ?? "";

  // ══ CSRF 防护：Origin/Referer 必须匹配 ALLOWED_ORIGINS ══════════════════
  //
  // 【为什么表单提交需要防 CSRF】
  //   虽然这是个公开的表单，但跨站伪造提交会造成：
  //     · 用别人的 IP 灌垃圾评论（栽赃）
  //     · 消耗你的 AI 配额和 D1 写入额度
  //     · 探测"某页是否暂停"这类内部状态
  //
  // 【判定逻辑】
  //   优先取 Origin 头，没有就退回 Referer 头（老浏览器可能不发 Origin）。
  //   然后用和 safeRedirect 一样的主机匹配规则（精确 + 子域）。
  //
  // ⚠ 【关键取舍】配置了 ALLOWED_ORIGINS 时，**空 Origin 一律拒绝**。
  //   源码注释列了三种空 Origin 的成因：
  //     · data: URI 页面发起的请求
  //     · 服务端重定向过来的请求
  //     · 代理剥掉了头
  //   这些都不是正常访客的浏览器行为，所以宁可误杀。
  //   ★ 只有在【本地开发】（ALLOWED_ORIGINS 没配，allowedHosts 长度为 0）时，
  //     空 Origin 才被放行。所以本地测试能过、线上能被挡。
  //   ⚠ 这也意味着：如果你用 curl / Postman 测线上，**必须手动加 Origin 头**，
  //     否则会被 403 挡住，容易误以为代码有 bug。
  const origin = request.headers.get("Origin") ?? request.headers.get("Referer") ?? "";
  const allowedHosts = (env.ALLOWED_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const originHost = origin ? new URL(origin).hostname.toLowerCase() : "";
  if (allowedHosts.length > 0) {
    if (!originHost || !allowedHosts.some((h) => originHost === h.toLowerCase() || originHost.endsWith("." + h.toLowerCase()))) {
      return new Response("Invalid origin", { status: 403 });
    }
  }

  // Per-slug pause check (after CSRF so a forged request can't even probe pause state)
  if (slug) {
    const slugPaused = await env.DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(`slug_paused:${slug}`).first();
    if (slugPaused) {
      const candidate = redirectUrl || request.headers.get("Referer") || "/";
      const destination = safeRedirect(candidate, allowedHosts);
      return new Response(null, { status: 303, headers: { Location: destination } });
    }
  }

  // Validate required fields
  if (!slug) return new Response("Missing slug", { status: 400 });
  if (!author) return new Response("Missing author", { status: 400 });
  if (!body) return new Response("Missing body", { status: 400 });

  // Slug validation
  if (slug.length > maxSlugLength) return new Response("Slug too long", { status: 400 });
  if (!/^[a-z0-9-]+$/.test(slug)) return new Response("Invalid slug format", { status: 400 });

  // Length limits
  if (author.length > maxAuthorLength)
    return new Response("Author name too long", { status: 400 });
  if (body.length > maxBodyLength)
    return new Response("Comment too long", { status: 400 });
  if (body.length < minBodyLength)
    return new Response("Comment too short", { status: 400 });

  // Body heuristics — reject > maxUrlsInBody URLs
  const urlCount = (body.match(/https?:\/\//g) ?? []).length;
  if (urlCount > maxUrlsInBody)
    return new Response("Too many URLs", { status: 400 });

  // Layer 0: structural / malicious payload filter
  const filter = structuralFilter(author, body);
  if (filter.blocked) {
    return new Response(filter.reason, { status: 400 });
  }

  // Rate limiting
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = await hashIp(ip);
  const maxPerHour = env.RATE_LIMIT ? parseInt(env.RATE_LIMIT, 10) : 30;
  const { allowed } = await checkRateLimit(env.DB, ipHash, maxPerHour);
  if (!allowed) {
    return new Response("Rate limited. Try again later.", { status: 429 });
  }

  // Ban check
  const banned = await env.DB.prepare("SELECT 1 FROM banned_ips WHERE ip_hash = ?").bind(ipHash).first();
  if (banned) {
    return new Response("Forbidden", { status: 403 });
  }

  // AI spam classification (skip if paused — pause means review everything)
  const classifyStart = Date.now();
  const classification = mode === "paused" ? "approve" as const : await classifyComment(author, body, env);
  const classifyMs = Date.now() - classifyStart;

  // Escape and insert
  const safeAuthor = escHtml(author);
  const safeBody = escHtml(body);

  // ══ status 解析：三套规则的优先级 ═══════════════════════════════════════
  //
  // 这是本文件最需要看懂的一段。三种模式互斥，顺序如下：
  //
  //   ① mode === "paused"（全站暂停）
  //        → 一律 pending。**AI 和 MODERATION 都不看** ——
  //          "暂停"的语义就是"全部人工过一遍"。
  //
  //   ② 绑定了 AI_MOD（有 AI）
  //        → **AI 的判定是权威的**，MODERATION 被完全忽略：
  //            'spam'    → "spam"
  //            'approve' → "approved"
  //            'review' 或任何意外值 → "pending"
  //          ⚠ 最后的 else 是兜底：AI 返回没见过的值时不会崩，落到人工审。
  //            这是"宁可多审，不可漏放"的保守选择。
  //
  //   ③ 没绑 AI
  //        → 看 MODERATION 设置：'on' → pending，其它（含 'off'）→ approved
  //          ⚠ 注意这里是 `=== "on"` 而不是 `=== "off"`：
  //            所以配错值（比如 "ON"、"true"）会走 approved 分支 ——
  //            **静默地变成"不审核"**。★ 自定义时建议改成显式白名单校验。
  //
  // ★ 想改审核策略（比如"AI 只做建议，最终由 MODERATION 定"），
  //   就改这一整段。改完记得看 dashboard 的统计是否还对得上。
  let status: string;
  if (mode === "paused") {
    status = "pending";
  } else if (env.AI_MOD) {
    // AI is the moderator — its verdict is authoritative
    status = classification === "spam" ? "spam"
      : classification === "approve" ? "approved"
      : "pending"; // "review" or any unexpected value → pending
  } else {
    // No AI — fall back to MODERATION setting
    status = env.MODERATION === "on" ? "pending" : "approved";
  }

  // ══ 内容去重：5 分钟内同一个 (slug, IP, 正文) 只算一条 ═══════════════════
  //
  // 【防的是什么】用户双击按钮、网络重试、或刻意刷屏导致的重复插入。
  //
  // 【实现要点】
  //   时间条件是 SQL 侧算的（strftime 'now', '-5 minutes'），不是 JS 侧，
  //   这样和 created_at 的写入格式（同样是 strftime）严格一致，
  //   避免 JS 和 SQLite 的时区/格式细微差异导致比较失败。
  //
  // ⚠ 这是【内容去重】不是【请求去重】：
  //   用户改了哪怕一个字，就会被当作新评论插入。
  //   如果想做"同 IP 短时间内不能重复提交"，那应该用限流（前面已有），
  //   而不是这里。★ 两者定位不同，别混。
  //
  // ⚠ 注意比较的是 `safeBody`（已转义），而不是原始 body ——
  //   因为库里存的就是转义后的形式，必须用同一个形式比对。
  const existing = await env.DB.prepare(
    "SELECT id FROM comments WHERE slug = ? AND ip_hash = ? AND body = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes')",
  ).bind(slug, ipHash, safeBody).first();

  // Generate ID so we can reference it in the mod log
  const commentId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO comments (id, slug, author, body, status, ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(commentId, slug, safeAuthor, safeBody, status, ipHash)
      .run();

    // Log AI decision
    if (env.AI_MOD && mode !== "paused") {
      await logModAction(env.DB, `ai_${classification}`, "ai", {
        commentId, slug,
        metadata: { model: "@cf/meta/llama-3.1-8b-instruct-fast", latency_ms: classifyMs },
      });
    }

    // Trigger debounced rebuild if auto-approved
    if (status === "approved") {
      await triggerRebuild(env.DB, env, slug);
    }
  }

  const candidate = redirectUrl || request.headers.get("Referer") || "/";
  const destination = safeRedirect(candidate, allowedHosts);

  // PRG: always redirect with 303. Set a flash cookie so the GET handler
  // serves fresh comments via HTMLRewriter (commenter sees their comment instantly).
  const headers = new Headers({ Location: destination });
  if (status === "approved" || status === "spam") {
    headers.set(
      "Set-Cookie",
      `ziscus_posted=${slug}; Max-Age=120; Path=/; SameSite=Lax; Secure; HttpOnly`,
    );
  }
  return new Response(null, { status: 303, headers });
}
