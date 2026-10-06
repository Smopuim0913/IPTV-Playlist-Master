/**
 * 端到端（无浏览器）：复刻浏览器里的真实数据流
 *   读文件 -> base64 -> 解码 -> parseM3U -> 编辑（删/排/改组）-> serialize
 * 目的是守住一条规则：编辑一轮之后，厂商私有属性和文件结构不能掉。
 * 运行：PORT=9207 node test/e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseM3U, serializeM3U, decodeBuffer, detectEncoding } from '../src/m3u.js';
import { probeMany } from '../src/probe.js';
import { rebuildResName, rebuildName, stripAllSuffix } from '../src/suffix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, '..', 'sample', 'channels.m3u');
const PORT = process.env.PORT || 9207;

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + extra}`);
  if (!cond) failed++;
};

console.log('\n— 模拟浏览器载入链路 —');
// 1) 服务端把原文以 base64 回传
const b64 = fs.readFileSync(SAMPLE).toString('base64');
// 2) 前端 b64 -> 字节 -> 解码
const s = Buffer.from(b64, 'base64').toString('binary');
const bytes = new Uint8Array(s.length);
for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
const content = decodeBuffer(bytes);
const enc = detectEncoding(bytes);
ok('编码识别为 utf-8', enc === 'utf-8', enc);
ok('解码内容非空', content.trim().length > 0);

// 3) 前端解析（浏览器里这一步走 /module/m3u.js 的同一份代码）
const doc = parseM3U(content);
// 4) adopt()：doc.entries 与 state.entries 指向同一数组
const entries = doc.entries;
ok('doc.entries 与 state.entries 同一引用', doc.entries === entries);

// 5) 编辑三件事：删一条（中间那台）、把首条挪到末位、批量改一个分组
const victim = entries[3];
entries.splice(3, 1);
const originalFirst = entries[0].url;
const moved = entries.splice(0, 1)[0];
entries.push(moved);
const target = entries.find((e) => e.attrMap['group-title'] === '央视');
target.attrMap['group-title'] = '央视频道';

console.log('\n— 编辑后导出 —');
// 6) serialize 用前端那一行写法：整份 doc 透传，entries 取实时数组
const out = serializeM3U({ ...doc, entries });

ok('#EXTM3U 头还在', out.startsWith('#EXTM3U'));
ok('#KODIPROP 头注释没丢', out.includes('#KODIPROP:inputstream.adaptive.license_type=clearkey'));
// 这条属于 CCTV-5，删除/排序都不会动到它
ok('response-time 私有写法存活到导出', out.includes('response-time="31"'));
// 被删掉的 CCTV-9 那条私有写法（{18}ms）应随条目一起消失
ok('被删条目的私有写法没残留', !out.includes('{18}ms'));
ok('catchup-source 还在', out.includes('catchup-source="cctv5"'));
const urls = out.split('\n').filter((l) => /^https?:/.test(l));

// 7) 删掉的那个频道必须真的消失
ok('删除的频道没被写回', !out.includes(victim.url), victim.url);
// 8) 顺序变动生效：首条是[移走后的]第二条，末条是被挪到最后的原首条
ok('首条已不是原首条', urls[0] !== originalFirst, urls[0]);
ok('末条是原首条', urls[urls.length - 1] === originalFirst, urls[urls.length - 1]);
ok('导出条目数为 8', urls.length === 8, String(urls.length));
ok('末尾换行保留', out.endsWith('\n'));

// 9) 再解析一次：属性必须还在（这一步守的是「保存后供应商给的列表没被销毁」）
const again = parseM3U(out);
const byUrl = Object.fromEntries(again.entries.map((e) => [e.url, e]));
const kept = byUrl['https://example-iptv.local/live/cctv5/index.m3u8'];
ok('回读后 catchup 仍在', kept && kept.attrMap['catchup'] === 'fmp4');
ok('回读后响应时长仍在', kept && kept.attrMap['response-time'] === '31');

console.log('\n— 服务端索引 -> 探测 —');
// 10) 前端把 id/url 登记给服务端，服务端据此探测
const targets = entries.filter((e) => e.url).map((e) => ({ id: e.id, url: e.url }));
ok('登记条目数与前端一致', targets.length === 8, String(targets.length));

const { done, results } = await probeMany(targets, { concurrency: 4, timeout: 4000 });
ok('探测条数与登记一致', done === 8, String(done));
ok('每条都有结论', results.length === 8);
ok('失败率在合理区间', results.filter((r) => !r.ok).length >= 3, JSON.stringify(results.map((r) => r.note)));

console.log('\n— 回填分辨率 / 彻底清洗 各自独立 —');
// 12) 名字上同时挂着手写分辨率后缀和延迟后缀
const subject = entries[0];
subject.title = 'CCTV-1 综合 480p 1000ms';
subject.probe = { ok: true, ttfbMs: 120, format: '1920x1080 (1080p)', note: '' };
const tier = /\(([^)]+)\)/.exec(subject.probe.format)[1];

// 回填分辨率：只动分辨率那一截，延迟后缀必须原样留着
const afterFillRes = rebuildResName({ title: subject.title, tier, strip: true, append: true });
ok('回填分辨率纠正了档位且没碰延迟后缀', afterFillRes === 'CCTV-1 综合 1080p 1000ms', afterFillRes);

// 回填延迟：只动延迟那一截，分辨率后缀必须原样留着
const afterFillDelay = rebuildName({ title: subject.title, ms: 120, tpl: '{ms}ms', strip: true, append: true });
ok('回填延迟重写了延迟且没碰分辨率后缀', afterFillDelay === 'CCTV-1 综合 480p 120ms', afterFillDelay);

// 彻底清洗：两头都摘，一个字都不回填
const cleaned = stripAllSuffix(afterFillDelay);
ok('彻底清洗把两种后缀都摘掉', cleaned === 'CCTV-1 综合', cleaned);

// 没有探测值时不许静默删除手写分辨率
const noProbe = { ...entries[1] };
noProbe.title = '晓心WXTV 480p';
const untouched = rebuildResName({ title: noProbe.title, tier: '', strip: true, append: true });
ok('没探测值时回填分辨率不改名字', untouched === '晓心WXTV 480p', untouched);

console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n');
process.exit(failed ? 1 : 0);
