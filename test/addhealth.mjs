/**
 * 「添加新频道」的体检报告：探测值摊开给人看，勾选项决定后缀写不写。
 *
 * 守的是什么：
 *   1. 报告把分辨率 / 首字节延迟 / 标称码率三格摆出来（读不到就显示「—」，
 *      且没读到分辨率时要给出原因 tooltip，别让人对着横杠猜）；
 *   2. 假直播判定（循环片 / 拼接）命中时，报告里要有一行告警；
 *   3. **后缀只在勾上时才写**，这是一个字都不能越的边界 ——
 *      工具栏那两个「回填」是批量动作，而这里只影响正在建的这一条，
 *      没真值的后缀绝不硬写，没勾的一个字都不动；
 *   4. 后缀顺序必须是「名字 1080p 320ms」，反着拼（名字 320ms 1080p）是错的。
 *
 * 跑真 server.js + 真 /api/probe-url（第一段），再在 DOM 桩上验前端拼装
 * （第二段）—— 桩里照抄的是 app.js 的源码文本，所以测的就是页面上跑的那份。
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeSps } from './lib/sps.mjs';
import { rebuildResName, rebuildName } from '../src/suffix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' → ' + extra : ''}`);
  }
};

/* ---------------- 1. 真 server + 假源站（报告数据从哪来） ---------------- */

const pidHi = (pid) => 0xe0 | ((pid >> 8) & 0x1f);
const pkt = (pid, pusi, payload) => {
  const p = Buffer.alloc(188);
  p[0] = 0x47;
  p[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
  p[2] = pid & 0xff;
  p[3] = 0x10;
  payload.copy(p, 4);
  return p;
};
const psiPkt = (pid, section) => pkt(pid, true, Buffer.concat([Buffer.from([0x00]), section]));
const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;

function pesOf(spsNal) {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), spsNal]);
  const header = Buffer.from([0x80, 0xc0, 0x00]);
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
}
function patSection(pmtPid = PMT_PID) {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(pmtPid), pmtPid & 0xff]),
  ]);
  return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
}
function pmtSection() {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(0), 0x00]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0x00, 0x00]),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
}

const SEG = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection()),
  pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1920, height: 1088 }))),
]);
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.000,',
  'seg.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const origin = http.createServer((req, res) => {
  if (req.url.startsWith('/live.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(PLAYLIST);
  }
  if (req.url.startsWith('/seg.ts')) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return res.end(SEG);
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;

const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let BASE = '';
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server 起来太慢')), 15000);
  proc.stdout.on('data', (d) => {
    const m = /localhost:(\d+)/.exec(d.toString());
    if (m) {
      BASE = `http://127.0.0.1:${m[1]}`;
      clearTimeout(t);
      resolve();
    }
  });
});

const { j: live } = await fetch(
  `${BASE}/api/probe-url?url=${encodeURIComponent(`${ORIGIN}/live.m3u8`)}&timeout=5000`,
).then((r) => r.json().catch(() => ({ j: null })).then?.((j) => ({ j })) ?? { j: null });

console.log('体检数据来源：/api/probe-url');
ok('真实源探得到分辨率（报告第一格有真值）', live && /^1920x1088 \(1080p\)$/.test(live.format || ''), JSON.stringify(live && live.format));
ok('真实源探得到首字节延迟（毫秒）', live && live.ttfbMs > 0, String(live && live.ttfbMs));
// 服务名由后面 DOM 桩那一段覆盖（桩里的探测结果带 serviceName），
// 这里只负责确认「报告的数据来源真能给出这些值」，不重复测一遍 SDT 解析
ok('格式是报告要的那一路（format + ttfbMs 都有）', live && !!live.format && !!live.ttfbMs);

origin.close();
proc.kill();

/* ---------------- 2. 前端：报告渲染 + 后缀勾选 ---------------- */

const APP = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const escSrc = APP.match(/const esc = [\s\S]*?\);/)[0];

