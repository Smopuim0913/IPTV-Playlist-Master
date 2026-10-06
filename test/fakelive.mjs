/**
 * 「伪直播」识别：一条被当成直播源加进列表的地址，其实是一段录好的循环片。
 *
 * 起因是实测这种引流源（epg.pw 转链的那一类）：点开是带二维码的 IPTV APP 广告页，
 * 一会儿就循环回去。抓下来看，形态非常规整：
 *
 *   主清单（单档变体）：#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
 *      └─ playlist.m3u8：
 *         #EXT-X-MEDIA-SEQUENCE:0 / #EXT-X-TARGETDURATION:6
 *         #EXTINF:5.021333 → output000.ts … #EXTINF:3.360000 → output023.ts
 *         #EXT-X-ENDLIST
 *         Last-Modified: Mon, 22 May 2023   （三年没动过，分片 output000.ts 目录里
 *         躺着的还是老文件，Content-Type 却老老实实写着 video/mp2t）
 *
 * 换句话说：24 段 × ~5 秒 = **01:58**，一个字都不带滚动的，还盖了 ENDLIST 封口。
 * 而它在现有那套归因里一条都不命中 —— 能连上、能播、分辨率也读得到（1080p），
 * 表格上就是个完美的「200 在线 · 1080p」。得播满两分钟才会发现永远是同一张脸。
 *
 * 所以这里手工拼三份清单跑到真的 probeUrl 上：一份是上面的循环片，
 * 一份是真直播（无 ENDLIST、分片名带时间戳），一份是超过 10 分钟的真点播。
 */
import http from 'node:http';
import { probeUrl, detectStaticClip, parseHlsMedia, segNameShape } from '../src/probe.js';

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

/** 一段够格当 TS 分片的字节（真正读不读得到分辨率另说，这里只看清单行为） */
const TS = Buffer.concat([Buffer.from([0x47, 0x40, 0x11, 0x10]), Buffer.alloc(184)]);

/** 24 段 output000.ts … output023.ts，总时长 118.381333 秒（= 01:58） */
const clipMedia = (segCount = 24, perSec = 5) => {
  const rows = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-TARGETDURATION:6'];
  for (let i = 0; i < segCount; i++) {
    // 第一段和最后一段故意不像 5 整秒（真切片就是这德行，首尾会被裁）
    rows.push(`#EXTINF:${i === 0 ? 5.021333 : i === segCount - 1 ? 3.36 : perSec.toFixed(6)},`);
    rows.push(`output${String(i).padStart(3, '0')}.ts`);
  }
  rows.push('#EXT-X-ENDLIST', '');
  return rows.join('\n');
};

const STALE = { 'last-modified': 'Mon, 22 May 2023 13:32:57 GMT', etag: '"646b6f09-357"' };
const FRESH = { 'last-modified': new Date().toUTCString() };

const srv = http.createServer((req, res) => {
  // ① 引流循环片：单档 master 写着 RESOLUTION，子清单是封口的老片子
  if (req.url === '/clip.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(
      ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080', '/nosignal_h264/playlist.m3u8', ''].join(
        '\n',
      ),
    );
    return;
  }
  if (req.url.startsWith('/nosignal_h264/playlist.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', ...STALE });
    res.end(clipMedia());
    return;
  }
  if (req.url.startsWith('/nosignal_h264/output')) {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end(TS);
    return;
  }
  // ② 真直播：无 ENDLIST、分片名带时间戳、源站声明是刚更新的
  if (req.url === '/live.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000',
        '/live/3000/playlist.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1200000',
        '/live/1200/playlist.m3u8',
        '',
      ].join('\n'),
    );
    return;
  }
  if (req.url.startsWith('/live/')) {
    const stamp = req.url.startsWith('/live/3000') ? 'seg_1730046800.ts' : 'seg_1730046801.ts';
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', ...FRESH });
    res.end(
      ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=3000000', stamp, '#EXT-X-ENDLIST', ''].join('\n'),
    );
    return;
  }
  // ③ 真点播/回看：同样封口、同样写死的名字，可是 24 分钟长 —— 不该被当成引流片
  if (req.url === '/movie.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080', '/movie/pl.m3u8', ''].join('\n'));
    return;
  }
  if (req.url.startsWith('/movie/pl.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', ...STALE });
    res.end(clipMedia(24, 60)); // 24 × 60 = 1440 秒
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

