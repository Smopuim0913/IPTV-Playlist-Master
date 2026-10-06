/**
 * TS 主路径的两处补强（本轮按实测结论修的）：
 *
 *   1) pesResolution 以前只扫「第一个视频 PES」，SPS 只挂在关键帧上 ——
 *      第一个 PES 往往只有 SEI + 切片，SPS 在后头的 PES 才随 IDR 到
 *      （实测 112.123.243.37 那条直播源：首个视频 PES 在 11.3KB，SPS 在 604KB）。
 *      于是 tsResolution 恒为 null，TS 这条路常年是摆设，全靠 Annex-B 兜底。
 *      现在单趟扫过前若干个 PES。
 *
 *   2) tsServiceName：从 SDT（PID 17 / table_id 0x42）里读流内频道名。
 *      媒体清单的 #EXTINF 标题可能是占位的 `no desc`，但流自己往往写着真名。
 *
 * 同样不连真源站，自己按 ISO 13818-1 拼出 PAT/PMT/SDT/PES 来跑。
 */
import http from 'node:http';
import { tsResolution, tsServiceName, readResolution } from '../src/resolution.js';
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

const pidHi = (pid) => 0xe0 | ((pid >> 8) & 0x1f);
const pkt = (pid, pusi, payload) => {
  const p = Buffer.alloc(188);
  p[0] = 0x47;
  p[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
  p[2] = pid & 0xff;
  p[3] = 0x10; // payload only
  payload.copy(p, 4);
  return p;
};
/** PSI 段起始包：净荷 = 1 字节 pointer_field + 段本体（段首字节就是 table_id） */
const psiPkt = (pid, section) => pkt(pid, true, Buffer.concat([Buffer.from([0x00]), section]));

function pesOf(spsNal) {
  // 00 00 01 E0 <len hi/lo> 80 C0 00 <SPS>
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), spsNal]);
  const header = Buffer.from([0x80, 0xc0, 0x00]);
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
}

/** 一个「没有 SPS 的第一个视频 PES（SEI + 切片）」，用来把 SPS 挤到后头 */
function pesWithoutSps() {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), Buffer.from([0x09, 0x10, 0x00, 0x01])]);
  const header = Buffer.from([0x80, 0xc0, 0x03]); // PES_header_data_length = 3
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
}

const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;
const SDT_PID = 0x0011;

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
    Buffer.from([0x00, 0x00]), // program_info_length = 0
    Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0x00, 0x00]),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
}

/* ---- 1. SPS 不在第一个视频 PES 里，而在后面某个 PES 身上 ---- */

