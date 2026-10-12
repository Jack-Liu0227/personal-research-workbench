/* ==== 开始卡片（科研工作 1.0） =================================================
   双击桌面快捷方式后先看到这张卡片，点「进入」才进主界面；卡片在的时候主界面
   已经在后面加载 —— 这段时间就是「后台拉起准备」。
   三个组件都由用户给的 React/TSX 源码手工转成原生 JS（本项目没有构建步骤）：
     1) Globe Study              — Originkit ：canvas 2D 点阵地球（陆地用字符铺）
     2) Vector Wordmark          — Originkit ：WebGL 字标（鼠标附近实心→点线描边）
     3) Interactive Hover Button — magicui   ：照抄（圆点 in 胶囊；悬停圆点放大填满 + 文字右移淡出 + 覆盖层带箭头滑入）
   只改内容与大小：标题 = Personal Research Workspace、按钮 = Enter；三个组件本身的视觉一律照原样
   （字标 fade 0.7 / blurK 3.5 / 手柄 size109 spread27 labels 都恢复成原组件默认）。
   卡片尺寸由窗口定（server.py 的 CARD_W/CARD_H = 1180x597），点「进入」→ /api/win/maximize 铺回工作区。
   可调项全在 CFG。
   ============================================================================ */
(function () {
"use strict";

var CFG = {
  title: "Personal Research Workspace",
  go: "Enter",
  globe: {
    color: "#0047F8", density: 110, glyphSize: 102, speed: 100, hover: 100,
    radius: 100, drift: 210, letters: 100, pins: 7, zoom: 100, light: 100,
    phrase: "everypointonthisballisapathbacktoanotherone"   // 陆地字符（原组件的原句，没动）
  },
  word: {
    size: 62, weight: 800, spacing: "-0.02em",
    family: '"Inter","Segoe UI","Microsoft YaHei",system-ui,sans-serif',
    color: "#FFFFFF", shade: "#FFFFFF", accent: "#FFFFFF",
    reach: 290, speed: 50, damping: 60,
    fade: 0.7,     // 原组件默认
    blurK: 3.5,    // 原组件默认
    textY: -0.219, // 字标占满整张卡片后，把字挪到卡片高度 71.9% 处（vUv.y 是自下往上，所以要负号）；只动位置不动效果
    handles: { size: 109, spread: 27, labels: true }    // 原组件默认：三个手柄框 + 坐标标签（三角形互动）
  }
};

var MAX_DPR = 2;

function num(v, fb) { return typeof v === "number" && isFinite(v) ? v : fb; }
function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ---------------- 1) 地球：Globe Study — Originkit（canvas 2D） ---------------- */
var LAND_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPcBAOD/HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACA//+P//f/LwgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4/v/4/////wcAAAAEAPABAAAAfAAAAAAAAAAAAAAAAAAAAADg9w/4/////wEAAP4AAAAAAAAA+AAAAAAAAAAAAAAAAAAAAIAG+Of//////wAAAHwGAAAAAAAAAAMAAAAAAAAAAAAAAACABwAc/4P//////wAAADAAAAAAQAAAAD4AAAAAAAAAAAAAAAAAfMbDcQAA/v///wAAAAAAAADABwAA//8HAMAPAAAAAAAAAABgAAAAAAAA/P///wAAAAAAAABwAADg//8AAAAAAAAAAAAAAADwG457dwcA8P//HwAAAAAAAAAYAAD///9/eAAAAAAAAAAAAAD4/g0H/w8A8P//PwAAAAAAAAAOgOv/////fwD/AAAAAAA/AAAA/B84/v8A8P//LwAAAAD4AAAA4PP//////////wAAAOD///H/+D/3cPgDoP//DwAAAID/BwAAx/v/////////P4AA/P///////////////////////w8AAOcBAAgAAAAAAAAAAAAAgP///////////////////////wcAACYAAAQAAAAAAAAAAAAAgf///////////////////////wMM8AAAAAAAAAAAAAAAAAAAIID/////////e+wPwH8AgA8AAP/5z/////////////////8/ANH///////9/AIALgD8AAAAAwH/+//////////////////9/APj///////8fADwAAD8AAAAA8D/+//////////////////sPAPC/+f////8fAPwAADgAAAAA8D/+////////////////D/wBAMCfAP////8PAPwYAAAAAAAA8H/4//////////////9/DgcAAAAcAOD///8/APw/AAAAAAAQAB7w//////////////8BgAMAAAACAMD/////Afh/AAAAAAA4gBz+/////////////38A4AMAAMAAAMD/////B/z/AAAAAABwwAb+/////////////x8A8AEAAAAAAAD/////P///AwAAAADmgOH//////////////z8A4AAAAAAAAAD+////P/7/BwAAAAD28P////////////////8D4AAAAAAAAAD8////f/7/BwAAAADz+f////////////////8HIAAAAAAAAAD6////////BAAAAABw/v////////////////8EAAAAAAAAAADo//////8jHgAAAACA//////////////////8MAAAAAAAAAADQ//////8OPgAAAADw//////////////////8AAAAAAAAAAADg//////+PIAAAAADA////v////////////38EAAAAAAAAAADg////////AAAAAACA//v/zD/8/////////z8AAAAAAAAAAADg//////8bAAAAAACA//N/gD///////////x8GAAAAAAAAAADw//////8AAAAAAAD+B8c/AD/+/////////wcPAAAAAAAAAADg//////8AAAAAAAD+gx4/DH74/////////wABAAAAAAAAAADg/////x8AAAAAAAD+gbCn///8////////fQABAAAAAAAAAADg/////w8AAAAAAAD/gCDn///4//////9/MgADAAAAAAAAAADA/////w8AAAAAAAD+AADm/3/4//////8/cIABAAAAAAAAAADA/////wcAAAAAAAA44AHC///5////////4+ABAAAAAAAAAACA/////wcAAAAAAACI/wEA4P//////////4OgAAAAAAAAAAAAA/////wMAAAAAAAD4/wAA4P//////////ADYAAAAAAAAAAAAA/P///wEAAAAAAAD+/wEA8P//////////AQcAAAAAAAAAAAAA+P//fwAAAAAAAAD//w8P8P//////////AQEAAAAAAAAAAAAAyP//fwAAAAAAAAD//3//////////////AQAAAAAAAAAAAAAA0P+PYQAAAAAAAAD//////z//////////AwAAAAAAAAAAAAAAoP8HwAAAAAAAAMD/////83/+////////AQAAAAAAAAAAAAAAIP8DwAAAAAAAAOD/////5//I////////AAAAAAAAAAAAAAAAQP4DgAAAAAAAAPD/////z/+A////////AAAAAAAAAAAAAAAAAPwDAAIAAAAAAPD/////z/8ZwP////9/AQAAAAAAAAAAAAAAAPgDQAAAAAAAAPj/////j/9/gP////8fAQAAAAAAAAAAAAAAAPADEAMAAAAAAPz/////v///AP9//P8DAAAAAAAAAAAAAAAAAPADAwwAAAAAAPj/////P/9/APw//B8AAAAAAAAAAAAIAAAAAPCHA8AAAAAAAPj/////P/4/APwP+J8BAAAAAAAAAAAAAAAAAMD/A0YEAAAAAPj/////f/4fAPwH+B8AAwAAAAAAAAAAAAAAAAD/AQAAAAAAAPj/////f/wHAPgD8D8AAwAAAAAAAAAAAAAAAADgHwAAAAAAAPj///////wDAPgAwH8AAQAAAAAAAAAAAAAAAADAHwAAAAAAAPz//////30AAPAAwH8AAAAAAAAAAAAAAAAAAAAAHAAAAAAAAPj//////wsAAPAAgH4AAQAAAAAAAAAAAAAAAAAAGEAAAAAAAPj//////wMBAPAAgHwAAAAAAAAAAAAAAAAAAAAAGPAhAAAAAPD///////cBAOAAgDiABAAAAAAAAAAAAAAAAAAAIPl/AAAAAOD///////8AAGABABBAFAAAAAAAAAAAAAAAAAAAgP7/AQAAAMD///////8AAAABgAAAHAAAAAAAAAAAAAAAAAAAAPz/AQAAAID///////8AAAABAAEgCAAAAAAAAAAAAAAAAAAAAPz/HwAAAAD/8P///38AAAAAAANgAAAAAAAAAAAAAAAAAAAAAPz/fwAAAAAAoP///z8AAAAAYAd4AAAAAAAAAAAAAAAAAAAAAPz/fwAAAAAAAP///x8AAAAAwAY8AAAAAAAAAAAAAAAAAAAAAP7//wAAAAAAAP///w8AAAAAgAc+AAAAAAAAAAAAAAAAAAAAAP///wAAAAAAAP///wcAAAAAgIM/TwAAAAAAAAAAAAAAAAAAAP///wEAAAAAgP///wMAAAAAAIc/QAQAAAAAAAAAAAAAAAAAgP///w8AAAAAgP///wEAAAAAAA6fAUQAAAAAAAAAAAAAAAAAAP////8AAAAAAP///wAAAAAAAB6ewuwDAgAAAAAAAAAAAAAAgP////8DAAAAAP7//wAAAAAAABwAAvAPAgAAAAAAAAAAAAAAgP////8PAAAAAPz/fwAAAAAAABAAAMCfAQAAAAAAAAAAAAAAAP////8PAAAAAPz//wAAAAAAAOADAIA/MAAAAAAAAAAAAAAAAP7///8PAAAAAPz/fwAAAAAAAAAPAMBngAAAAAAAAAAAAAAAAP7///8PAAAAAPz//wAAAAAAAAAACABAAAAAAAAAAAAAAAAAAPz///8HAAAAAPj//wAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAPz///8DAAAAAPj//wAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAPj///8BAAAAAPz//4AAAAAAAAAAAB8GAAAAAAAAAAAAAAAAAPj///8BAAAAAPz//8EAAAAAAAAAIB8OAAAAAAAAAAAAAAAAAPD///8BAAAAAP7//+AAAAAAAAAA+B8OACAAAAAAAAAAAAAAAMD///8BAAAAAP7/f/gAAAAAAAAA/H8eAAAAAAAAAAAAAAAAAID///8AAAAAAP7/H/gAAAAAAAAA/P8fAABAAAAAAAAAAAAAAAD///8AAAAAAPz/D3AAAAAAAAAA/v8/AAAAAAAAAAAAAAAAAAD///8AAAAAAPj/D3gAAAAAAADA//9/AAgAAAAAAAAAAAAAAAD//38AAAAAAPj/DzgAAAAAAADw////AAAAAAAAAAAAAAAAAAD//x8AAAAAAPD/DzgAAAAAAAD4////AQAAAAAAAAAAAAAAAAD//wMAAAAAAPD/DzgAAAAAAAD4////AwAAAAAAAAAAAAAAAID//wEAAAAAAPD/AwAAAAAAAAD4////AwAAAAAAAAAAAAAAAID//wEAAAAAAPD/AwAAAAAAAAD4////BwAAAAAAAAAAAAAAAID//wEAAAAAAOD/AwAAAAAAAAD4////BwAAAAAAAAAAAAAAAID//wAAAAAAAOD/AQAAAAAAAADw////BwAAAAAAAAAAAAAAAID//wAAAAAAAMD/AAAAAAAAAADw////AwAAAAAAAAAAAAAAAID/fwAAAAAAAIB/AAAAAAAAAADgf/z/AwAAAAAAAAAAAAAAAID/PwAAAAAAAIA/AAAAAAAAAADgB/D/AQAAAAAAAAAAAAAAAMD/HQAAAAAAAIABAAAAAAAAAADwAND/AQAAAAAAAAAAAAAAAMD/AwAAAAAAAAAAAAAAAAAAAAAAAID/AAAIAAAAAAAAAAAAAMD/BwAAAAAAAAAAAAAAAAAAAAAAAAD/AAAQAAAAAAAAAAAAAOD/AwAAAAAAAAAAAAAAAAAAAAAAAAA+AABwAAAAAAAAAAAAAOA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAOA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAOAPAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAGAAAAAAAAAAAAAMAPAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAADAAAAAAAAAAAAAPAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMABAAAAAAAAAAAAAPADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOABAAAAAAAAAAAAAPAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPADAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAPABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPCBAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAA+AABAAJ8//j8PAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAPD/fwD///////8/AAAAAAAAAAAAAAAAAIA+AAAAAAAAAAAAPP///8D/////////HwAAAAAAAAAAAAAAAIA9AAAAAAAA8Pz/////P/j//////////wMAAAAAAAAAAMAAAPB9AAAAAID/////////P/7///////////8BAAAAAAAAAOABAwB/AAAAAPD///////////////////////8AAAAAAFACPoD///9/AAAAAPD//////////////////////x8AAAAA+P////////8HAAAAAP///////////////////////wcAAAAA/v///////wMAAAAA/v///////////////////////wcAAAD8/////////w8AAA7w/////////////////////////w8AAMAB/////////wMAgB84/////////////////////////wEAAAAA/P///////3/w4AcA/////////////////////////wAAAADg//////////8/gM///////////////////////////wMAAADg/////////////f///////////////////////////z8A7wMA/v////////////////////////////////////////8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function mkGlobe(canvas) {
  if (!canvas) return null;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;
  var C = CFG.globe;
  var FACE = '"Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  var QA = Math.PI / 36, MW = 288, MH = 144;

  var land = null;
  try {
    var bin = atob(LAND_B64);
    land = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) land[i] = bin.charCodeAt(i);
  } catch (e) { land = null; }
  function isLand(lon, lat) {
    if (!land) return false;
    var gx = Math.floor(((lon + 180) / 360) * MW);
    var gy = Math.floor(((90 - lat) / 180) * MH);
    if (gx < 0 || gx >= MW || gy < 0 || gy >= MH) return false;
    var b = gy * MW + gx;
    return ((land[b >> 3] >> (b & 7)) & 1) === 1;
  }

  var V = {
    base: C.color,
    phrase: String(C.phrase || "").length ? String(C.phrase) : "globe",
    density: clampN(num(C.density, 100), 40, 200) / 100,
    glyphSize: clampN(num(C.glyphSize, 100), 20, 300) / 100,
    speed: clampN(num(C.speed, 50), 0, 100) / 50,
    hover: clampN(num(C.hover, 100), 0, 200) / 100,
    radius: clampN(num(C.radius, 100), 40, 200) / 100,
    drift: clampN(num(C.drift, 100), 0, 400) / 100,
    letters: clampN(num(C.letters, 100), 0, 200) / 100,
    zoom: clampN(num(C.zoom, 100), 0, 300) / 100,
    light: clampN(num(C.light, 100), 0, 300) / 100,
    pins: Math.round(clampN(num(C.pins, 7), 0, 24))
  };
  var PTR = { on: 0, x: -1e9, y: -1e9, dragging: 0, dx: 0, dy: 0, moved: 0, click: 0 };

  var boxW = function () { return canvas.clientWidth || 1200; };
  var boxH = function () { return canvas.clientHeight || 800; };

  var nodes = [], builtKey = "";
  function build(dens, letterK, text) {
    var step = 3.05 / dens;
    nodes = [];
    var k = 0, run = 0, sea3 = 0;
    var every = letterK <= 0 ? 0 : Math.max(1, Math.round(2 / letterK));
    for (var lat = -86; lat <= 86; lat += step) {
      var rl = Math.cos((lat * Math.PI) / 180);
      var n = Math.max(1, Math.round(98 * dens * rl));
      for (var i = 0; i < n; i++) {
        var lon = -180 + (360 * i) / n;
        var l = isLand(lon, lat);
        if (!l && sea3++ % 2) continue;
        var letter = "";
        if (l && every && run++ % every === 0) letter = text.charAt(k++ % text.length);
        nodes.push({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, land: l, c: letter });
      }
    }
    builtKey = dens + "|" + letterK + "|" + text;
  }

  var pins = [];
  var view = { cx: 0, cy: 0, R: 1, cs: 1, sn: 0, ct: 1, st: 0 };
  function unproject(px, py) {
    var x1 = (px - view.cx) / view.R;
    var y2 = (view.cy - py) / view.R;
    var q = 1 - x1 * x1 - y2 * y2;
    if (q <= 0.002) return null;
    var z2 = Math.sqrt(q);
    var y0 = y2 * view.ct + z2 * view.st;
    var z1 = -y2 * view.st + z2 * view.ct;
    var x0 = x1 * view.cs + z1 * view.sn;
    var z0 = -x1 * view.sn + z1 * view.cs;
    return { lat: Math.asin(clampN(y0, -1, 1)), lon: Math.atan2(z0, x0) };
  }

  function parseRGB(input, fb) {
    if (!input) return fb;
    var str = String(input).trim();
    if (str.charAt(0) === "#") {
      var hex = str.slice(1);
      if (hex.length === 3 || hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length >= 6) {
        var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
      }
      return fb;
    }
    var m = str.match(/[\d.]+/g);
    if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
    return fb;
  }

  var raf = 0, last = performance.now(), clock = 0, spin = 2.1, vel = 0.16, tilt = -0.36, vtilt = 0;
  var zoom = 1, zoomT = 1, seenClick = 0;
  var sea = [], soil = [], land8 = [];

  function render(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    var sp = V.speed;
    clock += dt * sp;

    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    var cw = boxW(), ch = boxH();
    var bw = Math.max(1, Math.round(cw * dpr)), bh = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var key = V.density + "|" + V.letters + "|" + V.phrase;
    if (key !== builtKey) build(V.density, V.letters, V.phrase);

    var u = Math.min(cw, ch);
    var hv = V.hover * (PTR.on ? 1 : 0);

    zoom += (zoomT - zoom) * Math.min(1, dt / 0.18);

    var cx = cw / 2, cy = ch / 2 + u * 0.035;
    var R = u * 0.318 * zoom * V.radius;
    var fs = u * 0.0275 * Math.pow(zoom, 0.72) * V.glyphSize;

    if (PTR.dragging) {
      var dspin = (PTR.dx * u) / R, dtilt = (-PTR.dy * u) / R;
      PTR.dx = 0; PTR.dy = 0;
      spin += dspin;
      tilt = clampN(tilt + dtilt, -1.15, 1.15);
      var k = Math.min(1, dt / 0.07), inv = 1 / Math.max(dt, 1 / 240);
      vel += (clampN(dspin * inv, -9, 9) - vel) * k;
      vtilt += (clampN(dtilt * inv, -9, 9) - vtilt) * k;
    } else {
      var idle = 0.16 * V.drift * (hv > 0 ? 0.28 : 1);
      vel += (idle - vel) * Math.min(1, (dt * sp) / 0.9);
      vtilt *= Math.exp(-dt * sp * 6.6);
      tilt = clampN(tilt + vtilt * dt * sp, -1.15, 1.15);
      tilt += (-0.36 - tilt) * Math.min(1, (dt * sp) / 4);
      spin += vel * dt * sp;
    }

    if (PTR.click !== seenClick) {
      seenClick = PTR.click;
      var g = unproject(PTR.x, PTR.y);
      if (g && V.pins > 0) {
        pins.push({ lat: g.lat, lon: g.lon, t: clock });
        while (pins.length > V.pins) pins.shift();
      }
    }

    var cs = Math.cos(spin), sn = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt);
    view.cx = cx; view.cy = cy; view.R = R; view.cs = cs; view.sn = sn; view.ct = ct; view.st = st;

    var lightK = V.light * hv;
    var lx = lightK > 0 && !PTR.dragging ? PTR.x : -1e9;
    var ly = lightK > 0 && !PTR.dragging ? PTR.y : -1e9;
    var lr = u * 0.2, lr2 = lr * lr;

    var ink = parseRGB(V.base, [226, 228, 233]);
    var rgb = ink[0] + "," + ink[1] + "," + ink[2];
    var tone = function (a) { return "rgba(" + rgb + "," + clampN(a, 0, 1).toFixed(3) + ")"; };

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    sea.length = 0; soil.length = 0;
    for (var bi = 0; bi < 8; bi++) if (land8[bi]) land8[bi].length = 0;

    for (var ni = 0; ni < nodes.length; ni++) {
      var nd = nodes[ni];
      var cl = Math.cos(nd.lat);
      var x0 = cl * Math.cos(nd.lon), y0 = Math.sin(nd.lat), z0 = cl * Math.sin(nd.lon);
      var x1 = x0 * cs - z0 * sn, z1 = x0 * sn + z0 * cs;
      var y2 = y0 * ct - z1 * st, z2 = y0 * st + z1 * ct;
      if (z2 <= 0.02) continue;
      var px = cx + x1 * R, py = cy - y2 * R;
      var ddx = px - lx, ddy = py - ly;
      var glow = ddx * ddx + ddy * ddy < lr2 ? (1 - Math.sqrt(ddx * ddx + ddy * ddy) / lr) * lightK : 0;
      if (!nd.land) { sea.push(px, py, Math.min(0.999, z2 + glow * 0.55)); continue; }
      if (!nd.c) { soil.push(px, py, Math.min(0.999, z2 + glow * 0.55)); continue; }
      var tx0 = -Math.sin(nd.lon), tz0 = Math.cos(nd.lon);
      var tx1 = tx0 * cs - tz0 * sn, tz1 = tx0 * sn + tz0 * cs;
      var ang = Math.round(Math.atan2(tz1 * st, tx1) / QA) * QA;
      var bb = Math.min(7, Math.max(0, (Math.min(0.999, z2 + glow * 0.6) * 7.99) | 0));
      (land8[bb] || (land8[bb] = [])).push(px, py, ang, ni);
    }

    var dmin = Math.max(0.7, u * 0.0029);
    function dots(list, baseA, gain, grow) {
      for (var lvl = 0; lvl < 6; lvl++) {
        var z = (lvl + 0.5) / 6;
        var dsz = dmin * grow * (0.55 + 0.75 * z);
        ctx.fillStyle = tone(baseA + gain * z);
        ctx.beginPath();
        for (var q = 0; q < list.length; q += 3) {
          var lv = list[q + 2] >= 1 ? 5 : (list[q + 2] * 6) | 0;
          if (lv !== lvl) continue;
          ctx.rect(list[q] - dsz / 2, list[q + 1] - dsz / 2, dsz, dsz);
        }
        ctx.fill();
      }
    }
    dots(sea, 0.1, 0.22, 1.0);
    dots(soil, 0.34, 0.46, 1.7);

    for (var b2 = 0; b2 < 8; b2++) {
      var arr = land8[b2];
      if (!arr || !arr.length) continue;
      var zb = (b2 + 0.5) / 8;
      ctx.font = "bold " + (fs * (0.42 + 0.58 * zb)).toFixed(2) + "px " + FACE;
      ctx.fillStyle = tone(0.28 + 0.72 * Math.pow(zb, 0.6));
      for (var t = 0; t < arr.length; t += 4) {
        ctx.save();
        ctx.translate(arr[t], arr[t + 1]);
        ctx.rotate(arr[t + 2]);
        ctx.fillText(nodes[arr[t + 3]].c, 0, 0);
        ctx.restore();
      }
    }

    for (var pi = 0; pi < pins.length; pi++) {
      var pn = pins[pi];
      var pcl = Math.cos(pn.lat);
      var ax = pcl * Math.cos(pn.lon), ay = Math.sin(pn.lat), az = pcl * Math.sin(pn.lon);
      var bx1 = ax * cs - az * sn, bz1 = ax * sn + az * cs;
      var by2 = ay * ct - bz1 * st, bz2 = ay * st + bz1 * ct;
      if (bz2 <= 0.02) continue;
      var ppx = cx + bx1 * R, ppy = cy - by2 * R;
      var age = clock - pn.t;
      var pop = Math.min(1, age / 0.22);
      var rr2 = u * 0.016 * (0.4 + 0.6 * pop) * (0.55 + 0.45 * bz2);
      ctx.beginPath(); ctx.arc(ppx, ppy, rr2, 0, Math.PI * 2);
      ctx.strokeStyle = tone(0.3 + 0.55 * bz2);
      ctx.lineWidth = Math.max(0.7, u * 0.0022); ctx.stroke();
      ctx.beginPath(); ctx.arc(ppx, ppy, Math.max(0.7, rr2 * 0.22), 0, Math.PI * 2);
      ctx.fillStyle = tone(0.45 + 0.55 * bz2); ctx.fill();
      if (age < 0.9) {
        var w2 = 1 - age / 0.9;
        ctx.beginPath(); ctx.arc(ppx, ppy, rr2 + (1 - w2) * u * 0.05, 0, Math.PI * 2);
        ctx.strokeStyle = tone(0.55 * w2 * w2);
        ctx.lineWidth = Math.max(0.6, u * 0.0016); ctx.stroke();
      }
    }

    raf = requestAnimationFrame(render);
  }

  var lastX = 0, lastY = 0;
  function localPoint(e) {
    var r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: ((e.clientX - r.left) / r.width) * boxW(), y: ((e.clientY - r.top) / r.height) * boxH() };
  }
  function track(e) {
    var p = localPoint(e);
    if (!p) return;
    PTR.on = 1;
    if (PTR.dragging) {
      var u = Math.min(boxW(), boxH());
      PTR.dx += (p.x - lastX) / u;
      PTR.dy += (p.y - lastY) / u;
      PTR.moved = 1;
    }
    PTR.x = p.x; PTR.y = p.y; lastX = p.x; lastY = p.y;
  }
  function onDown(e) {
    var p = localPoint(e);
    if (!p) return;
    PTR.dragging = 1; PTR.moved = 0; PTR.x = p.x; PTR.y = p.y;
    lastX = p.x; lastY = p.y;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function onUp() {
    if (PTR.dragging && !PTR.moved) PTR.click++;
    PTR.dragging = 0;
  }
  function onLeave() { if (!PTR.dragging) PTR.on = 0; }
  function onWheel(e) {
    if (V.zoom <= 0) return;
    e.preventDefault();
    zoomT = clampN(zoomT * Math.exp(-e.deltaY * 0.0016 * V.zoom), 0.85, 2.6);
  }

  canvas.addEventListener("pointermove", track);
  canvas.addEventListener("pointerenter", track);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  raf = requestAnimationFrame(render);

  return {
    dispose: function () {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", track);
      canvas.removeEventListener("pointerenter", track);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    }
  };
}

