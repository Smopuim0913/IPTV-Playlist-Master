/**
 * 分辨率补全 —— 直连流/HLS 子清单「200 在线却没分辨率」的那部分。
 *
 * 这里不连真源站（又慢又不稳定），而是自己拼出符合规范的 H.264 SPS 比特流、
 * 一整个 MPEG-TS 包（PAT/PMT/PES）、一个 MP4 moov 树，断言能把宽高读出来。
 */
import http from 'node:http';
import { readResolution, h264SpsResolution, tsResolution, mp4Resolution, annexbResolution, firstSegmentUri } from '../src/resolution.js';
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

/* ---------------- 1. 拼一段 H.264 SPS ---------------- */

console.log('H.264 SPS 解析');

// 真源站抓下来的 SPS（CGTN 直播，profile_idc=77 主档 level 4.0）：
// 带仿真阻止字节、靠 crop 把 1088 扣回 1080。下面解析用例和端到端用例都用这份真数据，
// 这样"合成样例全绿、真流全挂"的那类 bug 不会再溜过去。
const REAL_SPS = Buffer.from('674d4028d940780227e584000003000400000300cb928003d090007a139a8c01e3064b00', 'hex');

const s1080 = makeSps({ width: 1920, height: 1088 });
{
  const r = h264SpsResolution(s1080.subarray(4));
  ok('1080p 读宽高（宏块对齐到 1088）', r && r.width === 1920 && r.height === 1088, JSON.stringify(r));
  ok('标记为 h264', r && r.codec === 'h264');
}
{
  // 1080 不是 16 的整数倍，真源站会把高度写成 1088 再靠 crop 扣回 1080
  const r = h264SpsResolution(makeSps({ width: 1920, height: 1088, crop: [0, 0, 4, 4] }).subarray(4));
  ok('上下各裁 4 像素 → 1072', r && r.height === 1072, JSON.stringify(r));
}
{
  const r = h264SpsResolution(makeSps({ width: 1280, height: 720 }).subarray(4));
  ok('720p', r && r.width === 1280 && r.height === 720, JSON.stringify(r));
}
{
  const r = h264SpsResolution(makeSps({ width: 848, height: 480, profile: 0x4d }).subarray(4));
  ok('480p（非整 mb 宽度按宏块 16 像素对齐）', r && r.width === 848 && r.height === 480, JSON.stringify(r));
}
{
  // 隔行：frame_mbs_only_flag=0，高度要从「32 像素一 mb」展开，不是 ×2 蒙的
  const r = h264SpsResolution(makeSps({ width: 1920, height: 1088, interlaced: true }).subarray(4));
  ok('隔行按 32 像素/宏块展开', r && r.width === 1920 && r.height === 1088, JSON.stringify(r));
}
{
  // 4:2:0 一个 crop 单位是 2 像素，上下各 2 就是扣 8 → 1088→1080
  const r = h264SpsResolution(makeSps({ width: 1920, height: 1088, crop: [0, 0, 2, 2] }).subarray(4));
  ok('按 crop 把宏块补出来的高度扣回真实值', r && r.height === 1080, JSON.stringify(r));
}
ok('不是 SPS（切片 NAL）时不硬猜', h264SpsResolution(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x11])) === null);

{
  // 真源站抓下来的 SPS（CGTN 直播，profile_idc=77 主档 level 4.0）。
  // 这里全是解析器以前栽跟头的地方：
  //   · 位流起点 —— 必须跳过 nal 头 + profile + 约束位 + level_idc，从第 4 字节读 RBSP；
  //     早先写成从 1 起读两个字节，等于把 level_idc 当首字段，整段错位 → 一律返回 null。
  //   · 仿真阻止 —— 字节串里 00 00 03 是插入的转义，解析前必须剔掉，否则从那以后全错位。
  //   · 1088 存、1058… 存高宽：1088 不是 16 的整数倍，靠 crop_bottom=4 扣回 1080。
  ok('真源站 SPS：带仿真阻止字节也能读', REAL_SPS.includes(Buffer.from([0, 0, 0x03])), '数据里应有 00 00 03');
  const r = h264SpsResolution(REAL_SPS);
  ok('真源站 SPS 读出 1920x1080', r && r.width === 1920 && r.height === 1080, JSON.stringify(r));
  ok('真源站 SPS 标记为 h264', r && r.codec === 'h264', JSON.stringify(r));
}