console.log('TS 主路径：SPS 不在首个 PES 里');
{
  // 三个「空」PES（只有 SEI/切片、无 SPS）垫在前面，真正的 SPS 在第四个 PES
  const mk = (pes, extra = 0) =>
    Buffer.concat([
      psiPkt(0x0000, patSection()),
      psiPkt(PMT_PID, pmtSection()),
      pkt(VIDEO_PID, true, pes),
      ...(extra > 0 ? Array.from({ length: extra }, () => pkt(VIDEO_PID, false, Buffer.alloc(20, 0x22))) : []),
    ]);

  const empty = pesWithoutSps();
  const withSps = pesOf(makeSps({ width: 1920, height: 1088 }));

  // 基线：SPS 就在第一个 PES —— 老代码和新代码都得读出来
  ok('SPS 在首个 PES 时照旧能读', (() => {
    const r = tsResolution(mk(withSps, 1));
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');

  ok('SPS 在第 2 个 PES 时读得出（老实现会返回 null）', (() => {
    const r = tsResolution(Buffer.concat([mk(empty, 1), pkt(VIDEO_PID, true, withSps)]));
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');

  ok('SPS 在第 4 个 PES 时读得出', (() => {
    const r = tsResolution(Buffer.concat([mk(empty, 2), pkt(VIDEO_PID, true, empty), pkt(VIDEO_PID, true, withSps)]));
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');

  ok('SPS 在很靠后（第 12 个 PES）也还能读出来', (() => {
    const parts = [mk(empty, 2), ...Array.from({ length: 10 }, () => pkt(VIDEO_PID, true, empty))];
    const r = tsResolution(Buffer.concat([...parts, pkt(VIDEO_PID, true, withSps)]));
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');

  ok('整个窗口里都没有 SPS 时不硬猜（返回 null，交给 Annex-B 兜底）', (() => {
    const r = tsResolution(mk(empty, 3));
    return r === null;
  })(), JSON.stringify(tsResolution(mk(empty, 3))));

  ok('readResolution 总入口也走通这条（不靠 Annex-B）', (() => {
    // 整段里搜不到 00 00 01 67，逼得 Annex-B 那条路也帮不上忙
    const r = readResolution(Buffer.concat([mk(empty, 2), pkt(VIDEO_PID, true, withSps)]));
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');
}

/* ---- 2. SDT 服务名 ---- */

const sdtBytes = (name) => {
  const nm = Buffer.from(name, 'utf8');
  // service_descriptor body：service_type(0x01) + provider_len(0) + name_len + name
  const body = Buffer.concat([Buffer.from([0x01, 0x00, nm.length]), nm]);
  return Buffer.concat([Buffer.from([0x48, body.length]), body]);
};
/** 一个 service：service_id(2) + reserved(4)/descriptor_loop_length(12) + 描述符 */
const sdtService = (name, serviceId = 0x0001) => {
  const desc = sdtBytes(name);
  return Buffer.concat([
    Buffer.from([(serviceId >> 8) & 0xff, serviceId & 0xff]),
    Buffer.from([0x00, desc.length]),
    desc,
  ]);
};

/**
 * 造一个 SDT 段（t 指 table_id）—— 注意头是 **11 字节**，比 PAT/PMT 长 3 个：
 * tsid(2) + 版本/段号(2) + 末段号(1) + original_network_id(2) + 末段号(1) + 末子段号(1)。
 * 少那 3 字节（把 service 循环起手写成 +8）就会算出几百字节的描述符长度，全读不出来。
 */
function sdtSection(name, { serviceId = 0x0001 } = {}) {
  const rest = Buffer.concat([
    Buffer.from([0x00, 0x01]), // transport_stream_id
    Buffer.from([0xc0, 0x00]), // version / section_number
    Buffer.from([0x00]), // last_section_number
    Buffer.from([0x00, 0x01]), // original_network_id
    Buffer.from([0xff]), // segment_last_section_number
    Buffer.from([0x00]), // segment_last_sub_section_number
    sdtService(name, serviceId),
  ]);
  // table_id + 段长(12) + 其余 + 4 字节 CRC
  return Buffer.concat([Buffer.from([0x42, 0xb0, rest.length + 4]), rest, Buffer.alloc(4)]);
}

console.log('TS 服务名（SDT）');
{
  const tsWithSdt = (section) =>
    Buffer.concat([psiPkt(0x0000, patSection()), pkt(SDT_PID, true, section)]);

  ok('从 SDT 读出一个纯 ASCII 服务名', tsServiceName(tsWithSdt(sdtSection('dftvHD'))) === 'dftvHD',
    JSON.stringify(tsServiceName(tsWithSdt(sdtSection('dftvHD')))));

  ok('中文服务名也能读（UTF-8）', tsServiceName(tsWithSdt(sdtSection('中央一台'))) === '中央一台',
    JSON.stringify(tsServiceName(tsWithSdt(sdtSection('中央一台')))));

  ok('段前面带 pointer_field 时不吃掉服务名', (() => {
    // 段起始包里 pointer_field=0 → table_id 在下一字节，解析时要跳过去
    const sec = sdtSection('凤凰卫视');
    return tsServiceName(Buffer.concat([psiPkt(0x0000, patSection()), psiPkt(SDT_PID, sec)])) === '凤凰卫视';
  })());

  ok('没有 SDT 时返回空串（宁可空着也不猜）', tsServiceName(tsWithSdt(Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))) === '', '这是 PAT 而非 SDT');

  ok('喂 mp4 / 非 TS 字节时返回空串', tsServiceName(Buffer.from('\x00\x00\x00\x18ftypisom')) === '');
  ok('喂太短的字节时返回空串', tsServiceName(Buffer.alloc(64)) === '');

  ok('空名字 / 长度 0 的服务名不算数', (() => {
    const sec = sdtSection('');
    return tsServiceName(tsWithSdt(sec)) === '';
  })());

  {
    // 一段里含多个 service：挑最短的那个名字（更接近「频道名」）
    const rest = Buffer.concat([
      Buffer.from([0x00, 0x01]), // transport_stream_id
      Buffer.from([0xc0, 0x00]),
      Buffer.from([0x00]),
      Buffer.from([0x00, 0x01]),
      Buffer.from([0xff]),
      Buffer.from([0x00]),
      sdtService('第二套', 0x0002),
      sdtService('第一套', 0x0001),
    ]);
    const sec = Buffer.concat([Buffer.from([0x42, 0xb0, rest.length + 4]), rest, Buffer.alloc(4)]);
    const got = tsServiceName(tsWithSdt(sec));
    ok('一段里含多个 service 时不崩、给得出名字', got === '第一套' || got === '第二套', JSON.stringify(got));
  }
}

/* ---- 2b. PAT / PMT 解析的两个「时好时坏」的坑（真源上踩出来的） ---- */

console.log('PAT / PMT 解析边界');
{
  const withPat = (patSec, pmtSec, pes) =>
    Buffer.concat([psiPkt(0x0000, patSec), pmtSec ? psiPkt(PMT_PID, pmtSec) : pkt(PMT_PID, true, pes), pes].filter(Boolean));
  const spsPes = pesOf(makeSps({ width: 1920, height: 1088 }));

  ok('PAT 的 CRC 被当成第二条 program 时也不丢 PMT_PID', (() => {
    // 真 PAT 只有一个 program，CRC 4 字节紧跟着 program；若循环边界没卡在 CRC 前，
    // 这串 00 01 E0 7F 就会被当成 program，把正确的 PMT_PID 覆盖成 0x7f
    const body = Buffer.concat([Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]), Buffer.from([pidHi(PMT_PID), PMT_PID & 0xff])]);
    const pat = Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.from([0x00, 0x01, 0xe0, 0x7f])]);
    const r = tsResolution(withPat(pat, pmtSection(), pkt(VIDEO_PID, true, spsPes)));
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');

  ok('视频 PES 净荷不会被当成 PMT 抢走视频 PID', (() => {
    // 没有 PAT（逼得走全表兜底），前面几个视频包的净荷恰好以 00 02 开头，
    // 长得跟 PMT 段首一模一样；真 PMT 在后面
    const fakePes = Buffer.concat([Buffer.from([0x00, 0x02, 0xb0, 0x25, 0x00, 0x01, 0xc3]), Buffer.alloc(150, 0x5a)]);
    const ts = Buffer.concat([
      psiPkt(PMT_PID, pmtSection()),
      pkt(VIDEO_PID, true, fakePes),
      pkt(VIDEO_PID, true, fakePes),
      pkt(VIDEO_PID, true, spsPes),
    ]);
    const r = tsResolution(ts);
    return r && r.width === 1920 && r.height === 1088;
  })(), '1920x1088');
}

/* ---- 3. 探测端到端：服务名顺着探测结果带出来 ---- */

console.log('探测时顺带取服务名');
{
  const { probeUrl } = await import('../src/probe.js');
  // 一个真能跑的迷你 TS 分片：PAT + 带 SPS 的视频 PES + SDT
  const ts = Buffer.concat([
    psiPkt(0x0000, patSection()),
    pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1920, height: 1088 }))),
    psiPkt(SDT_PID, sdtSection('dftvHD')),
  ]);
  const s = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(ts);
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/live.ts`, { timeout: 3000 });
  ok('直连流探测把流内服务名带出来', out.serviceName === 'dftvHD', JSON.stringify(out.serviceName));
  ok('note 里也点明了这个服务名的出处', /SDT 服务名/.test(out.note), out.note);
  s.close();
}

{
  // 流里没有 SDT 时，serviceName 是空串而不是报错或乱猜
  const { probeUrl } = await import('../src/probe.js');
  const ts = Buffer.concat([psiPkt(0x0000, patSection()), pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1280, height: 720 })))]);
  const s = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(ts);
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/live.ts`, { timeout: 3000 });
  ok('没有 SDT 时 serviceName 留空', out.serviceName === '', JSON.stringify(out.serviceName));
  ok('分辨率照旧读得到', out.format.includes('720p'), out.format || '(空)');
  s.close();
}

console.log(failed ? `\n${failed} 项失败（通过 ${pass}）\n` : `\n全部通过（${pass} 项）\n`);
process.exit(failed ? 1 : 0);