/* ---------------- 2) 字标：Vector Wordmark — Originkit（WebGL） ---------------- */
var REF_WIDTH = 1200, MAX_TEX = 4096, HANDLES = 3, CELL_ASPECT = 0.6;
var DRIFT_X = 0.08, DRIFT_Y = 0.04, DRIFT_RATE = 1.3, DRIFT_RATE_Y = 1.3 * 1.3;
var SWEEP_RATE = 0.5, SWEEP_BAND = 0.28, RESNAP = 0.2, DAMP_REF = 20, SPEED_REF = 50, LABEL_MAX = 0.6;
var DOT_DIAMETER = 4 / 440, DOT_PITCH = 12 / 440;

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function fract(x) { return x - Math.floor(x); }

function parseColor(input, fallback) {
  if (!input) return fallback;
  var s = String(input).trim();
  if (s.slice(0, 4).toLowerCase() === "var(") {
    var comma = s.indexOf(","), close = s.lastIndexOf(")");
    if (comma < 0 || close < comma) return fallback;
    s = s.slice(comma + 1, close).trim();
  }
  if (s[0] === "#") {
    var h = s.slice(1), x = "";
    if (h.length === 3 || h.length === 4) { for (var i = 0; i < h.length; i++) x += h[i] + h[i]; h = x; }
    if (h.length === 6) h += "ff";
    if (h.length !== 8 || /[^0-9a-f]/i.test(h)) return fallback;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255,
            parseInt(h.slice(4, 6), 16) / 255, parseInt(h.slice(6, 8), 16) / 255];
  }
  var m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/i);
  if (!m) return fallback;
  var parts = m[2].split(/[\s,/]+/).filter(function (p) { return p.length > 0; });
  if (parts.length < 3) return fallback;
  function nm(t, scale) {
    var v = parseFloat(t);
    if (!Number.isFinite(v)) return 0;
    return t.indexOf("%") >= 0 ? (v / 100) * scale : v;
  }
  var alpha = parts.length > 3 ? clamp(nm(parts[3], 1), 0, 1) : 1;
  if (m[1].toLowerCase().slice(0, 3) === "rgb") {
    return [clamp(nm(parts[0], 255) / 255, 0, 1), clamp(nm(parts[1], 255) / 255, 0, 1),
            clamp(nm(parts[2], 255) / 255, 0, 1), alpha];
  }
  var hh = fract(parseFloat(parts[0]) / 360), sat = clamp(nm(parts[1], 1), 0, 1), li = clamp(nm(parts[2], 1), 0, 1);
  var q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat, p = 2 * li - q;
  function chan(t) {
    var uu = fract(t);
    if (uu < 1 / 6) return p + (q - p) * 6 * uu;
    if (uu < 1 / 2) return q;
    if (uu < 2 / 3) return p + (q - p) * (2 / 3 - uu) * 6;
    return p;
  }
  return [chan(hh + 1 / 3), chan(hh), chan(hh - 1 / 3), alpha];
}

