/**
 * 多语言 —— 中英双语，零依赖。
 *
 * 设计上刻意只维护**一份英文表**，中文用「原文」当 key：
 *
 *   t('打开本地文件') -> 'Open local file'
 *   t('打开本地文件') -> '打开本地文件'   // 英文表漏了这一条，就照常显示中文
 *
 * 这么定是因为本项目还在快速迭代，UI 文案每周都在变。如果中英各存一份、key 用英文语义名，
 * 那么每加一句文案就漏一个 key 的 chance 很大，而漏 key 的后果是界面上出现一个空白按钮 ——
 * 比显示中文糟糕得多。用原文当 key 之后，「没翻译」这件事自动降级成「显示中文」，永远不会坏。
 *
 * 两条硬规矩：
 *
 * 1. **整句进字典，不要「词根 + 参数」硬拼。** 中文的「已更新：3 条 / 新增 5 条」是按汉语语序
 *    拼出来的，英文得说 "3 switched to new sources / 5 added"，词序完全不同，模板字符串拼不出
 *    人话。所以带变量的句子一律写成整句 + {占位}：
 *
 *      t('已更新 {n} 条', { n: 3 })          // 中英文都能按各自语序写完整
 *
 * 2. **字典里的中文就是对照表**，改文案时同步改 key 就行，不用在两个文件之间对 key。
 *
 * index.html 里的静态文案用四种属性标 key，切语言时由 applyStatic() 统一回填：
 *
 *   data-i18n         -> textContent
 *   data-i18n-html    -> innerHTML（文案里含 <code> / <b> 这类标签时用）
 *   data-i18n-title   -> title
 *   data-i18n-ph      -> placeholder
 *
 * src/ 下的后端代码不参与国际化：那里的中文是日志和 HTTP 错误信息，只有你自己看得到，
 * 翻它需要动一堆测试断言，收益太低。
 */

export const LANGS = ['zh-CN', 'en'];
export const NAMES = { 'zh-CN': '中文', en: 'English' };
const STORE = 'mpm.lang';
const EVENT = 'mpm:lang';

