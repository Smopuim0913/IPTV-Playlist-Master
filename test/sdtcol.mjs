/**
 * 「流内名」这一列 + 「标称码率」这一格。
 *
 * 起因（这两个字段以前都只是"藏在探测结果里"）：
 *   · 流内 SDT 服务名（serviceName）只出现在分辨率格子的 tooltip 里，表格没列、也不能复制；
 *   · 吞吐那一格画的是**实测** mbps —— 主清单一律不算、样本不足 32KB 也不算，
 *     实测 26 条在线只有 1 条非零（还是 0.01M 噪音），整列常年「—」。
 * 现在：流内名单独成列（ⓘ 看完整名 / ⧉ 复制整段），码率那一格改显示**源站标称**的 BANDWIDTH
 * （实测值退到 tooltip）。
 *
 * 三段验证：
 *   上半——抠 app.js 里的单元格渲染函数 + DOM 桩，把各种输入都喂一遍；
 *   中段——静态检查接线（表头顺序、rowHtml / updateRow / 事件委托有没有真的接到新列）；
 *   下半——真起一个假源站，用 src/probe.js 跑两趟（TS 直连流 / HLS 主清单），
 *         拿真实回来的 row 去喂上面抠出来的两个渲染函数。
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { probeUrl } from '../src/probe.js';
import { makeSps } from './lib/sps.mjs';

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

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

/** 从源码里抠一段（抠不到就是测试跟着实现一起改坏了） */
const grab = (re, what) => {
  const m = APP.match(re);
  if (!m) throw new Error(`源码里抠不出 ${what}，测试该跟着实现一起更新`);
  return m[0];
};

/** 带 {占位} 的翻译桩 */
const ident = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => String((o && o[k]) ?? ''));

// esc 必须抠真身：这里要验的就是服务名里的引号/尖括号有没有被转义出来，
// 拿一个「原样返回」的假 esc 是验不出来的。
const ESC = grab(/const esc = \(s\) =>\n.*;/, 'esc');
const SRC = [
  grab(/const stallRiskText = .*;/, 'stallRiskText'),
  grab(/const mbpsCell = \(p\) => \{[\s\S]*?\n\};/, 'mbpsCell'),
  grab(/const sdtCell = \(p\) => \{[\s\S]*?\n\};/, 'sdtCell'),
].join('\n\n');

// 形参就不叫 esc 了：抠进来的那行自己就声明了 const esc，同名会撞车
const render = new Function('t', `${ESC}\n${SRC}\nreturn { esc, mbpsCell, sdtCell, stallRiskText };`)(ident);

/* ---------------- A. 流内名这一格 ---------------- */
console.log('流内名这一格');

ok('没探测过 → 横杠', /sdtlow/.test(render.sdtCell(null)) && /—/.test(render.sdtCell(null)), render.sdtCell(null));
ok('探测失败 → 横杠', render.sdtCell({ ok: false, serviceName: 'dftvHD' }).includes('—'));
ok('在线但流里没写 SDT（serviceName 空串）→ 横杠', render.sdtCell({ ok: true, serviceName: '' }).includes('—'));
const withName = render.sdtCell({ ok: true, serviceName: 'dftvHD' });
ok('读到服务名 → 给信息图标', /data-act="sdtwhy"/.test(withName) && /ⓘ/.test(withName), withName);
ok('读到服务名 → 给复制图标', /data-act="sdtcopy"/.test(withName) && /⧉/.test(withName), withName);
ok('信息图标的 title 就是完整服务名（悬停即看）', /title="流内名：dftvHD"/.test(withName), withName);
ok('没读到服务名时不给任何图标', !/data-act=/.test(render.sdtCell({ ok: true, serviceName: '' })));
// 名字里带引号/尖括号：必须转义，否则一整句英文服务名会把属性截断
const risky = render.sdtCell({ ok: true, serviceName: 'Phoenix "Chinese" <HD>' });
ok('服务名里的引号/尖括号被转义', /&quot;Chinese&quot;/.test(risky) && /&lt;HD&gt;/.test(risky), risky);
ok('转义后 title 没被提前截断', /title="流内名：Phoenix &quot;Chinese&quot; &lt;HD&gt;">/.test(risky), risky);

/* ---------------- B. 标称码率这一格 ---------------- */
console.log('标称码率这一格');

ok('没探测过 → 横杠', render.mbpsCell(null).includes('—'));
ok('探测失败 → 横杠', render.mbpsCell({ ok: false, bandwidthMbps: 4.2 }).includes('—'));
ok('源站没标 BANDWIDTH → 横杠', render.mbpsCell({ ok: true, bandwidthMbps: 0, mbps: 3.1 }).includes('—'));
const declared = render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 0, stallRisk: '' });
ok('标称码率照原样显示（4.2M）', />4\.2M</.test(declared), declared);
ok('实测值退到 tooltip，别让 64KB 样本占了这一格', /实测 3\.1M/.test(render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 3.1, stallRisk: '' })), render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 3.1 }));
ok('tooltip 里带上卡顿预判', /容易卡/.test(render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 0, stallRisk: 'high' })), render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 0, stallRisk: 'high' }));
ok(' stallRisk 只是分类，不进格子正文', !/容易卡/.test(render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 0, stallRisk: 'high' }).replace(/title="[^"]*"/, '')), render.mbpsCell({ ok: true, bandwidthMbps: 4.2, mbps: 0, stallRisk: 'high' }));

/* ---------------- C. 接线（静态） ---------------- */
console.log('接线');

