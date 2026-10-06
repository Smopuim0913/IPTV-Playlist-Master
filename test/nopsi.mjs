/**
 * 「这一窗没带节目信息表」不是「这条流没视频」。
 *
 * 起因：实测 112.123.243.37 那条 txiptv 直播源
 *   http://112.123.243.37:50085/tsfile/live/0124_1.m3u8?key=txiptv&playlive=0&authid=0
 * 的子清单里，第一个分片开头 **128KB 只有音视频包**（PID 4113 / 4352 / 8191），
 * PAT / PMT / SDT 一个都不发，全在 1MB 之后（实测 SDT 落在第 1,116,156 字节、
 * SPS 在 604KB 处）。首窗把它交给 analyzeStream，早先得到的是 no-video ——
 * 一句「源站的流描述里就没有视频」，于是一段 1920x1080 被判了死刑：
 *
 *   · 归因是 no-video → 不在 RES_RETRYABLE 里 → 界面连 ⟳ 都不给；
 *   · 更糟的是 HLS 那条「首窗口没盖到关键帧就加深再读一遍」的补救，
 *     前提是扫到过视频切片（sawVideo），no-video 不置位 → 2MB 深挖压根不触发；
 *   · 于是分辨率和流内服务名（dftvHD）一起丢掉，表格里「流内名」那列是「—」。
 *
 * 这里造一个同样形态的假源站（分片前 128KB 一个表都没有，表全在后面），
 * 跑真的 probeUrl，验证三件事：归因是 no-psi、深挖会触发、
 * 分辨率和流内服务名都能被捞回来。
 */
import http from 'node:http';
import { probeUrl, NO_RES_TEXT } from '../src/probe.js';
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
const SDT_PID = 0x0011;
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

const patSection = () => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]), // transport_stream_id + version/section
    Buffer.from([0x00, 0x01]), // program_number —— 少了这两个字节 program 就被拼到 CRC 里，
    //                             PAT 解出来的 PMT_PID 会变成 0，PMT 永远等不到
    Buffer.from([pidHi(PMT_PID), PMT_PID & 0xff]),
  ]);
  return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};

const pmtSection = () => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(0), 0x00]), // reserved(3)+PCR_PID
    Buffer.from([0x00, 0x00]), // reserved(4)+program_info_length = 0
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

/**
 * 造一条「表在后面」的分片：开头 700 个空壳视频包（131,600 字节，超过 128KB 首窗口），
 * PAT / PMT / SDT / 带 SPS 的视频 PES 全排在窗口之外。
 * 每个包必须正好 188 字节 —— TS 是按 188 对齐跳着走的，错位后面所有表都读不到。
 */
const shellPkt = () => {
  const p = Buffer.alloc(188);
  p[0] = 0x47;
  p[1] = 0x70; // PID 4113 + PUSI
  p[2] = 0x11;
  p[3] = 0x10;
  p.fill(0x7f, 4);
  return p;
};
const EMPTY_HEAD = Buffer.concat(Array.from({ length: 700 }, shellPkt));
const SEG_TAIL = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection()),
  psiPkt(SDT_PID, sdtSection('dftvHD')),
  pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1920, height: 1088 }))),
]);
const SEG = Buffer.concat([EMPTY_HEAD, SEG_TAIL]);

/* ---------------- 假源站 ---------------- */

let hits = 0; // 分片被打了几次（顺便看有没有白挖第三遍）
const srv = http.createServer((req, res) => {
  if (req.url === '/live.m3u8' || req.url.startsWith('/live.m3u8?')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.000,',
        'seg.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
    return;
  }
  if (req.url.startsWith('/seg.ts')) {
    hits++;
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    // 刻意分两次发：真实链路是「每块 3~4KB」一片片来的（早先就是因为写死
    // 「最多留 8 个块」这个假上限才闹出过分辨率读不到的 bug）。一次 write 整个
    // 132KB 的话客户端会当成一个大块收到，首窗永远碰不到「表在后面」这件事，
    // 这条测试就自己把被测的前提给绕过去了。
    res.write(EMPTY_HEAD);
    setTimeout(() => {
      try {
        res.end(SEG_TAIL);
      } catch {}
    }, 80);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

try {
  const row = await probeUrl(`${base}/live.m3u8`, { timeout: 8000, probeBytes: 65536 });

  ok('子清单能被线上拿到', row.ok && row.status === 200, `${row.status}`);
  // 前提先立住：这趟探测读到的第一个窗口里，一个 PAT/PMT 都没有
  const { analyzeStream } = await import('../src/resolution.js');
  const win = analyzeStream(EMPTY_HEAD);
  ok('首窗口确实扫不到任何视频轨（夹具成立）', win.reason === 'no-psi', win.reason);
  // 于是它绝不能被说成「源站的流描述里就没有视频」—— 那会连 ⟳ 都不给，
  // 把一段 1080p 判死在 128KB 上
  ok('no-psi 那句文案不说「没视频轨」', !/没视频轨/.test(NO_RES_TEXT[win.reason] || ''), NO_RES_TEXT[win.reason]);
  // 好在探测自己会加深再读一遍，最终这条是被捞回来的（不是留着 no-psi 让用户去点 ⟳）
  ok('最终归因是空的（这趟自己就捞回来了）', !row.noRes, row.noRes);

  // 深挖救场：同一趟探测就得把 1920x1088 和 dftvHD 一起捞回来
  ok('深挖后读到了分辨率', /1072|1088|1920/.test(row.format || ''), row.format || '(空)');
  ok('深挖后读到了流内服务名 dftvHD', row.serviceName === 'dftvHD', row.serviceName || '(空)');
  ok('读到了就别再挂着归因', !row.noRes, row.noRes);
  ok('note 里要说清是「加深读分片」捞回来的', /流头得到/.test(row.note || ''), row.note);
  ok('note 里别写成「没盖到关键帧」（那句会误导成再挖也白挖）', !/没盖到关键帧/.test(row.note || ''), row.note);
  ok('note 里点明原因是「这一窗没带 PAT/PMT」', /PAT\/PMT/.test(row.note || ''), row.note);
} finally {
  srv.close();
}

/* ---------------- 补一条：真没视频轨的时候仍要报 no-video ---------------- */
{
  const { analyzeStream } = await import('../src/resolution.js');
  // PMT 拆得出来、里面一条 elementary stream 都没有 —— 这才是「源站流描述里就没视频」
  const stubPmt = Buffer.concat([
    Buffer.from([0x02, 0xb0, 0x0d]),
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([0xe0, 0x00]), // reserved(3)+PCR_PID=0
    Buffer.from([0x00, 0x00]), // program_info_length = 0
    Buffer.alloc(4),
  ]);
  const ts = Buffer.concat([psiPkt(0x0000, patSection()), psiPkt(PMT_PID, stubPmt)]);
  ok('PMT 拆得出来却没视频轨：仍报 no-video，不报 no-psi', analyzeStream(ts).reason === 'no-video', analyzeStream(ts).reason);
}

console.log(failed ? `\n[节目信息表迟到] ${failed} 项失败（通过 ${pass}）` : `\n[节目信息表迟到] 全部通过（${pass} 项）`);
process.exit(failed ? 1 : 0);