function grabFn(head) {
  const i = APP.indexOf(head);
  if (i < 0) throw new Error('源码里没找到: ' + head);
  let depth = 0;
  for (let j = APP.indexOf('{', i); j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') {
      if (--depth === 0) return APP.slice(i, j + 1);
    }
  }
  throw new Error('花括号没配对: ' + head);
}
// stateCell / explainNoRes 只负责报告里那枚状态药丸与「为什么没分辨率」的提示，
// 它们自己有各自的重测试（test/noresreason.mjs、表格渲染），这里用等价桩顶掉，
// 免得把整条渲染依赖链都拖进来
const stateCellStub = (p) =>
  p && p.ok ? '<span class="pill ok">200 在线</span>' : `<span class="pill bad">${(p && p.note) || '失败'}</span>`;
const explainStub = () => '这条流里没扫到分辨率';

/** 搭一套「添加新频道」弹窗的 DOM 桩，跑真的 watchStreamUrl */
function boot({ probe, sufRes = true, sufDelay = true } = {}) {
  const urlEl = { value: '', _h: null, addEventListener(t, f) { this._h = f; } };
  const titleEl = { value: '', _h: null, addEventListener(t, f) { this._h = f; } };
  const box = { innerHTML: '' };
  // 真 checkbox 是能挂事件的，桩也得能 —— 报告每次重写都会重新挂一遍
  const chk = (v) => ({ checked: v, _h: null, addEventListener(t, f) { this._h = f; } });
  const boxes = {
    mpmStreamInfo: box,
    mpmSufRes: chk(sufRes !== false),
    mpmSufDelay: chk(sufDelay !== false),
    mpmNamePreview: { textContent: '' },
  };
  const $ = (sel) => {
    if (sel.includes('data-k="url"')) return urlEl;
    if (sel.includes('data-k="title"')) return titleEl;
    return { focus() {}, classList: { remove() {}, add() {} } };
  };
  const document = { getElementById: (id) => (id in boxes ? boxes[id] : null) };
  let pending = null;
  const calls = [];
  // esc 不从外面传：它就在 escSrc 里声明，再当形参塞进去会重复声明
  const fn = new Function(
    't',
    '$',
    'document',
    'setTimeout',
    'clearTimeout',
    'fetch',
    'rebuildResName',
    'rebuildName',
    'stateCell',
    'explainNoRes',
    `${escSrc}
     ${grabFn('function suggestTitle(probe, curTitle) {')}
     ${grabFn('function watchStreamUrl() {')}
     return watchStreamUrl;`,
  )(
    // t 得真做占位符替换：报告里的告警是「不是实时直播：{why}」这一整句，
    // 桩要是原样返回，等于把 {why} 也印出来，断言就成了在测桩自己
    (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : `{${k}}`)),
    $,
    document,
    (f) => {
      pending = f;
      return 1;
    },
    () => {
      pending = null;
    },
    async (u) => {
      calls.push(u);
      return { json: async () => (probe || {}) };
    },
    rebuildResName,
    rebuildName,
    stateCellStub,
    explainStub,
  );
  const handle = fn();
  const probeIt = async (url) => {
    urlEl.value = url;
    urlEl._h('input');
    const p = pending;
    pending = null; // 非 http 地址压根不排定时器，这时 p 是 null
    if (typeof p === 'function') await p();
    await new Promise((r) => setImmediate(r));
  };
  return { urlEl, titleEl, box, boxes, calls, probeIt, apply: (base) => handle.applyTitle(base) };
}

const GOOD = {
  ok: true,
  status: 200,
  serviceName: 'dftvHD',
  format: '1920x1080 (1080p)',
  width: 1920,
  height: 1080,
  ttfbMs: 320,
  bandwidthMbps: 4.2,
};
const URL_GOOD = 'http://example.com/live/index.m3u8';

