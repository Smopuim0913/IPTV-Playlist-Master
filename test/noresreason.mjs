/**
 * 「分辨率读不到」得先说清是**为什么**没读到，再决定要不要给「再挖一次」的入口。
 *
 * 起因：之前所有读不到分辨率的条目长得一模一样（一个光秃秃的「—」），
 * 用户分不清是「这条流没救了」还是「探测窗口不够大」。现在探测会给出原因码：
 *
 *   audio-only  纯音频台，只有音频轨 —— 挖多深都不可能有分辨率，重挖是白烧流量
 *   long-gop    视频轨在，只是关键帧（SPS）没落在探测窗口里 —— **唯一值得重挖的一类**
 *   seg-fail    分片根本没取到（直播窗口已滚走 / 源站闪了一下）—— 换个时刻重挖可能就命中
 *   m3u-note    源站清单里压根没写 —— 物理上没有这个信息
 *   no-video    PMT 拆得出来，可里头一条 elementary stream 都没有 —— 流描述里真没视频
 *   no-psi      这一窗压根没带 PAT/PMT（实测某 IPTV 直播源分片开头 128KB 只有音视频包，
 *               表全在 1MB 之后）—— 是「看得不够远」，不是「没视频」，加大窗口就是解药
 *   no-pmt / no-data   结构认不出 / 一个字节都没收到
 *
 * long-gop、seg-fail、no-psi 属于「值得重试」（probe.js 导出的 RES_RETRYABLE），
 * 界面据此只给这类条目挂 ⟳ 按钮。这里起几个假源站，把每一种原因都摆一遍。
 *
 * TS 夹具的段内偏移沿用项目里已验证的那套（见 resolution.mjs 的说明）：
 * PMT +8..9 是 reserved(3)+PCR_PID、+10..11 是 reserved(4)+program_info_length、
 * +12 起才是各条 stream。早先把夹具写「规范」了反而测不出真机的行为。
 */
import http from 'node:http';
import { probeUrl, RES_RETRYABLE, NO_RES_TEXT } from '../src/probe.js';
import { analyzeStream } from '../src/resolution.js';
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

/* ---------------- TS 夹具 ---------------- */

const PMT_PID = 0x0100;
const VIDEO_PID = 0x0101;
const AUDIO_PID = 0x0200;
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

const patSection = (pmtPid = PMT_PID) => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(pmtPid), pmtPid & 0xff]),
  ]);
  return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};

/** @param {Array<[number, number]>} streams [stream_type, elementary_pid] */
const pmtSection = (streams) => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(0), 0x00]), // reserved(3)+PCR_PID
    Buffer.from([0x00, 0x00]), // reserved(4)+program_info_length = 0
    ...streams.map(([st, pid]) => Buffer.from([st, pidHi(pid), pid & 0xff, 0x00, 0x00])),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};

/** 一路 MPEG-1/2 音频（stream_type 0x03）、一路 AC-3（0x0f），没有视频轨 */
const audioTs = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection([[0x03, AUDIO_PID], [0x0f, AUDIO_PID + 1]])),
  pkt(AUDIO_PID, true, Buffer.alloc(64, 0x21)),
]);

/** 一个没有 SPS 的视频 PES（只有 SEI + 切片） */
const pesWithoutSps = () => {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), Buffer.from([0x09, 0x10, 0x00, 0x01])]);
  const header = Buffer.from([0x80, 0xc0, 0x03]); // PES_header_data_length = 3
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
};

/** 视频轨在、SPS 不在窗口里的 TS */
const longGopTs = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection([[0x1b, VIDEO_PID]])),
  pkt(VIDEO_PID, true, pesWithoutSps()),
  pkt(VIDEO_PID, false, Buffer.alloc(20, 0x22)),
]);

/* ---------------- fMP4 夹具 ---------------- */

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 4, 'latin1');
  return Buffer.concat([head, body]);
};

