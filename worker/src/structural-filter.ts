/**
 * ============================================================================
 * worker/src/structural-filter.ts —— 反垃圾 Layer 0（纯规则，零成本）
 * ============================================================================
 *
 * 【定位：它不判断"内容是不是垃圾"，只判断"这根本不是人写的评论"】
 *
 *   源码注释说得很准：
 *     "Catches payloads that **no legitimate comment would ever produce**.
 *      Does NOT filter on content (that's the AI's job)."
 *
 *   所以它拦的都是**结构上不可能正常**的东西：
 *     空字节、大量不可见字符、同一字符重复 20 次以上、
 *     完全没有词、超长连续 token（编码/二进制载荷）。
 *
 * 【为什么要有 Layer 0（明明有 AI 了）】
 *   1. **免费且瞬时** —— AI 每天只有约 3000 次免费额度，且每次要几百毫秒。
 *      让规则先挡掉明显的垃圾，能省额度、降延迟。
 *   2. **AI 挂了也有效** —— AI 超时/异常时落到 review，而 Layer 0 始终在。
 *   3. **防提示词注入** —— 空字节和不可见字符常被用来绕过 AI 的判断。
 *
 * 【⚠ 一个意识到的局限】
 *   这里的规则都是"形态"层面的，所以：
 *     · 挡不住语义垃圾（"Great post! Visit my site"）→ 交给 AI
 *     · 挡不住刻意构造的规避（把长 token 切成两半、用不同的不可见字符）
 *   ★ 如果被针对性攻击，需要在这里加规则 —— 但每加一条都要问
 *     "会不会误杀正常评论"。比如中文/日文评论里连续字符很多，
 *     REPETITION_RE 用 `(.)\1{19,}` 而不是更短的门槛，就是为了避免
 *     把"哈哈哈哈哈哈…"这类正常表达误判（虽然 20 个以上还是会拦）。
 */

/** Layer 0 的判定结果。`blocked` 为 true 时 submit.ts 会拒绝并回显 `reason`。 */
export interface FilterResult {
  blocked: boolean;
  reason: string;
}

/**
 * 各种【不可见】Unicode 字符。
 *
 * 分类说明：
 *   \u200B-\u200F  零宽空格/连接符/方向标记
 *   \u2060-\u2064  词连接符、不可见分隔符
 *   \uFEFF         BOM / 零宽不换行空格
 *   \u202A-\u202E  双向文本控制字符（**危险**：能让文字显示顺序与实际相反）
 *
 * 为什么限制数量而不是完全禁止：某些正常场景（如阿拉伯语/希伯来语混排）
 * 会合法用到方向标记。所以允许少量、拦截滥用。
 */
const INVISIBLE_RE =
  /[\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\uFEFF\u202A-\u202E]/g;

/**
 * 不可见字符的容忍上限。
 * ⚠ 超过 5 个就拒。**这个门槛对纯中文/英文的正常评论足够宽松**，
 *   但如果你的读者群大量使用双向文字（阿拉伯语、希伯来语），
 *   可能需要调高。★ 这是自定义时值得关注的旋钮。
 */

// 好多些不可见字符，需要过滤吗？
const MAX_INVISIBLE_CHARS = 5;

/**
 * 同一字符连续重复 20 次以上。
 * 拦的是"aaaaaaaa…"这类填充/噪声。
 * ⚠ 门槛取 20 而不是 5，是为了不误杀正常的语气强化（"好—————"）。
 */
// 杀掉超过及20个连续的字符
const REPETITION_RE = /(.)\1{19,}/;

/**
 * "至少有一个像词的东西" —— 两个以上字母/数字，或者 "+1" 这种。
 *
 * 用 Unicode 属性 \p{L}（任意语言的字母）和 \p{N}（数字），
 * 所以中文、日文、韩文、俄文都算"词"，不会被误杀。
 * ⚠ 最后的 `[+]\d` 是专门为 "+1" 这种网络用语开的口子 ——
 *   否则纯 "+1" 的评论会因为不含两个连续字母而被拦。
 */
// 过滤单个数字等类似的信息，但是我怀疑其必要性
const HAS_WORD_RE = /[\p{L}\p{N}]{2,}|[+]\d/u;

/**
 * 单个"非空白 token"的最大长度，**URL 除外**。
 *
 * 拦的是 base64/十六进制编码的载荷（它们通常是一大坨无空格的字符）。
 * ⚠ 排除 URL 是必要的：长查询串的 URL 很容易超过 200 字符，
 *   但那是完全正常的评论内容。
 */
const MAX_TOKEN_LENGTH = 200;

/** 判断一个 token 是不是 URL（用于豁免长度限制） */
// URL前缀PREFIX
const URL_PREFIX_RE = /^https?:\/\//;

/**
 * Layer 0 结构过滤器。
 *
 * 按顺序检查 5 条规则，**任一条命中就立即返回**（短路）——
 * 顺序是从"最确定无疑的恶意"到"有可能是正常内容"，这样
 * 报给用户的 reason 最准确。
 *
 * @param author 昵称（和正文拼接后一起检查不可见字符和空字节）
 * @param body   正文（重复字符和超长 token 分别对两者检查）
 * @returns `{blocked, reason}`；`reason` 会直接展示给访客，所以措辞要友好
 */
export function structuralFilter(author: string, body: string): FilterResult {
  const combined = author + body;

  // 1. Null bytes — injection vector
  if (combined.includes("\0")) {
    return { blocked: true, reason: "Null bytes are not allowed" };
  }

  // 2. Invisible unicode abuse — text obfuscation 文本混淆
  const invisibleCount = (combined.match(INVISIBLE_RE) ?? []).length;
  if (invisibleCount > MAX_INVISIBLE_CHARS) {
    return { blocked: true, reason: "Too many invisible unicode characters" };
  }

  // 3. Excessive character repetition — padding / noise
  if (REPETITION_RE.test(author) || REPETITION_RE.test(body)) {
    return { blocked: true, reason: "Excessive character repetition" };
  }

  // 4. No word-like content — pure symbols / gibberish 单字符或是无意义
  if (!HAS_WORD_RE.test(body)) {
    return { blocked: true, reason: "Comment must contain word-like content" };
  }

  // 5. Long unbroken tokens — encoded/binary payloads (skip URLs) 过长
  // 根据任意字符切片
  const tokens = body.split(/\s+/);
  for (const token of tokens) {
    if (token.length > MAX_TOKEN_LENGTH && !URL_PREFIX_RE.test(token)) {
      return { blocked: true, reason: "Unusually long token detected" };
    }
  }

  return { blocked: false, reason: "" };
}
