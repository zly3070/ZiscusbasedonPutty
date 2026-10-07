/**
 * ============================================================================
 * embed/src/styles/themes.ts —— 主题（配色 + 配套 CSS），供 CLI 脚手架使用
 * ============================================================================
 *
 * 【这个文件在系统里的位置】
 *
 *   它【不在访客路径上，也不在 SSG 的运行时路径上】，只在
 *   `npx ziscus init` 生成模板的那一刻被调用一次：
 *
 *     npx ziscus init --ssg hugo --theme dark
 *          │
 *          ▼  cli/init.ts  runInit()
 *       generateThemeCss("dark")   ← 本文件
 *          │
 *          ▼  把这段 CSS 内联进生成的模板文件
 *       layouts/partials/ziscus.html（Hugo）/ src/components/Ziscus.astro / …
 *          │
 *          ▼  之后每次构建，这段 CSS 都作为静态文本原样输出
 *       页面里的 <style> 或 .css
 *
 *   ⚠ 也就是说：本文件【只在 init 时跑一次】。改了这里的 CSS，
 *     已经 init 过的项目【不会自动更新】—— 必须重跑 init
 *     （会覆盖你手改过的模板，⚠ 注意备份），或者手动把新 CSS 抄过去。
 *
 * ⚠⚠ 【这个仓库里同时存在两套互不相容的 class 命名 / 变量命名体系】
 *
 *   体系 A（库用户走这条）：
 *     render.ts + styles.ts
 *     选择器：#comments / .comment / .comment-form
 *     变量：  --ziscus-text 等（回退到 --color-text）
 *
 *   体系 B（脚手架用户走这条）：
 *     themes.ts（本文件）+ cli/init.ts 生成的模板
 *     选择器：.ziscus / .ziscus-comment / .ziscus-form
 *     变量：  --zc-text 等（没有回退链）
 *
 *   两套【没有任何交集】：class 名不同、变量前缀不同、连变量数量都不同。
 *
 *   ⚠ 后果：
 *     ① 用 `npx ziscus init` 生成模板的人，拿到的是体系 B；
 *        而他照 README 的 Theming 一节自定义 `--ziscus-*` 时
 *        （那是体系 A 的变量），【一点效果都没有】，且没有任何提示。
 *     ② 体系 B 的模板不产出 `#comments` / `.comment-form`，
 *        因此 worker 端的两个 HTMLRewriter 功能【都失效】：
 *          · 评论者提交后"立刻看到自己的评论"（html-rewriter.ts）
 *          · 按页暂停评论（index.ts 删表单元素）
 *        页面照样能构建、评论照样能提交，所以【故障完全静默】。
 *     ③ 两套设计系统意味着任何视觉改动都要做两遍，且很容易只改一边。
 *
 *   ★ 这是本项目最大的一处技术债。想收敛，建议二选一：
 *     (a) 让 cli/init.ts 的模板直接改用体系 A 的 class 名与 `#comments`，
 *         即脚手架不再自带一套 CSS，而是内联 `ziscusStyles()` 的结果 ——
 *         顺便让 README 的 Theming 立刻生效。
 *     (b) 反过来把 render.ts/styles.ts 改成体系 B。
 *     (a) 改动更小、兼容性更好，且能顺带修好即时预览功能。
 *     ⚠ 无论选哪个，都要同步更新 worker 端的选择器，并补跨包断言测试。
 *
 * 【导出】
 *   ThemeColors        主题的颜色形状
 *   THEMES             内置三套主题（light / dark / terminal）
 *   generateThemeCss   主题 → CSS 文本
 *
 *   ⚠ 这三个都【没有从包的 index.ts 导出】。外部用户拿不到它们，
 *     只能通过 `npx ziscus init --theme <name>` 间接使用。
 *     想开放见 embed/src/index.ts 的注释。
 */

/** 一套主题需要定义的颜色。⚠ 只有这 4 个槽位，改不了字号/间距/圆角。 */
export interface ThemeColors {
  text: string;
  bg: string;
  border: string;
  muted: string;
}

/**
 * 内置主题表。★ 想加自己的主题，就在这里加一个 key
 * （但记得同时把名字加进 `cli.ts` 里 init 的提示文案与校验，
 *  否则用户输入的名字不会被识别 —— 虽然不会报错，只会静默回退到 light）。
 *
 * ⚠ `light` 的四个值和 `styles.ts` 里硬编码的兜底值【完全相同】，
 *   是【两份独立的拷贝】。改配色时两边都要改，否则"用 init 的浅色主题"
 *   和"用 ziscusStyles() 默认样式"看起来一样、实际是两个来源，
 *   将来只改一边就会出现两套浅色。
 *
 * ⚠ `terminal` 的配色（琥珀色 / #FFB000 on #0D0D0D）看起来是给某个
 *   终端风格主题站的定制需求加的。这类高度个人化的主题放在库里，
 *   意味着长期维护成本 —— ★ 更合适的做法是让用户在配置里传 ThemeColors。
 *
 * ⚠ `dark` 的对比度：#e0e0e0 on #1a1a1a 约 12:1，通过 WCAG AA/AAA；
 *   `terminal` 的 #FFB000 on #0D0D0D 约 10:1，也过 AA。
 *   但 `muted` 色没这么幸运：light 的 #6b6b6b on #fff 约 5.3:1（过 AA），
 *   dark 的 #888 on #1a1a1a 约 4.6:1（擦线过 AA），
 *   ⚠ terminal 的 #AA7700 on #0D0D0D 约 5.0:1 —— 但 muted 被用在了
 *   label 和 time 上，属于【正文级文本】，改动这些值时请重新算对比度。
 */