/** avcC 体：configurationVersion/profile/compat/level/lengthSizeMinusOne/SPS 个数 + 一整个 SPS NAL */
const avcCBox = (sps) => {
  const body = Buffer.alloc(6 + 2 + sps.length);
  body[0] = 0x01; // configurationVersion
  body[1] = 0x42; // profile_idc
  body[2] = 0x00; // compatibility
  body[3] = 0x1e; // level_idc
  body[4] = 0xff; // lengthSizeMinusOne = 3、后面 5 位保留
  body[5] = 0xe1; // 高 3 位保留 + 低 5 位 = 1 个 SPS
  body.writeUInt16BE(sps.length, 6);
  sps.copy(body, 8);
  return box('avcC', body);
};

/** 一整个 fMP4 init 段：avc3 样本项被拆薄（里面没有宽高），分辨率只能去 avcC 里拿 */
const initSegment = () => {
  // makeSps 造的是带 Annex-B 起始码的 NAL，avcC 里存的是剥掉起始码的裸 NAL
  const sps = makeSps({ width: 1920, height: 1088, crop: [0, 0, 2, 2] }).subarray(4);
  const stsd = box('stsd', Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 1]), box('avc3', Buffer.alloc(8), avcCBox(sps)));
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', mdia);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1', 'latin1')),
    box('moov', trak),
  ]);
};

console.log('无分辨率的归因');

/* ---------------- 1. 纯音频台：该判 audio-only，且不给重挖 ---------------- */
{
  const a = analyzeStream(audioTs);
  ok('纯音频 TS：analyzeStream 给出 audio-only', a.reason === 'audio-only', a.reason);
  ok('纯音频 TS：没有分辨率', !a.res, JSON.stringify(a.res));

  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(audioTs);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/audio.ts`, { timeout: 4000 });
  srv.close();

  ok('直连音频流：判在线', p.ok === true, p.code || '');
  ok('直连音频流：分辨率空着', !p.format, p.format || '(空)');
  ok('归因是 audio-only（不是 long-gop / no-video）', p.noRes === 'audio-only', p.noRes);
  ok('说明文字讲清了「只有音频、再挖也没有」', /只有音频/.test(p.noResText || ''), p.noResText);
  ok('纯音频不值得重挖（不在可重挖名单里）', !RES_RETRYABLE.has(p.noRes), [...RES_RETRYABLE].join(','));
}

/* ---------------- 2. 长 GOP：视频轨在、关键帧没盖到，这一类才给重挖 ---------------- */
{
  const a = analyzeStream(longGopTs);
  ok('长 GOP TS：analyzeStream 给出 long-gop', a.reason === 'long-gop', a.reason);

  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(longGopTs);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/gop.ts`, { timeout: 4000 });
  srv.close();

  ok('直连长 GOP：判在线', p.ok === true, p.code || '');
  ok('直连长 GOP：归因是 long-gop', p.noRes === 'long-gop', p.noRes);
  ok('说明文字指向关键帧 / SPS 没盖到', /关键帧|SPS/.test(p.noResText || ''), p.noResText);
  ok('关键帧太远属于可重挖（界面要给 ⟳）', RES_RETRYABLE.has(p.noRes), [...RES_RETRYABLE].join(','));
  ok('长 GOP 不会被说成纯音频', !/只有音频/.test(p.noResText || ''), p.noResText);
}

