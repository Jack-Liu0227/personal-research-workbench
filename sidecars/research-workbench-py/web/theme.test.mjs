// 主题色自检：node web/theme.test.mjs
// 从 index.html 里抠出主题函数块，用假的 document/localStorage 跑真值检验。
// 颜色数学（HSL 往返、对比度、明暗推导）最容易悄悄坏，所以留这一个可跑的检查。
import assert from "node:assert";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).sort((a, b) => b.length - a.length)[0];   // 取最大的那块（头里还有一个构建戳小脚本）
const block = js.slice(js.indexOf("const DEFAULT_THEME"), js.indexOf("function bindSwatches"));

const shim = `
const store = {};
const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
const document = { documentElement: { dataset: { theme: "dark" }, style: { v: {}, setProperty(k, v) { this.v[k] = v; } } } };
function alert(m) { throw new Error("alert:" + m); }
${block}
export { applyTheme, hexToHsl, hslToHex, luminance, themeSwatches, currentPrimary, DEFAULT_THEME, THEME_PRESETS, document };
`;
const t = await import("data:text/javascript;base64," + Buffer.from(shim).toString("base64"));
const root = t.document.documentElement;
const contrast = (a, b) => {
  const [l1, l2] = [t.luminance(a), t.luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

assert.ok(t.THEME_PRESETS.length >= 8, "预置色不能少于 8 个");
assert.ok(t.THEME_PRESETS.some((p) => p.primary === t.DEFAULT_THEME));

// HSL 往返
for (const h of [0, 45, 90, 150, 200, 270, 330]) {
  const hex = t.hslToHex(h, 70, 45);
  assert.ok(Math.abs(t.hexToHsl(hex).h - h) < 1.5, `hue ${h} 往返失败`);
}

// 深色模式：提亮主色 + 深色字
t.applyTheme("#176B87");
const darkAccent = root.style.v["--accent"];
assert.notEqual(darkAccent, "#176B87", "深色底必须提亮主色");
assert.equal(root.style.v["--accent-ink"], "#0d1218");

// 浅色模式：本色 + 白字
root.dataset.theme = "light";
t.applyTheme("#176B87");
assert.equal(root.style.v["--accent"], "#176B87");
assert.equal(root.style.v["--accent-ink"], "#ffffff");

// 对比度（WCAG AA 正文 4.5，深色底放宽到 3）
assert.ok(contrast("#176B87", "#ffffff") > 4.5, "浅色主题对比度不足");
assert.ok(contrast(darkAccent, "#111821") > 3, "深色主题对比度不足");

// 侧栏底色随明暗变化
root.dataset.theme = "dark";
t.applyTheme("#C85C4A");
const sideDark = root.style.v["--side-bg"];
root.dataset.theme = "light";
t.applyTheme("#C85C4A");
assert.notEqual(sideDark, root.style.v["--side-bg"]);

// 非法色号必须报错，不能静默
assert.throws(() => t.applyTheme("不是颜色"), /alert:/);

// 持久化 + 选中态唯一
root.dataset.theme = "dark";
t.applyTheme("#28735D");
assert.equal(t.currentPrimary(), "#28735D");
assert.equal((t.themeSwatches().match(/sel/g) || []).length, 1);
assert.equal((t.themeSwatches(true).match(/doton/g) || []).length, t.THEME_PRESETS.length);

// 每个预置色都要能推出一套能看的主题（深色底强调色对比度 ≥ 3）
for (const p of t.THEME_PRESETS) {
  t.applyTheme(p.primary);
  assert.ok(contrast(root.style.v["--accent"], "#111821") > 3, `${p.name} ${p.primary} 深色对比度不足`);
  root.dataset.theme = "light";
  t.applyTheme(p.primary);
  assert.ok(contrast(root.style.v["--accent"], "#ffffff") > 3, `${p.name} ${p.primary} 浅色对比度不足`);
  root.dataset.theme = "dark";
}

console.log("theme.test OK | 深色对比度", contrast(darkAccent, "#111821").toFixed(2),
            "| 浅色对比度", contrast("#176B87", "#ffffff").toFixed(2));
