import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * ============================================================================
 * worker/vitest.config.ts —— 测试环境的运行时配置
 * ============================================================================
 *
 * 【这个文件在做什么】
 *   它告诉 vitest：「用 @cloudflare/vitest-pool-workers 这个池来跑测试」，
 *   并为每个测试文件起一个隔离的 workerd 实例（Cloudflare 线上用的那个
 *   运行时），然后注入测试用的绑定与变量。
 *
 * 【配置的三个层次，优先级从低到高】
 *   1. wrangler.toml 里的绑定与变量（下面没覆盖的都沿用）
 *   2. miniflare.bindings —— 覆盖【变量】（字符串值）和绑定
 *   3. 单个测试文件里自己构造的 env（如 handleSubmit(request, mockEnv)）
 *
 * ============================================================================
 * 【⚠ 已知问题：测试会真的去请求 Cloudflare 的 Workers AI】
 * ============================================================================
 *
 * wrangler.toml 里声明了：
 *     [ai]
 *     binding = "AI_MOD"
 *
 * 于是测试环境也注入一个【真的 Workers AI 绑定】。而 index.test.ts 里
 * 那几个走 `SELF.fetch("/submit")` 的测试（SELF 用真实 env，绕过单个
 * 测试自己的 mock env）会**真的发起网络请求**。
 *
 * 【实测观察到的后果】
 *   · 每次要多等 classify.ts 里 3 秒的 AI_TIMEOUT_MS（好在 fail-closed
 *     会返回 "pending" 或 "approved"，测试仍然通过）
 *   · ⚠ 在无法访问 / 未登录的环境下，会触发 wrangler 的 OAuth 登录流程，
 *     它开一个本地回调端口（localhost:8976），浏览器打不开 → **测试被挂住**，
 *     实测 250 个测试只跑到 129 个就停了
 *
 * 【人家尝试过的两种修法，都失败了（记录下来避免重复踩坑）】
 *   ① 把 bindings 里的 AI_MOD 设为 undefined
 *      → 报 "Unexpected pool options"，因为 pool 会把显式的 undefined 当作
 *        非法配置项
 *   ② 给 AI_MOD 传一个带 run() 的普通对象
 *      → 同样报 "Unexpected pool options"。miniflare 的 bindings 是
 *        **数据绑定**，值必须是可 JSON 序列化的，函数保留不下来
 *
 * 【真正可行的方案（需要改测试代码，尚未实施）】
 *   让 vitest 不去读 wrangler.toml 的 [ai]，或者让 SELF 相关的测试不依赖
 *   真实绑定。注意：index.test.ts 里 "AI moderation security model" 那一组
 *   测试是**自己注入 mock** 的（envWithAI），完全不依赖这个真绑定 ——
 *   也就是说真实 AI 调用路径本来就没有被有意义地测试覆盖，
 *   只是被"碰巧能连通"覆盖了。
 *
 * 【如果你以后确实想测真实 AI】
 *   不要用 SELF（它用真实 env），改为直接调 handleSubmit 并自己传
 *   env.AI_MOD 的 mock —— 这正是项目里已有的做法。
 * ============================================================================
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // ⚠ 指向【测试专用】的配置，而不是 wrangler.toml。
        //
        // 原因：wrangler.toml 里有 `[ai] binding = "AI_MOD"`，会让测试环境
        // 注入一个【真的 Workers AI 绑定】，于是走 SELF.fetch 的测试会真的
        // 去请求 Cloudflare（未登录时触发 OAuth 弹窗、把测试挂住，还会产生
        // 用量计费）。而 miniflare 的 AI 绑定【没有本地实现】，无法在配置里
        // 替换成假的 —— 详见 wrangler.test.toml 头部的完整说明。
        //
        // 所以改用不含 [ai] 的配置：classifyComment() 会走
        // `if (!env.AI_MOD) return "approve"` 立刻返回，测试纯本地化。
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: {
            ADMIN_SECRET: "test-admin-secret",
            ALLOWED_ORIGINS: "ziscus.com,ziscus.hdz.workers.dev",
            MODERATION: "off",
            RATE_LIMIT: "30",
            GITHUB_REPO: "HectorZarate/ziscus",
          },
        },
      },
    },
  },
});
