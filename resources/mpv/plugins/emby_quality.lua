-- Emby-aware UOSC streaming quality menu.
--
-- UOSC's built-in stream-quality menu changes ytdl-format and reloads the
-- current playlist entry. Emby URLs are already resolved media endpoints, so
-- that reload neither changes server bitrate nor preserves the web player's
-- lifecycle. This script only owns presentation; PlayerComponent forwards a
-- selected bitrate to Emby Web's playbackManager, which requests PlaybackInfo
-- again with the current position and track selections.

local mp = require('mp')
local utils = require('mp.utils')

local qualities = {
	{title = '自动', hint = '由 Emby 检测当前网络', bitrate = 0},
	{title = '120 Mbps', hint = '4K / 原盘高码率', bitrate = 120000000},
	{title = '80 Mbps', hint = '4K 高码率', bitrate = 80000000},
	{title = '60 Mbps', hint = '4K', bitrate = 60000000},
	{title = '40 Mbps', hint = '4K / 1080p 高码率', bitrate = 40000000},
	{title = '25 Mbps', hint = '1080p 高码率', bitrate = 25000000},
	{title = '20 Mbps', hint = '1080p', bitrate = 20000000},
	{title = '15 Mbps', hint = '1080p', bitrate = 15000000},
	{title = '10 Mbps', hint = '1080p / 720p', bitrate = 10000000},
	{title = '8 Mbps', hint = '720p', bitrate = 8000000},
	{title = '5 Mbps', hint = '720p', bitrate = 5000000},
	{title = '4 Mbps', hint = '720p / 480p', bitrate = 4000000},
	{title = '3 Mbps', hint = '480p', bitrate = 3000000},
	{title = '2 Mbps', hint = '480p', bitrate = 2000000},
	{title = '1 Mbps', hint = '360p', bitrate = 1000000},
}

local selected_bitrate = nil
local pending_bitrate = nil

local function find_quality(bitrate)
	for _, quality in ipairs(qualities) do
		if quality.bitrate == bitrate then return quality end
	end
	return nil
end

local function quality_title(bitrate)
	local quality = find_quality(bitrate)
	return quality and quality.title or tostring(bitrate) .. ' bps'
end

local function button_tooltip()
	if pending_bitrate ~= nil then
		return '正在切换流媒体品质: ' .. quality_title(pending_bitrate)
	end
	if selected_bitrate ~= nil then
		return '流媒体品质: ' .. quality_title(selected_bitrate)
	end
	return '流媒体品质'
end

local function update_button()
	local payload = utils.format_json({
		icon = 'high_quality',
		active = pending_bitrate ~= nil,
		tooltip = button_tooltip(),
		command = 'script-binding emby_quality/open',
	})
	mp.commandv('script-message-to', 'uosc', 'set-button', 'stream-quality', payload)
end

local function build_menu()
	local items = {}
	for _, quality in ipairs(qualities) do
		items[#items + 1] = {
			title = quality.title,
			hint = quality.hint,
			value = {'script-message-to', 'emby_quality', 'select', tostring(quality.bitrate)},
			active = selected_bitrate == quality.bitrate,
		}
	end
	return {
		type = 'emby-stream-quality',
		title = '流媒体品质',
		hint = '通过 Emby 服务器保留进度与音字轨切换码率',
		items = items,
	}
end

local function update_open_menu()
	if mp.get_property_native('user-data/uosc/menu/type') == 'emby-stream-quality' then
		mp.commandv('script-message-to', 'uosc', 'update-menu', utils.format_json(build_menu()))
	end
end

local function open_menu()
	mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(build_menu()))
end

local function select_quality(raw_bitrate)
	if pending_bitrate ~= nil then
		mp.commandv('show-text', '正在切换流媒体品质，请稍候', 1800)
		return
	end
	local bitrate = tonumber(raw_bitrate)
	if not bitrate or not find_quality(bitrate) then
		mp.commandv('show-text', '无效的码率档位', 2400)
		return
	end
	pending_bitrate = bitrate
	update_button()
	update_open_menu()
	mp.commandv('show-text', '正在切换至 ' .. quality_title(bitrate) .. '…', 1800)
	mp.commandv('script-message', 'tigerest-stream-quality', tostring(bitrate))
end

local function on_result(raw_bitrate, success, message)
	local bitrate = tonumber(raw_bitrate)
	if pending_bitrate ~= nil and bitrate ~= pending_bitrate then return end
	pending_bitrate = nil
	if success == 'yes' and bitrate and find_quality(bitrate) then
		selected_bitrate = bitrate
		mp.commandv('show-text', '已切换流媒体品质: ' .. quality_title(bitrate), 2400)
	else
		local reason = message and message ~= '' and message or '未知错误'
		mp.commandv('show-text', '流媒体品质切换失败: ' .. reason, 3200)
	end
	update_button()
	update_open_menu()
end

mp.register_script_message('select', select_quality)
mp.register_script_message('tigerest-stream-quality-result', on_result)
mp.add_key_binding(nil, 'open', open_menu)
mp.register_event('file-loaded', update_button)
update_button()
