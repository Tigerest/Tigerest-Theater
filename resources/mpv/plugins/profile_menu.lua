-- Tigerest Theater 的 UOSC 画质档菜单。
-- 只暴露用户确认的“默认 / 真人 / 激进测试”三档，并在切换后核对实际 shader 数量。

local mp = require('mp')
local utils = require('mp.utils')

local current_profile = 'tigerest-default'

local profiles = {
	{
		title = '默认',
		hint = 'Anime AA：SSim + Krig + ravu zoom',
		profile = 'tigerest-default',
		expected_shaders = 3,
	},
	{
		title = '真人',
		hint = '真人影视：SSim + ravu zoom',
		profile = 'tigerest-liveaction',
		expected_shaders = 2,
	},
	{
		title = '激进测试',
		hint = 'Anime4K 完整链，用于检查 shader 挂载',
		profile = 'tigerest-aggressive-test',
		expected_shaders = 4,
	},
}

local function find_profile(name)
	for _, item in ipairs(profiles) do
		if item.profile == name then
			return item
		end
	end
	return nil
end

local function current_title()
	local item = find_profile(current_profile)
	return item and item.title or current_profile
end

local function shader_count()
	local shaders = mp.get_property_native('glsl-shaders', {})
	local count = 0
	for _, shader in ipairs(shaders) do
		if type(shader) == 'string' and shader:match('%S') then
			count = count + 1
		end
	end
	return count
end

local function set_current_profile(name)
	if not find_profile(name) then
		return
	end
	current_profile = name
	mp.set_property_native('user-data/profile_menu/current', name)
end

local function update_button()
	local filters_payload = utils.format_json({
		icon = 'tune',
		tooltip = '滤镜: ' .. current_title(),
		command = 'script-binding profile_menu/open',
	})
	mp.commandv('script-message-to', 'uosc', 'set-button', 'filters', filters_payload)

	local diagnostics_payload = utils.format_json({
		icon = 'monitoring',
		tooltip = '播放诊断（打开后按 2 查看完整帧处理流程）',
		command = 'script-binding stats/display-stats-toggle',
	})
	mp.commandv('script-message-to', 'uosc', 'set-button', 'diagnostics', diagnostics_payload)

	local back_payload = utils.format_json({
		icon = 'arrow_back',
		tooltip = '返回媒体库',
		command = 'stop',
	})
	mp.commandv('script-message-to', 'uosc', 'set-button', 'tigerest-back', back_payload)
end

local function apply_profile(name)
	local item = find_profile(name)
	if not item then
		mp.commandv('show-text', '未知滤镜档位: ' .. tostring(name), 2400)
		return
	end

	-- mpv 的列表型选项在运行时应用 Profile 时可能累加，所以先显式清空外部 shader。
	mp.commandv('change-list', 'glsl-shaders', 'clr', '')
	mp.commandv('apply-profile', item.profile)

	local actual = shader_count()
	set_current_profile(item.profile)
	update_button()
	if actual == item.expected_shaders then
		mp.commandv('show-text', string.format('已切换滤镜: %s（%d 个 shader）', item.title, actual), 2400)
	else
		mp.commandv('show-text', string.format('滤镜切换失败: %s（预期 %d，实际 %d 个 shader）',
			item.title, item.expected_shaders, actual), 3200)
	end
end

local function build_menu()
	local items = {}
	for _, item in ipairs(profiles) do
		items[#items + 1] = {
			title = item.title,
			hint = item.hint,
			value = {'script-message-to', 'profile_menu', 'apply-profile', item.profile},
			active = current_profile == item.profile,
		}
	end
	return {
		type = 'profile-menu',
		title = '滤镜',
		hint = '切换默认、真人或 shader 链路测试档',
		items = items,
	}
end

local function open_menu()
	mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(build_menu()))
end

mp.register_script_message('apply-profile', apply_profile)
	mp.add_key_binding(nil, 'open', open_menu)
	mp.add_key_binding(nil, 'apply-default', function() apply_profile('tigerest-default') end)
	mp.add_key_binding(nil, 'apply-liveaction', function() apply_profile('tigerest-liveaction') end)
	mp.add_key_binding(nil, 'apply-aggressive-test', function() apply_profile('tigerest-aggressive-test') end)

-- 宿主在设置页应用初始档位或用原生快捷键切换后会写入该属性；观察它以同步菜单高亮。
mp.observe_property('user-data/profile_menu/current', 'string', function(_, value)
	if value and find_profile(value) and value ~= current_profile then
		current_profile = value
		update_button()
	end
end)

set_current_profile(current_profile)
update_button()
	mp.register_event('file-loaded', update_button)