/* ---------------- 3. HLS 子清单指到音频分片：同样得判纯音频 ---------------- */
{
  const play = (kind) =>
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg.ts?kind=${kind}\n#EXT-X-ENDLIST\n`;
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/sub')) {
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      r.end(play(q.url.includes('gop') ? 'gop' : 'audio'));
      return;
    }
    r.writeHead(200, { 'Content-Type': 'video/mp2t' });
    r.end(q.url.includes('kind=audio') ? audioTs : longGopTs);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/sub.m3u8`, { timeout: 5000 });
  const p2 = await probeUrl(`${base}/subgop.m3u8`, { timeout: 5000 });
  srv.close();

  ok('子清单 + 音频分片：判在线', p.ok === true, p.code || '');
  ok('子清单 + 音频分片：归因 audio-only', p.noRes === 'audio-only', p.noRes);
  ok('子清单 + 音频分片：不给重挖入口', !RES_RETRYABLE.has(p.noRes));
  ok('子清单里也不该把它说成关键帧太远', !/关键帧/.test(p.noResText || ''), p.noResText);
  ok('子清单 + 长 GOP 分片：归因 long-gop', p2.noRes === 'long-gop', p2.noRes);
}

/* ---------------- 4. 分片取不到：换个时刻重挖可能就命中 ---------------- */
{
  const SUB = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\ngone.ts\n#EXT-X-ENDLIST\n`;
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/sub')) {
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      r.end(SUB);
      return;
    }
    r.writeHead(404);
    r.end();
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/sub.m3u8`, { timeout: 5000 });
  srv.close();

  ok('分片 404：判在线（清单还活着）', p.ok === true, p.code || '');
  ok('分片 404：归因 seg-fail', p.noRes === 'seg-fail', p.noRes);
  ok('分片取不到说明换了时刻可能命中', /重挖|换个时刻|命中/.test(p.noResText || ''), p.noResText);
  ok('seg-fail 属于可重挖（界面要给 ⟳）', RES_RETRYABLE.has(p.noRes), [...RES_RETRYABLE].join(','));
}

/* ---------------- 5. 源站清单没写分辨率：物理上就没有，别让用户白挖 ---------------- */
{
  const MASTER = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=2200000\nv0.m3u8\n`;
  const EMPTY = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n`;
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/master')) {
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      r.end(MASTER);
    } else {
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      r.end(EMPTY);
    }
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/master.m3u8`, { timeout: 5000 });
  srv.close();

  ok('没标 RESOLUTION 的主清单：分辨率空着', !p.format, p.format || '(空)');
  ok('没标 RESOLUTION 的主清单：归因 m3u-note', p.noRes === 'm3u-note', p.noRes);
  ok('要说清「重挖也没用」', /重挖也没用|压根没写/.test(p.noResText || ''), p.noResText);
  ok('源站没写不属于可重挖（界面不给 ⟳）', !RES_RETRYABLE.has(p.noRes), [...RES_RETRYABLE].join(','));
}

/* ---------------- 6. fMP4 的 avcC 能补出分辨率，且不该报「没读到」 ---------------- */
{
  const init = initSegment();
  const a = analyzeStream(init);
  ok('fMP4 init 段：从 avcC 里读出 1920x1080', a.res && a.res.width === 1920 && a.res.height === 1080,
     a.res ? `${a.res.width}x${a.res.height}` : '(空)');
  ok('fMP4 init 段：归因是空串（读到了）', a.reason === '', a.reason);

  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp4' });
    r.end(init);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/init.mp4`, { timeout: 4000 });
  srv.close();

  ok('fMP4 直连流：探测拿到分辨率', (p.format || '').includes('1080'), p.format || '(空)');
  ok('fMP4 直连流：noRes 是空串', p.noRes === '', p.noRes);
}

/* ---------------- 7. 一个字节都没收到：归到 no-data，同样不重挖 ---------------- */
{
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Length': '0', 'Content-Type': 'video/mp2t' });
    r.end();
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/empty.ts`, { timeout: 4000 });
  srv.close();

  ok('空响应：归因 no-data', p.noRes === 'no-data', p.noRes);
  ok('空响应不属于可重挖', !RES_RETRYABLE.has(p.noRes), [...RES_RETRYABLE].join(','));
}

/* ---------------- 7.5 纯电台直连流：别因为音频字节里凑巧撞上起始码就说它「有视频轨」 ---------------- */
{
  // 真实例子：一张表里几十条 mp3/aac 电台直连流，Annex-B 兜底扫描偶尔能从音频数据里
  // 撞出「00 00 01 + 切片头」，于是报 long-gop —— 界面上就给一个 ⟳，
  // 用户点下去是 4MB 的白挖。源站自己声明送的是 audio/*，这种结论就不可信。
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audioTs.length) });
    r.end(audioTs);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = await probeUrl(`${base}/radio.mp3`, { timeout: 4000 });
  srv.close();

  ok('声明是 audio/mpeg 的直连流：判在线', p.ok === true, p.code || '');
  ok('纯电台直连流：归 audio-only，不是 long-gop', p.noRes === 'audio-only', p.noRes);
  ok('纯电台直连流：不给重挖入口（挖 4MB 也是挖音频）', !RES_RETRYABLE.has(p.noRes), p.noRes);
}

