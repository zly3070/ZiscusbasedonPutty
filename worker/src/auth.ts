import type { Env } from "./types.js";

/**
 * ============================================================================
 * worker/src/auth.ts —— 管理端点鉴权（全项目唯一的一处）
 * ============================================================================
 *
 * 【鉴权模型：一个共享密钥，没有用户系统】
 *
 *   这个项目刻意不做好友/用户/角色。管理权限就是一个 Bearer token：
 *       Authorization: Bearer <ADMIN_SECRET>
 *   ADMIN_SECRET 由 `npx ziscus deploy` 生成，用
 *       wrangler secret put ADMIN_SECRET
 *   存进 Cloudflare（密钥是【只写】的，放进去就再也读不出来 —— 见下）。
 *
 * 【为什么从 query string 读密钥是错的】
 *   源码注释特意强调这点，值得展开：
 *     ① 浏览器历史 —— 密钥留在你的历史记录里
 *     ② Referer 头 —— 页面里的外部资源（图片/字体/分析脚本）会收到完整 URL
 *     ③ CDN / 代理日志 —— Cloudflare 和中间层都会记 URL
 *     ④ 搜索引擎 —— 被抓到的 URL 会进索引
 *   走请求头就没这些问题：头不会进历史、不会进 Referer、通常不进访问日志。
 *
 *   ⚠ 浏览器里没法直接设自定义头，所以官方建议用
 *     ModHeader / Requestly 这类扩展。**这是这个项目在开发体验上的一个痛点**
 *     —— 如果你要改进，可以在这里加一个"用 HttpOnly Cookie 换 Bearer"
 *     的登录端点（cookie 比扩展好用），但要自己处理 CSRF。
 *
 * 【⚠ 丢密钥 = 必须轮换】
 *   Cloudflare 的 secret 是 write-only，`wrangler secret list` 只给名字不给值。
 *   所以 npx ziscus deploy 之后【必须自己备份】ADMIN_SECRET，
 *   丢了只能重新 put 一次（所有已发出的 CLI 凭证立刻失效）。
 */

/**
 * 鉴权通过返回 `null`，失败返回 401 Response。
 *
 * 这个"返回 Response | null"的约定让调用方可以写成：
 *     const err = requireAuth(request, env);
 *     if (err) return err;
 * 比抛异常或返回布尔值都更顺手。
 *
 * ⚠ 注意 `!env.ADMIN_SECRET` 时【也返回 401】（而不是放行或 500）。
 *   这是一个偏保守的选择：**没配置密钥 = 锁死管理端点**，
 *   而不是"没密钥就没有保护"。别改成放行。
 */
export function requireAuth(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });
  const auth = request.headers.get("Authorization");
  if (auth === `Bearer ${env.ADMIN_SECRET}`) return null;
  return new Response("Unauthorized", { status: 401 });
}
