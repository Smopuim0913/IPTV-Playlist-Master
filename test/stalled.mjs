/**
 * 「缝起来的假直播」识别：几段历史切片按顺序塞进一个没有 ENDLIST 的滚动窗口里，
 * 假装成直播。这是继「循环片」（fakelive.mjs 那类引流短片）之后的第二路假源。
 *
 * 起因是实测大湾区卫视那条（SRS 转封装，dwq.m3u8），形态：
 *
 *   主清单：#EXT-X-STREAM-INF:BANDWIDTH=1,AVERAGE-BANDWIDTH=1
 *      └─ 子清单（10 段，无 ENDLIST）：
 *         #EXT-X-MEDIA-SEQUENCE:2017 / #EXT-X-TARGETDURATION:15
 *         #EXT-X-DISCONTINUITY / #EXTINF:10.432 / dwq-2017.ts
 *         #EXT-X-DISCONTINUITY / #EXTINF:8.768 / dwq-2018.ts
 *         #EXT-X-DISCONTINUITY / #EXTINF:1.130 / dwq-2019.ts   ← 零头片
 *         … 10 段共 67 秒，每段之间都断
 *
 * 探测上它挑不出毛病：200 在线、1080p 读得到、延迟正常。可播起来是「几段别的节目接
 * 起来」的拼接感，而且放到最后一片就整个停住 —— 两次间隔 45 秒拉清单，md5 一字未变，
 * 窗口早就不滚了。所以这里既测静态那两条（每段都断 / 时长零碎到没有一片是整段），
 * 也测「隔一会儿重拉清单一模一样」这条复查，并配三组对照别误伤真直播、真回看。
 */
import http from 'node:http';
import { probeUrl, analyzeClipSeams, detectSeamedLive, parseHlsMedia } from '../src/probe.js';
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

/* ---------------- TS 夹具（跟项目里其余测试同一套写法） ---------------- */

const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;
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

/** PAT / PMT / 带 SPS 的视频 PES —— 分辨率就出在这三包里 */
const SEG = Buffer.concat([
  psiPkt(
    0x0000,
    (() => {
      const body = Buffer.concat([
        Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
        Buffer.from([0x00, 0x01]),
        Buffer.from([pidHi(PMT_PID), PMT_PID & 0xff]),
      ]);
      return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
    })(),
  ),
  psiPkt(
    PMT_PID,
    (() => {
      const body = Buffer.concat([
        Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
        Buffer.from([pidHi(0), 0x00]),
        Buffer.from([0x00, 0x00]),
        Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0x00, 0x00]),
      ]);
      return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
    })(),
  ),
  pkt(
    VIDEO_PID,
    true,
    (() => {
      // 1088 才对：SPS 里那 8 行会被 crop 标记裁掉，显示出来是 1080
      const sps = makeSps({ width: 1920, height: 1088 });
      const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), sps]);
      const header = Buffer.from([0x80, 0xc0, 0x00]);
      const len = header.length + payload.length;
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]),
        header,
        payload,
      ]);
    })(),
  ),
]);

/* ---------------- 清单夹具 ---------------- */

/**
 * dwq 那条原样复刻：10 段零碎时长、每段一条 DISCONTINUITY、无 ENDLIST。
 * frozen=true 时两次拉到的是同一份（源站压根不再更新）；
 * frozen=false 时每次都往前滚一段（真直播那样）。
 */
const dwqMedia = (frozen, round = 0) => {
  const durs = [10.432, 8.768, 1.13, 4.202, 1.685, 10.09, 10.664, 10.523, 8.349, 1.28];
  const rows = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:2017', '#EXT-X-TARGETDURATION:15'];
  const from = frozen ? 0 : round; // 滚动时按次数往前挪
  for (let i = from; i < durs.length; i++) {
    rows.push('#EXT-X-DISCONTINUITY', `#EXTINF:${durs[i]}, no desc`, `dwq-${2017 + i}.ts`);
  }
  return rows.join('\n') + '\n';
};

/** 真直播：切片时长贴着目标值、没有多余断点 */
const liveMedia = (round = 0) => {
  const rows = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:100 + round', '#EXT-X-TARGETDURATION:10'];
  for (let i = 0; i < 10; i++) rows.push(`#EXTINF:10.000,`, `seg_${1730000000 + round}.ts`);
  return rows.join('\n').replace('#EXT-X-MEDIA-SEQUENCE:100 + round', `#EXT-X-MEDIA-SEQUENCE:${100 + round}`) + '\n';
};

/** 点播长片：同样每段都断，但封了口 —— 那是回看，不该被当成假直播 */
const vodMedia = () => {
  const rows = ['#EXTM3U', '#EXT-X-TARGETDURATION:15'];
  for (let i = 0; i < 20; i++) {
    rows.push('#EXT-X-DISCONTINUITY', `#EXTINF:${i % 4 ? 9.5 : 2.1},`, `ch${String(i).padStart(3, '0')}.ts`);
  }
  rows.push('#EXT-X-ENDLIST', '');
  return rows.join('\n');
};

const masterSingle = (child) =>
  ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,AVERAGE-BANDWIDTH=1', child, ''].join('\n');

