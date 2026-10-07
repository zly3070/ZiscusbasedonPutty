/**
 * worker/src/env.d.ts —— 让 `cloudflare:test` 的测试环境认识我们的 Env 类型。
 *
 * 【这 5 行在做什么】
 *   `@cloudflare/vitest-pool-workers` 提供 `cloudflare:test` 模块，
 *   测试里用 `import { env } from "cloudflare:test"` 拿到一个"假的"绑定集合。
 *   这个模块自己声明了一个 `ProvidedEnv` 接口，默认是空的。
 *
 *   这里用【模块增强（module augmentation）】把我们的 `Env` 合并进去，
 *   于是测试里的 `env.DB`、`env.ADMIN_SECRET` 等都有正确的类型提示，
 *   不用到处写 `any` 或强制断言。
 *
 * 【⚠ 为什么它不在 types.ts 里】
 *   因为这个声明只在【测试编译期】有意义。放进 types.ts 会让生产代码
 *   也依赖 `cloudflare:test` 这个只有测试环境才有的模块。
 *   单独一个 .d.ts 是标准和干净的做法。
 *
 * ★ 如果你在 vite/vitest 配置里改了测试环境的绑定名，
 *   记得确认这里的 Env 和实际注入的对得上。
 */
import type { Env } from "./types.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