var VERT = "\nattribute vec2 aPos;\nvarying vec2 vUv;\nvoid main() {\n    vUv = aPos * 0.5 + 0.5;\n    gl_Position = vec4(aPos, 0.0, 1.0);\n}";

/* 与原组件同一份片元着色器，只多两个旋钮：uFade（原 0.7 的渐隐指数）、uBlurK（原 3.5 的柔焦范围） */
var FRAG = "\nprecision highp float;\n\nuniform sampler2D uMap;\nuniform vec2 uRes;\nuniform vec2 uAtlas;\nuniform vec2 uPtr;\nuniform float uReach;\nuniform vec3 uText;\nuniform vec3 uShade;\nuniform vec4 uAccent;\nuniform vec2 uV0;\nuniform vec2 uV1;\nuniform vec2 uV2;\nuniform float uHalf;\nuniform float uFade;\nuniform float uBlurK;\nuniform float uTextOff;\n\nvarying vec2 vUv;\n\nfloat hash(vec2 p) {\n    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);\n}\n\nvec2 blurRG(vec2 uv, float e) {\n    vec4 sum = vec4(0.0);\n    for (int i = 0; i < 6; i++) {\n        float fi = float(i);\n        float th = radians(fi / 6.0 * 360.0);\n        vec2 dir = vec2(cos(th), sin(th));\n        vec2 off = dir * (hash(vec2(fi, uv.x + uv.y)) + e);\n        sum += texture2D(uMap, uv + off * e);\n    }\n    return (sum / 6.0).rg;\n}\n\nvec2 segment(vec2 p, vec2 a, vec2 b) {\n    vec2 ab = b - a;\n    vec2 ap = p - a;\n    float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);\n    return vec2(length(ap - ab * t), t);\n}\n\nfloat stroke(float d, float lw, float px) {\n    return 1.0 - smoothstep(lw, lw + px, d);\n}\n\nfloat dashedLine(vec2 p, vec2 a, vec2 b, float lw, float px) {\n    vec2 s = segment(p, a, b);\n    float dash = step(0.5, fract(s.y * length(b - a) * 100.0));\n    return stroke(s.x, lw, px) * dash;\n}\n\nfloat boxEdge(vec2 p, vec2 c, float h, float lw, float px) {\n    vec2 q = abs(p - c) - vec2(h);\n    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);\n    return stroke(abs(d), lw, px);\n}\n\nvoid main() {\n    float aspect = uRes.x / uRes.y;\n\n    vec2 E = (vUv * uRes - (uRes - uAtlas) * 0.5 - vec2(0.0, uTextOff * uRes.y)) / uAtlas;\n    float inside = step(0.0, E.x) * step(E.x, 1.0) * step(0.0, E.y) * step(E.y, 1.0);\n    vec2 safeUv = clamp(E, 0.0, 1.0);\n\n    float b = clamp(1.0 - E.y * uBlurK, 0.0, 1.0) * 0.008;\n    vec2 soft = blurRG(safeUv, b);\n    vec2 sharp = blurRG(safeUv, b * 0.1);\n\n    float d = length((vUv - uPtr) / vec2(1.0, aspect));\n    float k = 1.0 - pow(smoothstep(0.0, max(uReach, 1e-4), d), 3.0);\n\n    float mask = mix(soft.r, sharp.g, k) * inside;\n    vec3 fill = mix(uShade, uText, smoothstep(0.0, 1.0, E.y));\n\n    vec2 P = vec2(vUv.x * aspect, vUv.y);\n    float px = 1.0 / uRes.y;\n    float lw = px * 0.2;\n    float lines = max(\n        max(dashedLine(P, uV0, uV1, lw, px), dashedLine(P, uV1, uV2, lw, px)),\n        dashedLine(P, uV2, uV0, lw, px)\n    );\n    float boxes = max(\n        max(boxEdge(P, uV0, uHalf, lw, px), boxEdge(P, uV1, uHalf, lw, px)),\n        boxEdge(P, uV2, uHalf, lw, px)\n    );\n    float A = max(lines, boxes) * uAccent.a * (1.0 - vUv.y);\n\n    vec4 card = vec4(fill * mask, mask);\n    vec4 comp = vec4(uAccent.rgb * A, A) + card * (1.0 - A);\n\n    gl_FragColor = comp * pow(clamp(E.y, 0.0, 1.0), uFade);\n}";

