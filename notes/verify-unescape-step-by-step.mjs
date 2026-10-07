// 最小复现：确认 &amp;lt; 到底被解成什么
const s = "&amp;lt;";
console.log("输入          :", JSON.stringify(s));
console.log();

// 逐步执行，观察每一步
let step = s;
console.log("初始            :", JSON.stringify(step));
step = step.replace(/&lt;/g, "<");
console.log("解 &lt;  之后   :", JSON.stringify(step));
step = step.replace(/&gt;/g, ">");
console.log("解 &gt;  之后   :", JSON.stringify(step));
step = step.replace(/&quot;/g, '"');
console.log("解 &quot; 之后  :", JSON.stringify(step));
step = step.replace(/&#39;/g, "'");
console.log("解 &#39; 之后   :", JSON.stringify(step));
step = step.replace(/&amp;/g, "&");
console.log("解 &amp; 之后   :", JSON.stringify(step));
console.log();

console.log("=== 关键：字符串里 '&amp;lt;' 的字符位置 ===");
for (let i = 0; i < s.length; i++) {
  console.log(`  [${i}] '${s[i]}'`);
}
console.log();

console.log("=== 在 '&amp;lt;' 里搜 '&lt;' ===");
console.log("  indexOf('&lt;') =", s.indexOf("&lt;"));
console.log("  从 index 5 开始看:", JSON.stringify(s.slice(5)));
console.log("  s.slice(5) 是否等于 '&lt;' ?", s.slice(5) === "&lt;");
console.log();

console.log("=== 所以 /&lt;/g 会不会匹配？===");
const m = s.match(/&lt;/g);
console.log("  match(/&lt;/g) =", JSON.stringify(m));
console.log();

console.log("=== 结论 ===");
console.log("  如果 match 为 null  → &lt; 规则不匹配 → &amp; 最后解 → 得到 '&lt;' ✅");
console.log("  如果 match 有值     → &lt; 规则匹配   → 会解成 '<'  ❌");
console.log();
console.log(`  实际 match = ${JSON.stringify(m)}，所以是 ${m === null ? "第一种（正确）" : "第二种（会解错）"}`);
