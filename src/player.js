/**
 * 调起本机播放器打开流。
 *
 * 为什么不放进浏览器：浏览器不能直接打开外域视频流（要 CORS + <video> 支持直播协议，
 * 而且常常弹个黑屏就关）。但我们的服务就跑在本机，所以让它 spawn 一个桌面播放器最简单。
 *
 * 为什么不用「系统默认关联」：Windows 上双击一个 .m3u8 走的系统默认程序经常是浏览器，
 * 浏览器播不了直播流；用户装的高级播放器也未必被注册成默认。所以这里宁可自己去扫
 * 常见安装路径 + PATH，让用户明确挑一个，再存下来复用。
 *
 * 只有 http/https 地址会被放行：开一个本地文件的 <a> 是最常见的误触，
 * 而且本地播放器对 file:// 的支持参差，先挡掉省得用户以为是播放器坏了。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// 配置文件路径在用到时才算（模块加载时就算的话，改 HOME 起不了第二份测试实例）
const configFile = () => path.join(os.homedir ? os.homedir() : '.', '.iptv-playlist-master.json');

/**
 * 候选播放器。win/mac 列的是最常见的安装位置；
 * PATH 里能找到的（vlc、mpv、kodi…）也会被自动认出来，见 which()。
 * args 是「除了地址之外」要带的固定参数，主要指 VLC 那种爱弹标题条的。
 */
const CANDIDATES = [
  {
    id: 'vlc',
    name: 'VLC media player',
    win: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'],
    mac: ['/Applications/VLC.app/Contents/MacOS/VLC'],
    // 这里**故意不加** --no-one-instance。加了它，每点一次就另起一个 VLC 窗口，
    // 几路声音一起出来混成一团，用户要的「频道调度中心」直接变成噪音。
    // 不加的话走 VLC 默认的单实例行为：新起的那个会把地址转交给已经在跑的实例再退出，
    // 桌面始终只留一个 VLC 窗口，批量播放的频道排进同一份播放列表里轮流播。
    // --no-video-title-show：别把地址糊在标题条上，播放列表里有名字就够了。
    args: ['--no-video-title-show'],
  },
  {
    id: 'mpv',
    name: 'mpv',
    win: ['C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe'],
    mac: ['/Applications/mpv.app/Contents/MacOS/mpv'],
    args: [],
  },
  {
    id: 'potplayer',
    name: 'PotPlayer',
    win: ['C:\\Program Files\\PotPlayer\\PotPlayer.exe', 'C:\\Program Files (x86)\\PotPlayer\\PotPlayer.exe', 'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayer.exe'],
    mac: [],
    args: [],
  },
  {
    id: 'mpchc',
    name: 'MPC-HC / MPC-BE',
    win: ['C:\\Program Files\\MPC-HC\\mpc-hc64.exe', 'C:\\Program Files (x86)\\MPC-HC\\mpc-hc64.exe', 'C:\\Program Files\\MPC-BE\\mpc-be64.exe'],
    mac: [],
    args: [],
  },
  {
    id: 'kodi',
    name: 'Kodi',
    win: ['C:\\Program Files\\Kodi\\Kodi.exe'],
    mac: ['/Applications/Kodi.app/Contents/MacOS/Kodi'],
    args: [],
  },
  {
    id: 'system',
    name: '系统默认程序（可能是浏览器，谨慎用）',
    kind: 'system',
    win: ['C:\\Windows\\explorer.exe'],
    mac: ['/usr/bin/open'],
    args: [],
  },
];

const isWin = process.platform === 'win32';

/** PATH 里找可执行文件（Windows 补 .exe/.bat） */
function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = isWin ? [bin, `${bin}.exe`, `${bin}.bat`] : [bin];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

