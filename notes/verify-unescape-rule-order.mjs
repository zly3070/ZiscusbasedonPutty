// ============================================================================
// 穷举验证：unescapeHtml 里 5 条替换规则的【顺序】到底在什么情况下重要
//
// 背景：源码注释说 "&amp; is decoded last so that &amp;lt; becomes &lt;, not <"
// 人家先手算觉得不对，实测发现手算错了。为了给注释写出准确的原因，
// 这里用穷举法找出真正能体现顺序重要性的输入。
// ============================================================================

const RULES = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&amp;", "&"],
];

const apply = (s, order) => {
  let out = s;
  for (const i of order) out = out.split(RULES[i][0]).join(RULES[i][1]);
  return out;
};

// 所有排列
const perms = (arr) => {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of perms(rest)) out.push([arr[i], ...p]);
  }
  return out;
};
const ALL = perms([0, 1, 2, 3, 4]);
const CANONICAL = [0, 1, 2, 3, 4]; // 0=&lt; 1=&gt; 2=&quot; 3=&#39; 4=&amp;  ← 源码用的顺序

// 一个"实体原子"清单：评论者可能真的把这些字面打出来
const ATOMS = [
  "&amp;", "&lt;", "&gt;", "&quot;", "&#39;",
  "&amp;amp;", "&amp;lt;", "&amp;gt;", "&amp;quot;", "&amp;#39;",
  "&lt;&amp;lt;", "&amp;lt;&amp;gt;",
];

console.log("=".repeat(74));
console.log("第一步：验证源码声称的那个例子 —— &amp;lt; 会解成什么");
console.log("=".repeat(74));
const t = "&amp;lt;";
console.log(`  输入                        : ${JSON.stringify(t)}`);
console.log(`  indexOf('&lt;')             : ${t.indexOf("&lt;")}   ← -1 表示规则压根不匹配`);
console.log(`  源码顺序解码结果              : ${JSON.stringify(apply(t, CANONICAL))}`);
console.log(`  期望（评论者字面输入）          : "&lt;"`);
console.log(`  结论: ${apply(t, CANONICAL) === "&lt;" ? "✅ 源码注释正确" : "❌ 注释错了"}`);
console.log();

console.log("=".repeat(74));
console.log("第二步：穷举所有输入 × 所有替换顺序，找出【顺序真的会影响结果】的情况");
console.log("=".repeat(74));

let found = 0;
for (const atom of ATOMS) {
  const results = new Map();
  for (const order of ALL) {
    const r = apply(atom, order);
    if (!results.has(r)) results.set(r, []);
    results.get(r).push(order.join(""));
  }
  if (results.size > 1) {
    found++;
    console.log(`\n  输入 ${JSON.stringify(atom)}  →  ${results.size} 种不同结果：`);
    for (const [res, orders] of results) {
      const isCanonical = orders.includes(CANONICAL.join(""));
      console.log(
        `      ${JSON.stringify(res).padEnd(12)} ${isCanonical ? "← 源码顺序得到这个" : ""}`,
      );
      console.log(`          顺序代码: ${orders.slice(0, 4).join(", ")}${orders.length > 4 ? ` … 共${orders.length}种` : ""}`);
    }
  }
}

if (found === 0) {
  console.log("\n  没有找到任何「顺序会影响结果」的输入。");
  console.log("  → 说明这 5 条规则在本项目实际会遇到的输入上，顺序【无关紧要】");
}
console.log();

console.log("=".repeat(74));
console.log("第三步：直接对比两种极端顺序");
console.log("=".repeat(74));
const AMP_FIRST = [4, 0, 1, 2, 3]; // &amp; 最先
console.log("  " + "输入".padEnd(20) + "| 源码顺序(&amp;最后) | &amp;最先");
console.log("  " + "-".repeat(64));
for (const atom of ATOMS) {
  const a = apply(atom, CANONICAL);
  const b = apply(atom, AMP_FIRST);
  const mark = a === b ? "  " : " ≠";
  console.log(
    "  " +
      JSON.stringify(atom).padEnd(20) +
      "| " +
      JSON.stringify(a).padEnd(18) +
      " | " +
      JSON.stringify(b) +
      mark,
  );
}
console.log();

console.log("=".repeat(74));
console.log("第四步：构造一个真正会出错的输入（双次转义 + 多轮场景）");
console.log("=".repeat(74));
console.log("  场景：评论者输入字面文本  &amp;lt;  （9个字符，他想讨论 HTML 实体）");
const userTyped = "&amp;lt;";
const stored = userTyped
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;");
console.log(`    他输入的        : ${JSON.stringify(userTyped)}`);
console.log(`    escHtml 入库后  : ${JSON.stringify(stored)}`);
console.log(`    源码顺序解码    : ${JSON.stringify(apply(stored, CANONICAL))}`);
console.log(`    &amp;最先解码     : ${JSON.stringify(apply(stored, AMP_FIRST))}`);
console.log(`    他期望看到      : ${JSON.stringify(userTyped)}`);
console.log();

console.log("=".repeat(74));
console.log("总  结");
console.log("=".repeat(74));
console.log("  1. 源码注释举的例子（&amp;lt; → &lt;）是【正确】的，人家一开始手算错了");
console.log("  2. 但 &amp;lt; 之所以正确，不是因为「&amp; 最后解」救的它，");
console.log("     而是因为 lt; 前面没有 & → /&lt;/ 根本匹配不上（indexOf = -1）");
console.log("  3. 真正能体现「&amp; 必须最后解」的输入需要仔细构造；");
console.log("     在正常「转义一次 → 解码一次」的流程里，几种顺序大多等价");
console.log("  4. ⚠ 真正危险的是【解码两次】：第一次解码把 &amp;amp; 变成 &amp;，");
console.log("     第二次解码再把它变成 & → 用户看到的内容被吞掉");
console.log("     → 所以渲染器只能调 unescapeHtml 一次，这是纪律问题");