/* ---------------- 7.6 纯音频的三种自证：别只认 content-type ---------------- */
{
  /** 起一个只按给定头回应的假源站，跑一条直连流 */
  async function probeWith(path, headers, body) {
    const srv = http.createServer((q, r) => {
      r.writeHead(200, { 'Content-Length': String(body.length), ...headers });
      r.end(body);
    });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const port = srv.address().port;
    try {
      return await probeUrl(`http://127.0.0.1:${port}${path}`, { timeout: 4000 });
    } finally {
      srv.close();
    }
  }

  // 真实例子：很多电台源站不声明 audio/*，只给 icy 电台元数据头（URL 也不带后缀）——
  // 早先只在 analyzeStream 回 long-gop 时才降级，于是这类源界面上挂的是「?」，
  // 点开一句「码流结构认不出来」，看不出「这是电台、不用挖」。
  const p1 = await probeWith('/live/stream', { 'icy-name': 'Radio', 'icy-br': '128' }, audioTs);
  ok('只有 icy 电台头的（没声明 audio/*、URL 也没后缀）：照样判 audio-only',
     p1.noRes === 'audio-only', p1.noRes);

  // 真实例子：.mp3 后缀的电台，源站回 application/octet-stream 之类含糊的 ct
  const p2 = await probeWith('/radio.mp3', { 'Content-Type': 'application/octet-stream' }, audioTs);
  ok('URL 是 .mp3 的电台（ct 含糊）：判 audio-only',
     p2.noRes === 'audio-only', p2.noRes);

  // 反向：真视频流不能被误伤
  const vid = makeSps({ width: 1920, height: 1080 });
  const p3 = await probeWith('/v.mp2t', { 'Content-Type': 'video/mp2t' }, vid);
  ok('ct 是视频、后缀是视频容器的：分辨率照读，不被纯音频规则误伤',
     /1072|1080/.test(p3.format || '') && p3.noRes === '', `${p3.format || '(空)'}/${p3.noRes}`);

  // 真实例子：音频字节里瞎撞出一套「SPS」，界面上就在电台那栏偶尔冒出个 1920x1080。
  // 源站自证是音频，这种宽高不能采信（样本随机，时有时无）。
  const p4 = await probeWith('/faux.mp3', { 'Content-Type': 'audio/mpeg' }, vid);
  ok('声明 audio/* 却扫出宽高：不采信，不显示分辨率',
     !p4.format && p4.noRes === 'audio-only', `${p4.format || '(空)'}/${p4.noRes}`);
  ok('不采信时要在 note 里说清是巧合', /不采信|巧合/.test(p4.note || ''), p4.note);
}

/* ---------------- 8. 可重挖名单就那几类，别到处乱加 ---------------- */
{
  const all = ['audio-only', 'no-video', 'no-psi', 'no-pmt', 'long-gop', 'seg-fail', 'm3u-note', 'no-data'];
  const retriable = all.filter((k) => RES_RETRYABLE.has(k)).sort();
  // 三类可重挖：long-gop（缺关键帧）、seg-fail（没取到分片）、
  // no-psi（这一窗没带节目信息表，往深读才碰得上）。其余一律不给按钮。
  ok('可重挖就 long-gop / seg-fail / no-psi 三类', retriable.join(',') === 'long-gop,no-psi,seg-fail', retriable.join(','));
  const empty = analyzeStream(Buffer.alloc(0));
  ok('空输入归到 no-data', empty.reason === 'no-data', empty.reason);
}