/** 扫本机装了哪些播放器，返回 [{id,name,path,args,kind}] */
export function detectPlayers() {
  const found = [];
  for (const c of CANDIDATES) {
    const mine = (isWin ? c.win : c.mac) || [];
    const other = (isWin ? c.mac : c.win) || [];
    // 每一条都得是「真的存在」的路径才认。
    // 早年这行还留过一条「名字里带 .app/ 就算找到了」的兜底，
    // 结果 Windows 上会把 /Applications/VLC.app/... 当成已装 —— 点 ▶ 才蹦「路径不存在」。
    const p = mine.find((x) => fs.existsSync(x)) || other.find((x) => fs.existsSync(x)) || which(c.id);
    if (p) found.push({ id: c.id, name: c.name, path: p, args: c.args || [], kind: c.kind || 'player' });
  }
  return found;
}

/** 用户手动指定的播放器（存在 ~/.iptv-playlist-master.json，换会话不用重选） */
export function readCustom() {
  try {
    const j = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return typeof j.playerPath === 'string' ? j.playerPath : null;
  } catch {
    return null;
  }
}

export function writeCustom(p) {
  try {
    fs.writeFileSync(configFile(), JSON.stringify({ playerPath: p || null }, null, 2), 'utf8');
    return true;
  } catch {
    return false; // 只读环境（受管电脑）下别因为这个把功能卡死
  }
}

/** 把用户选的路径补成一条播放器记录（读不到文件也算它存在，打开时再报找不到） */
export function describeCustom(p) {
  if (!p) return null;
  return { id: 'custom', name: path.basename(p), path: p, args: [], kind: 'player', custom: true };
}

/** 当前该用哪个播放器：手动指定优先，否则第一个扫到的 */
export function activePlayer(customPath) {
  const list = detectPlayers();
  if (customPath) return describeCustom(customPath) || list[0] || null;
  return list[0] || null;
}

/** 最近打开的播放器 pid（按顺序），点「把窗口调到最前」时按这个顺序再捞一遍 */
const opened = [];

/**
 * 把最近打开的那些播放器窗口再捞一遍。
 *
 * 自动那次在 spawn 时就跑了；这里给 UI 一个「点了管用」的出口 ——
 * 用户亲手点一下鼠标时，系统才真的把前台权限放开（自动那次多半被拒，SetForegroundWindow 返回 False）。
 * 返回捞了几个。
 */
export function raiseRecent() {
  const list = opened.slice(-8);
  list.forEach((it) => raiseWindow(it.pid, it.step));
  return list.length;
}

/**
 * 把刚 spawn 出来的播放器窗口「捞回前台」。
 *
 * 为什么需要：服务进程自己是**没有窗口**的（多半还是后台起的），Windows 的前台激活规则
 * 就不允许它把子进程的窗口顶上来 —— 新窗口只能开在浏览器后面。声音照放，画面全被盖住，
 * 任务栏右侧只剩 VLC 自己的托盘图标在动；这跟「用托盘播」是两回事，是窗口没浮上来。
 * 所以 spawn 完还得显式还原 + 置前，浏览器那边也能再点一次「调到最前」补救。
 *
 * 顺手错开一格（最多 8 个）：多个窗口落在同一个位置时只有最上面那个看得见，
 * 看着就像「只开了一个窗口」，和「多窗口并行」的预期对不上。
 *
 * 走 PowerShell 只是为了拿到 user32 那几个 API（本项目零依赖，引不了 ffi）。
 * 一切失败都静默吞掉：捞窗口是锦上添花，不能反过来把「能不能播」给拖累。
 *
 * 踩过的三个坑（都是探针脚本跑出来的，别再改回去）：
 *  1) SetWindowPos 的最后一个尺寸参数不能叫 h，跟句柄重名 → C# 编译报「参数名 h 重复」，
 *     Add-Type 直接失败，后面一句都不会执行；
 *  2) VLC 的 MainWindowHandle **读出来是 0**（它一开就是一摞窗口：主窗口 / Playlist /
 *     Errors / 托盘消息窗），所以句柄要自己 EnumWindows 按 pid 找；
 *  3) 回调是独立作用域，$found = ... 只造出个局部量，外面读到的是 0，得写 $script:。
 */
