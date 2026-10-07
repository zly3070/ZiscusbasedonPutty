// ============================================================================
// notes/tscheck.mjs —— TS 文件的真实语法校验器
//
// 【为什么需要它】
//   node --experimental-strip-types --check file.ts   ← 在 Node 24 上是【无效的】
//
//   实测：即使文件里塞进 "@@@ not valid" 这样的垃圾，甚至函数体外游离的
//   return 语句，`--check` 依然返回 exit 0。原因是 --check 对 .ts 走不到
//   真正的解析路径（它按 CommonJS 处理，而 TS 的剥离规则让它静默通过）。
//
//   本项目是给源码加注释的，改坏了必须立刻发现，所以需要一个可靠的检查器。
//
// 【这个脚本的原理】
//   1. 用 Node 内置的 module.stripTypeScriptTypes() 把 TS 剥离成 JS
//      —— 这一步本身就是解析，语法错误会在这里抛
//   2. 再用 vm.SourceTextModule 只解析不执行（构造时就会校验语法）
//      —— 这一步能抓出"剥离后仍不合法"的情况（比如游离的顶层 return）
//
// 【用法】
//   node --experimental-vm-modules notes/tscheck.mjs <文件...>
//
//   必须带 --experimental-vm-modules，否则 vm.SourceTextModule 不可用。
// ============================================================================

import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("用法: node --experimental-vm-modules notes/tscheck.mjs <文件...>");
  process.exit(2);
}

let failed = 0;

// 用 async IIFE 包住整个循环，这样循环内部可以用 await import() 做真实求值
await (async () => {
for (const file of files) {
  const abs = path.resolve(file);
  const label = path.basename(abs);

  if (!fs.existsSync(abs)) {
    console.log(`  ✗ ${label}  —— 文件不存在`);
    failed++;
    continue;
  }

  const source = fs.readFileSync(abs, "utf8");
  let js;
  let stage = "stripTypeScriptTypes";

  try {
    // 阶段 1：剥离 TS 类型。语法错误在这里就会抛。
    js = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (e) {
    console.log(`  ✗ ${label}  —— ${stage} 失败`);
    console.log(`      ${e.message.split("\n")[0]}`);
    failed++;
    continue;
  }

  try {
    // 阶段 2：只解析不执行。能抓出剥离后仍然非法的结构。
    stage = "SourceTextModule 解析";
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(js, { identifier: abs });
  } catch (e) {
    console.log(`  ✗ ${label}  —— ${stage} 失败`);
    console.log(`      ${e.message.split("\n")[0]}`);
    failed++;
    continue;
  }

  const lines = source.split("\n").length;

  // ── 阶段 3：真正【求值】模块 ────────────────────────────────────────────
  //
  // 【为什么语法检查还不够 —— 这是一个真实的教训】
  //
  //   有一次给 auth.ts 加注释时，替换范围出错，把 requireAuth 的函数体
  //   复制了一份留在文件末尾（模块顶层的游离代码）。
  //
  //   如果那些游离语句里【带 return】→ stripTypeScriptTypes 会报
  //   "Return statement is not allowed here"，能抓到。
  //   但如果游离语句是 `const x = 1; if (x) ...;` 这种合法结构，
  //   语法检查【全部通过】，可一旦真正加载这个模块就会因为引用了
  //   不存在的绑定而抛 ReferenceError —— 整个 Worker 起不来。
  //
  //   所以在语法检查之后，再做一次真实的模块求值。
  //
  //   安全性：这里只 import 该文件本身，不会执行它的顶层副作用之外的东西。
  //   Worker 模块的顶层只有 import/声明/default export，加载是安全的。
  //   （如果某个模块在顶层真的做了网络/数据库操作，这里也会暴露出来 ——
  //     那本身就是值得知道的坏设计。）
  try {
    const fileUrl = pathToFileURL(abs).href + "?tscheck=" + Date.now();
    // ⚠ 有些文件【不是库】而是可执行脚本（比如 classify.eval.ts），
    //   它们在顶层检查环境变量，缺了就调 process.exit()。
    //   那会把我们整个检查器一起干掉（实测踩过），所以这里临时把
    //   process.exit 换成一个抛错版本，把退出请求变成可捕获的异常。
    const realExit = process.exit;
    process.exit = ((code) => {
      throw new Error(`__SCRIPT_EXITED__:${code ?? 0}`);
    });
    try {
      await import(fileUrl);
    } finally {
      process.exit = realExit;
    }
  } catch (e) {
    // 允许两类"无关错误"通过：
    //
    //  ① 缺少 Cloudflare 运行时全局（crypto、HTMLRewriter 等）
    //     —— 那些只有 Worker 运行时才有，不是代码写坏了。
    //
    //  ② 解析不到 "./xxx.js"
    //     本项目是 TypeScript，按 TS 的 ESM 约定 import 时写 "./auth.js"
    //     （因为编译产物是 .js）。Node 原生加载 .ts 时不会做这个映射，
    //     所以会报 "Cannot find module ...auth.js"。
    //     这是工具的限制，不是代码问题 —— 但⚠ 它会让求值阶段对
    //     【有相对 import 的文件】失效。所以下面的结论要标出来。
    const msg = e?.message ?? String(e);
    const isRuntimeGlobalMissing =
      e instanceof ReferenceError &&
      /\b(crypto|HTMLRewriter|D1Database|Fetcher|Ai|Request|Response|Headers|fetch)\b/.test(msg);
    const isTsJsExtensionResolution =
      e?.code === "ERR_MODULE_NOT_FOUND" && /\.js' imported from/.test(msg);
    // 脚本在顶层自行退出（需要环境变量等）—— 说明它是可执行入口而非库，
    // 不是语法问题，也不该算失败。
    const isScriptExit = /__SCRIPT_EXITED__/.test(msg);

    if (isScriptExit) {
      console.log(
        `  - ${label.padEnd(22)} ${String(lines).padStart(5)} 行  语法正确（可执行脚本，顶层会自行退出）`,
      );
      continue;
    }

    // 依赖没装（本地没跑 pnpm install）—— 测试文件 import vitest 会这样。
    // 这是环境问题，不是代码问题。
    const isMissingDependency =
      e?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package/.test(msg);

    if (isMissingDependency) {
      console.log(
        `  ~ ${label.padEnd(22)} ${String(lines).padStart(5)} 行  语法正确（依赖未安装，求值阶段跳过）`,
      );
      continue;
    }

    if (isTsJsExtensionResolution) {
      console.log(
        `  ~ ${label.padEnd(22)} ${String(lines).padStart(5)} 行  语法正确（有相对 import，求值阶段跳过）`,
      );
      continue;
    }

    if (!isRuntimeGlobalMissing) {
      console.log(`  ✗ ${label}  —— 模块求值失败（语法通过但运行时会崩）`);
      console.log(`      ${e?.constructor?.name ?? "Error"}: ${msg.split("\n")[0]}`);
      failed++;
      continue;
    }
    // 缺运行时全局 —— 记一下但不算失败
    console.log(`  ✓ ${label.padEnd(22)} ${String(lines).padStart(5)} 行  语法正确（缺运行时全局，已跳过求值）`);
    continue;
  }

  console.log(`  ✓ ${label.padEnd(22)} ${String(lines).padStart(5)} 行  语法正确 + 模块可加载`);
}
})();

console.log();
if (failed > 0) {
  console.log(`  ${failed} 个文件有问题`);
  process.exit(1);
}
console.log(`  全部 ${files.length} 个文件语法正确`);