function compile(gl, vs, fs) {
  function make(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }
  var p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  return p;
}

function fontString(f, px) { return f.style + " " + f.weight + " " + px + "px " + f.family; }

function buildAtlas(text, f, drawFontPx, dpr) {
  var probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  function setFont(ctx, px) {
    ctx.font = fontString(f, px);
    try { if ("letterSpacing" in ctx) ctx.letterSpacing = f.letterSpacing; } catch (e) {}
  }
  function measure(px) {
    setFont(probe, px);
    var m = probe.measureText(text);
    var asc = m.actualBoundingBoxAscent || px * 0.8;
    var desc = m.actualBoundingBoxDescent || px * 0.22;
    return { w: Math.max(1, m.width), asc: asc, desc: desc };
  }
  var fpx = Math.max(8, drawFontPx * dpr);
  var m = measure(fpx);
  var pad = fpx * 0.12;
  var over = Math.max((m.w + pad * 2) / MAX_TEX, (m.asc + m.desc + pad * 2) / MAX_TEX);
  if (over > 1) { fpx = Math.max(8, fpx / over); m = measure(fpx); pad = fpx * 0.12; }

  var w = Math.max(1, Math.ceil(m.w + pad * 2)), h = Math.max(1, Math.ceil(m.asc + m.desc + pad * 2));
  var canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  setFont(ctx, fpx);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = "#ff0000";
  ctx.fillText(text, pad, pad + m.asc);

  var block = m.asc + m.desc;
  ctx.strokeStyle = "#00ff00";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, block * DOT_DIAMETER);
  ctx.setLineDash([0, Math.max(2, block * DOT_PITCH)]);
  ctx.strokeText(text, pad, pad + m.asc);

  var cssPerPx = drawFontPx / fpx;
  return { canvas: canvas, cssW: w * cssPerPx, cssH: h * cssPerPx };
}