/* ---------------- 2. 拼一个 MPEG-TS ---------------- */

/**
 * 造一整个 .ts 流：PAT → PMT → 视频 PES（内含 SPS + 一字节切片）。
 *
 * PSI 段的字段偏移这里按 ISO 13818-1 严格来（table_id 记为偏移 0）：
 *
 *   PAT   +0 table_id | +1..2 段长 | +3..4 program_number | +5 版本/段号
 *         +6 段号 | +7 末段号 | +8..9 reserved(3)+PMT_PID(13)
 *   PMT   +0 table_id | +1..2 段长 | +3..4 program_number | +5 版本/段号
 *         +6 段号 | +7 末段号 | +8..9 reserved(3)+PCR_PID(13)
 *         +10..11 reserved(4)+program_info_length(12) | +12 起各条 stream
 *
 * 早先这份夹具把 PAT 的 program_number 写了两遍、把 PMT 的 PIL 前移了两字节，
 * 整体比规范左移 —— 于是「按错误偏移解析」的旧代码反而能通过，
 * 真按规范解析的流却一直读不出分辨率。夹具必须和规范一致才测得出来。
 *
 * @param {Object} o
 * @param {boolean} [o.brokenPat=false] PAT 里把 PMT_PID 写成一个码流中不存在的 PID，
 *        模拟实测遇到的坏源（播放器照样能播，因为它会自己扫 PID 找表）
 */
function makeTs({ width = 1920, height = 1088, crop = null, sps = null, brokenPat = false } = {}) {
  // PID 只有 13 位可用，高 4 位要挤在标志字节低位里，0x1xxx 这种会被截断成 0x0fxx
  const VIDEO_PID = 0x0101;
  const PMT_PID = 0x0100;
  const declaredPmtPid = brokenPat ? 0x0200 : PMT_PID;
  // TS 里的 NAL 带 Annex-B 起始码（00 00 01 67），剥掉就扫不到 SPS 了
  const spsNal = sps || makeSps({ width, height, crop });

  // PES：00 00 01 E0 <len> 80 C0 00 <SPS>
  const pesPayload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), spsNal]);
  const pesHeader = Buffer.from([0x80, 0xc0, 0x00]); // marker + flags + header_data_length=0
  const pesLen = pesHeader.length + pesPayload.length;
  const pes = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (pesLen >> 8) & 0xff, pesLen & 0xff]), pesHeader, pesPayload]);

  // PSI/PAT 里 PID 是 13 位：前面 3 个保留位，高 5 位挤在低 5 位（0xe0 是「3 保留 + 5 位」）
  const pidHi = (pid) => 0xe0 | ((pid >> 8) & 0x1f);

  // PAT：1 个 program → PMT_PID
  const patBody = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]), // program_number + 版本/段号 + 段号/末段号
    Buffer.from([pidHi(declaredPmtPid), declaredPmtPid & 0xff]), // reserved(3)+PMT_PID(13)
  ]);
  const patSection = Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + patBody.length + 4]), patBody, Buffer.alloc(4)]);
  const pat = Buffer.concat([Buffer.from([0x00]), patSection]);

  // PMT：一路 H.264 视频（stream_type 0x1b）；program_info_length = 0
  const pmtBody = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]), // program_number + 版本/段号 + 段号/末段号
    Buffer.from([pidHi(0), 0x00]), // reserved(3)+PCR_PID(13)
    Buffer.from([0x00, 0x00]), // reserved(4)+program_info_length(12)
    Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0x00, 0x00]), // stream_type/PID/ES_info_length
  ]);
  const pmtSection = Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + pmtBody.length + 4]), pmtBody, Buffer.alloc(4)]);
  const pmt = Buffer.concat([Buffer.from([0x00]), pmtSection]);

  const pkt = (pid, pusi, payload) => {
    const p = Buffer.alloc(188);
    p[0] = 0x47;
    p[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
    p[2] = pid & 0xff;
    p[3] = 0x10; // payload only
    payload.copy(p, 4);
    return p;
  };

  // PSI 段起始包：净荷 = 1 字节 pointer_field + 整个段（段首字节就是 table_id，别多拼一个 0）
  return Buffer.concat([
    pkt(0x0000, true, Buffer.from([0x00, ...patSection])),
    pkt(PMT_PID, true, Buffer.from([0x00, ...pmtSection])),
    pkt(VIDEO_PID, true, pes),
    pkt(VIDEO_PID, false, Buffer.alloc(20, 0x22)),
  ]);
}

