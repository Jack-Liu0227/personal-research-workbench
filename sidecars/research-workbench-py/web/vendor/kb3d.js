/* 知识库页的两件视觉（逐字照 Baixiao-Reading-Cockpit 的实现）：
   1) fluid(root)       —— 四张统计卡各自的 WebGL 流体材质；着色器从参考插件原样搬，WebGL 不可用时回退 CSS 渐变
   2) orbit(root, opts) —— 3D 环绕目录卡：stage/scene/ring 的变换数学、拖拽 / 滚轮 / 自动巡航 / 复位 / 平面模式
   暴露 window.KB3D = { fluid, orbit, selfCheck }；重复 bind 会自动停掉上一轮（rAF/WebGL 不泄漏）。 */
(function () {
  "use strict";

  var VERTEX = "attribute vec2 p; varying vec2 uv; void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}";

  var FRAGMENT = `precision highp float;
      varying vec2 uv;
      uniform vec2 r,m,v;
      uniform float t,seed,hit,speed,intensity,pointer,surface;
      uniform vec3 colorA,colorB,colorC;
      float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}
      float fb(vec2 p){float x=0.,a=.53;mat2 rot=mat2(.80,-.60,.60,.80);for(int i=0;i<5;i++){x+=a*n(p);p=rot*p*2.02+vec2(17.13,9.27);a*=.49;}return x;}
      float blob(vec2 p,vec2 center,float radius,float softness){return 1.-smoothstep(radius-softness,radius+softness,length(p-center));}
      void main(){
        float aspect=r.x/max(1.,r.y);
        vec2 p=(uv-.5)*vec2(aspect,1.),mm=(m-.5)*vec2(aspect,1.),d=p-mm;
        float dist=length(d),mouseField=exp(-dist*dist*7.2)*hit*pointer;
        vec2 normal=d/max(dist,.035),tangent=vec2(-normal.y,normal.x);
        p+=normal*mouseField*.115+tangent*mouseField*(v.x-v.y)*.045;
        // 保留极低速的自主基线：即使用户把速度拉到 0，流体也不会退化成只靠鼠标才变化的静态图。
        float time=t*(max(speed,.08)*1.68+.08);
        vec2 seedVec=vec2(seed*1.713,seed*.937);
        float w1=fb(p*1.22+seedVec+vec2(time*.075,-time*.052));
        float w2=fb(p*1.54-seedVec*.37+vec2(-time*.057,time*.064)+w1*.82);
        vec2 q=p+(vec2(w1,w2)-.5)*(.58*intensity);
        float broad=fb(q*1.12+vec2(time*.041,-time*.033));
        float detail=fb(q*2.18+vec2(-time*.083,time*.057)+broad*.95);
        float ribbon=.5+.5*sin(q.x*3.15+q.y*.76+detail*5.+time*.25+seed);
        vec3 fluid=mix(colorA,colorB,smoothstep(.16,.88,broad*.61+ribbon*.39));
        fluid=mix(fluid,colorC,smoothstep(.43,.84,detail*.69+(.5+.5*sin(q.y*4.2-q.x*.8-time*.17))*.31)*.74);
        float plume1=blob(p,vec2(aspect*.23+.12*sin(time*.08+seed),.16*cos(time*.11+seed)),.52,.38);
        float plume2=blob(p,vec2(aspect*.39+.10*cos(time*.07-seed),-.24+.11*sin(time*.09)),.43,.34);
        float haze=clamp(plume1*.72+plume2*.58,0.,1.);
        float reveal=smoothstep(.055,.735,uv.x+(.5-broad)*.27+.070*sin(uv.y*4.+time*.12));
        reveal=clamp(reveal*mix(.70,1.,haze)*intensity,0.,1.);
        float spec=pow(clamp(1.-abs(detail-.52)*2.,0.,1.),5.)*reveal;
        float caustic=pow(clamp(.52+.48*sin((q.x-q.y)*5.2+detail*7.-time*.18),0.,1.),7.)*reveal;
        vec3 glow=mix(fluid,vec3(.34,1.,.90),spec*.18+caustic*.09);
        glow*=.78+.25*haze;
        glow=mix(glow,glow*.70,surface*.34);
        float filament=smoothstep(.48,.86,detail)*reveal;
        float density=clamp(reveal*(.36+.48*haze)+filament*.22+mouseField*.28,0.,1.);
        float alpha=clamp(.035*haze+density*(.24+.50*intensity)+spec*.08+surface*density*.14,0.,.92);
        alpha*=smoothstep(1.08,.70,length((uv-.5)*vec2(1.,.92)));
        glow=pow(max(glow,0.),vec3(.94));
        gl_FragColor=vec4(glow,alpha);
      }`;

  /* 参考插件的配色预设与四张卡默认参数（FLUID_PRESETS / FLUID_DEFAULTS 原样抄） */
  var PRESETS = {
    cyan: { a: "#00e7d2", b: "#3cc8ff", c: "#075f68" },
    original: { a: "#ff3aa7", b: "#ff8050", c: "#a443ff" },
    klein: { a: "#3158ff", b: "#ff6531", c: "#20252e" },
    chrome: { a: "#eef2f3", b: "#6c7780", c: "#11171d" }
  };
  var CARDS = {
    today: { preset: "chrome", a: PRESETS.chrome.a, b: PRESETS.chrome.b, c: PRESETS.chrome.c, speed: 1.92, intensity: 1.6, pointer: 1.5, surface: .86, seed: 1.7 },
    unread: { preset: "custom", a: "#00e7d2", b: "#3cc8ff", c: "#096907", speed: .84, intensity: 1.08, pointer: .8, surface: .08, seed: 4.9 },
    read: { preset: "custom", a: "#3158ff", b: "#36ff33", c: "#20252e", speed: .76, intensity: .98, pointer: .72, surface: .08, seed: 8.4 },
    backlog: { preset: "original", a: PRESETS.original.a, b: PRESETS.original.b, c: PRESETS.original.c, speed: .75, intensity: 1.05, pointer: .86, surface: .08, seed: 12.1 }
  };
  var QUALITY_DPR = { high: 1.8, balanced: 1.35, eco: 1, fallback: 1 };
  var QUALITY = "high";

  var clamp = function (n, min, max) { return Math.min(max, Math.max(min, n)); };
  var hexRgb = function (hex) { var n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  var live = { fluid: null, orbit: null };

  /* ---------------- 1) 流体统计卡 ---------------- */
  function fluid(root) {
    if (live.fluid) live.fluid();
    live.fluid = null;
    var cards = root.querySelectorAll("[data-fluid-card]");
    if (!cards.length) return;
    var raf = 0, contexts = [], draws = [], observers = [];
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function stop() {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      observers.forEach(function (o) { o.disconnect(); });
      observers = [];
      contexts.forEach(function (gl) { try { gl.getExtension("WEBGL_lose_context").loseContext(); } catch (e) { /* 忽略 */ } });
      contexts = [];
      draws = [];
    }

    function compile(gl, type, source) {
      var s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    }

    var index = 0;
    cards.forEach(function (card) {
      var conf = CARDS[card.dataset.fluidCard] || CARDS.today;
      var canvas = card.querySelector(".kb-fluid-canvas");
      var slot = index++;
      try {
        if (!canvas) throw new Error("no canvas");
        var gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false, powerPreference: "high-performance" });
        if (!gl) throw new Error("WebGL unavailable");
        var program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link");
        gl.useProgram(program);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(program, "p");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        var U = {};
        ["r", "m", "v", "t", "seed", "hit", "speed", "intensity", "pointer", "surface", "colorA", "colorB", "colorC"]
          .forEach(function (k) { U[k] = gl.getUniformLocation(program, k); });

        var dpr = Math.min(window.devicePixelRatio || 1, QUALITY_DPR[QUALITY] || 1.35);
        var resize = function () {
          var box = card.getBoundingClientRect();
          canvas.width = Math.max(2, Math.round(box.width * dpr));
          canvas.height = Math.max(2, Math.round(box.height * dpr));
          gl.viewport(0, 0, canvas.width, canvas.height);
        };
        var ro = new ResizeObserver(resize);
        ro.observe(card);
        observers.push(ro);
        resize();

        /* 材质：卡片底色透明度 / 文字阴影 / 文字颜色 —— 与参考同一套算法 */
        var light = clamp((conf.surface - .25) / .21, 0, 1);
        card.style.setProperty("--surface-opacity", conf.surface);
        card.style.setProperty("--content-shade", (.48 * Math.pow(1 - conf.surface, 1.45)).toFixed(3));
        card.style.setProperty("--stat-text", light > .5 ? "#16201d" : "#f3fffb");
        card.dataset.surfaceTone = light > .5 ? "light" : "dark";

        var mouse = { x: .5, y: .5, tx: .5, ty: .5, vx: 0, vy: 0, hit: 0 };
        card.addEventListener("pointermove", function (e) {
          var box = card.getBoundingClientRect();
          var x = clamp((e.clientX - box.left) / box.width, 0, 1), y = clamp(1 - (e.clientY - box.top) / box.height, 0, 1);
          mouse.vx = clamp(x - mouse.tx, -.12, .12);
          mouse.vy = clamp(y - mouse.ty, -.12, .12);
          mouse.tx = x; mouse.ty = y; mouse.hit = 1;
        });
        card.addEventListener("pointerleave", function () { mouse.hit = 0; });

        var rgb = [hexRgb(conf.a), hexRgb(conf.b), hexRgb(conf.c)];
        contexts.push(gl);
        draws.push(function (now) {
          mouse.x += (mouse.tx - mouse.x) * .105;
          mouse.y += (mouse.ty - mouse.y) * .105;
          mouse.vx *= .90;
          mouse.vy *= .90;
          gl.useProgram(program);
          gl.uniform2f(U.r, canvas.width, canvas.height);
          gl.uniform2f(U.m, mouse.x, mouse.y);
          gl.uniform2f(U.v, mouse.vx, mouse.vy);
          gl.uniform1f(U.t, now * .001 + slot * 3.73);
          gl.uniform1f(U.seed, conf.seed);
          gl.uniform1f(U.hit, mouse.hit);
          gl.uniform1f(U.speed, reduced ? Math.max(.12, conf.speed * .22) : conf.speed);
          gl.uniform1f(U.intensity, conf.intensity);
          gl.uniform1f(U.pointer, conf.pointer);
          gl.uniform1f(U.surface, conf.surface);
          gl.uniform3fv(U.colorA, rgb[0]);
          gl.uniform3fv(U.colorB, rgb[1]);
          gl.uniform3fv(U.colorC, rgb[2]);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        });
        card.classList.remove("is-fallback");
      } catch (err) {
        card.classList.add("is-fallback");            // WebGL 不可用 → CSS 渐变（参考插件同款降级）
      }
    });

    var loop = function (now) {
      if (!root.isConnected) { stop(); return; }
      for (var i = 0; i < draws.length; i++) draws[i](now);
      raf = window.requestAnimationFrame(loop);
    };
    if (draws.length) raf = window.requestAnimationFrame(loop);
    live.fluid = stop;
  }

  /* ---------------- 2) 3D 环绕目录卡 ---------------- */
  function orbit(root, opts) {
    if (live.orbit) live.orbit();
    live.orbit = null;
    opts = opts || {};
    var stage = root.querySelector(".kb-stage"), ring = root.querySelector(".kb-ring"), scene = root.querySelector(".kb-scene");
    if (!stage || !ring || !scene) return;
    var folders = (opts.folders || []).slice(0, 6);
    var o = { r: -24, x: -5, zoom: 1, radius: 240, auto: true, speed: 1, flat: false, dragging: false, vr: 0, vx: 0 };
    var angle = function (v, fb) { var n = Number(v); return isFinite(n) ? ((n + 180) % 360 + 360) % 360 - 180 : fb; };
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var stepAngle = function () { return 360 / Math.max(folders.length, 1); };
    var raf = 0, lx = 0, ly = 0, lastMove = 0, lastFrame = performance.now();

    var syncControls = function () {
      var mode = root.querySelector(".kb-orbit-mode"), auto = root.querySelector(".kb-auto"), speed = root.querySelector(".kb-speed");
      if (mode) { mode.classList.toggle("active", !o.flat); mode.textContent = o.flat ? "▦ 平面目录" : "◉ 3D 环绕"; }
      if (auto) { auto.classList.toggle("active", o.auto); auto.textContent = o.auto ? "↻ 自动巡航" : "Ⅱ 已暂停"; }
      if (speed) speed.textContent = "速度 " + o.speed + "×";
    };
    var transform = function () {
      o.r = angle(o.r, -24);
      scene.style.transform = o.flat
        ? "translate3d(0,0,0) scale(" + o.zoom + ")"
        : "translate3d(0,0,0) rotateX(" + o.x + "deg) rotateY(" + o.r + "deg) scale(" + o.zoom + ")";
    };
    var front = function () {
      var count = Math.max(folders.length, 1), step = stepAngle();
      return Math.round(((-o.r % 360 + 360) % 360) / step) % count;
    };
    var syncFrontCard = function () {
      var frontIndex = front();
      ring.querySelectorAll("button").forEach(function (button, i) {
        var active = i === frontIndex;
        button.classList.toggle("is-front", active);
        button.setAttribute("aria-pressed", String(active));
        var doc = button.querySelector(".kb-doc-card");
        if (doc) doc.classList.toggle("active", active);
      });
    };
    var paint = function () {
      var step = stepAngle(), frontIndex = front(), w = 120, h = 182;
      ring.innerHTML = folders.map(function (c, i) {
        var col = (i % 3) - 1, row = Math.floor(i / 3) - .5;
        var flat = "translate3d(" + (col * (w + 12)) + "px," + (row * (h * .74)) + "px,0) scale(.64)";
        var active = i === frontIndex;
        return '<button type="button" class="kb-orbit-card' + (active ? " is-front" : "") + '" data-index="' + i + '" data-folder="' + esc(c.name) + '"'
          + ' aria-label="聚焦目录 ' + esc(c.name) + '" aria-pressed="' + active + '"'
          + ' style="transform:' + (o.flat ? flat : "rotateY(" + (i * step) + "deg) translateZ(" + o.radius + "px)") + '">'
          + '<span class="kb-card-top"><span>MD · ' + String(i + 1).padStart(2, "0") + '</span><i></i></span>'
          + '<span class="kb-card-lines"></span><span class="kb-card-glyph">⌑</span>'
          + '<b>' + esc(c.name) + '</b><small>' + c.total + ' 篇　未读 ' + c.unread + '</small>'
          + '<span class="kb-card-reflection"></span></button>';
      }).join("");
      transform();
      syncControls();
      ring.querySelectorAll("button").forEach(function (button) {
        button.onclick = function (event) {
          event.preventDefault();
          event.stopPropagation();
          var i = Number(button.dataset.index);
          o.r = angle(-stepAngle() * i, o.r);
          o.vr = 0; o.vx = 0; o.auto = false;
          transform(); syncFrontCard(); syncControls();
          if (opts.onPick) opts.onPick(button.dataset.folder);
        };
      });
    };
    paint();

    var release = function () { o.dragging = false; stage.classList.remove("is-dragging"); };
    stage.onpointerdown = function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest(".kb-progress")) return;          // 完成率卡自己拖
      o.dragging = true; o.vr = 0; o.vx = 0;
      lx = event.clientX; ly = event.clientY; lastMove = performance.now();
      stage.classList.add("is-dragging");
      if (stage.setPointerCapture) stage.setPointerCapture(event.pointerId);
    };
    stage.onpointermove = function (event) {
      if (!o.dragging) return;
      var now = performance.now(), dt = Math.max(8, now - lastMove);
      var dx = event.clientX - lx, dy = event.clientY - ly;
      o.r = angle(o.r + dx * .27, o.r);
      o.x = clamp(o.x - dy * .08, -18, 12);
      o.vr = (dx * .27) / dt * 16;
      o.vx = (-dy * .08) / dt * 16;
      o.auto = false;
      lx = event.clientX; ly = event.clientY; lastMove = now;
      transform(); syncFrontCard(); syncControls();
    };
    stage.onpointerup = release;
    stage.onpointercancel = release;
    stage.onlostpointercapture = release;
    stage.onwheel = function (event) {
      event.preventDefault();
      o.zoom = clamp(o.zoom - event.deltaY * .0007, .72, 1.35);
      o.radius = clamp(o.radius - event.deltaY * .035, 190, 340);
      o.auto = false;
      paint();
    };
    var reset = root.querySelector(".kb-reset");
    if (reset) reset.onclick = function () {
      o.r = -24; o.x = -5; o.zoom = 1; o.radius = 240; o.vr = 0; o.vx = 0; o.auto = true; o.flat = false;
      stage.classList.remove("is-flat");
      paint();
    };
    var autoBtn = root.querySelector(".kb-auto");
    if (autoBtn) autoBtn.onclick = function () { o.auto = !o.auto; o.vr = 0; o.vx = 0; syncControls(); };
    var speedBtn = root.querySelector(".kb-speed");
    if (speedBtn) speedBtn.onclick = function () { o.speed = o.speed === 1 ? 2 : o.speed === 2 ? .5 : 1; syncControls(); };
    var modeBtn = root.querySelector(".kb-orbit-mode");
    if (modeBtn) modeBtn.onclick = function () { o.flat = !o.flat; stage.classList.toggle("is-flat", o.flat); paint(); };
    var filterBtn = root.querySelector(".kb-folder-filter");
    if (filterBtn && opts.onCycle) filterBtn.onclick = opts.onCycle;

    /* 完成率卡：可拖可缩放（参考插件同款） */
    var card = root.querySelector(".kb-progress");
    var p = { x: 6, y: 14, scale: 1 };
    var apply = function () {
      card.style.left = p.x + "%";
      card.style.top = p.y + "%";
      card.style.setProperty("--kb-progress-scale", p.scale);
    };
    var scaleBy = function (amount) { p.scale = clamp(Math.round((p.scale + amount) * 100) / 100, .65, 1.7); apply(); };
    if (card) {
      var dragging = false, px = 0, py = 0;
      card.onpointerdown = function (event) {
        if (event.target.closest("button")) return;
        event.preventDefault(); event.stopPropagation();
        dragging = true; px = event.clientX; py = event.clientY;
        card.classList.add("is-dragging");
        if (card.setPointerCapture) card.setPointerCapture(event.pointerId);
      };
      card.onpointermove = function (event) {
        if (!dragging) return;
        var rect = stage.getBoundingClientRect();
        p.x = clamp(p.x + (event.clientX - px) / Math.max(1, rect.width) * 100, 1, 96);
        p.y = clamp(p.y + (event.clientY - py) / Math.max(1, rect.height) * 100, 2, 92);
        px = event.clientX; py = event.clientY;
        apply();
      };
      card.onpointerup = card.onpointercancel = card.onlostpointercapture = function () { dragging = false; card.classList.remove("is-dragging"); };
      card.onwheel = function (event) { event.preventDefault(); event.stopPropagation(); scaleBy(event.deltaY < 0 ? .1 : -.1); };
      card.querySelectorAll("[data-progress-scale]").forEach(function (button) {
        button.onclick = function (event) { event.preventDefault(); event.stopPropagation(); scaleBy(Number(button.dataset.progressScale)); };
      });
      apply();
    }

    var loop = function (now) {
      if (!root.isConnected) { cancelAnimationFrame(raf); raf = 0; return; }
      var dt = Math.min(50, Math.max(0, now - lastFrame));
      lastFrame = now;
      if (!o.dragging) {
        if (!document.hidden && o.auto) o.r += .0033 * dt * (Number(o.speed) || 1);
        if (!document.hidden && (Math.abs(o.vr) > .002 || Math.abs(o.vx) > .002)) {
          var k = dt / 16.667;
          o.r += o.vr * k;
          o.x = clamp(o.x + o.vx * k, -18, 12);
          o.vr *= Math.pow(.93, k);
          o.vx *= Math.pow(.88, k);
        }
        transform(); syncFrontCard();
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    live.orbit = function () { if (raf) cancelAnimationFrame(raf); raf = 0; };
  }

  /* 自检：环绕卡的“正面”判定与角度归一是纯数学，可在无 WebGL 环境下断言 */
  function selfCheck() {
    var angle = function (v, fb) { var n = Number(v); return isFinite(n) ? ((n + 180) % 360 + 360) % 360 - 180 : fb; };
    var front = function (r, count, step) { return Math.round(((-r % 360 + 360) % 360) / step) % count; };
    var out = [];
    out.push(["angle 归一", angle(370) === 10 && angle(-370) === -10 && angle("x", -24) === -24]);
    out.push(["正面判定", front(-24, 6, 60) === 0 && front(-84, 6, 60) === 1 && front(-324, 6, 60) === 5]);
    out.push(["着色器已内嵌", VERTEX.indexOf("varying vec2 uv") > 0 && FRAGMENT.indexOf("void main") > 0 && FRAGMENT.indexOf("gl_FragColor") > 0]);
    out.push(["四张卡配置齐", !!CARDS.today && !!CARDS.unread && !!CARDS.read && !!CARDS.backlog]);
    return out;
  }

  window.KB3D = { fluid: fluid, orbit: orbit, selfCheck: selfCheck, cards: CARDS, presets: PRESETS };
})();