function mkWord(canvas, host) {
  if (!canvas) return null;
  host = host || canvas.parentElement || canvas;   // 原组件的事件/标签都挂宿主容器；canvas 自己 pointer-events:none
  var C = CFG.word;
  var hg = { size: 109, spread: 27, labels: true };
  if (C.handles) {
    if (typeof C.handles.size === "number") hg.size = C.handles.size;
    if (typeof C.handles.spread === "number") hg.spread = C.handles.spread;
    if (typeof C.handles.labels === "boolean") hg.labels = C.handles.labels;
  }
  var fontSpec = {
    family: C.family || "Inter, system-ui, sans-serif",
    weight: String(C.weight == null ? 500 : C.weight),
    style: "normal",
    size: Math.max(8, num(parseFloat(String(C.size)), 240) || 240),
    letterSpacing: String(C.spacing || "0px")
  };
  var accentRGBA = parseColor(C.accent, [1, 1, 1, 0.4]);
  var labelColor = "rgb(" + Math.round(accentRGBA[0] * 255) + ", " + Math.round(accentRGBA[1] * 255) + ", " + Math.round(accentRGBA[2] * 255) + ")";

  var attrs = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "high-performance" };
  var gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs);
  if (!gl) return null;
  var isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

  var prog = compile(gl, VERT, FRAG);
  var U = {
    map: gl.getUniformLocation(prog, "uMap"), res: gl.getUniformLocation(prog, "uRes"),
    atlas: gl.getUniformLocation(prog, "uAtlas"), ptr: gl.getUniformLocation(prog, "uPtr"),
    reach: gl.getUniformLocation(prog, "uReach"), text: gl.getUniformLocation(prog, "uText"),
    shade: gl.getUniformLocation(prog, "uShade"), accent: gl.getUniformLocation(prog, "uAccent"),
    v0: gl.getUniformLocation(prog, "uV0"), v1: gl.getUniformLocation(prog, "uV1"),
    v2: gl.getUniformLocation(prog, "uV2"), half: gl.getUniformLocation(prog, "uHalf"),
    fade: gl.getUniformLocation(prog, "uFade"), blurK: gl.getUniformLocation(prog, "uBlurK"),
    off: gl.getUniformLocation(prog, "uTextOff")
  };

  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);

  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  var alive = true;
  var boxW = Math.max(1, canvas.offsetWidth), boxH = Math.max(1, canvas.offsetHeight);
  var boxDirty = true, dpr = 1, bufW = 0, bufH = 0;
  var atlasRatioW = 1, atlasRatioH = 1, atlasKey = "";

  function drawFontPx() { return fontSpec.size * (boxW / REF_WIDTH); }

  function resize() {
    boxW = Math.max(1, canvas.offsetWidth ? canvas.offsetWidth : canvas.clientWidth);
    boxH = Math.max(1, canvas.offsetHeight ? canvas.offsetHeight : canvas.clientHeight);
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(boxW * dpr)), h = Math.max(1, Math.round(boxH * dpr));
    if (w === bufW && h === bufH) return;
    bufW = w; bufH = h; canvas.width = w; canvas.height = h;
  }

  function rebuildAtlas() {
    var px = Math.max(8, drawFontPx());
    var atlas = buildAtlas(CFG.title || " ", fontSpec, px, dpr);
    if (!atlas) return;
    atlasRatioW = Math.max(1e-4, atlas.cssW / px);
    atlasRatioH = Math.max(1e-4, atlas.cssH / px);
    if (document.fonts) {
      try {
        var probe = fontString(fontSpec, 64);
        if (!document.fonts.check(probe)) {
          var again = function () { if (alive) atlasKey = ""; };
          document.fonts.load(probe, CFG.title).then(again, again);
        }
      } catch (e) {}
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    var cw = atlas.canvas.width, ch = atlas.canvas.height;
    var pot = (cw & (cw - 1)) === 0 && (ch & (ch - 1)) === 0;
    if (isGL2 || pot) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  var target = { x: -0.5, y: 0.5 }, eased = { x: -0.5, y: 0.5 };
  var cells = [], verts = [], labels = [];
  for (var i = 0; i < HANDLES; i++) { cells.push({ x: -0.5, y: 0.5 }); verts.push({ x: -0.5, y: 0.5 }); }
  if (hg.labels) {
    for (var li = 0; li < HANDLES; li++) {
      var el = document.createElement("div");
      el.style.cssText = "position:absolute;left:0;top:0;opacity:" + LABEL_MAX + ";pointer-events:none;white-space:nowrap;" +
        "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.08em;color:" + labelColor;
      host.appendChild(el);
      labels.push(el);
    }
  }
  var hasPointer = false, sweepClock = 0, driftT = 0;
  var lastBranch = "";
  window.__rwWordState = function () { return { hp: hasPointer, tx: target.x, ty: target.y, bw: boxW, bh: boxH,
    box: textBox(boxW / boxH, hg.spread / 100, (hg.spread / 100) * CELL_ASPECT), branch: lastBranch,
    cells: cells.map(function (c) { return [Math.round(c.x * 1000) / 1000, Math.round(c.y * 1000) / 1000]; }) }; };

  function snap(x, y, cw, ch) {
    var cx = Math.floor(x / cw), cy = Math.floor(y / ch), found = [];
    for (var i2 = -1; i2 <= 1; i2++) for (var j = -1; j <= 1; j++) {
      var px = (cx + i2 + 0.5) * cw, py = (cy + j + 0.5) * ch;
      found.push({ x: px, y: py, d: Math.hypot(px - x, py - y) });
    }
    found.sort(function (a, b) { return a.d - b.d; });
    for (var k = 0; k < HANDLES; k++) { cells[k].x = found[k + 1].x; cells[k].y = found[k + 1].y; }
  }

  function onMove(e) {
    hasPointer = true;
    var r = host.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    target.x = (e.clientX - r.left) / r.width;
    target.y = 1 - (e.clientY - r.top) / r.height;
  }
  function onLeaveHost() { hasPointer = false; }
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeaveHost);

  var raf = 0, last = 0, running = true;

  function sync() {
    if (boxDirty) { boxDirty = false; resize(); }
    var f = fontSpec;
    var key = [CFG.title, f.family, f.weight, f.style, f.letterSpacing, dpr, Math.ceil(Math.max(8, drawFontPx()) / 64)].join("|");
    if (key !== atlasKey) { atlasKey = key; rebuildAtlas(); }
  }

  /* 手柄（三角）只准围着文字转：范围 = 字块矩形 + 一点点外延（原来跟着指针满画布跑，太散） */
  function textBox(aspect, cw, ch) {
    var px = Math.max(8, drawFontPx());
    var hx = (atlasRatioW * px) / (2 * boxW) + 0.15 * cw / aspect;
    var hy = (atlasRatioH * px) / (2 * boxH) + 0.2 * ch;
    var cy = 0.5 + num(C.textY, 0);
    return { x0: (0.5 - hx) * aspect, x1: (0.5 + hx) * aspect, y0: cy - hy, y1: cy + hy };
  }

  function step(dt) {
    var rate = Math.max(0, C.speed) / SPEED_REF;
    var cw = Math.max(0.01, hg.spread / 100), ch = cw * CELL_ASPECT, aspect = boxW / boxH;
    var box = textBox(aspect, cw, ch);
    if (!hasPointer) {
      lastBranch = "sweep";
      var band = (atlasRatioH * Math.max(8, drawFontPx())) / boxH;
      target.x += dt * SWEEP_RATE * rate;
      target.y = (1 - band) / 2 + SWEEP_BAND * band;
      if (target.x > 1.5) { target.x = -0.5; eased.x = -0.5; }
      sweepClock += dt;
      if (sweepClock >= RESNAP) {
        sweepClock = 0;
        snap(clamp(target.x * aspect, box.x0, box.x1), clamp(target.y, box.y0, box.y1), cw, ch);
      }
    } else if (target.x * aspect >= box.x0 && target.x * aspect <= box.x1
               && target.y >= box.y0 && target.y <= box.y1) {
      lastBranch = "near";
      snap(clamp(target.x * aspect, box.x0, box.x1), clamp(target.y, box.y0, box.y1), cw, ch);
    } else {
      lastBranch = "frozen";
      target.x = -1;        // 指针在卡片别处（拖地球/滚轮缩放）→ 手柄原地不动，镜头收回、标题恢复全实心
    }
    var damp = clamp((C.damping / 100) * DAMP_REF * dt, 0, 1);
    eased.x += (target.x - eased.x) * damp;
    eased.y += (target.y - eased.y) * damp;
    driftT += dt * rate;
    for (var i2 = 0; i2 < HANDLES; i2++) {
      var c = cells[i2];
      var sx = Math.round(c.x / cw - 0.5), sy = Math.round(c.y / ch - 0.5);
      var h1 = fract(Math.sin(sx * 127.1 + sy * 311.7) * 43758.5453);
      var h2 = fract(Math.sin(sx * 269.5 + sy * 183.3) * 43758.5453);
      verts[i2].x = clamp(c.x + DRIFT_X * cw * Math.sin(driftT * DRIFT_RATE + h1 * Math.PI * 2), box.x0, box.x1);
      verts[i2].y = clamp(c.y + DRIFT_Y * ch * Math.sin(driftT * DRIFT_RATE_Y + h2 * Math.PI * 2), box.y0, box.y1);
    }
  }

  function writeLabels() {
    var aspect = boxW / boxH, half = hg.size / 2;
    for (var i2 = 0; i2 < labels.length; i2++) {
      var el = labels[i2];
      var bx = verts[i2].x / aspect, by = verts[i2].y;
      el.style.transform = "translate(" + (bx * boxW - half) + "px," + ((1 - by) * boxH - half) + "px)";
      el.textContent = Math.round(clamp(bx * 100, 0, 100)) + ", " + Math.round(clamp(by * 100, 0, 100));
    }
  }

  function draw() {
    var tc = parseColor(C.color, [0.859, 0.918, 0.992, 1]);
    var sc = parseColor(C.shade, [0.035, 0.063, 0.102, 1]);
    var ac = accentRGBA;
    gl.viewport(0, 0, bufW, bufH);
    gl.useProgram(prog);
    gl.uniform1i(U.map, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform2f(U.res, boxW, boxH);
    var px = Math.max(8, drawFontPx());
    gl.uniform2f(U.atlas, atlasRatioW * px, atlasRatioH * px);
    gl.uniform2f(U.ptr, eased.x, eased.y);
    gl.uniform1f(U.reach, Math.max(1, C.reach) / boxW);
    gl.uniform3f(U.text, tc[0], tc[1], tc[2]);
    gl.uniform3f(U.shade, sc[0], sc[1], sc[2]);
    gl.uniform4f(U.accent, ac[0], ac[1], ac[2], ac[3]);
    gl.uniform2f(U.v0, verts[0].x, verts[0].y);
    gl.uniform2f(U.v1, verts[1].x, verts[1].y);
    gl.uniform2f(U.v2, verts[2].x, verts[2].y);
    gl.uniform1f(U.half, hg.size / 2 / boxH);
    gl.uniform1f(U.fade, num(C.fade, 0.7));
    gl.uniform1f(U.blurK, num(C.blurK, 3.5));
    gl.uniform1f(U.off, num(C.textY, 0));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function frame(now) {
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    sync(); step(dt); if (labels.length) writeLabels(); draw();
    raf = requestAnimationFrame(frame);
  }

  function gate() {
    if (running && !document.hidden) {
      if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  var ro = new ResizeObserver(function () { boxDirty = true; });
  ro.observe(canvas);
  document.addEventListener("visibilitychange", gate);
  if (document.fonts) document.fonts.ready.then(function () { if (alive) atlasKey = ""; }, function () {});
  gate();

  return {
    gl: gl,
    dispose: function () {
      alive = false; running = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeaveHost);
      document.removeEventListener("visibilitychange", gate);
      for (var i2 = 0; i2 < labels.length; i2++) if (labels[i2].parentElement) labels[i2].parentElement.removeChild(labels[i2]);
      var lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
  };
}

/* ---------------- 3) 卡片装配 + 「进入」 ---------------- */
function boot() {
  var sp = document.getElementById("splash");
  if (!sp || window.__rwSplashDone) return;
  window.__rwSplashDone = true;
  var g = mkGlobe(document.getElementById("spGlobe"));
  var w = mkWord(document.getElementById("spWord"), sp);

  function leave() {
    if (sp.classList.contains("out")) return;
    sp.classList.add("out");
    try { fetch("/api/win/maximize", { method: "POST" }); } catch (e) {}   // 卡片 → 铺回工作区
    setTimeout(function () {
      if (g) g.dispose();
      if (w) w.dispose();
      sp.style.display = "none";
      window.__rwSplashGone = true;
    }, 460);
  }
  var go = document.getElementById("spGo");
  if (go) {
    var glab = go.querySelectorAll(".sp-lb, .sp-hv > span");   // 文字只留 CFG 一处
    for (var gi = 0; gi < glab.length; gi++) glab[gi].textContent = CFG.go;
    go.addEventListener("click", leave);
  }
  var x = document.getElementById("spClose");
  if (x) x.addEventListener("click", function () {
    fetch("/api/win/close", { method: "POST" }).catch(function () { window.close(); });
  });
  ["spGo", "spClose"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
  });
  sp.classList.add("ready");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
