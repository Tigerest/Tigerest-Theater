-- Tigerest Theater 专业模式的数据源。
-- 专业模式下视频缩到窗口一角，客户端网页在旁边显示调参面板和实时统计。
-- 这个脚本只在模式开启时工作：每 0.5 秒把统计写到 user-data/tigerest/pro/stats，
-- 面板关心的属性一有变化就写到 user-data/tigerest/pro/options，客户端观察这两个属性并转给网页。
-- 属性都在脚本线程读取，客户端的界面线程不等待 mpv。

local mp = require('mp')
local utils = require('mp.utils')

local STATS_INTERVAL = 0.5
local OPTIONS_DEBOUNCE = 0.03

local active = false
---@type string[] 面板要镜像的属性名，由客户端用 watch 消息给出。
local watched = {}
local options_pending = false
local stats_timer = nil

local function number(name) return mp.get_property_number(name) end
local function native(name) return mp.get_property_native(name) end

-- vo-passes 的每个处理步骤带 256 个采样，面板只需要最近值、平均值和峰值（纳秒）。
local function summarize_passes(list)
	local result, total = {}, 0
	if type(list) ~= 'table' then return result, total end
	for _, pass in ipairs(list) do
		result[#result + 1] = {desc = pass.desc, last = pass.last, avg = pass.avg, peak = pass.peak}
		total = total + (pass.avg or 0)
	end
	return result, total
end

local function collect_stats()
	local source = native('video-params') or {}
	local filtered = native('video-out-params') or {}
	local target = native('video-target-params') or {}
	local osd = native('osd-dimensions') or {}
	local cache = native('demuxer-cache-state') or {}
	local passes = native('vo-passes') or {}
	local audio_in = native('audio-params') or {}
	local audio_out = native('audio-out-params') or {}
	local fresh, fresh_total = summarize_passes(passes.fresh)
	local redraw, redraw_total = summarize_passes(passes.redraw)

	local filters = {}
	for _, filter in ipairs(native('vf') or {}) do
		filters[#filters + 1] = {name = filter.name, label = filter.label, enabled = filter.enabled}
	end

	return {
		time = mp.get_time(),
		title = mp.get_property('media-title'),
		pause = native('pause'),
		speed = number('speed'),
		position = number('time-pos'),
		duration = number('duration'),
		video = {
			codec = mp.get_property('video-format'),
			w = source.w, h = source.h,
			pixelformat = source.pixelformat,
			hw_pixelformat = source['hw-pixelformat'],
			colormatrix = source.colormatrix,
			colorlevels = source.colorlevels,
			primaries = source.primaries,
			gamma = source.gamma,
			max_luma = source['max-luma'],
			fps = number('container-fps'),
			output_fps = number('estimated-vf-fps'),
			bitrate = number('video-bitrate'),
			hwdec = mp.get_property('hwdec-current'),
			filtered_w = filtered.w, filtered_h = filtered.h,
		},
		output = {
			-- 视频窗口的像素尺寸，以及画面四周的黑边。
			w = osd.w, h = osd.h, ml = osd.ml, mr = osd.mr, mt = osd.mt, mb = osd.mb,
			primaries = target.primaries,
			gamma = target.gamma,
			max_luma = target['max-luma'],
			vo = mp.get_property('current-vo'),
			context = mp.get_property('current-gpu-context'),
		},
		display = {
			fps = number('display-fps'),
			measured = number('estimated-display-fps'),
			sync = mp.get_property('video-sync'),
			sync_active = native('display-sync-active'),
			ratio = number('vsync-ratio'),
			jitter = number('vsync-jitter'),
		},
		frames = {
			dropped = number('frame-drop-count'),
			decoder_dropped = number('decoder-frame-drop-count'),
			delayed = number('vo-delayed-frame-count'),
			mistimed = number('mistimed-frame-count'),
		},
		sync = {av = number('avsync'), total = number('total-avsync-change')},
		cache = {
			seconds = number('demuxer-cache-duration'),
			speed = number('cache-speed'),
			bytes = cache['fw-bytes'],
			buffering = native('paused-for-cache'),
		},
		audio = {
			codec = mp.get_property('audio-codec-name'),
			samplerate = audio_in.samplerate,
			channels = audio_in['hr-channels'] or audio_in.channels,
			format = audio_in.format,
			out_samplerate = audio_out.samplerate,
			out_channels = audio_out['hr-channels'] or audio_out.channels,
			out_format = audio_out.format,
			device = mp.get_property('current-ao'),
			bitrate = number('audio-bitrate'),
		},
		passes = {fresh = fresh, redraw = redraw, fresh_total = fresh_total, redraw_total = redraw_total},
		filters = filters,
	}
end

local function publish_stats()
	if active then mp.set_property_native('user-data/tigerest/pro/stats', collect_stats()) end
end

local function publish_options()
	options_pending = false
	if not active then return end
	local values = {}
	for _, name in ipairs(watched) do
		local value = native(name)
		if value ~= nil then values[name] = value end
	end
	mp.set_property_native('user-data/tigerest/pro/options', {
		values = values,
		-- 客户端发布的当前档位和档位列表（后者是 JSON 文本）。
		profile = native('user-data/profile_menu/current'),
		profiles = native('user-data/profile_menu/profiles'),
	})
end

-- 一次切档会连续改十几个属性，合并成一次发布。
local function schedule_options()
	if not active or options_pending then return end
	options_pending = true
	mp.add_timeout(OPTIONS_DEBOUNCE, publish_options)
end

local function observe_watched()
	mp.unobserve_property(schedule_options)
	if not active then return end
	for _, name in ipairs(watched) do
		mp.observe_property(name, 'native', schedule_options)
	end
	mp.observe_property('user-data/profile_menu/current', 'native', schedule_options)
	mp.observe_property('user-data/profile_menu/profiles', 'native', schedule_options)
end

local function update_button()
	mp.commandv('script-message-to', 'uosc', 'set-button', 'pro-mode', utils.format_json({
		icon = 'dashboard',
		active = active,
		tooltip = active and '退出专业模式（F2）' or '专业模式（F2）：边看边调画质，实时查看渲染统计',
		command = 'script-message tigerest-pro-toggle',
	}))
end

local function set_active(value)
	value = value == true
	if value == active then return end
	active = value
	observe_watched()
	if active then
		stats_timer = mp.add_periodic_timer(STATS_INTERVAL, publish_stats)
		publish_stats()
		schedule_options()
	elseif stats_timer then
		stats_timer:kill()
		stats_timer = nil
	end
	update_button()
end

mp.register_script_message('watch', function(json)
	local names = json and utils.parse_json(json)
	if type(names) ~= 'table' then return end
	watched = {}
	for _, name in ipairs(names) do
		if type(name) == 'string' and name ~= '' then watched[#watched + 1] = name end
	end
	observe_watched()
	schedule_options()
end)

-- 客户端决定模式的开关（页面、按钮和快捷键都经过它），这里只跟随。
mp.observe_property('user-data/tigerest/pro/active', 'native', function(_, value) set_active(value) end)

mp.add_key_binding('F2', 'toggle', function() mp.commandv('script-message', 'tigerest-pro-toggle') end)

update_button()
mp.register_event('file-loaded', update_button)