function raiseWindow(pid, step = 0) {
  if (!isWin || !pid) return;
  const off = 32 + Math.max(0, Math.min(Number(step) || 0, 8)) * 28;

  const script = [
    '$sig = @"',
    'using System; using System.Runtime.InteropServices;',
    'public class MpmWin {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hw);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hw, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hw);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc e, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hw, out uint pid);',
    '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hw);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hw, StringBuilder s, int n);',
    '  public delegate bool EnumWindowsProc(IntPtr hw, IntPtr l);',
    '}',
    '"@',
    'try {',
    '  Add-Type -TypeDefinition $sig -ErrorAction Stop | Out-Null;',
    '  $p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue | Select-Object -First 1;',
    '  if (-not $p) { exit }',
    '  $h = $p.MainWindowHandle;',
    '  if (-not $h -or $h -eq 0) {',
    '    $script:wh = [IntPtr]::Zero;',
    '    $del = [MpmWin+EnumWindowsProc] {',
    '      param($hw, $l)',
    '      if ($script:wh -ne [IntPtr]::Zero) { return $true }',
    '      $pp = 0',
    '      [void][MpmWin]::GetWindowThreadProcessId($hw, [ref]$pp)',
    '      if ($pp -ne ' + pid + ') { return $true }',
    '      $len = [MpmWin]::GetWindowTextLength($hw)',
    '      if ($len -le 0) { return $true }',
    '      $sb = New-Object System.Text.StringBuilder ($len + 1)',
    '      [void][MpmWin]::GetWindowText($hw, $sb, $sb.Capacity)',
    '      $t = $sb.ToString();',
    '      $skip = $t.Contains("TrayIcon") -or $t.StartsWith("VLC ghk") -or $t.Contains("IME");',
    '      if (-not $skip) { $script:wh = $hw }',   // 兜底：该 pid 下第一个真窗口
    '      if (-not $skip -and $t.Contains("VLC")) { $script:wh = $hw; return $false }', // 认出 VLC 主窗口就收手
    '      return $true',
    '    };',
    '    [void][MpmWin]::EnumWindows($del, [IntPtr]::Zero);',
    '    $h = $script:wh;',
    '  }',
    '  if (-not $h -or $h -eq 0) { exit }',
    '  if ([MpmWin]::IsIconic($h)) { [void][MpmWin]::ShowWindow($h, 9) }', // 9 = SW_RESTORE：被最小化到托盘也算捞回来
    '  [void][MpmWin]::SetForegroundWindow($h);',
    '} catch {}',
  ].join('\n');

  const run = (bin) => {
    try {
      // -EncodedCommand：省得拼一堆引号把自己绕进去。
      // -NoProfile：不读用户自己的 PowerShell profile（里头可能有一堆自定义函数/改环境）。
      // -WindowStyle hidden：别让 powershell 自己闪一下黑窗。
      const cp = spawn(bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      if (cp.pid) cp.unref();
      return true;
    } catch {
      return false;
    }
  };

  if (run('powershell.exe') || run('pwsh.exe')) return;
  // 播放器刚起来时主窗口可能还没建好，过 0.6s 再捞一次（这一次多半就成了）
  setTimeout(() => {
    if (run('powershell.exe') || run('pwsh.exe')) return;
  }, 600);
}

/** player 可能是记录对象，也可能就是一个路径字符串；都没给就退回当前该用的那个 */
function resolvePlayer(player) {
  return (typeof player === 'string' ? describeCustom(player) : player) || activePlayer(readCustom());
}

/**
 * 是不是 VLC —— 不能只看 id：候选表里 VLC 的 id 是 'vlc'，
 * 但用户从「播放器设置」手选路径时 id 是 'custom'（describeCustom 给的），
 * 那也得认它，否则手动指定的 VLC 就享受不到「同一个窗口追加」那套。
 */
function isVlc(p) {
  return !!p && (p.id === 'vlc' || /^vlc(\.exe)?$/i.test(path.basename(p.path || '')));
}

/**
 * 把「一个目标」甩给播放器进程。
 * 目标既可以是流地址，也可以是本地的播放清单文件（批量播放走的是后者，
 * 所以这里**不能**再校验协议 —— 那会把清单路径当非法地址挡回去）。
 */
function launch(target, p, opts = {}) {
  const bin = p.path;
  if (!bin) return { ok: false, error: '没有指定播放器' };
  try {
    if (!fs.existsSync(bin)) return { ok: false, error: `播放器路径不存在：${bin}` };
  } catch {}

  // 系统打开器在 mac/linux 是 open / xdg-open，参数就是裸地址；
  // Windows 走 explorer.exe 打开默认程序时也要给它一个「标题」参数，不然会弹窗
  const args = [...(p.args || [])];

  // VLC 额外开一个本机 HTTP 控制口：以后再点播放就能把频道**加进这同一个窗口**，
  // 而不是另起一个 VLC 实例（--one-instance 在这台便携版 VLC 上实测不转发，起了三个进程）。
  // 密码是随机的 16 位，只在本机回环上听，等于没有入口。
  let port = 0;
  let password = '';
  if (isVlc(p)) {
    port = 18000 + Math.floor(Math.random() * 8000);
    password = crypto.randomBytes(8).toString('hex');
    args.push('--extraintf', 'http', '--http-port', String(port), '--http-password', password);
  }

  args.push(target);

  try {
    const child = spawn(bin, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // Windows 上别给每个流弹一个黑色控制台窗口
      cwd: os.tmpdir(),
    });
    if (child.pid) {
      child.unref(); // 别让播放器进程吊着服务
      const step = opts.raise || 0;
      opened.push({ pid: child.pid, step });
      if (opened.length > 12) opened.splice(0, opened.length - 12);
      raiseWindow(child.pid, step); // 尽力捞回前台，否则窗口就躲在浏览器后面
    }
    return { ok: true, player: p.name || path.basename(bin), pid: child.pid, port, password };
  } catch (e) {
    return { ok: false, error: `调起播放器失败：${(e && e.message) || e}` };
  }
}

