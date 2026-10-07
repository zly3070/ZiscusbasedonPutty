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

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("用法: node --experimental-vm-modules notes/tscheck.mjs <文件...>");
  process.exit(2);
}

let failed = 0;

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
  console.log(`  ✓ ${label.padEnd(22)} ${String(lines).padStart(5)} 行  语法正确`);
}

console.log();
if (failed > 0) {
  console.log(`  ${failed} 个文件有问题`);
  process.exit(1);
}
console.log(`  全部 ${files.length} 个文件语法正确`);