/* ---------------- 8b. 「没扫到 PAT/PMT」不能报成「没视频轨」 ----------------
 * 实测 112.123.243.37 那条 txiptv 直播：分片开头 128KB 里只有 PID 4113/4352/8191，
 * PAT/PMT/SDT 一个都不发，全在 1MB 之后。首窗拿它去判，早先一律报 no-video
 * （「源站的流描述里就没有视频」）—— 一段 1920x1080 就那么被判了死刑，
 * 还因为不可重挖连 ⟳ 都不给，分辨率和流内服务名一起丢。
 */
{
  const { tsServiceName } = await import('../src/resolution.js');
  const SDT_PID = 0x0011;
  // SDT 段：table_id(0x42) + 段长 + [tsid2 | ver/section3 | onid2 | seg2 | service…]
  const sdtSection = (name) => {
    const nm = Buffer.from(name, 'utf8');
    const body = Buffer.concat([Buffer.from([0x01, 0x00, nm.length]), nm]); // service_type / provider_len=0 / name_len / name
    const desc = Buffer.concat([Buffer.from([0x48, body.length]), body]);
    const service = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from([0x00, desc.length]), desc]);
    const rest = Buffer.concat([
      Buffer.from([0x00, 0x01]), // transport_stream_id
      Buffer.from([0xc0, 0x00, 0x00]), // version / section_number / last_section_number
      Buffer.from([0x00, 0x01]), // original_network_id
      Buffer.from([0xff, 0x00]), // segment last section / sub section
      service,
    ]);
    return Buffer.concat([Buffer.from([0x42, 0xb0, rest.length + 4]), rest, Buffer.alloc(4)]);
  };
  const pesOf = (spsNal) => {
    const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), spsNal]);
    const header = Buffer.from([0x80, 0xc0, 0x00]);
    const len = header.length + payload.length;
    return Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]),
      header,
      payload,
    ]);
  };
  // 700 个空壳包 ×188 = 131,600 字节：比 128KB 的首窗口还长，PAT/PMT/SDT 全落在窗口外。
  // 每个包必须正好 188 字节 —— 少一个字节拼接处就整体错位，TS 是按 188 对齐跳着走的，
  // 错位之后后面所有表都读不到（这事只在夹具上发生，真流不会）。
  const shell = () => {
    const p = Buffer.alloc(188);
    p[0] = 0x47;
    p[1] = 0x70; // PID 4113 + PUSI（跟实测那条源一个 PID）
    p[2] = 0x11;
    p[3] = 0x10; // payload only
    p.fill(0x7f, 4);
    return p;
  };
  const head = Buffer.concat(Array.from({ length: 700 }, shell));
  const tail = Buffer.concat([
    psiPkt(0x0000, patSection()),
    psiPkt(PMT_PID, pmtSection([[0x1b, VIDEO_PID]])),
    psiPkt(SDT_PID, sdtSection('dftvHD')),
    pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1920, height: 1088 }))),
  ]);
  const late = Buffer.concat([head, tail]);
  ok('夹具确实造出来了（前 128KB 没有表）', head.length > 131072 && !tsServiceName(head.subarray(0, 131072)));

  const first = analyzeStream(late.subarray(0, 131072));
  ok('首窗口扫不出视频轨时报 no-psi，不是 no-video', first.reason === 'no-psi', first.reason);
  ok('no-psi 的时候别说成「源站流描述里没有视频」', !/没视频|没视频轨/.test(NO_RES_TEXT[first.reason] || ''), NO_RES_TEXT[first.reason]);
  ok('no-psi 给了能挖的出口（在可重挖名单里）', RES_RETRYABLE.has(first.reason), first.reason);

  const whole = analyzeStream(late);
  ok('整段喂进去就能读出分辨率（证明表是真在后面，不是没有）', whole.reason === '' && !!whole.res, JSON.stringify(whole));
  ok('整段能读出流内服务名 dftvHD', tsServiceName(late) === 'dftvHD', tsServiceName(late));
}

console.log(failed ? `\n[无分辨率归因] ${failed} 项失败（通过 ${pass}）` : `\n[无分辨率归因] 全部通过（${pass} 项）`);
process.exit(failed ? 1 : 0);
