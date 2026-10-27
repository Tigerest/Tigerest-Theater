local script_path = debug.getinfo(1, 'S').source
if script_path:sub(1, 1) == '@' then script_path = script_path:sub(2) end
local fixture_dir = script_path:match('^(.*)[/\\]') or '.'
local root = fixture_dir .. '/../../resources/mpv/plugins/uosc_danmaku'

package.path = root .. '/?.lua;' .. root .. '/?/init.lua;' .. package.path
require('modules/options')
require('modules/utils')
require('modules/mapping')

mp.register_script_message('tigerest-danmaku-routing-probe', function()
    local ok, err = pcall(function()
        local local_api = 'http://192.168.5.150:18443'
        local remote_api = 'https://nas.tigerest.top:18446'
        local retired_api = 'http://nas.tigerest.top:18443'
        local legacy_api = 'https://danmaku-api.152468.xyz'
        mp.set_property_native('user-data/tigerest/danmaku/api-server', local_api)
        assert(get_api_server_list(options.api_server)[1] == local_api, 'LAN playback did not use LAN API')
        assert(get_api_server_list(legacy_api)[1] == local_api, 'legacy default was not migrated')
        mp.set_property_native('user-data/tigerest/danmaku/api-server', remote_api)
        assert(get_api_server_list(local_api)[1] == remote_api, 'LAN history survived switch to remote playback')
        assert(get_api_server_list(retired_api)[1] == remote_api, 'the retired public address was used')
        assert(get_api_server_list('https://custom.example/api')[1] == 'https://custom.example/api', 'custom API was overwritten')
        require('apis/dandanplay')
        DANMAKU = { sources = {}, api_server = local_api }
        write_history = function() end
        set_danmaku_button = function() end
        local fetched_server
        fetch_danmaku = function(_, _, server) fetched_server = server end
        set_episode_id(176170001, false, legacy_api)
        assert(fetched_server == remote_api, 'episode restored a stale API address')
        mp.set_property_native('user-data/tigerest/danmaku/client-headers', {
            ['X-Tigerest-Client-Name'] = 'Tigerest Theater', ['X-Tigerest-Client-Version'] = '2.9.5',
            ['X-Tigerest-Client-Platform'] = 'Windows', ['X-Tigerest-Client-Extra'] = 'a\r\nInjected: 1'})
        local function sent_headers(list)
            local found = {}
            for i = 2, #list do if list[i - 1] == '-H' then found[#found + 1] = list[i] end end
            return table.concat(found, '\n')
        end
        local args = make_danmaku_request_args('GET', remote_api .. '/api/v2/search/anime?keyword=test')
        for _, arg in ipairs(args) do
            assert(not arg:match('^X%-App'), 'upstream credentials were sent by the client')
        end
        local sent = sent_headers(args)
        for _, header in ipairs({'X-Tigerest-Client-Name: Tigerest Theater', 'X-Tigerest-Client-Version: 2.9.5',
            'X-Tigerest-Client-Platform: Windows'}) do
            assert(sent:find(header, 1, true), 'our service did not receive ' .. header)
        end
        assert(not sent:find('Injected', 1, true), 'a header value with a line break was sent')
        local custom = sent_headers(make_danmaku_request_args('GET', 'https://custom.example/api/v2/search/anime?keyword=test'))
        assert(not custom:find('X-Tigerest', 1, true), 'another provider received the client headers')
        assert(#managed_client_headers('http://192.168.5.150:18443') == 3, 'the LAN service did not receive the client headers')
        assert(#managed_client_headers(retired_api) == 0, 'the retired public address received the client headers')
    end)
    mp.set_property('user-data/tigerest-test/error', ok and '' or tostring(err))
    mp.set_property_bool('user-data/tigerest-test/done', true)
end)

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
