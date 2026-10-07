/**
 * ============================================================================
 * worker/src/classify.ts —— AI 垃圾评论分类（Layer 1，可选）
 * ============================================================================
 *
 * 【在反垃圾体系里的位置】
 *
 *   Layer 0  structural-filter.ts   纯规则，无成本，挡明显恶意载荷
 *   Layer 1  本文件                   Workers AI，判"像不像垃圾评论"
 *   Layer 2  人工                    管理面板 approve/reject/spam
 *
 *   只有绑定了 `AI_MOD` 这个 binding 才会走 Layer 1。
 *   没绑 → classifyComment 直接返回 "approve"（等于"全放行，交给人工"）。
 *
 * 【⚠ 与 MODERATION 的关系（容易搞错）】
 *   一旦绑定 AI，**AI 的判定就成为权威**，MODERATION 被忽略：
 *     AI 说 approve → 直接发布（线上立刻可见）
 *     AI 说 spam    → 直接进垃圾箱
 *     AI 说 review  → 进待审队列
 *   也就是说 AI 绑了以后，"先审后发"的保守模式就失效了。
 *   ★ 想改成"AI 只做建议、仍按 MODERATION 待审"，要改 submit.ts 的
 *     status 解析段，不是改这里。
 *
 * 【为什么这个函数【从不抛异常】】
 *   它是评论提交路径上的一个环节。如果 AI 挂了导致访客提交失败，
 *   那是不可接受的 —— 评论系统不该被 AI 拖垮。
 *   所以：
 *     · 超时（3 秒）→ 返回 "review"
 *     · 任何异常     → 返回 "review"
 *     · 返回了看不懂的词 → 返回 "review"
 *   一律落到"待人工审"，**宁可多审，不可漏放也不可误杀**。
 *   ★ 这是正确的容错取向。别改成抛异常。
 */
import type { Env } from "./types.js";

/** AI 的三种判定。submit.ts 会把它映射成数据库里的 status */
export type Classification = "approve" | "spam" | "review";

/**
 * Workers AI 上的模型名。
 * ⚠ 这是【硬编码】的，不在 Env 里 —— 想换模型要改代码重新部署。
 * ★ 如果要做成可配置，加一个 AI_MODEL 环境变量。
 * 注意 `-fast` 后缀：分类是低延迟场景，不需要大模型。
 */
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

/**
 * 送给模型的最大正文字符数。
 * 目的：控制 token 消耗（Workers AI 免费额度约 3000 次/天）。
 * ⚠ 副作用：**超长评论的后半段不会被检查**，
 *   攻击者可以把垃圾内容放在第 500 字之后绕过 AI。
 *   （但 Layer 0 的规则过滤和 URL 数量限制仍然生效。）
 */
const MAX_BODY_CHARS = 500;

/**
 * AI 调用超时（毫秒）。
 *
 * ⚠ 这个值直接决定访客的等待时间 —— 因为分类是**在提交请求内同步做的**。
 *   超过 3 秒就放弃、落到 review。3 秒是"不阻塞用户体验"和
 *   "给模型足够时间"之间的折中。
 *   ★ 想降低访客等待，可以改成异步（先入库 pending，再由 queue 异步判定），
 *     代价是要引入 Cloudflare Queue。
 */
const AI_TIMEOUT_MS = 3000;

/**
 * 系统提示词。**这是你调优 AI 判定的主要旋钮。**
 *
 * 设计要点（值得学习）：
 *   · 明确给出三类和边界，而不是笼统说"判断垃圾"
 *   · **明确列出"什么算合法"**：短回复（"nice"、"thanks"、"+1"）、
 *     技术问题、反馈、批评、bug 报告、机器人状态更新、相关链接
 *     —— 这些很容易被误判为垃圾，所以显式白名单化
 *   · **明确列出"什么算垃圾"**：SEO 推销、营销服务、加密货币、
 *     虚假收益、带外链的客座投稿、"联系我谈合作"
 *   · **给 review 加上约束**（"This should be rare."）——
 *     否则模型会偷懒，大量落到 review，把工作推给人工
 *   · 要求"one word only"配合 `max_tokens: 5` 限制输出
 *   · **"When in doubt, approve."** 偏向放行 ——
 *     因为漏放垃圾的代价（人工删）小于误杀好评论的代价（作者不爽）
 *
 * ★ 自定义提示：如果你的站点是特定领域（比如技术博客），
 *   可以在这里加上领域知识，或者调整"偏向放行"的倾向。
 */
const SYSTEM_PROMPT = `You classify blog comments as approve, spam, or review.

approve: any legitimate comment. Short reactions ("nice", "thanks", "+1"), technical questions, feedback, criticism, bug reports, bot status updates, and links to related content are all legitimate. When in doubt, approve.

spam: unsolicited commercial content. SEO pitches, marketing services, crypto/trading schemes, fake earnings claims, guest post requests with backlinks, and "contact me for a proposal" outreach.

review: only when you genuinely cannot tell. This should be rare.

Respond with one word only.`;

/**
 * 判断一条评论是 approve / spam / review。
 *
 * @param author 昵称（会被截断并去掉尖括号）
 * @param body   正文（会被截断到 MAX_BODY_CHARS 并去掉尖括号）
 * @returns 三种判定之一；**任何失败都返回 "review"**
 */
export async function classifyComment(
  author: string,
  body: string,
  env: Env,
): Promise<Classification> {
  if (!env.AI_MOD) return "approve";

  const safeAuthor = author.slice(0, 100).replace(/[<>]/g, "");
  const safeBody = body.slice(0, MAX_BODY_CHARS).replace(/[<>]/g, "");

  try {
    const result = await Promise.race([
      (env.AI_MOD.run as Function)(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Author: ${safeAuthor}\nComment: ${safeBody}` },
        ],
        max_tokens: 5,
        temperature: 0,
        stream: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), AI_TIMEOUT_MS),
      ),
    ]);

    const response = (result as { response: string }).response
      .trim()
      .toLowerCase();

    if (response.startsWith("spam")) return "spam";
    if (response.startsWith("approve")) return "approve";
    if (response.startsWith("review")) return "review";

    console.error(`[ziscus] Unexpected AI response: "${response}"`);
    return "review";
  } catch (err) {
    console.error(`[ziscus] AI classification failed: ${err instanceof Error ? err.message : err}`);
    return "review";
  }
}