console.log('MPEG-TS 结构解析');

const ts1080 = makeTs({ crop: [0, 0, 2, 2] }); // SPS 里是 1088，crop 扣回 1080
{
  const r = tsResolution(ts1080);
  ok('从 PAT/PMT/PES 里读出 1920x1080', r && r.width === 1920 && r.height === 1080, JSON.stringify(r));
}
{
  // PAT 指向一个不存在的 PID（实测的坏源）：不能靠 PAT 走通，得靠全表兜底扫
  const r = tsResolution(makeTs({ crop: [0, 0, 2, 2], brokenPat: true }));
  ok('PAT 里 PMT_PID 写错时全表兜底仍读得出', r && r.width === 1920 && r.height === 1080, JSON.stringify(r));
}
{
  const r = readResolution(makeTs({ width: 848, height: 480 }));
  ok('直连流总入口能读 TS', r && r.width === 848 && r.height === 480, JSON.stringify(r));
}
{
  // 只有 codec 线索、给不出尺寸时不能瞎报
  const r = tsResolution(Buffer.concat([makeTs().subarray(0, 0), Buffer.alloc(188 * 2, 0x07)]));
  ok('全是与视频包无关的字节时返回 null', r === null, JSON.stringify(r));
}
ok('裸 Annex-B 扫描也能读（整段含起始码）', (() => {
  const r = annexbResolution(makeSps({ width: 1280, height: 720 }));
  return r && r.width === 1280 && r.height === 720;
})(), '没带起始码就扫不到 00 00 01');

/* ---------------- 3. 拼一个 MP4 ---------------- */

/** 造 moov>trak>mdia>minf>stbl>stsd>avc1 */
function makeMp4({ width = 1920, height = 1080, type = 'avc1' } = {}) {
  // 每层 box 的类型要各写各的，不能闭包里那个视觉样本项类型（type）
  const mk = (boxType, payload) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8, 0); // box 大小必须真写，不然逐层下钻会错位
    header.write(boxType, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  // 视觉样本项：6 保留 + 2 data_ref + 2 pre_defined + 2 保留 + 12 pre_defined[3]，
  // 宽高在样本项 box 起始 +32（body 里就是 +24，前面还有 8 字节 box 头）
  const sample = Buffer.alloc(8 + 24 + 4, 0);
  sample.writeUInt16BE(width, 24);
  sample.writeUInt16BE(height, 26);
  const avc1 = mk(type, sample);
  const stsdBody = Buffer.concat([Buffer.alloc(8), avc1]); // version/flags + entry_count=1
  const stsd = mk('stsd', stsdBody);
  const stbl = mk('stbl', stsd);
  const minf = mk('minf', stbl);
  const mdia = mk('mdia', minf);
  const trak = mk('trak', mdia);
  const moov = mk('moov', trak);
  // ftyp 声明的大小必须和实际字节数一致，否则 boxes() 逐层下钻会错位
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'latin1');
  return Buffer.concat([ftyp, moov]);
}

console.log('MP4 容器解析');

{
  const r = mp4Resolution(makeMp4());
  ok('从 stsd 视觉样本项读 1920x1080', r && r.width === 1920 && r.height === 1080, JSON.stringify(r));
}
{
  const r = mp4Resolution(makeMp4({ width: 1280, height: 720 }));
  ok('720p', r && r.width === 1280 && r.height === 720, JSON.stringify(r));
}
{
  const r = readResolution(makeMp4({ type: 'hvc1' }));
  ok('hvc1 也能读（HEVC 在容器里走通用样本项）', r && r.width === 1920, JSON.stringify(r));
}
ok('不是视频文件（纯 HTML）时返回 null', readResolution(Buffer.from('<html><body>404</body></html>')) === null);