ok('表头多了一列「流内名」，紧跟分辨率', /<th class="c-res"[^>]*>分辨率<\/th>\s*\n\s*<th class="c-sdt"[^>]*>流内名<\/th>/.test(HTML), (HTML.match(/<th class="c-sdt"[^>]*>[^<]*<\/th>/) || [''])[0]);
ok('吞吐那列表头改成「标称码率」', /<th class="c-mbps"[^>]*>标称码率<\/th>/.test(HTML) && !/class="c-mbps"[^>]*>吞吐</.test(HTML));
ok('行模板里这一列是 data-c="sdt"', /<td data-c="res">\$\{resCell\(e\.probe\)\}<\/td>\s*\n\s*<td data-c="sdt">\$\{sdtCell\(e\.probe\)\}<\/td>/.test(APP));
ok('单行刷新也刷这一列（否则探测完不更新）', /querySelector\('\[data-c="sdt"\]'\)/.test(grab(/function updateRow\(e\) \{[\s\S]*?\n\}/, 'updateRow')));
const sdtwhyBr = APP.match(/if \(act === 'sdtwhy'\)\s*\{[\s\S]*?\n  \}/) || [''];
ok(
  'ⓘ 摊开成就地常驻浮层，不是一闪而过的提示条',
  /respop/.test(sdtwhyBr) && !/toast\(/.test(sdtwhyBr),
  sdtwhyBr.slice(0, 160),
);
ok('⧉ 走的是同一套带兜底的复制', /act === 'sdtcopy'/.test(APP));
ok('浮层那两个图标样式都在 CSS 里', /\.sdticon,.sdtcopy\{/.test(CSS) && /\.sdtpop\{/.test(CSS));
ok('两列列宽都写死了（信息密集，列得窄）', /\.c-sdt\{width:74px\}/.test(CSS) && /\.c-mbps\{width:86px\}/.test(CSS));
// 新文案必须都在字典里（i18n.mjs 只查 index.html / t() 字面量，这里再补一眼动态拼的几条）
for (const key of ['流内名：{n}', '复制完整流内名', '已复制流内名', '源站标称 {n}M', '实测 {n}M', '卡顿预判：{n}', '这条没读到标称码率']) {
  ok(`字典里有「${key}」的英文`, new RegExp(`'${key.replace(/[{}]/g, (m) => '\\' + m)}':\\s*'`).test(I18N));
}

/* ---------------- D. 真探测两趟 ---------------- */
console.log('真探测（假源站）');

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
const pesOf = (spsNal) => {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), spsNal]);
  const header = Buffer.from([0x80, 0xc0, 0x00]);
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
};
const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;
const SDT_PID = 0x0011;
const patSection = () => {
  const body = Buffer.concat([Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]), Buffer.from([pidHi(PMT_PID), PMT_PID & 0xff])]);
  return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};
const pmtSection = () => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(0), 0x00]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0x00, 0x00]),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};
const sdtSection = (name) => {
  const nm = Buffer.from(name, 'utf8');
  const body = Buffer.concat([Buffer.from([0x01, 0x00, nm.length]), nm]);
  const desc = Buffer.concat([Buffer.from([0x48, body.length]), body]);
  const service = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from([0x00, desc.length]), desc]);
  const rest = Buffer.concat([
    Buffer.from([0x00, 0x01]),
    Buffer.from([0xc0, 0x00]),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x01]),
    Buffer.from([0xff]),
    Buffer.from([0x00]),
    service,
  ]);
  return Buffer.concat([Buffer.from([0x42, 0xb0, rest.length + 4]), rest, Buffer.alloc(4)]);
};
const tsWithSdt = (name) =>
  Buffer.concat([
    psiPkt(0x0000, patSection()),
    psiPkt(PMT_PID, pmtSection()),
    psiPkt(SDT_PID, sdtSection(name)),
    pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1920, height: 1088 }))),
  ]);

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1280x720',
  'seg0.ts',
  '',
].join('\n');

// 探测只读前 64KB，夹具得撑得比 32KB 的吞吐门槛高，否则测不到「实测有数」这条
const TS_BIG = Buffer.concat(Array.from({ length: 96 }, () => tsWithSdt('dftvHD')));

const srv = http.createServer((req, res) => {
  if (req.url === '/ts') {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end(TS_BIG);
    return;
  }
  if (req.url === '/master.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(MASTER);
    return;
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const tsRow = await probeUrl(`${base}/ts`, { timeout: 4000 });
const hlsRow = await probeUrl(`${base}/master.m3u8`, { timeout: 4000 });

ok('TS 直连流确实探到流内服务名 dftvHD', tsRow.ok && tsRow.serviceName === 'dftvHD', JSON.stringify(tsRow.serviceName));
ok('这一格给的是 ⓘ + ⧉', /data-act="sdtwhy"/.test(render.sdtCell(tsRow)) && /data-act="sdtcopy"/.test(render.sdtCell(tsRow)));
ok('TS 流探到了分辨率（说明这一趟真读到了码流）', !!tsRow.format, tsRow.format);
ok('直连流没有标称码率 → 这一格是横杠（实测值只进 tooltip）', render.mbpsCell(tsRow).includes('—'), render.mbpsCell(tsRow));
ok('实测吞吐算得出数（证明上面那句是"没标称"而不是"没算"）', tsRow.mbps > 0, String(tsRow.mbps));

ok('HLS 主清单探到标称码率 4.2M', hlsRow.ok && hlsRow.bandwidthMbps === 4.2, String(hlsRow.bandwidthMbps));
ok('HLS 主清单的标称码率显示为 4.2M', />4\.2M</.test(render.mbpsCell(hlsRow)), render.mbpsCell(hlsRow));
ok('HLS 主清单读不到流内名 → 横杠', render.sdtCell(hlsRow).includes('—'), render.sdtCell(hlsRow));

srv.close();

console.log(`\n${failed ? '有失败项' : '全部通过'}（${pass + failed} 项）`);
if (failed) process.exit(1);