/* ---------------- 假源站 ---------------- */

let rollingRound = 0; // 滚动窗口算到第几轮
const sends = new Map(); // 冻结源每份清单只发一次，验证「两次确实一模一样」

const srv = http.createServer((req, res) => {
  const ct = { 'content-type': 'application/vnd.apple.mpegurl' };
  const ts = { 'content-type': 'video/mp2t' };

  /* ① 复刻 dwq：单档 master（不写 RESOLUTION → 会下钻）+ 冻结窗口 + 每段都断 */
  if (req.url.startsWith('/seam.m3u8')) {
    res.writeHead(200, ct);
    res.end(masterSingle('/seam/dwq.m3u8?hls_ctx=abc'));
    return;
  }
  if (req.url.startsWith('/seam/dwq.m3u8')) {
    res.writeHead(200, ct);
    if (sends.has('seam')) return res.end(sends.get('seam')); // 第二次拿的是同一份
    sends.set('seam', dwqMedia(true, 0));
    return res.end(sends.get('seam'));
  }
  if (req.url.startsWith('/seam/dwq-')) {
    res.writeHead(200, ts);
    res.end(SEG);
    return;
  }

  /* ② 真直播：切片时长均匀、窗口每次都在往前滚 */
  if (req.url.startsWith('/live.m3u8')) {
    res.writeHead(200, ct);
    res.end(masterSingle('/live/dwq.m3u8'));
    return;
  }
  if (req.url.startsWith('/live/dwq.m3u8')) {
    res.writeHead(200, ct);
    res.end(liveMedia(rollingRound++));
    return;
  }
  if (req.url.startsWith('/live/dwq-')) {
    res.writeHead(200, ts);
    res.end(SEG);
    return;
  }

  /* ③ 滚动窗口但时长零碎：静态证据成立，可窗口在动 —— 那就不该说是「停更卡死」 */
  if (req.url.startsWith('/ragged.m3u8')) {
    res.writeHead(200, ct);
    res.end(masterSingle('/ragged/dwq.m3u8'));
    return;
  }
  if (req.url.startsWith('/ragged/dwq.m3u8')) {
    res.writeHead(200, ct);
    res.end(dwqMedia(false, rollingRound++)); // 每次往前挪一段
    return;
  }
  if (req.url.startsWith('/ragged/dwq-')) {
    res.writeHead(200, ts);
    res.end(SEG);
    return;
  }

  /* ④ 点播长片：每段都断、时长也参差，但封了口 */
  if (req.url.startsWith('/vod.m3u8')) {
    res.writeHead(200, ct);
    res.end(masterSingle('/vod/pl.m3u8'));
    return;
  }
  if (req.url.startsWith('/vod/pl.m3u8')) {
    res.writeHead(200, ct);
    res.end(vodMedia());
    return;
  }
  if (req.url.startsWith('/vod/ch')) {
    res.writeHead(200, ts);
    res.end(SEG);
    return;
  }

  res.writeHead(404);
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

try {
  /* ---------- ① 缝起来的假直播（dwq 那条原样复刻） ---------- */
  const seam = await probeUrl(`${base}/seam.m3u8`, { timeout: 15000, probeBytes: 65536 });

  ok('这条能探到（不是连不上）', seam.ok && seam.status === 200, `${seam.status}`);
  // 前提先立住：它在旧结论里是「完美在线」，分辨率也读得到 —— 所以旧逻辑认不出来
  ok('1080p 读得到（旧结论就是个在线）', /1080/.test(seam.format || ''), seam.format || '(空)');
  ok('没有分辨率归因', !seam.noRes, seam.noRes);
  ok('没被判成失败', seam.ok === true);

  ok('被认成拼接的假直播', seam.seamLive === true);
  ok('静态证据成立（每段都断/时长零碎）', seam.clipSeams === true);
  ok('窗口复查确认没在滚动', seam.windowFrozen === true);
  ok('跟循环片那一路不混（fakeLive 仍为 false）', seam.fakeLive === false);
  ok('note 点出了每一段都断', /每一段都写了 #EXT-X-DISCONTINUITY/.test(seam.note || ''), seam.note || '(空)');
  ok('note 点出了没有一片是整段', /没有一片是整段/.test(seam.note || ''), seam.note || '(空)');
  ok('note 带上了源站声明的目标时长 15 秒', /目标时长 15 秒/.test(seam.note || ''), seam.note || '(空)');
  ok('note 坐实「放到最后一片就卡死」', /放到最后一片就再没下一片/.test(seam.note || ''), seam.note || '(空)');
  ok('note 写清了停在 dwq-2017…dwq-2026', /dwq-2017\.ts…dwq-2026\.ts/.test(seam.note || ''), seam.note || '(空)');
  ok('seamLiveWhy 与 note 结尾说的是同一句', !!seam.seamLiveWhy && seam.note.endsWith(seam.seamLiveWhy));

  /* ---------- ② 真直播不能被误伤 ---------- */
  const live = await probeUrl(`${base}/live.m3u8`, { timeout: 15000, probeBytes: 65536 });
  ok('真直播不被判成拼接假直播', live.seamLive === false, live.seamLiveWhy || '');
  ok('真直播压根没触发静态证据', live.clipSeams === false);
  ok('真直播的 note 里不出现「缝起来」', !/缝起来/.test(live.note || ''), live.note || '(空)');

  /* ---------- ③ 窗口还在滚但内容零碎：只报拼接，不谎称卡死 ---------- */
  const ragged = await probeUrl(`${base}/ragged.m3u8`, { timeout: 15000, probeBytes: 65536 });
  ok('零碎时长照样认出静态证据', ragged.clipSeams === true);
  ok('内容是缝的 → 照样是拼接假直播', ragged.seamLive === true);
  // 但「拼接」判的是内容形态，跟源还活不活是两码事：窗口在滚就不该说「放完卡死」
  ok('窗口在滚就不说「停住」', ragged.windowFrozen === false);
  ok('但 be honest：note 里说了窗口还在滚', /窗口还在滚/.test(ragged.note || ''), ragged.note || '(空)');
  ok('也不编「放到最后一片就卡死」这句', !/放到最后一片/.test(ragged.note || ''), ragged.note || '(空)');

  /* ---------- ④ 封口的点播（回看）不能被当成假直播 ---------- */
  const vod = await probeUrl(`${base}/vod.m3u8`, { timeout: 15000, probeBytes: 65536 });
  ok('每段都断的回看片不判假直播（有 ENDLIST）', vod.seamLive === false, vod.seamLiveWhy || '');
  ok('回看那条 note 干净', !/缝起来/.test(vod.note || ''), vod.note || '(空)');

  /* ---------- ⑤ 判据本身（纯函数） ---------- */
  const ev = analyzeClipSeams(dwqMedia(true, 0));
  ok('analyzeClipSeams 认得出「每段都断」', ev.seamed === true);
  ok('analyzeClipSeams 认得出「时长零碎」', ev.ragged === true);
  ok('analyzeClipSeams 给出 min/max', Math.abs(ev.minDur - 1.13) < 1e-6 && Math.abs(ev.maxDur - 10.664) < 1e-6);
  ok('analyzeClipSeams 数得对断点数（10 处）', ev.discont === 10, String(ev.discont));

  const evLive = analyzeClipSeams(liveMedia(0));
  ok('真直播的时长均匀 → 不算拼接', evLive.suspicious === false);
  ok('真直播没有多余断点 → 不算拼接', evLive.seamed === false);

  // 只有零头、没有「每段都断」的：不够硬，得再配一条
  const onlyRagged = analyzeClipSeams(
    ['#EXTM3U', '#EXT-X-TARGETDURATION:10', ...Array.from({ length: 6 }, (_, i) => `#EXTINF:10.0,\ns${i}.ts`), '#EXTINF:1.1,\ns6.ts'].join('\n'),
  );
  ok('单凭一片零头不敢下结论（还需「每段都断」）', onlyRagged.ragged === true && onlyRagged.seamed === false);

  // 段太少说不清
  ok(
    '只给两片不判（样本太少）',
    analyzeClipSeams('#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n').suspicious === false,
  );
  // 断点偶发（真直播换编码参数那样）不该一棍子打死
  ok(
    '偶发一两个断点不算「每段都断」',
    analyzeClipSeams(
      ['#EXTM3U', ...Array.from({ length: 8 }, (_, i) => `#EXTINF:${10 + (i % 3) * 0.1},\ns${i}.ts`)].join('\n').replace(
        '#EXTINF:10.0,',
        '#EXT-X-DISCONTINUITY\n#EXTINF:10.0,',
      ) + '\n',
    ).seamed === false,
  );

  /* ---------- ⑥ 窗口复查的语义 ---------- */
  const f1 = detectSeamedLive(dwqMedia(true, 0), dwqMedia(true, 0));
  ok('隔一会儿拉来同一份 → 窗口已停（frozen）', f1.frozen === true && f1.yes === true);
  ok('frozen 的文案里点出「窗口已经停住」', /窗口已经停住/.test(f1.why || ''), f1.why);

  const f2 = detectSeamedLive(dwqMedia(false, 0), dwqMedia(false, 3));
  ok('拉来的是新的一份 → 窗口还在滚', f2.frozen === false);
  ok('窗口在滚也仍是「缝的」', f2.yes === true);
  ok('窗口在滚就不硬说「卡死」', !/窗口已经停住/.test(f2.why || ''), f2.why);

  const f3 = detectSeamedLive(dwqMedia(true, 0), null);
  ok('复查没拉到时不谎称停更', f3.frozen === false && f3.yes === true);
  ok('复查没拉到就不说窗口停住', !/窗口已经停住/.test(f3.why || ''), f3.why);
  ok('但静态那部分照样说清是缝的', /缝起来的/.test(f3.why || ''), f3.why);

  const f4 = detectSeamedLive(vodMedia(), vodMedia());
  ok('封口的清单不进这套判据', f4.yes === false && parseHlsMedia(vodMedia()).endlist === true);
} finally {
  srv.close();
}

console.log(`\n${failed ? '有失败项' : '全部通过'}：${pass} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