/**
 * 写一份临时播放清单（m3u）。
 *
 * 为什么要绕这一圈：批量播放如果走「每条流 spawn 一次」，就是 N 个进程 N 个窗口，
 * 多路声音同时出来。写一份清单只给播放器**一个**入口，播放器内部才是真正的播放列表：
 * 同进程一次只出一路声，做出来的就是「一个 VLC 窗口里换台」，不是一屋子窗口。
 * 顺带还有个好处：频道名能写进 #EXTINF，播放列表里看得见是哪条。
 */
function writePlaylist(items) {
  const file = path.join(
    os.tmpdir(),
    `mpm-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.m3u`,
  );
  const lines = ['#EXTM3U'];
  for (const it of items) {
    const name = String(it.name || '').replace(/[\r\n]/g, ' ').trim() || 'IPTV';
    lines.push(`#EXTINF:-1 tvg-name="${name.replace(/"/g, '')}",${name}`, String(it.url));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  // 清单只是递给播放器的引子，它已经读进内存了；留一天再删，别把临时目录养胖。
  setTimeout(() => {
    try {
      fs.unlinkSync(file);
    } catch {}
  }, 86400000);
  return file;
}

/**
 * 打开一条流（单条专用入口，校验过协议）。
 * @param {string} url 流地址
 * @param {object} [player] 播放器记录；不传就用 activePlayer()
 * @param {{raise?:number}} [opts]
 * @returns {{ok:boolean, player?:string, pid?:number, error?:string}}
 */
export function openStream(url, player, opts = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持 http/https 地址（浏览器里拿不到本地播放器，请用行内的 ▶ 或工具栏按钮）' };
  const p = resolvePlayer(player);
  if (!p) return { ok: false, error: '本机没找到可用播放器，先去「播放器设置」里指一个' };
  return launch(target, p, opts);
}

/** 进程还在不在（signal 0 只探活，不真的发信号） */
function procAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 我们起过、还活着的 VLC 实例（同一个 exe 只留最后一个） */
const instances = [];

function liveInstance(bin) {
  instances.splice(0, instances.length, ...instances.filter((it) => procAlive(it.pid)));
  return instances.find((it) => it.bin === bin) || null;
}

/**
 * 把一份清单塞进已经开着的那个 VLC 窗口（走它自己的 HTTP 控制口）。
 * 返回 false 表示那条实例已经不管用了，调用方得重新起一个。
 */
async function appendToInstance(it, items) {
  const file = writePlaylist(items);
  const uri = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  const auth = 'Basic ' + Buffer.from(':' + it.password, 'utf8').toString('base64');
  try {
    // 用 add 而不是 in_play：这版 VLC（3.0.24）的 in_play 在 http 接口上是坏的，
    // 老老实实返回一段「Error loading …」；add 会把它排进窗口的播放列表（若没在播就直接播）。
    const r = await fetch(`http://127.0.0.1:${it.port}/requests/status.xml?command=add&uri=${encodeURIComponent(uri)}`, {
      headers: { Authorization: auth },
    });
    // VLC 出错也是 200，响应里是段「Error loading …」的 HTML，所以得看正文
    const text = r.ok ? await r.text().catch(() => '') : '';
    return !!text && !/Error loading|Internal error/i.test(text);
  } catch {
    return false;
  }
}

/** 起完等一会儿探一下：还活着才留着当「以后追加的目标」，否则下次该重开就重开 */
function watchInstance(it) {
  setTimeout(() => {
    if (!procAlive(it.pid)) {
      const i = instances.indexOf(it);
      if (i >= 0) instances.splice(i, 1);
      return;
    }
    const auth = 'Basic ' + Buffer.from(':' + it.password, 'utf8').toString('base64');
    fetch(`http://127.0.0.1:${it.port}/requests/status.xml`, { headers: { Authorization: auth } })
      .then((r) => (r.ok ? undefined : (() => { const i = instances.indexOf(it); if (i >= 0) instances.splice(i, 1); })()))
      .catch(() => {});
  }, 1500);
}

/**
 * 打开一串流 —— **始终只有一个播放器进程**（= 一个窗口）。
 *
 * 频道排成一份播放清单：第一次点会把窗口起起来，以后每次点都往那**同一个**窗口里追加
 * （VLC 用自带 HTTP 控制口；别的播放器没有这个口，就照旧每次起一个实例）。
 * 这样"几路声音同时出来"就不会发生：一个窗口一次只播一条，播完接着下一条。
 *
 * @param {Array<{name?:string, url:string}>|{name?:string, url:string}} items 一条也行，多条也行
 * @param {object} [player] 播放器记录；不传就用 activePlayer()
 * @param {{raise?:number}} [opts]
 * @returns {Promise<{ok:boolean, player?:string, pid?:number, count?:number, reused?:boolean, error?:string}>}
 */
export async function openStreams(items, player, opts = {}) {
  const list = (Array.isArray(items) ? items : [items]).map((it) => (typeof it === 'string' ? { url: it } : it || {}));
  const clean = list
    .map((it) => ({ name: String(it.name || '').trim(), url: String(it.url || '').trim() }))
    .filter((it) => /^https?:\/\//i.test(it.url));
  if (!clean.length) {
    return { ok: false, error: '没有可播放的 http/https 地址（浏览器里拿不到本地播放器）' };
  }
  const p = resolvePlayer(player);
  if (!p) return { ok: false, error: '本机没找到可用播放器，先去「播放器设置」里指一个' };

  // 已经有一个我们起的 VLC 开着 → 追加进去，绝不新开窗口
  if (isVlc(p)) {
    const it = liveInstance(p.path);
    if (it) {
      if (await appendToInstance(it, clean)) {
        return { ok: true, player: p.name, pid: it.pid, count: clean.length, reused: true };
      }
      // 追加失败（-instance 已经关了 / 控制口没响应）：只好当没这回事，重新起一个
      const i = instances.indexOf(it);
      if (i >= 0) instances.splice(i, 1);
    }
  }

  // 一条走老路（裸直地址），多条才落一份清单 —— 单条直传播放器兼容性最好
  const target = clean.length === 1 ? clean[0].url : writePlaylist(clean);
  const r = launch(target, p, opts);
  if (!r.ok) return r;
  if (isVlc(p) && r.pid) {
    const it = { pid: r.pid, bin: p.path, port: r.port, password: r.password };
    instances.push(it);
    if (instances.length > 3) instances.splice(0, instances.length - 3);
    watchInstance(it);
  }
  return { ...r, count: clean.length, playlist: clean.length > 1 ? target : undefined };
}
