-- Presentation only: menu values remain the original mpv commands.
local exact = {
    ['cycle pause'] = '暂停 / 继续', ['set pause yes'] = '暂停', ['set pause no'] = '继续播放',
    ['stop'] = '停止播放并返回媒体库', ['quit'] = '退出播放器',
    ['quit-watch-later'] = '记住进度并退出', ['frame-step'] = '下一帧',
    ['frame-back-step'] = '上一帧', ['playlist-next'] = '播放下一个',
    ['playlist-prev'] = '播放上一个', ['show-progress'] = '显示播放进度',
    ['revert-seek'] = '返回上次跳转位置', ['revert-seek mark'] = '标记跳转位置',
    ['ab-loop'] = '设置 / 清除 A-B 循环', ['ignore'] = '不执行操作',
    ['set speed 1'] = '恢复正常倍速', ['set speed 1.0'] = '恢复正常倍速',
    ['set fullscreen no'] = '退出全屏', ['set fullscreen yes'] = '进入全屏',
    ['set playlist-pos 0'] = '播放列表第一项',
    ['set playlist-pos-1 ${playlist-count}'] = '播放列表最后一项',
    ['screenshot'] = '截图（含字幕）', ['screenshot video'] = '截图（仅视频）',
    ['screenshot window'] = '截图（整个播放窗口）', ['screenshot each-frame'] = '开启 / 停止逐帧截图',
    ['show-text ${playlist}'] = '显示播放列表', ['show-text ${track-list}'] = '显示音视频与字幕轨道',
}

local properties = {
    pause = '暂停状态', fullscreen = '全屏', mute = '静音', volume = '音量', speed = '倍速',
    chapter = '章节', sub = '字幕轨道', sid = '字幕轨道', audio = '音轨', aid = '音轨',
    video = '视频轨道', vid = '视频轨道', edition = '视频版本', ontop = '窗口置顶',
    deband = '去色带', deinterlace = '反交错', interpolation = '插帧', hwdec = '硬件解码',
    ['sub-delay'] = '字幕延迟', ['audio-delay'] = '音频延迟', ['sub-scale'] = '字幕大小',
    ['sub-pos'] = '字幕位置', ['sub-visibility'] = '字幕显示',
    ['secondary-sub-visibility'] = '第二字幕显示', ['sub-ass-override'] = 'ASS 样式覆盖',
    ['sub-ass-use-video-data'] = 'ASS 视频参数', ['sub-forced-events-only'] = '仅强制字幕',
    contrast = '对比度', brightness = '亮度', gamma = '伽马', saturation = '饱和度',
    ['video-pan-x'] = '画面水平位置', ['video-pan-y'] = '画面垂直位置',
    ['video-align-x'] = '画面水平对齐', ['video-align-y'] = '画面垂直对齐',
    ['video-scale-x'] = '画面水平比例', ['video-scale-y'] = '画面垂直比例',
    ['video-zoom'] = '画面缩放', ['video-rotate'] = '画面旋转', panscan = '画面裁切',
    ['window-scale'] = '窗口大小', ['video-aspect-override'] = '画面宽高比',
    ['osd-level'] = '屏幕信息显示', ['loop-file'] = '单文件循环', ['loop-playlist'] = '列表循环',
}

local scripts = {
    ['commands/open'] = '打开 MPV 控制台', ['console/enable'] = '打开 MPV 控制台',
    ['console/open'] = '打开 MPV 控制台', ['osc/visibility'] = '切换原生控制栏显示',
    ['stats/display-stats'] = '显示播放统计', ['stats/display-stats-toggle'] = '开关播放统计',
    ['stats/display-page-1'] = '显示播放统计总览', ['stats/display-page-2'] = '显示帧处理统计',
    ['stats/display-page-4-toggle'] = '开关快捷键统计',
    ['profile_menu/apply-default'] = '切换到默认画质',
    ['profile_menu/apply-liveaction'] = '切换到真人画质',
    ['profile_menu/apply-aggressive-test'] = '切换到激进测试画质',
    ['profile_menu/open'] = '选择画质档位', ['emby_quality/open'] = '选择播放码率',
    ['uosc_danmaku/open_search_danmaku_menu'] = '搜索弹幕',
    ['uosc_danmaku/show_danmaku_keyboard'] = '开关弹幕',
    ['positioning/drag-to-pan'] = '拖动平移画面',
    ['uosc/menu'] = '打开播放器菜单', ['uosc/menu-blurred'] = '打开播放器菜单',
    ['uosc/keybinds'] = '查看快捷键', ['uosc/subtitles'] = '选择字幕',
    ['uosc/audio'] = '选择音轨', ['uosc/video'] = '选择视频轨道',
    ['uosc/audio-device'] = '选择音频设备', ['uosc/playlist'] = '选择播放列表项目',
    ['uosc/chapters'] = '选择章节', ['uosc/editions'] = '选择视频版本',
    ['uosc/stream-quality'] = '选择播放质量', ['uosc/open-file'] = '打开文件',
    ['uosc/open-file-blurred'] = '打开文件', ['uosc/items'] = '浏览播放列表 / 文件',
    ['uosc/prev'] = '播放上一个', ['uosc/next'] = '播放下一个',
    ['uosc/first'] = '播放第一项', ['uosc/last'] = '播放最后一项',
    ['uosc/toggle-ui'] = '开关播放控制界面', ['uosc/flash-ui'] = '显示播放控制界面',
    ['uosc/flash-timeline'] = '显示进度条', ['uosc/flash-volume'] = '显示音量',
    ['uosc/flash-top-bar'] = '显示顶部栏', ['uosc/flash-speed'] = '显示倍速',
    ['uosc/load-subtitles'] = '加载外部字幕', ['uosc/subtitle-line'] = '选择字幕行',
    ['uosc/shuffle'] = '开关随机播放', ['uosc/fullscreen'] = '切换全屏',
    ['select/select-playlist'] = '选择播放列表项目', ['select/select-sid'] = '选择字幕',
    ['select/select-secondary-sid'] = '选择第二字幕', ['select/select-aid'] = '选择音轨',
    ['select/select-vid'] = '选择视频轨道', ['select/select-track'] = '选择媒体轨道',
    ['select/select-chapter'] = '选择章节', ['select/select-edition'] = '选择视频版本',
    ['select/select-subtitle-line'] = '选择字幕行', ['select/select-audio-device'] = '选择音频设备',
    ['select/select-watch-history'] = '查看播放历史', ['select/select-watch-later'] = '查看稍后播放',
    ['select/select-binding'] = '查看原生快捷键列表', ['select/show-properties'] = '查看播放器属性',
    ['select/menu'] = '打开原生选择菜单',
}

