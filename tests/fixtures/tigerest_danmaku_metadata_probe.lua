local script_path = debug.getinfo(1, 'S').source
if script_path:sub(1, 1) == '@' then script_path = script_path:sub(2) end
local fixture_dir = script_path:match('^(.*)[/\\]') or '.'
local root = fixture_dir .. '/../../resources/mpv/plugins/uosc_danmaku'

package.path = root .. '/?.lua;' .. root .. '/?/init.lua;' .. package.path
require('modules/options')
require('modules/utils')

mp.register_script_message('tigerest-danmaku-probe', function()
    local title, season, episode = parse_title()
    mp.set_property('user-data/tigerest-test/title', title or '')
    mp.set_property('user-data/tigerest-test/season', season or '')
    mp.set_property('user-data/tigerest-test/episode', episode or '')
    mp.set_property_bool('user-data/tigerest-test/done', true)
end)

mp.register_script_message('tigerest-danmaku-autoload-probe', function()
    local should_init = false
    if type(should_initialize_enabled_stream) == 'function' then
        should_init = should_initialize_enabled_stream(
            true,
            'https://emby.example/emby/videos/72857/original.mkv',
            nil,
            false
        )
    end
    mp.set_property_bool('user-data/tigerest-test/should-init-stream', should_init)
    mp.set_property_bool('user-data/tigerest-test/done', true)
end)