/* ---------------- 4. HLS 首个分片 URI ---------------- */

console.log('HLS 子清单补分辨率');
{
  const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nsegment0.ts\n#EXT-X-ENDLIST\n';
  ok('提取首个相对分片', firstSegmentUri(text, 'http://a.com/live/index.m3u8') === 'http://a.com/live/segment0.ts', firstSegmentUri(text, 'http://a.com/live/index.m3u8'));
  const abs = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:8\nhttps://b.com/s1.ts\n';
  ok('绝对地址原样返回', firstSegmentUri(abs, 'http://a.com/x.m3u8') === 'https://b.com/s1.ts');
  ok('媒体清单里没有可下行的分片时返回 null', firstSegmentUri('#EXTM3U\n#EXT-X-STREAM-INF:800\n', 'http://a.com/x.m3u8') === null);
}

/* ---------------- 5. 走一遍真探测（假源站） ---------------- */

console.log('探测端到端（本地假源站）');
{
  const ts = makeTs({ width: 1280, height: 720 });
  const s = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(ts);
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/live.ts`, { timeout: 3000 });
  ok('直连流探测判在线', out.ok === true, out.code || out.note);
  ok('直连流也能给出分辨率', out.format.includes('720p'), out.format || '(空)');
  ok('读分辨率的来源说清楚了', /视频流头/.test(out.note), out.note);
  s.close();
}
{
  // HLS 媒体清单（子清单）本身没分辨率 → 拉一个分片才补上
  const ts = makeTs({ width: 1920, height: 1088 });
  const s = http.createServer((q, r) => {
    if (q.url.endsWith('.m3u8')) {
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      r.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg/1.ts\n');
      return;
    }
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(ts);
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/index.m3u8`, { timeout: 3000 });
  ok('子清单探测判在线', out.ok === true, out.code || out.note);
  ok('子清单补出分辨率', out.format.includes('1080p'), out.format || '(空)');
  ok('说明了是读分片流头得到的', /第一个分片流头/.test(out.note), out.note);
  s.close();
}

{
  // 直播小窗口：清单上列出的第一条分片已经滚出窗口（404），重拉一次清单才轮到活的那条。
  // 只试一次分片的话，这种源就永远"在线但没分辨率"，其实能补出来。
  const sps = Buffer.concat([Buffer.from([0, 0, 0, 1]), REAL_SPS]);
  let pulls = 0;
  const s = http.createServer((q, r) => {
    if (q.url.endsWith('.m3u8')) {
      // 每被拉一次，清单就往前滚一格：头一次列已失效的分片，重拉后列活着的
      pulls++;
      const n = pulls <= 1 ? 0 : 1;
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      r.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${n}\n#EXTINF:4.0,\nseg/${n}.ts\n`);
      return;
    }
    if (q.url.includes('seg/0.')) {
      r.writeHead(404, { 'Content-Type': 'text/plain' });
      r.end('not found');
      return;
    }
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(sps); // 裸 Annex-B 流头也能被 readResolution 兜住
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/index.m3u8`, { timeout: 6000 });
  ok('直播首分片已滚出窗口时判在线', out.ok === true, out.code || out.note);
  ok('重拉一轮清单后仍补出了分辨率', out.format.includes('1080p'), out.format || '(空)');
  s.close();
}
{
  // 分片彻底取不到时，note 得说清楚是「分片滚出去了」而不是含糊的「子清单没写分辨率」
  const s = http.createServer((q, r) => {
    if (q.url.endsWith('.ts')) {
      r.writeHead(404, { 'Content-Type': 'text/plain' });
      r.end('not found');
      return;
    }
    r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    r.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\ngone.ts\n');
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/index.m3u8`, { timeout: 6000 });
  ok('分片取不到时说明原因', /分片取不到/.test(out.note), out.note);
  s.close();
}

console.log(failed ? `\n${failed} 项失败（通过 ${pass}）\n` : `\n全部通过（${pass} 项）\n`);
process.exit(failed ? 1 : 0);
