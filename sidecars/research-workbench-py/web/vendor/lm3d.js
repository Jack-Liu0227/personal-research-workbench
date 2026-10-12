/* 文献库 · 星云总览（three.js r128，全局 THREE，见 web/vendor/three/）
   照用户 Word 规格：
     · 中心金色爆发粒子星云 + 多层淡金同心弧轨道 + 中心下方标题
     · 5 个外围星系节点，每个是「独立的小螺旋星云」，5 个方位、5 种配色
     · 中心 ↔ 节点的柔和淡色曲线连线（不是直线图谱）
     · 磨砂玻璃面板绑在节点上（数字 / 标题 / 分支数 / 右箭头）
     · 极深黑底 + 稀疏远星；UnrealBloomPass 辉光；粒子 depthWrite=false
   数据仍是原结构：中心根节点 + N 个子目录节点（主题数 / 分支数） */
const LM3 = {
  // ① 中心星云
  corePts: 2600, coreR: 2.3, coreCol: 0xffd489, coreCol2: 0xfff0c2,
  arcs: 4, arcPts: 240, arcR: [6, 9.5, 13.5, 18], arcCol: 0xffd08a,   // 多层淡金同心弧
  // ② 外围 5 个小星云
  nodeDist: 27, nodeArms: 2, nodePts: 560, nodeR: 5, nodeTilt: 0.55,
  // ③ 背景 / 渲染
  bgPts: 900, bgR: 190, nebulaHaze: 0.55,
  spin: 0.018, bloom: 0.62, bloomR: 0.8, bloomT: 0.2,
};
// 5 个方位的配色（照文档：上=基础概念淡紫 / 右上=论文创新暖金 / 右下=图表框图淡蓝 / 左下=代码工程浅蓝绿 / 左上=研究方法青绿）
const LM3_NODES = [
  { deg: -90, col: 0xa06cff },     // 上方：淡紫
  { deg: -40, col: 0xffab3d },     // 右上：暖金
  { deg: 40, col: 0x5aa8ff },      // 右下：淡蓝
  { deg: 140, col: 0x4fd7c0 },     // 左下：浅蓝绿
  { deg: -140, col: 0x2fd39a },    // 左上：青绿
  { deg: 90, col: 0xb9a88c },      // 备用第 6 个（数据里那股「其余」用，暗一档、小一号）
];
let lm3 = null, lmGen = 0;
const lm3Rnd = (a, b) => a + Math.random() * (b - a);
const lm3Gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
function lm3Col(hex, mul = 1) { const c = new THREE.Color(hex); return [c.r * mul, c.g * mul, c.b * mul]; }
function lm3StarTex() {
  const s = 128, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d"), gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.22, "rgba(255,255,255,0.8)");
  gr.addColorStop(0.5, "rgba(255,255,255,0.22)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
function lm3Mat(tex, opacity) {          // 粒子材质：自发光 + 加色 + depthWrite=false（防闪烁）
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: tex }, uOpacity: { value: opacity }, uScale: { value: 1100 } },
    vertexShader: `attribute float aSize; attribute vec3 aCol;
      varying vec3 vCol; uniform float uScale;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(1.0, -mv.z);
        vCol = aCol; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uMap; uniform float uOpacity; varying vec3 vCol;
      void main(){ float m = texture2D(uMap, gl_PointCoord).r;
        gl_FragColor = vec4(vCol, 1.0) * m * uOpacity; }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function lm3Swarm(n, fn, mat) {          // 生成粒子云
  const pos = [], size = [], col = [];
  for (let i = 0; i < n; i++) { const p = fn(i); pos.push(p[0], p[1], p[2]); size.push(p[3]); col.push(p[4][0], p[4][1], p[4][2]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aSize", new THREE.Float32BufferAttribute(size, 1));
  g.setAttribute("aCol", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Points(g, mat);
}
function lm3Init() {
  const cv = $("lm3c"); if (!cv) return null;
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: false });
  renderer.setClearColor(0x03040a, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 900);
  const composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(1, 1), LM3.bloom, LM3.bloomR, LM3.bloomT);
  composer.addPass(bloom);
  return { cv, renderer, scene, camera, composer, bloom, tex: lm3StarTex(), root: new THREE.Group(),
           panels: [], childPanels: [], open: -1, hit: new Set(), rot: { x: 1.15, y: 0 }, dist: 66,
           drag: false, px: 0, py: 0, gen: lmGen };
}
function lm3Resize() {
  const cv = lm3.cv, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    lm3.renderer.setSize(w, h, false); lm3.composer.setSize(w, h);
    lm3.camera.aspect = w / h; lm3.camera.updateProjectionMatrix();
    return true;
  }
  return false;
}
function lm3BindInput() {
  const st = lm3, cv = st.cv;
  cv.style.cursor = "grab";
  cv.addEventListener("mousedown", e => { st.drag = true; st.px = e.clientX; st.py = e.clientY; cv.style.cursor = "grabbing"; });
  window.addEventListener("mousemove", e => {
    if (!st.drag || lm3 !== st) return;
    st.rot.y -= (e.clientX - st.px) * 0.005; st.rot.x -= (e.clientY - st.py) * 0.004;
    st.rot.x = Math.max(-1.3, Math.min(1.3, st.rot.x)); st.px = e.clientX; st.py = e.clientY;
  });
  window.addEventListener("mouseup", () => { st.drag = false; if (lm3 === st) cv.style.cursor = "grab"; });
  cv.addEventListener("wheel", e => { e.preventDefault(); st.dist = Math.max(26, Math.min(160, st.dist * (1 + Math.sign(e.deltaY) * 0.09))); }, { passive: false });
}
/* 场景构造：中心金色星云 + 多层淡金同心弧 + 5 个小螺旋星云 + 曲线连线 + 背景远星 */
function lm3Ang(deg) { return deg * Math.PI / 180; }

function lm3Center() {                       // ① 中心：金色爆发粒子星云 + 多层同心弧
  const S = LM3, tex = lm3.tex, g = new THREE.Group();
  const core = lm3Swarm(S.corePts, () => {   // 爆发核：球内高斯分布，里亮外淡
    const r = Math.pow(Math.random(), 2.2) * S.coreR, th = Math.random() * 6.283,
          ph = Math.acos(2 * Math.random() - 1);
    return [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.62, r * Math.sin(ph) * Math.sin(th),
            lm3Rnd(0.7, 1.9) * (1 - r / S.coreR * 0.35),
            lm3Col(Math.random() < 0.7 ? S.coreCol : S.coreCol2, lm3Rnd(0.5, 1.05))];
  }, lm3Mat(tex, 0.85));
  g.add(core);
  S.arcR.forEach((rr, k) => {                // ② 多层淡淡的金色同心圆弧轨道（粒子画的弧，留缺口）
    const gap = Math.random() * 6.283, arc = 4.4 + Math.random() * 1.8;
    const arcPts = lm3Swarm(S.arcPts, i => {
      const th = gap + (i / S.arcPts) * arc, wob = rr + lm3Gauss() * 0.18;
      return [Math.cos(th) * wob, lm3Gauss() * 0.3, Math.sin(th) * wob,
              lm3Rnd(0.35, 0.75), lm3Col(S.arcCol, 0.62 - k * 0.06)];
    }, lm3Mat(tex, 0.55));
    arcPts.userData.arcSpeed = (k % 2 ? 1 : -1) * (0.012 + k * 0.004);   // 每层转速/方向略不同
    g.add(arcPts);
  });
  return g;
}

function lm3MiniNode(ang, colHex, scale = 1) {   // ③ 外围节点＝一个独立的小螺旋星云
  const S = LM3;
  const pts = lm3Swarm(S.nodePts, i => {
    const arm = i % S.nodeArms, t = Math.pow(Math.random(), 0.6);
    const rad = 0.6 + t * S.nodeR * scale;
    const a = (arm / S.nodeArms) * 6.283 + t * 2.2 + lm3Gauss() * 0.22;
    const sp = 0.22 + t * 0.5;
    return [Math.cos(a) * rad + lm3Gauss() * sp, lm3Gauss() * sp * 0.8, Math.sin(a) * rad + lm3Gauss() * sp,
            lm3Rnd(0.55, 1.5) * (1 - t * 0.25),
            lm3Col(colHex, lm3Rnd(0.55, 1.05) * (1 - t * 0.3))];
  }, lm3Mat(lm3.tex, 0.62));
  const core = lm3Swarm(140, () => {         // 小星云也自带一点亮核
    const r = Math.pow(Math.random(), 2) * 0.9;
    return [lm3Gauss() * r, lm3Gauss() * r * 0.7, lm3Gauss() * r,
            lm3Rnd(0.6, 1.4), lm3Col(0xffffff, lm3Rnd(0.5, 0.95))];
  }, lm3Mat(lm3.tex, 0.75));
  const g = new THREE.Group(); g.add(pts, core);
  g.position.set(Math.cos(ang) * S.nodeDist, 0, Math.sin(ang) * S.nodeDist);
  g.rotation.set(lm3Rnd(-0.35, 0.35), lm3Rnd(0, 6.283), lm3Rnd(-0.35, 0.35));   // 每个小星云姿态不同
  g.userData.spin = lm3Rnd(0.25, 0.5) * (Math.random() < 0.5 ? -1 : 1);
  return g;
}

function lm3Link(a, b) {                     // ④ 柔和淡色曲线连线（中点抬高 → 自然弯曲，不是直线图谱）
  const mid = a.clone().add(b).multiplyScalar(0.5); mid.y += 4.2;
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(72));
  const mat = new THREE.LineBasicMaterial({ color: 0xbfd2ef, transparent: true, opacity: 0.15 });
  return new THREE.Line(geo, mat);
}

function lm3Background() {                   // ⑤ 极深黑底 + 稀疏远星 + 淡淡星雾
  const S = LM3;
  const bg = lm3Swarm(S.bgPts, () => {
    const th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1), r = S.bgR * (0.75 + Math.random() * 0.25);
    return [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th),
            lm3Rnd(0.45, 1.1), lm3Col(Math.random() < 0.85 ? 0xdfe8f6 : 0xffe6bb, lm3Rnd(0.2, 0.6))];
  }, lm3Mat(lm3.tex, 0.5));
  const haze = lm3Swarm(420, () => {         // 暗星云雾噪点
    const r = 30 + Math.random() * 120, th = Math.random() * 6.283;
    return [Math.cos(th) * r, lm3Gauss() * 22, Math.sin(th) * r,
            lm3Rnd(9, 22), lm3Col(0x2a3550, lm3Rnd(0.25, 0.6))];
  }, lm3Mat(lm3.tex, 0.16));
  const g = new THREE.Group(); g.add(bg, haze); return g;
}
/* 数据绑定：把 5 个主题分支挂到 5 个小星云上（磨砂面板 + 展开下一层） */
function lmCards() {
  const cs = (lmG.clusters || []).map((c, i) => ({ key: i, ids: c.ids, term: c.term, count: c.count }));
  const rest = (lmG.nodes || []).filter(n => n.cluster < 0).map(n => n.id);
  if (rest.length) cs.push({ key: -1, ids: rest, term: "其余", count: rest.length });
  return cs;
}
function lmNode(id) { return (lmG.nodes || []).find(n => n.id === id) || null; }
function lmCut(s, n) { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }
function lmHex(n) { return "#" + n.toString(16).padStart(6, "0"); }

function lm3Build() {
  const S = LM3, root = lm3.root;
  root.add(lm3Center());                                   // 中心金色星云 + 同心弧
  root.add(lm3Background());                               // 深空底 + 远星 + 星雾
  lm3.nodes = [];
  const cards = lmCards();
  cards.slice(0, LM3_NODES.length).forEach((c, i) => {
    const nd = LM3_NODES[i], ang = lm3Ang(nd.deg);
    const mini = lm3MiniNode(ang, nd.col, i === 5 ? 0.62 : 1);   // 第 6 个（「其余」）小一号
    root.add(mini);
    root.add(lm3Link(new THREE.Vector3(0, 0, 0), mini.position.clone()));
    lm3.nodes.push({ card: c, mini, ang, col: nd.col,
                     anchor: new THREE.Vector3(Math.cos(ang) * S.nodeDist, 6, Math.sin(ang) * S.nodeDist),
                     papers: new THREE.Group() });
  });
  lm3Panels();
}
function lm3Panels() {
  const box = $("lmPanels"); box.innerHTML = "";
  lm3.panels = (lm3.nodes || []).map((nd, i) => {
    const el = document.createElement("div");
    el.className = "lm-panel"; el.dataset.n = i;
    el.style.borderColor = lmHex(nd.col) + "55";
    el.innerHTML = `<span class="n">${nd.card.count}</span><b>${esc(nd.card.term)}</b>
      <span class="sub">${nd.card.count} 分支</span><i class="arw">›</i>`;
    el.onclick = e => { e.stopPropagation(); lm3Expand(i); };
    box.appendChild(el);
    return { el, anchor: nd.anchor, node: nd };
  });
  $("lmCenterTitle").innerHTML =
    `<b>文献库</b><i>${esc((lmG.center || {}).sub || "")}</i>
     <u>${(lmG.counts || {}).clusters || 0} 分支 · 派生自检索结果</u>`;
}
function lm3Expand(i) {
  const nd = (lm3.nodes || [])[i]; if (!nd) return;
  lm3ClearChildren();
  lm3.open = i;
  const ids = nd.card.ids.map(lmNode).filter(Boolean);
  if (!ids.length) return;
  const S = LM3, sw = lm3Swarm(Math.max(220, ids.length * 60), k => {   // 论文自身的粒子云
    const n = ids[k % ids.length], j = Math.floor(k / ids.length);
    const r = 1.2 + j * 0.5 + lm3Gauss() * 1.2, a = Math.random() * 6.283;
    return [Math.cos(a) * r + lm3Gauss() * 1.1, lm3Gauss() * 1.6, Math.sin(a) * r + lm3Gauss() * 1.1,
            lm3Rnd(0.6, 1.6), lm3Col(lm3.hit.has(n.id) ? 0xffe9a8 : nd.col, lm3Rnd(0.6, 1.1))];
  }, lm3Mat(lm3.tex, 0.85));
  sw.position.copy(nd.mini.position).add(new THREE.Vector3(0, 2.2, 0));
  nd.papers.add(sw);
  lm3.root.add(nd.papers);
  // 最多 6 张小板（点开看信息卡）
  lm3.childPanels = ids.slice(0, 6).map((n, k) => {
    const a = nd.ang + (k - 2.5) * 0.22, RR = 8.2;
    const el = document.createElement("div");
    el.className = "lm-panel mini"; el.dataset.id = n.id;
    el.innerHTML = `<b>${esc(lmCut(n.title, 22))}</b><span>被引 ${n.cited || 0}</span>`;
    el.style.borderColor = lmHex(nd.col) + "44";
    el.onclick = e => { e.stopPropagation(); lmPick = n; lmPaintInfo(); };
    $("lmPanels").appendChild(el);
    return { el, anchor: nd.mini.position.clone().add(new THREE.Vector3(Math.cos(a) * RR, 3.2, Math.sin(a) * RR)) };
  });
}
function lm3ClearChildren() {
  (lm3.childPanels || []).forEach(p => p.el.remove());
  lm3.childPanels = [];
  (lm3.nodes || []).forEach(nd => { nd.papers.clear(); lm3.root.remove(nd.papers); });
}
function lm3Project(v) {
  const p = v.clone().project(lm3.camera);
  return [(p.x * 0.5 + 0.5) * lm3.cv.clientWidth, (-p.y * 0.5 + 0.5) * lm3.cv.clientHeight, p.z];
}
function lm3Place() {
  const list = (lm3.panels || []).concat(lm3.childPanels || []);
  list.forEach(p => {
    const [x, y, z] = lm3Project(p.anchor), on = z < 1;
    p.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    p.el.style.opacity = on ? "1" : "0";
    p.el.style.pointerEvents = on ? "auto" : "none";
  });
  const [cx, cy, cz] = lm3Project(new THREE.Vector3(0, -4.6, 0));   // 中心标题挂在星云下方
  const t = $("lmCenterTitle");
  if (t) { t.style.transform = `translate(-50%,0) translate(${cx.toFixed(1)}px,${cy.toFixed(1)}px)`; t.style.opacity = cz < 1 ? "1" : "0"; }
}
function lm3Tick() {
  if (!lm3) return;
  if (lm3.gen !== lmGen || !document.body.contains(lm3.cv)) { lm3Dispose(); return; }
  const reduced = $("lmRM") && $("lmRM").checked;
  lm3Resize();
  if (!reduced) {
    lm3.root.rotation.y += LM3.spin * 0.016;                          // 整盘极慢自转
    lm3.root.children.forEach(o => {
      if (o.userData && o.userData.arcSpeed) o.rotation.y += o.userData.arcSpeed * 0.016;
      if (o.userData && o.userData.spin) o.rotation.y += o.userData.spin * 0.016;
    });
  }
  const c = lm3.camera, r = lm3.dist;
  const cx = Math.sin(lm3.rot.y) * Math.cos(lm3.rot.x), cy = Math.sin(lm3.rot.x), cz = Math.cos(lm3.rot.y) * Math.cos(lm3.rot.x);
  c.position.set(cx * r, cy * r + 3.2, cz * r); c.lookAt(0, 0, 0);
  lm3.composer.render();
  lm3Place();
  lm3.raf = requestAnimationFrame(lm3Tick);
}
function lm3Dispose() {
  lmGen++;
  if (lm3) {
    cancelAnimationFrame(lm3.raf);
    try {
      lm3.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      lm3.renderer.dispose();
      const lose = lm3.renderer.getContext().getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    } catch (e) { }
    lm3 = null;
  }
}
function lm3Search(v) {
  const q = (v || "").trim().toLowerCase(); lm3.hit = new Set();
  if (!q) { lm3ClearChildren(); lm3.open = -1; return; }
  const hit = (lmG.nodes || []).filter(n => `${n.title} ${n.authors} ${n.doi}`.toLowerCase().includes(q));
  lm3.hit = new Set(hit.map(n => n.id));
  if (hit.length) {
    const i = (lm3.nodes || []).findIndex(nd => nd.card.ids.includes(hit[0].id));
    if (i >= 0) lm3Expand(i);
  }
}
let lmPick = null;
function lmPaintInfo() {
  const n = lmPick, box = $("lmInfo");
  if (!n) { box.classList.add("hidden"); return; }
  box.innerHTML = `<b>${esc(n.title)}</b>
    <div class="meta">${esc(n.authors || "—")}<br>${esc(n.source || "")} ${esc(n.year || "")} · 被引 ${n.cited || 0}${n.oa ? " · OA" : ""}</div>
    <div class="acts">
      ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noreferrer">去来源页</a>` : ""}
      ${n.doi ? `<a href="https://doi.org/${esc(n.doi)}" target="_blank" rel="noreferrer">打开 DOI</a>` : ""}
      ${n.pdf ? `<a href="${esc(n.pdf)}" target="_blank" rel="noreferrer">OA 全文</a>` : ""}
      ${n.doi ? `<a data-copy="${esc(n.doi)}">复制 DOI</a>` : ""}
    </div>`;
  box.classList.remove("hidden");
  box.querySelectorAll("[data-copy]").forEach(a => a.onclick = () => navigator.clipboard?.writeText(a.dataset.copy));
}
/* 文献库 · 星云总览页：一块 3D 画布 + 浮层（顶部标题栏/搜索、5 张磨砂卡片、图例、底部控件） */
async function renderLibrary(m) {
  lm3Dispose(); lmPick = null;
  m.innerHTML = needTask();
  if (!curTask) return;
  m.innerHTML = `<div class="lm">
    <canvas id="lm3c"></canvas>
    <div class="lm-top">
      <div class="lm-tabs"><span class="on">文献库</span><span>星云总览</span></div>
      <input id="lmQ" class="lm-q" placeholder="搜索节点...">
    </div>
    <div class="lm-panels" id="lmPanels"></div>
    <div class="lm-ctitle" id="lmCenterTitle"><b>文献库</b><i>正在取数据…</i><u></u></div>
    <div class="lm-info hidden" id="lmInfo"></div>
    <div class="lm-legend">
      <div><i style="background:#ffd489"></i>主题分支</div>
      <div><i style="background:#9cc7ff"></i>检索文献</div>
      <div><i style="background:#74d3ad"></i>已入库 OA</div>
    </div>
    <div class="lm-foot">
      <label class="lm-rm"><input type="checkbox" id="lmRM"> 减少动态效果</label>
      <span class="lm-hint">点击星族展开下一层；点击知识碎片返回来源</span>
      <span class="lm-zoom"><button id="lmZout" title="缩小">－</button><button id="lmZin" title="放大">＋</button></span>
    </div>
  </div>`;
  let d;
  try { d = await api(`/api/litgraph?task=${encodeURIComponent(curTask)}`); }
  catch (e) { lmCoreMsg("读不到数据", e.message); return; }
  if (d.error) { lmCoreMsg("还是空的", d.error); return; }
  if (typeof THREE === "undefined") { lmCoreMsg("three.js 没加载", "看 web/vendor/three/ 那几个文件"); return; }
  lmG = d;
  lm3 = lm3Init();
  if (!lm3) { lmCoreMsg("这个窗口不给 WebGL", "换台机器 / 更新显卡驱动再试"); return; }
  lm3.hit = new Set(); lm3.open = -1; lm3.childPanels = [];
  lm3Build();                                   // 中心星云 + 5 个小星云 + 曲线 + 面板
  lm3.scene.add(lm3.root);
  lm3BindInput(); lm3Resize(); lm3Tick();
  $("lmQ").oninput = e => lm3Search(e.target.value);
  $("lmRM").checked = localStorage.getItem("lm-rm") === "1";
  $("lmRM").onchange = e => { localStorage.setItem("lm-rm", e.target.checked ? "1" : "0"); };
  $("lmZin").onclick = () => { lm3.dist = Math.max(26, lm3.dist * 0.86); };
  $("lmZout").onclick = () => { lm3.dist = Math.min(160, lm3.dist / 0.86); };
  $("lm3c").addEventListener("click", () => {     // 点空白处收回
    lm3ClearChildren(); lm3.open = -1; lmPick = null; $("lmInfo").classList.add("hidden");
  });
}
function lmCoreMsg(a, b) {
  const c = $("lmCenterTitle");
  if (c) c.innerHTML = `<b>文献库</b><i>${esc(a)}</i><u>${esc(b || "")}</u>`;
}
