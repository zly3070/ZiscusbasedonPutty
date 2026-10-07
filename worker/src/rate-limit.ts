/**
 * ============================================================================
 * worker/src/rate-limit.ts —— 按 IP 限流（固定时间窗 + 原子自增）
 * ============================================================================
 *
 * 【算法：固定窗口计数器（fixed-window counter）】
 *
 *   把时间切成 `windowMinutes` 长的窗口，每个 (IP, 窗口) 一个计数器。
 *   窗口边界是【绝对时间对齐】的，不是"从第一次请求开始算"：
 *
 *     12:00:00 ─────────── 13:00:00 ─────────── 14:00:00
 *       窗口A (count=3)      窗口B (count=0)      窗口C
 *
 *   好处：实现极简，一次数据库往返搞定，不需要定时清理（旧行留着也无害）。
 *
 *   ⚠ 代价是这个算法有【边界突刺】问题：
 *     如果某人在 12:59 用满 30 次、13:01 又用满 30 次，
 *     他就在 2 分钟内发了 60 条 —— 跨越窗口边界时限流形同虚设。
 *     如果这对你的站点是问题，要换成【滑动窗口】或【令牌桶】。
 *     （本项目是评论系统，突刺造成的最坏情况是一些垃圾评论，
 *       所以选了简单方案。这是个有意识的技术取舍。）
 *
 * 【为什么用 `INSERT ... ON CONFLICT ... RETURNING`】
 *
 *   D1（SQLite）在 Cloudflare 边缘是【多实例并发】的。
 *   如果写成"先 SELECT 再 UPDATE"，两个并发请求会读到同一个值、
 *   各自 +1、都写回 count+1 —— 有一次自增丢失（经典竞态）。
 *
 *   这里把"自增"和"读取"合成【一条原子语句】：
 *     INSERT 一行（不存在时）或 UPDATE count=count+1（存在时），
 *     并用 RETURNING 直接拿回新值。
 *   全程一次往返、无竞态。★ 你扩展限流逻辑时【必须保留这个写法】。
 */

/**
 * 检查某个 IP 哈希是否在限流之内。
 *
 * @param db            D1 绑定
 * @param ipHash        IP 的哈希（**不要传原始 IP** —— 见 submit.ts 的 hashIp）
 * @param maxPerWindow  窗口内允许的最大次数
 * @param windowMinutes 窗口长度（分钟）
 * @returns `allowed=false` 时调用方应该回 429；`remaining` 可用于给用户提示或加响应头
 *
 * ⚠ 注意默认值是 `maxPerWindow = 5`，但 submit.ts 调用时【显式传了
 *   env.RATE_LIMIT ?? 30】。也就是说实际的线上默认是 30，不是这里的 5。
 *   这个 5 只是"调用方忘了传参时的兜底"，容易误读 —— 学习时要留意。
 */
export async function checkRateLimit(
  db: D1Database,
  ipHash: string,
  maxPerWindow: number = 5,
  windowMinutes: number = 60,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  // 窗口键：把当前时间【向下取整】到窗口边界，得到本窗口的起始时刻。
  // 这样同一窗口内的所有请求会算出【同一个】windowStart 字符串，
  // 从而命中 rate_limits 表的 (ip_hash, window) 主键。
  const windowStart = new Date(
    Math.floor(now.getTime() / (windowMinutes * 60 * 1000)) * (windowMinutes * 60 * 1000),
  ).toISOString();

  // 原子 upsert：一次往返，无竞态。
  //   - 行不存在 → 插入 count = 1
  //   - 行已存在 → count = count + 1
  //   - RETURNING count 把新值带回来，省掉一次 SELECT
  const row = await db
    .prepare(
      "INSERT INTO rate_limits (ip_hash, window, count) VALUES (?, ?, 1) ON CONFLICT(ip_hash, window) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(ipHash, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  // ⚠ 注意判断是 `> maxPerWindow` 而不是 `>=`：
  //   也就是 maxPerWindow = 30 时，第 30 次【仍然放行】，第 31 次才拒。
  //   边界差一位，改的时候要小心。
  if (count > maxPerWindow) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: maxPerWindow - count };
}