/** 英文表。中文一律不写 —— 原文即默认文案。 */
const EN = {
  /* ---------- 页面骨架 ---------- */
  '播放列表体检 / 编辑 / 更新': 'Playlist health check / editing / updater',
  '体检 · 编辑 · 更新': 'Check · Edit · Update',
  '原文件为 {encoding} 编码，保存/导出时会统一输出为 UTF-8':
    'The file was {encoding}; it is always written out as UTF-8 on save / export',

  /* ---------- 顶栏 ---------- */
  '未载入': 'Not loaded',
  '打开本地文件': 'Open local file',
  '从网址载入': 'Load from URL',
  '开始测速探测': 'Probe speeds',
  '+ 新频道': '+ New channel',
  '覆盖保存': 'Overwrite save',
  '导出 .m3u': 'Export .m3u',
  '导出 .m3u8': 'Export .m3u8',

  /* ---------- 拖拽蒙层 / 搜索 ---------- */
  '松手即导入 m3u / m3u8 文件': 'Drop to import a m3u / m3u8 file',
  '搜索频道名 / tvg-id / 地址…': 'Search channel name / tvg-id / URL…',

  /* ---------- 工具栏 ---------- */
  '全部分组': 'All groups',
  '全选当前': 'Select all shown',
  '选中探测失败的': 'Select failed',
  '选中所有没有 LOGO（或 LOGO 加载不出来）的频道，方便批量补':
    'Select channels with a missing or broken LOGO',
  '选中缺 LOGO 的': 'Select no-LOGO',
  '清空勾选，接着做别的操作': 'Clear the selection',
  '清除选择': 'Clear selection',
  '批量改分组': 'Batch group',
  '完整地址': 'Full URL',
  '把所选频道（没选就全部）的流地址一行一个复制到剪贴板':
    'Copy stream URLs, one per line',
  '复制地址': 'Copy URLs',
  '调起本机播放器打开所选频道（没选就开第一条）。选中多条时全部排进同一个窗口，在窗口里轮流播，一次只出一路声':
    'Open the selection in the local player (first one if nothing is selected). Multiple channels are queued into a single window and play one at a time.',
  '▶ 用播放器打开': '▶ Open in player',
  '选择/确认本机播放器路径，没有可用播放器时行内的 ▶ 不会显示':
    'Pick or confirm the local player path',
  '播放器设置': 'Player settings',
  '拉取远端最新列表，合并进这张表：本地手动改过的字段不会被覆盖':
    'Fetch the remote list and merge it into this table; anything you edited locally is never overwritten',
  '从源站更新': 'Update from source',
  '把探测到的分辨率写回频道名末尾（追加/更新，没探测值的不动）':
    'Write the probed resolution into the channel name (untouched when not probed)',
  '回填分辨率': 'Fill resolution',
  '把探测到的首字节延迟写在频道名末尾，方便挑低延迟的源':
    'Write the probed latency into the channel name so low-latency sources are easy to spot',
  '回填延迟': 'Fill latency',
  '把频道名末尾的分辨率/延迟后缀全部摘掉，一个字都不回填':
    'Strip resolution / latency suffixes without writing anything back',
  '彻底清洗频道名': 'Clean channel names',
  '同名频道（多个源）按延迟升序挪位置，只在本组内调整':
    'Sort same-named channels by latency (within their group only)',
  '同名按延迟排序': 'Sort by latency',
  '删除所选': 'Delete selected',
  '本地绝对路径（用于覆盖保存）': 'Absolute path (used for overwrite save)',
  '按路径读取': 'Read by path',
  '把播放器窗口调到最前': 'Bring player window to front',
  '知道了': 'Got it',

  /* ---------- 空态 / 进度 ---------- */
  '还没有载入播放列表': 'No playlist loaded yet',
  '点右上角「打开本地文件」，或直接把 <code>.m3u</code> / <code>.m3u8</code> 拖进来。也可以粘贴一段 m3u 文本，或填入远程列表网址（由本地服务代取，绕开跨域限制）。':
    'Hit <b>Open local file</b> top-right, or just drop a <code>.m3u</code> / <code>.m3u8</code> file here. You can also paste some m3u text, or paste a remote list URL — the local service fetches it for you, so CORS is not a problem.',
  '用上面的文本载入': 'Load from the text above',
  '准备中…': 'Preparing…',
  '停止': 'Stop',

  /* ---------- 表头 ---------- */
  '频道名': 'Channel name',
  '分组': 'Group',
  '流地址': 'Stream URL',
  '分辨率': 'Resolution',
  '流内名': 'In-stream name',
  '延迟': 'Latency',
  '标称码率': 'Nominal bitrate',
  '状态': 'Status',

  /* ---------- 弹窗通用 ---------- */
  '编辑频道': 'Edit channel',
  '添加新频道': 'Add new channel',
  '取消': 'Cancel',
  '确定': 'OK',

  /* ---------- 行内 ---------- */
  '补一个 LOGO 地址': 'Add a LOGO URL',
  '用本机播放器打开这条流': 'Open this stream in the local player',
  '未测': 'Not probed',
  '失败': 'failed',
  '原始错误码：{code}；共尝试 {attempts} 次（重试 {retried} 次仍失败）':
    'Raw error code: {code}; {attempts} attempt(s) total ({retried} retry/retries still failed)',
  '{status} · 证书异常但可播': '{status} · TLS issue, still playable',
  '{status} · 易卡顿': '{status} · likely to stutter',
  '循环片': 'Loop clip',
  '拼接': 'Seam-stitched',
  '选中伪直播': 'Select fake live',
  '选中拼接的': 'Select stitched',
  '选中所有拼接的假直播（几段历史切片缝起来放在滚动窗口里，播到末尾就卡死），方便整批删掉':
    'Select every stitched fake-live entry (several old slices sewn into a sliding window; stalls at the end), for bulk removal',
  '已选中 {n} 个拼接的假直播': '{n} stitched fake-live selected',
  '没挑出拼接的假直播': 'No stitched fake-live found',
  '不是实时直播：{why}': 'Not a live stream: {why}',
  '选中所有伪直播（其实是录好的循环片，像带二维码的引流短片），方便整批删掉':
    'Select every fake-live entry (really a recorded looping clip, e.g. a QR-code ad page), for bulk removal',
  '已选中 {n} 个伪直播（循环片）': '{n} fake-live (loop clip) selected',
  '没挑出伪直播（循环片）': 'No fake-live (loop clip) found',
  '不是实时直播：{why}': 'Not a live stream: {why}',
  // 「添加新频道」里那张体检报告：先把它读到的数摆出来，再让人自己勾要不要落成后缀
  '首字节延迟': 'First-byte delay',
  '带分辨率后缀': 'Append resolution suffix',
  '带延迟后缀': 'Append delay suffix',
  '这不是实时直播，是几段历史切片缝起来的': 'Not live — several old slices stitched together',
  '（还没填频道名）': '(no channel name yet)',
  '{status} 在线': '{status} online',
  '拖动排序': 'Drag to reorder',
  '复制这条流地址': 'Copy this stream URL',
  '频道名': 'Channel name',
  '分组': 'Group',

  /* ---------- 统计 ---------- */
  '{shown} / 共 {total} 条 · 已选 {sel} · 在线 {ok} / 失败 {bad}':
    '{shown} of {total} · {sel} selected · {ok} online / {bad} failed',
  '{name} · 共 {n} 个频道': '{name} · {n} channels',
  '已测 {done}（在线 {ok} / 失败 {bad}）': 'Probed {done} ({ok} online / {bad} failed)',
  '没有匹配的频道': 'No matching channels',
  '共 {total} 条，此处仅渲染前 {max} 条（批量操作与导出均作用于全部）。继续输入关键词可缩小范围。':
    '{total} channels; only the first {max} are rendered — batch actions and export still cover all of them. Type a keyword to narrow it down.',
  '（未分组）': '(Ungrouped)',

  /* ---------- 批量播放按钮 ---------- */
  '▶ 排进一个窗口 ({n})': '▶ Queue into one window ({n})',
  '这 {n} 条排进同一个播放器窗口，在窗口里轮流播（一次只出一路声，不会混）':
    'These {n} channels go into one player window and play one at a time — the audio never mixes.',
  '调起本机播放器打开所选频道（可先在设置里选播放器）':
    'Open the selected channel in the local player (pick a player in Settings first)',
  '没选就按整表 {n} 条排进同一个播放器窗口（一次只出一路声，点下去会先确认一次）':
    'With nothing selected, this queues the whole list ({n}) into one player window — the audio never mixes, and you get a confirmation first',

  /* ---------- 载入 ---------- */
  '内容为空': 'The content is empty',
  '粘贴内容': 'Pasted text',
  '远程列表': 'Remote list',
  '读取 {name} …': 'Reading {name}…',
  '载入中…': 'Loading…',
  '载入失败': 'Load failed',
  '载入失败：{msg}': 'Failed to load: {msg}',
  '服务端没有返回列表内容': 'The server returned no playlist content',
  '先载入播放列表': 'Load a playlist first',
  '先把 m3u 文本粘进去': 'Paste some m3u text first',
  '填入远程播放列表地址（由本地服务代取，可绕开跨域）：':
    'Remote playlist URL (the local service fetches it, so cross-origin is not an issue):',
  '填入源站（播放列表）地址：\n（本地这张已编辑过的表不会被覆盖，只做合并）':
    'Source (playlist) URL:\n(this edited list is never overwritten — it gets merged)',
  '填入绝对路径，例如 D:\\playlist\\channels.m3u':
    'Type an absolute path, e.g. D:\\playlist\\channels.m3u',

  /* ---------- 复制 ---------- */
  '已复制流地址': 'Stream URL copied',
  '复制失败，请手动选中（或用「编辑频道」复制）':
    'Copy failed — select the text manually (or use Edit channel)',
  '这些频道没有流地址': 'None of these channels has a stream URL',
  '已复制 {n} 条流地址（{skip} 条为空已跳过）':
    'Copied {n} stream URLs ({skip} empty one(s) skipped)',
  '复制失败，可能是浏览器限制了剪贴板':
    'Copy failed — the browser may have blocked clipboard access',
  '复制完整流内名': 'Copy the full in-stream name',
  '已复制流内名': 'In-stream name copied',
  '流内名：{n}': 'In-stream name: {n}',
  '点右边的 ⧉ 复制整段': 'Click ⧉ on the right to copy the whole thing',
  '这些频道没有 http/https 流地址': 'None of these channels has an http/https stream URL',

  /* ---------- 播放器 ---------- */
  '在浏览器里播放 · {name}': 'Play in browser · {name}',
  '你用的是<b>原生支持 HLS</b>的浏览器，直接在页面里播就行，不用唤起本机播放器。':
    'Your browser plays <b>HLS natively</b>, so it can play right here — no need to launch the local player.',
  '要是黑屏或一直转圈，多半是源站校验了 Referer / 只允许播放器 UA —— 这种得用本机播放器打开。':
    'If it stays black or keeps buffering, the source is probably checking Referer or allowlisting player UAs — open it with the local player instead.',
  '这个地址浏览器播不了，且本机没配播放器（去「播放器设置」指一个 exe）':
    'The browser cannot play this URL and no local player is set (open Player settings and point at an .exe)',
  '播放器窗口可能盖在浏览器后面：声音在放，画面看不见。':
    'The player window is probably behind the browser: the audio is playing but the picture is hidden.',
  '若只听见声音、看不见画面，说明窗口被浏览器盖住了：点「调到最前」或双击播放器托盘图标。':
    'Audio but no picture means the window is behind the browser — click "Bring to front" or double-click the player tray icon.',
  '这 {n} 条排在同一个播放器窗口里依次播（一次只出一路声）。若被浏览器盖住，点「调到最前」把它捞回来。':
    'These {n} channels play one at a time in a single player window. If the browser covers it, click "Bring to front".',
  '已把 {n} 个播放器窗口调到最前；还在后面就双击 VLC 托盘图标':
    'Brought {n} player window(s) to front; if it is still hidden, double-click the VLC tray icon',
  '没捞到窗口（播放器可能已经关了）': 'No window found (the player may have closed)',
  '调窗口失败：{msg}': 'Could not raise the window: {msg}',
  '「{name}」没有 http/https 流地址': '{name} has no http/https stream URL',
  '「{name}」没有 http/https 流地址，播放器打不开':
    '{name} has no http/https stream URL, so the player cannot open it',
  '本机没找到可用播放器': 'No usable local player found',
  '本机没找到可用播放器，先点「播放器设置」指一个路径':
    'No usable local player found — open Player settings and pick a path first',
  '已用「{player}」打开：{name}': 'Opened with {player}: {name}',
  '打开失败：{msg}': 'Could not open: {msg}',
  '会往同一个播放器窗口里排 {total} 条（只排前 {cap} 条，剩下的没进去），继续吗？':
    'This queues {total} channels into one player window (only the first {cap}; the rest are left out). Continue?',
  '又往「{who}」那一个窗口里加了 {n} 条（现在 {n} 条排在一起，一次只出一路声）。':
    'Added {n} more to that single {who} window ({n} queued in total, one stream at a time).',
  '已用「{who}」打开 {n} 条，全在同一个窗口里排着；窗口里切一下就能换台（一次只出一路声）。':
    'Opened {n} with {who}, all queued in the same window — switch inside the window to change channel.',
  '（没扫到常用播放器，可以手动填路径）': '(no common player found — feel free to type a path)',
  '扫到 {n} 个可用播放器<span class="mono">（{names}）</span>。选一个作为默认，行内的 <b>▶</b> 与工具栏「▶ 用播放器打开」都会用它。':
    'Found {n} usable player(s) <span class="mono">({names})</span>. Pick one as the default; the inline <b>▶</b> and the toolbar button both use it.',
  '无': 'none',
  '只认 <b>http/https</b> 地址；播放器路径填错了会在打开时提示。':
    'Only <b>http/https</b> URLs work; a wrong player path shows up the next time you open something.',
  '播放器可执行文件路径（留空＝取消自定义，回到自动扫描）':
    'Player executable path (leave blank to drop the custom path and go back to auto-scan)',
  '例如 C:\\Program Files\\VideoLAN\\VLC\\vlc.exe':
    'e.g. C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
  '浏览…': 'Browse…',
  ' 拿不到真实磁盘路径，「浏览」走的是本机服务（可切盘符、可直接敲路径）':
    ' (the browser cannot reach a real disk path, so Browse goes through the local service — switch drives or type a path)',
  '也可以直接手填路径，留空点「确定」＝回到自动扫描。':
    'You can also type a path directly; leaving it blank and pressing OK returns to auto-scan.',
  '填一个目录路径后回车，例如 D:\\Software\\VideoLAN':
    'Type a directory path and press Enter, e.g. D:\\Software\\VideoLAN',
  '前往': 'Go',
  '预览': 'Preview',
  '读不了这个目录（不存在或没权限）': 'Cannot read this directory (missing or no permission)',
  '↑ 上一级': '↑ Up',
  '（这个目录里没有可执行程序）': '(no executable in this directory)',
  '保存播放器设置失败：{msg}': 'Failed to save player settings: {msg}',
  '已选择播放器：{name}': 'Player set: {name}',
  '已回到自动扫描': 'Back to auto-scan',

  /* ---------- 批量操作 ---------- */
  '没有选中任何频道': 'No channel is selected',
  '确定删除 {n} 个频道？': 'Delete {n} channels?',
  '先选中要改的频道': 'Select the channels to change first',
  '已选中 {n} 个缺 LOGO 的频道': 'Selected {n} channels without a LOGO',
  '每个频道都有 LOGO 了': 'Every channel already has a LOGO',
  '改为分组': 'Set group to',
  '例如：央视': 'e.g. CCTV',

  /* ---------- 从源站更新 ---------- */
  '从源站更新列表': 'Update from source',
  '将拉取 <span class="mono">{url}</span> 的最新列表，与当前 {n} 条合并。<br>本地手动改过的地址 / 频道名不会被源站覆盖。':
    'This pulls the latest list from <span class="mono">{url}</span> and merges it into the {n} channels here.<br>Addresses and names you edited locally are never overwritten by the source.',
  '追加远端新增的频道（不勾的话只更新已有的）':
    'Add channels that only exist on the source (off = update existing only)',
  '删除远端已经移除的频道（不勾则本地保留，勾之前先导出一份）':
    'Remove channels the source dropped (off = keep them locally; export a copy first)',
  '拉取中…': 'Fetching…',
  '拉取源站失败：{msg}': 'Failed to fetch the source: {msg}',
  '源站内容与本地一致，没有可更新的': 'The source matches this list — nothing to update',
  '{n} 条换用新源': '{n} switched to new sources',
  '新增 {n} 条': '{n} added',
  '删除 {n} 条': '{n} removed',
  '{n} 条因本地手改而保留': '{n} kept because edited locally',
  '已更新：{parts}': 'Updated: {parts}',

  /* ---------- 探测 ---------- */
  '对当前 {n} 个频道发起探测？\n每条约 8 秒超时、瞬时失败自动重试（最多共 3 次）、403 会换播放器 UA 再试、同源最小间隔 0.2 秒。':
    'Probe the current {n} channels?\nRoughly 8s timeout each, auto-retry on instant failure (up to 3 tries total), 403 retried with a player UA, min 0.2s between requests to the same host.',
  '连接中…': 'Connecting…',
  '已测 {done} / {total}': 'Probed {done} / {total}',
  '已载入新列表，上一趟探测已停止，进度已清空':
    'New list loaded — the previous probe was stopped and its progress cleared',
  /* ---------- 局部重挖（分辨率没读到的那几类） ---------- */
  '探测完成：{total} 条，失败 {bad} 条（已勾上，其中新增 {added} 条）':
    'Probe done: {total} channels, {bad} failed (auto-selected, {added} newly added)',
  '其中 {n} 条在线': '{n} are online and reachable',
  '这条还没探测过': 'This one has not been probed yet',
  '这条流只有音频、没有视频轨，再挖多深也读不出分辨率':
    'This stream carries audio only — no video track at all, so no amount of digging will yield a resolution',
  '这条探测就失败了：{note}': 'This one failed outright ({note})',
  '压根没拿到码流，谈不上分辨率': 'No stream was received, so there is no resolution to speak of',
  '这条读到分辨率了：{fmt}': 'Resolution read: {fmt}',
  '服务端这一趟没回报没读到分辨率的原因（多半是服务跑着旧版本，改了代码得重启服务）':
    'The server reported no reason for the missing resolution (most likely an old build is still running — server code changes need a restart)',
  '重启后再测一次，这里就会显示原因和 ⟳ 按钮':
    'Re-probe after restarting and this will show the reason and the ⟳ button',
  '原因：{why}（视频轨在，只是探测窗口没盖到关键帧）':
    'Reason: {why} (the video track is there, the probe window just never reached a keyframe)',
  '点这个 ⟳ 用更大的窗口（每条最多 {mb}MB 往下读）重挖一次':
    'Hit this ⟳ to re-read with a much bigger window (up to {mb}MB)',
  // no-psi 和 long-gop 都给 ⟳，但不是一回事：前者缺的是节目信息表，后者缺的是关键帧。
  // 共用上面那句会写成「只是没盖到关键帧」，容易让人以为再挖也白挖。
  '原因：{why}（这一窗连节目信息表都没扫到，不代表没视频轨）':
    'Reason: {why} (this window held no PAT/PMT at all — it does not mean the stream has no video)',
  '点这个 ⟳ 用更大的窗口（每条最多 {mb}MB 往下读）继续往里找':
    'Hit this ⟳ to keep reading deeper (up to {mb}MB) for the tables',
  '再点一下收起': 'Click again to collapse',
  /* 「标称码率」那一格的 tooltip：源站标的数、实测值、卡顿预判（实测值常年是空的，别让它白算） */
  '源站标称 {n}M': 'Source declares {n}M',
  '实测 {n}M': 'Measured {n}M',
  '卡顿预判：{n}': 'Stutter risk: {n}',
  '容易卡': 'likely to stutter',
  '勉强够用': 'marginal',
  '够用': 'fine',
  '这条没读到标称码率': 'No nominal bitrate read from this one',
  '原因：{why}。这一类再往深挖也不会有分辨率，所以只给说明、不给重挖按钮':
    'Reason: {why}. Going deeper will not produce a resolution either, so this only explains — no retry button',
  '有 {n} 条在线但没读到分辨率，一次原因都没回报 —— 多半是服务跑着旧版本（改了代码要重启服务），重启后再测一次，这些格子上就会显示原因和 ⟳ 按钮':
    '{n} are online but yield no resolution and none of them reported a reason — most likely an old server build is still running (restart the server after code changes). Re-probe afterwards and these cells will show the reason and the ⟳ button',
  '↻ 补测没读到的 {n} 条': '↻ Refill {n} missing',
  '对这 {n} 条逐个用更大的窗口重读流头（每条最多 4MB、独立超时 25 秒），挖到关键帧就补上分辨率':
    'Re-read the stream head of these {n} channels with a much bigger window (up to 4MB each, 25s each) to catch a keyframe',
  '把这 {n} 条逐个用更大的窗口重读一遍？\n每条最多往下读 {mb}MB、独立超时 25 秒；挖到关键帧就补上分辨率，挖不到也照实记在表里，方便对照着判断窗口该不该再加大。':
    'Re-read these {n} channels with a much bigger window?\nUp to {mb}MB each with a 25s timeout per channel. Whatever a keyframe yields is filled in; whatever it does not is recorded as-is, so you can tell whether the window needs to grow.',
  '补测完这 {n} 条：挖到分辨率 {got} 条，仍没读到 {rest} 条（{parts}）':
    'Refill of {n} done: {got} got their resolution, {rest} still have none ({parts})',
  '纯音频': 'audio only',
  '没视频轨': 'no video track',
  '表在更后面': 'tables further in',
  '结构认不出': 'unrecognised container',
  '关键帧太远': 'keyframe too far',
  '分片取不到': 'segment unreachable',
  '源站没写': 'not declared by source',
  '没拿到码流': 'no payload received',
  '正在用更大的窗口重挖…': 'Digging deeper…',

  /* ---------- 后缀相关 ---------- */
  '回填分辨率到频道名': 'Fill resolution into channel names',
  '已有的手写分辨率后缀先用探测值覆盖（名字写 1080p、实测 480p 的会被纠正）':
    'Overwrite an existing handwritten resolution with the probed value (a name saying 1080p measured as 480p gets corrected)',
  '没探测到分辨率的频道保持原样（当前 {n} 条，不会动它们）':
    'Leave channels without a probed resolution untouched ({n} here)',
  '这些频道都没有探测出分辨率，没有可回填的值，频道名一个字都不会改。\n（先跑一遍探测，或换个能返回 HLS 主清单的源）':
    'None of these channels returned a resolution, so nothing will be written.\n(Run a probe first, or point it at a source that serves an HLS master playlist.)',
  '已回填 {n} 条频道名的分辨率后缀（另有 {rest} 条已是最新，无需改动）':
    'Resolution written into {n} channel names ({rest} already up to date)',
  '分辨率后缀已经是最新，无需改动': 'The resolution suffix is already up to date',
  '彻底清洗频道名后缀': 'Strip suffixes from channel names',
  '去掉末尾分辨率后缀（480p / 1080i / 4K …）': 'Strip the trailing resolution suffix (480p / 1080i / 4K …)',
  '去掉末尾延迟后缀（1043ms / 延迟135ms / [317ms] …）':
    'Strip the trailing latency suffix (1043ms / 延迟135ms / [317ms] …)',
  '这些频道名上没有可清掉的后缀': 'No suffix to strip on these channel names',
  '即将清掉 {n} 条频道名末尾的后缀，且不会再补回探测值。\n（如果只是想把探测结果写进名字，请用「回填分辨率 / 回填延迟」）\n继续？':
    'This strips the trailing suffix from {n} channel names and will not put any probed value back.\n(To write probe results into the names, use "Fill resolution" / "Fill latency")\nContinue?',
  '已清掉 {n} 条频道名的后缀，导出后再保存':
    'Stripped the suffix from {n} channel names — export or save afterwards',
  '回填延迟到频道名': 'Fill latency into channel names',
  '去掉末尾已有的延迟后缀（1043ms / 延迟135ms / [317ms]）':
    'Strip the existing trailing latency suffix (1043ms / 延迟135ms / [317ms])',
  '把探测到的延迟写成后缀（当前 {n} 条有可用延迟）':
    'Write the probed latency as a suffix ({n} have one)',
  '后缀模板（{ms} 换成毫秒数）': 'Suffix template ({ms} becomes the latency in ms)',
  '没测出延迟的也标出来，挑的时候一眼排掉':
    'Also mark channels with no latency so you can skip them at a glance',
  '标记文字': 'Marker text',
  '超时': 'timeout',
  '没有需要改的频道名': 'No channel name needs changing',
  '已更新 {n} 条频道名，导出后再保存': 'Updated {n} channel names — export or save afterwards',

  /* ---------- 排序 ---------- */
  '同名频道已经是按延迟排好的（没有需要挪位置的）':
    'Same-named channels are already sorted by latency',
  '已在同名频道组内按延迟重排，{n} 条的排列顺序有变化。导出或保存时会带上这个顺序。':
    'Reordered same-named channels by latency; {n} channel(s) moved. The order is kept on export / save.',

  /* ---------- 保存 ---------- */
  '覆盖写回原文件：\n{path}\n\n建议先导出一份副本。':
    'Overwrite the file:\n{path}\n\nExport a copy first.',
  '保存失败：{msg}': 'Failed to save: {msg}',
  '已覆盖保存。': 'Overwritten and saved.',

  /* ---------- LOGO / 新频道弹窗 ---------- */
  '补 LOGO 地址': 'Add LOGO URL',
  'LOGO 图片地址（填好后回车即写入 tvg-logo；留空表示去掉 LOGO）':
    'LOGO image URL (press Enter to write tvg-logo; leave blank to remove the LOGO)',
  '已写入 tvg-logo，导出后再保存': 'tvg-logo written — export or save afterwards',
  '已去掉这个频道的 LOGO': 'This channel’s LOGO removed',
  '频道显示名': 'Display name',
  '分组 group-title': 'Group (group-title)',
  'LOGO 地址 tvg-logo': 'LOGO URL (tvg-logo)',
  '播放地址': 'Stream URL',
  /* 「添加新频道」里对着地址框的实时检测 */
  '正在检测这条地址…': 'Probing this URL…',
  '这条地址没读到流内服务名（源站没写 SDT，或这条流连不上）':
    'No in-stream service name (the source has no SDT, or the stream is unreachable)',
  '流内服务名「{n}」，频道名已经填过了，不去覆盖':
    'In-stream name “{n}” — the display name is already set, not overwriting',
  '流内服务名「{n}」→ 已填入频道名，不用就自己改':
    'In-stream name “{n}” filled into the display name — edit it if you don’t want it',
  '流内服务名：{n}': 'In-stream service name: {n}',
};