export const THEMES: Record<string, ThemeColors> = {
  light: { text: "#1a1a1a", bg: "#fff", border: "#e0e0e0", muted: "#6b6b6b" },
  dark: { text: "#e0e0e0", bg: "#1a1a1a", border: "#333", muted: "#888" },
  terminal: { text: "#FFB000", bg: "#0D0D0D", border: "#333", muted: "#AA7700" },
};

/**
 * 生成带指定主题颜色的完整 CSS（变量定义 + 组件规则）。
 *
 * 【输入契约】
 *   theme  可以传【主题名】（`"light"` / `"dark"` / `"terminal"`），
 *          也可以直接传一个 `ThemeColors` 对象自定义配色。
 *   返回   一段完整可用的 CSS 文本（不含 `<style>` 标签）。
 *
 * ⚠ 【传未知主题名不会报错，会静默回退到 light】
 *   `THEMES[theme] ?? THEMES.light!` —— 打错字（比如 `--theme Dark`
 *   或 `--theme solarized`）的后果是"拿到浅色主题"，
 *   【没有任何警告】。对 CLI 用户来说，很容易以为自己选的主题不生效。
 *   ★ 想改进：未知名字时 `console.warn` 一下，或者抛错让用户知道。
 *     注意 `cli.ts` 里 init 的 theme 是自由字符串，没有白名单校验
 *     （只有 ssg 做了白名单检查），所以拼错 theme 是完全可能的。
 *
 * ⚠ 【颜色值被直接拼进 CSS，没有任何校验 —— 这是 CSS 注入面】
 *   如果 `theme` 来自不可信来源（配置文件、CI 变量、用户输入），
 *   那么 `generateThemeCss({ text: "red } body { display: none } .x {" })`
 *   就会注入任意 CSS 规则。在 ziscus 的用法里 `customColors` 只可能来自
 *   本地代码，所以【当前不是可利用的漏洞】；
 *   ★ 但如果你以后做了"从远端配置读主题"，必须先按白名单校验颜色格式
 *     （如 `/^#[0-9a-f]{3,8}$/i` 或 `rgb()/hsl()` 语法），再拼接。
 *
 * ⚠ 【本函数的 CSS 用的是 `.ziscus` 体系，和 render.ts 不配套】
 *   详见文件头的「两套体系」说明。具体地说：
 *     · 变量前缀是 `--zc-*`，【不是】README 里写的 `--ziscus-*`
 *     · 选择器是 `.ziscus` / `.ziscus-comment` / `.ziscus-form`，
 *       【不是】`#comments` / `.comment` / `.comment-form`
 *   所以这段 CSS 只对 `cli/init.ts` 生成的那套模板有效。
 *   把它和 `renderCommentsSection()` 一起用，样式【完全不会命中】。
 *
 * ⚠ 变量定义挂在 `.ziscus` 这个【类】选择器上（而不是 `:root`），
 *   意味着它的作用域是"所有 class 含 ziscus 的元素及其后代"。
 *   好处是多个 ziscus 区域可以各自换色；坏处是
 *   ★ 你不能通过在 `:root` 上覆盖 `--zc-*` 来换主题 —— 因为
 *   `.ziscus` 上的定义优先级更高，会盖掉 `:root` 继承下来的值。
 *   想换色必须传 `customColors` 或直接改这个文件。
 *
 * @param theme 主题名（`light` / `dark` / `terminal`）或自定义颜色对象
 * @returns 完整 CSS 文本；未知主题名时回退到 light
 */
export function generateThemeCss(theme: string | ThemeColors): string {
  // 名字查不到就静默回退 light（⚠ 见函数注释：拼错主题名不会有任何提示）。
  // `!` 非空断言是给编译器看的 —— 实际运行时若 THEMES.light 被删掉，
  // 这里会变成 undefined 并在下面的模板串里渲染成 "undefined"（非法 CSS），
  // 而不是抛错。⚠ 别删 light 这个 key。
  const colors = typeof theme === "string" ? THEMES[theme] ?? THEMES.light! : theme;

  return `.ziscus { --zc-text: ${colors.text}; --zc-bg: ${colors.bg}; --zc-border: ${colors.border}; --zc-muted: ${colors.muted}; }
.ziscus { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--zc-border); }
.ziscus h2 { font-size: 1.2rem; margin-bottom: 1rem; color: var(--zc-text); }
.ziscus-comment { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--zc-border); }
.ziscus-header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.25rem; }
.ziscus-author { font-weight: bold; color: var(--zc-text); }
.ziscus-time { font-size: 0.85rem; color: var(--zc-muted); }
.ziscus-body { margin: 0; color: var(--zc-text); }
.ziscus-form { margin-top: 1.5rem; }
.ziscus-form label { display: block; margin-bottom: 0.25rem; font-size: 0.9rem; color: var(--zc-muted); }
.ziscus-form input, .ziscus-form textarea { width: 100%; padding: 0.5rem; margin-bottom: 0.75rem; border: 1px solid var(--zc-border); background: var(--zc-bg); color: var(--zc-text); font: inherit; box-sizing: border-box; }
.ziscus-form textarea { resize: vertical; }
.ziscus-form button { padding: 0.5rem 1.25rem; border: 1px solid var(--zc-border); background: var(--zc-text); color: var(--zc-bg); font: inherit; cursor: pointer; min-height: 44px; }
.ziscus-form button:hover { opacity: 0.85; }`;
}