try {
  /* ---------- ① 引流循环片 ---------- */
  const clip = await probeUrl(`${base}/clip.m3u8`, { timeout: 8000, probeBytes: 65536 });

  ok('循环片这条能探到（不是连不上）', clip.ok && clip.status === 200, `${clip.status}`);
  // 前提先立住：它长得太规矩了 —— 分辨率也读得到，现有归因一条都不该命中
  ok('它 1080p 读得到（所以旧逻辑认不出来）', /1080/.test(clip.format || ''), clip.format || '(空)');
  ok('旧逻辑认不出：没有 noRes 归因', !clip.noRes, clip.noRes);
  ok('旧逻辑认不出：也没被判成失败', clip.ok === true);

  ok('被认成伪直播（循环片）', clip.fakeLive === true);
  ok('总时长抓到了（118 秒上下）', Math.abs((clip.clipSec || 0) - 118.38) < 0.5, String(clip.clipSec));
  ok('分片数抓到了（24 段）', clip.clipSegs === 24, String(clip.clipSegs));
  // 关键：单档 master 带着 RESOLUTION，走的正是「补拉一次子清单」那条路
  ok('note 里点出了时长 01:58', /共 01:58/.test(clip.note || ''), clip.note || '(空)');
  ok('note 里点出了 ENDLIST 封口', /#EXT-X-ENDLIST/.test(clip.note || ''));
  ok('note 里点出了分片名写死到 23 号', /分片名 0 号写死到 23 号/.test(clip.note || ''));
  ok('note 里引用了源站的旧时间戳', /最后修改于 2023-05-22（3 年前）/.test(clip.note || ''), clip.note || '');
  ok('fakeLiveWhy 和 note 说的是同一句话', clip.fakeLiveWhy && clip.note.endsWith(clip.fakeLiveWhy));

  /* ---------- ② 真直播不能被误伤 ---------- */
  const live = await probeUrl(`${base}/live.m3u8`, { timeout: 8000, probeBytes: 65536 });
  ok('真直播不被误判成循环片', live.fakeLive === false);
  ok('真直播的 note 里不出现「录好的循环片」', !/循环片/.test(live.note || ''), live.note || '(空)');

  /* ---------- ③ 长片点播不能被误伤 ---------- */
  const movie = await probeUrl(`${base}/movie.m3u8`, { timeout: 8000, probeBytes: 65536 });
  ok('24 分钟的点播不被当成引流循环片', movie.fakeLive === false, movie.fakeLiveWhy || '');
  ok('长片那条 note 干净（没硬塞循环片）', !/循环片/.test(movie.note || ''), movie.note || '(空)');

  /* ---------- ④ 判据本身（纯函数） ---------- */
  const media = parseHlsMedia(clipMedia());
  ok('parseHlsMedia 数得出 24 个分片', media.segs.length === 24, String(media.segs.length));
  ok('parseHlsMedia 加得出总时长', Math.abs(media.durSec - 118.381333) < 1e-3, String(media.durSec));
  ok('parseHlsMedia 认得出 ENDLIST 封口', media.endlist === true);
  ok('循环片的清单能过检测', detectStaticClip(media ? clipMedia() : '', STALE).yes === true);

  // ENDLIST 是地基：少了它，写死的分片名说明不了「不是直播」
  ok('没有 ENDLIST 就算名字写死也不算数', detectStaticClip('#EXTM3U\n#EXTINF:5,\noutput000.ts\n', {}).yes === false);
  ok(
    '变体清单（一行一个变体）不算循环片',
    detectStaticClip('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', {}).yes === false,
  );
  ok(
    '超过 10 分钟的长片不算引流片（判据有上限）',
    detectStaticClip(clipMedia(24, 60), STALE).yes === false,
  );

  // 源站压根不回 Last-Modified 时，另外两条照样成立（它只是加分项）
  const noStamp = detectStaticClip(clipMedia(), {});
  ok('源站不回 Last-Modified 也照样判出来', noStamp.yes === true);
  ok('没时间戳就不提「最后修改于」', !/最后修改于/.test(noStamp.why || ''), noStamp.why);
  // 但回的是新日期的话，那句证据就该出现（说明源站还在更新，只是恰好也写死）
  const fresh = detectStaticClip(clipMedia(), FRESH);
  ok('最后修改日期很新时，证据栏留空不硬编', !/（\d+ (年|个月|天)前）/.test(fresh.why || ''), fresh.why);

  /* ---------- ⑤ 分片名的形态 ---------- */
  const shape = (names) => segNameShape(names);
  ok('output000.ts 这种写死小序号认得', shape(['output000.ts', 'output001.ts']).to === 1);
  ok('从 1 号起也认（chunk1/2/3）', shape(['chunk1.ts', 'chunk2.ts', 'chunk3.ts']).from === 1);
  ok('名字里没序号的不认（abc.ts）', shape(['abc.ts', 'abd.ts']) === null);
  ok('时间戳分片名不认（seg_1730046800.ts）', shape(['seg_1730046800.ts', 'seg_1730046801.ts']) === null);
  ok('大序号不认（segment-99177.ts）', shape(['segment-99177.ts']) === null);
  ok('含 8 位以上哈希的片段名不认', shape(['a1b2c3d4e1.ts', 'a1b2c3d4e2.ts']) === null);
  ok('主干各不相同的（随机名）不认', shape(['x1a9f3.ts', 'zz7c0.ts']) === null);
  ok('中间缺号的不认（0,1,3）', shape(['s0.ts', 's1.ts', 's3.ts']) === null);
  ok('带 query 的分片名也能数（?token=）', shape(['o000.ts?t=1', 'o001.ts?t=1']) !== null);
  ok('CMAF 的 .m4s 也认', shape(['c0.m4s', 'c1.m4s']) !== null);
  ok('空列表不算写死', shape([]) === null);
} finally {
  srv.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASS'} ${pass}/${pass + failed}`);
process.exit(failed ? 1 : 0);