let cur = null;

/** 浏览器/系统语言是简体或繁体中文就用中文，其余一律英文。 */
function guess() {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved && LANGS.includes(saved)) return saved;
  } catch {}
  const list = navigator.languages || (navigator.language ? [navigator.language] : []);
  return /^zh/i.test(list[0] || '') ? 'zh-CN' : 'en';
}

export const lang = () => cur || (cur = guess());

/**
 * 取一句文案。
 * @param {string} key 中文原文（漏翻时原样返回，界面绝不空白）
 * @param {Record<string, string|number>} [vars] 整句里的 {占位}
 */
export function t(key, vars) {
  let s = lang() === 'en' && EN[key] != null ? EN[key] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

/** 切语言：写进 localStorage、刷一遍静态属性、再广播给 app.js 重绘表格 */
export function setLang(l) {
  if (!LANGS.includes(l) || l === lang()) return lang();
  cur = l;
  try {
    localStorage.setItem(STORE, l);
  } catch {}
  applyStatic();
  window.dispatchEvent(new CustomEvent(EVENT));
  return cur;
}

export const toggleLang = () => setLang(lang() === 'en' ? 'zh-CN' : 'en');

/** app.js 订阅重绘 */
export function onLangChange(fn) {
  window.addEventListener(EVENT, fn);
}

/**
 * 把 [data-i18n] / [data-i18n-html] / [data-i18n-title] / [data-i18n-ph] 的文案刷回 DOM。
 * 切语言不动页面、不刷新：列表全在内存里，reload 会让人白改一轮。
 */
export function applyStatic(root = document) {
  document.documentElement.lang = lang();
  const mark = (sel, prop, attr) => {
    root.querySelectorAll(sel).forEach((el) => {
      const k = el.getAttribute(attr);
      if (k != null) el[prop] = t(k);
    });
  };
  mark('[data-i18n]', 'textContent', 'data-i18n');
  mark('[data-i18n-html]', 'innerHTML', 'data-i18n-html');
  mark('[data-i18n-title]', 'title', 'data-i18n-title');
  mark('[data-i18n-ph]', 'placeholder', 'data-i18n-ph');
  // 语言切换按钮自己那两个字
  const sw = document.getElementById('btnLang');
  if (sw) sw.textContent = lang() === 'en' ? '中文' : 'English';
  return root;
}

/** 顶栏那个「中 / EN」小按钮 */
export function mountLangSwitch() {
  const sw = document.getElementById('btnLang');
  if (sw) sw.addEventListener('click', toggleLang);
  applyStatic();
}