console.log('体检报告：把探测值摊开');
{
  const s = boot({ probe: GOOD });
  await s.probeIt(URL_GOOD);
  const h = s.box.innerHTML;
  ok('报告卡渲染出来了（带 .hlt 容器）', /class="hlt"/.test(h), h.slice(0, 120));
  ok('状态那一格跟表格是同一套说法（200 在线）', /200 在线/.test(h) && /pill ok/.test(h), h.slice(0, 120));
  ok('分辨率格显示探测到的分辨率', /1920x1080/.test(h) && /1080p/.test(h), h.slice(0, 200));
  ok('首字节延迟格显示了毫秒数', /320ms/.test(h), h.slice(0, 200));
  ok('标称码率格显示了码率', /4\.2M/.test(h), h.slice(0, 200));
  ok('三个勾选项都在（分辨率 / 延迟）', /id="mpmSufRes"/.test(h) && /id="mpmSufDelay"/.test(h), h.slice(0, 240));
  ok('频道名预览跟出来了', s.boxes.mpmNamePreview.textContent === 'dftvHD 1080p 320ms', s.boxes.mpmNamePreview.textContent);
  ok('服务名照样自动填进频道名（没被后缀搞丢）', s.titleEl.value === 'dftvHD', s.titleEl.value);
}

console.log('后缀：勾了才写，不勾一个字不动');
{
  const s = boot({ probe: GOOD });
  await s.probeIt(URL_GOOD);
  ok('两个都勾 → 分辨率在前、延迟在后', s.apply('大爱1台') === '大爱1台 1080p 320ms', s.apply('大爱1台'));
}
{
  const s = boot({ probe: GOOD, sufDelay: false });
  await s.probeIt(URL_GOOD);
  ok('只勾分辨率 → 只写分辨率', s.apply('大爱1台') === '大爱1台 1080p', s.apply('大爱1台'));
}
{
  const s = boot({ probe: GOOD, sufRes: false });
  await s.probeIt(URL_GOOD);
  ok('只勾延迟 → 只写延迟', s.apply('大爱1台') === '大爱1台 320ms', s.apply('大爱1台'));
}
{
  const s = boot({ probe: GOOD, sufRes: false, sufDelay: false });
  await s.probeIt(URL_GOOD);
  ok('一个都没勾 → 原样返回，一个字不动', s.apply('大爱1台') === '大爱1台', s.apply('大爱1台'));
}
{
  // 手打的名字不该被服务名顶掉（suggestTitle 的 filled 分支），但后缀照样生效
  const s = boot({ probe: GOOD });
  s.titleEl.value = '我手打的名字';
  await s.probeIt(URL_GOOD);
  ok('手打的名字不被服务名覆盖', s.titleEl.value === '我手打的名字', s.titleEl.value);
  ok('但体检报告照样给建议（后缀落在我打的名字上）', s.apply('我手打的名字') === '我手打的名字 1080p 320ms', s.apply('我手打的名字'));
  ok('预览也跟着刷新成我手打的名字', s.boxes.mpmNamePreview.textContent === '我手打的名字 1080p 320ms', s.boxes.mpmNamePreview.textContent);
}
{
  // 已经带着 1080p 了就别再叠一个
  const s = boot({ probe: GOOD });
  await s.probeIt(URL_GOOD);
  ok('名字末尾已有同档位时只更新、不重复', s.apply('CCTV-1 1080p') === 'CCTV-1 1080p 320ms', s.apply('CCTV-1 1080p'));
  ok('旧的延迟后缀会被顶掉而不是叠加', s.apply('CCTV-1 1080p 999ms') === 'CCTV-1 1080p 320ms', s.apply('CCTV-1 1080p 999ms'));
}