local messages = {
    open_search_danmaku_menu = '搜索弹幕', toggle_danmaku = '开关弹幕', show_danmaku_keyboard = '开关弹幕',
    open_danmaku_menu = '打开弹幕菜单', open_danmaku_style_menu = '调整弹幕样式',
    open_source_delay_menu = '调整弹幕延迟', open_add_source_menu = '添加弹幕来源',
    open_add_total_menu = '添加弹幕', immediately_save_danmaku = '保存弹幕',
    ['clear-source'] = '清空弹幕来源',
}

local prefixes = {['no-osd'] = true, ['osd-auto'] = true, ['osd-bar'] = true,
    ['osd-msg'] = true, ['osd-msg-bar'] = true, ['raw'] = true, ['expand-properties'] = true,
    ['repeatable'] = true, ['nonrepeatable'] = true, ['async'] = true, ['sync'] = true}

local function describe(command)
    local normalized = command:match('^%s*(.-)%s*$')
    local prefix, rest = normalized:match('^(%S+)%s+(.+)$')
    while prefixes[prefix] do
        normalized = rest
        prefix, rest = normalized:match('^(%S+)%s+(.+)$')
    end
    if exact[normalized] then return exact[normalized] end
    -- Do not split quoted strings or compound commands; retain them verbatim.
    if normalized:find(';', 1, true) then return nil end
    local action, args = normalized:match('^(%S+)%s+(.+)$')
    if action == 'script-binding' then
        if scripts[args] then return scripts[args] end
        local page = args:match('^stats/display%-page%-(%d+)')
        if page then return '显示统计第 ' .. page .. ' 页' end
    elseif action == 'script-message' or action == 'script-message-to' then
        local message = action == 'script-message' and args:match('^(%S+)') or args:match('^%S+%s+(%S+)')
        return messages[message]
    elseif action == 'seek' then
        local number, flags = args:match('^([%+%-]?[%d%.]+)%s*(.*)$')
        local value = tonumber(number)
        if not value then return nil end
        local unit = flags:find('percent', 1, true) and '%' or ' 秒'
        if flags:find('absolute', 1, true) then return '跳转到 ' .. value .. unit end
        return (value < 0 and '后退 ' or '前进 ') .. math.abs(value) .. unit
    elseif action == 'sub-seek' then
        local value = tonumber(args)
        if value then return value < 0 and '跳到上一句字幕' or '跳到下一句字幕' end
    elseif action == 'sub-step' then
        local value = tonumber(args)
        if value then return value < 0 and '将上一句字幕对齐到当前画面' or '将下一句字幕对齐到当前画面' end
    elseif action == 'cycle' or action == 'cycle-values' then
        local property, direction = args:match('^(%S+)%s*(.*)$')
        if properties[property] then
            return '切换' .. properties[property] .. (direction == 'down' and '（反向）' or '')
        end
    elseif action == 'add' or action == 'set' or action == 'multiply' then
        local property, number = args:match('^(%S+)%s+(%S+)$')
        local name, value = properties[property], tonumber(number)
        if name and value then
            if action == 'set' then return '设置' .. name .. '为 ' .. number end
            if action == 'multiply' then return name .. '乘以 ' .. number end
            return name .. (value < 0 and '减少 ' or '增加 ') .. math.abs(value)
        end
        if property == 'speed' and action == 'multiply' and number == '1/1.1' then return '降低播放倍速' end
    end
end

return function(command)
    return (describe(command) or '自定义命令') .. '  ·  ' .. command
end