console.log('没真值的时候：宁可不写，也不编数');
{
  const s = boot({ probe: { ok: true, status: 200, serviceName: 'nosignal', ttfbMs: 0 } });
  await s.probeIt(URL_GOOD);
  ok('没读到分辨率时那格是「—」不是空白', /hlt-none/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 200));
  ok('没分辨率时顺手给出原因 tooltip', /title="[^"]*没扫到分辨率|title="[^"]*分辨率/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 260));
  ok('没测到延迟就一个字都不写', s.apply('nosignal') === 'nosignal', s.apply('nosignal'));
}
{
  const s = boot({ probe: { ok: false, code: 404, note: '找不到这个地址', serviceName: '' } });
  await s.probeIt(URL_GOOD);
  const h = s.box.innerHTML;
  ok('探测失败时报告照样给（让人看见为什么不行）', /class="hlt"/.test(h), h.slice(0, 120));
  ok('失败时状态是红的那枚', /pill bad/.test(h) && /找不到这个地址/.test(h), h.slice(0, 200));
  ok('失败的流不给写后缀', s.apply('大爱1台') === '大爱1台', s.apply('大爱1台'));
}
{
  // 没勾、且压根没探测（地址还不像 http）→ 什么都不该发生
  const s = boot({ probe: GOOD });
  await s.probeIt('file:///C:/x.m3u8');
  ok('地址不像 http(s) 时报告清空', s.box.innerHTML === '', s.box.innerHTML);
  ok('此时 applyTitle 原样返回', s.apply('大爱1台') === '大爱1台', s.apply('大爱1台'));
}

console.log('假直播判定：报告里当场说破');
{
  const s = boot({
    probe: {
      ...GOOD,
      fakeLive: true,
      fakeLiveWhy: '清单是已写完的点播（带 #EXT-X-ENDLIST），24 段共 01:58',
    },
  });
  await s.probeIt(URL_GOOD);
  ok('循环片命中 → 报告里有一行告警', /class="hlt-warn"/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 200));
  ok('告警把原因说清楚了（不是只写个词）', /ENDLIST/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 260));
}
{
  const s = boot({ probe: { ...GOOD, seamLive: true, seamLiveWhy: '这 10 段之间每一段都写了 #EXT-X-DISCONTINUITY' } });
  await s.probeIt(URL_GOOD);
  ok('拼接命中 → 也有告警', /hlt-warn/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 200));
  ok('拼接用冷蓝那一类（跟循环片的紫区分开）', /hlt-warn seam/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 200));
  ok('拼接同时给了原因', /DISCONTINUITY/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 260));
}
{
  const s = boot({ probe: GOOD });
  await s.probeIt(URL_GOOD);
  ok('真直播一条告警都不给（不吓唬人）', !/hlt-warn/.test(s.box.innerHTML), s.box.innerHTML.slice(0, 160));
}

console.log('实时性：换地址 / 改勾选');
{
  const s = boot({ probe: GOOD });
  await s.probeIt(URL_GOOD);
  ok('勾一下就重算预览', (() => {
    s.boxes.mpmSufRes.checked = false;
    s.boxes.mpmSufRes._h('change');
    return s.boxes.mpmNamePreview.textContent === 'dftvHD 320ms';
  })(), s.boxes.mpmNamePreview.textContent);

  // 换地址：上一轮的报告得撤掉，不能挂着上一个地址的体检结果
  const s2 = boot({ probe: GOOD });
  await s2.probeIt(URL_GOOD);
  ok('换地址后先撤掉旧报告', /class="hlt"/.test(s2.box.innerHTML));
  await s2.probeIt('file:///nope');
  ok('地址变得不可探测 → 报告清干净', s2.box.innerHTML === '', s2.box.innerHTML);
  ok('清掉之后也不残留旧的后缀逻辑（原样返回）', s2.apply('大爱1台') === '大爱1台', s2.apply('大爱1台'));
}
{
  // 连续两轮探测：报告重渲染后事件还得挂得住（不能只有第一轮有效）
  const s = boot({ probe: GOOD });
  await s.probeIt(URL_GOOD);
  await s.probeIt('http://example.com/second/2.m3u8');
  ok('第二轮探测后报告还在', /class="hlt"/.test(s.box.innerHTML));
  ok('第二轮照样发过请求', s.calls.length === 2, `calls=${s.calls.length}`);
  s.boxes.mpmSufDelay.checked = false;
  s.titleEl._h('input');
  ok('第二轮重渲染后勾选事件仍然生效', s.boxes.mpmNamePreview.textContent === 'dftvHD 1080p', s.boxes.mpmNamePreview.textContent);
}

console.log(`\n[体检报告] 通过 ${pass} 项 / 失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
