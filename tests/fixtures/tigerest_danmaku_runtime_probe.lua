-- Run the real Lua entry points with a deterministic mpv event loop. Network,
-- OSD submission and media properties are the only substituted boundaries.
local original_mp = mp
local unpack = unpack or table.unpack
local fixture = debug.getinfo(1, 'S').source:sub(2):match('^(.*)[/\\]')
local root = fixture .. '/../../resources/mpv/plugins/uosc_danmaku/'

local function sandbox(integration, mapping)
    local env = setmetatable({}, {__index = _G})
    env._G = env
    local props = {pause = false, ['time-pos'] = 10, ['display-fps'] = 120,
        ['osd-width'] = 1920, ['osd-height'] = 1080, vf = {}, speed = 1,
        path = 'https://example.test/video.mkv', ['filename/no-ext'] = 'video',
        ['current-tracks/video'] = {}, duration = 1200, ['container-fps'] = 24}
    local events, observers, messages, timers, overlays, requests, request_args = {}, {}, {}, {}, {}, {}, {}
    local now, visible = 0, true
    local api = {msg = original_mp.msg}
    local function load_script(name)
        local fn, err
        if setfenv then fn, err = loadfile(root .. name); if fn then setfenv(fn, env) end
        else fn, err = loadfile(root .. name, 't', env) end
        assert(fn, err)
        return fn()
    end
    function api.get_property_native(name, fallback)
        if props[name] == nil then return fallback end
        return props[name]
    end
    api.get_property = api.get_property_native
    api.get_property_number = api.get_property_native
    api.get_property_bool = api.get_property_native
    function api.set_property_native(name, value) props[name] = value; return true end
    api.set_property = api.set_property_native
    api.set_property_bool = api.set_property_native
    function api.get_time() return now end
    function api.get_script_name() return 'uosc_danmaku' end
    function api.commandv() end
    function api.command_native(args) return args[2] end
    function api.command_native_async(args, callback)
        requests[#requests + 1] = callback
        request_args[#requests] = args.args
        return #requests
    end
    function api.abort_async_command() end
    function api.register_event(name, fn)
        events[name] = events[name] or {}; table.insert(events[name], fn)
    end
    function api.add_hook(name, _, fn) api.register_event(name, fn) end
    function api.register_script_message(name, fn) messages[name] = fn end
    function api.add_key_binding() end
    function api.observe_property(name, _, fn)
        observers[name] = observers[name] or {}; table.insert(observers[name], fn)
    end
    function api.unobserve_property(fn)
        for _, list in pairs(observers) do
            for i = #list, 1, -1 do if list[i] == fn then table.remove(list, i) end end
        end
    end
    function api.add_timeout(timeout, fn, disabled)
        local timer = {timeout = timeout, callback = fn, enabled = not disabled, due = now + timeout}
        function timer:kill() self.enabled = false end
        function timer:resume() self.enabled = true; self.due = now + self.timeout end
        function timer:is_enabled() return self.enabled end
        timers[#timers + 1] = timer
        return timer
    end
    function api.add_periodic_timer(timeout, fn)
        local timer = api.add_timeout(timeout, fn)
        timer.periodic = true
        return timer
    end
    function api.create_osd_overlay()
        local overlay = {updates = 0}
        function overlay:update() self.updates = self.updates + 1; self.removed = false end
        function overlay:remove() self.removed = true end
        overlays[#overlays + 1] = overlay
        return overlay
    end
    env.mp = api
    env.require = function(name)
        if name == 'mp.msg' then return original_mp.msg end
        if name == 'mp.utils' then return require('mp.utils') end
        if name == 'mp.options' then return {read_options = function() end} end
        if name == 'modules/utils' or name == 'modules/http' or name == 'modules/options' or name == 'modules/mapping'
            or (mapping and name == 'modules/menu')
            or (integration and (name == 'modules/parse' or name == 'modules/guess'
                or name == 'modules/render' or name == 'apis/dandanplay')) then
            return load_script(name .. '.lua')
        end
        return {}
    end
    load_script('main.lua')
    if not integration then
        env.get_danmaku_visibility = function() return visible end
        env.set_danmaku_visibility = function(value) visible = value end
    end
    env.toggle_danmaku_switch = function() end
    local restore_sources = env.read_danmaku_source_record
    env.read_danmaku_source_record = function() end
    env.show_message = function() end
    if not integration then env.show_loaded = function() end end
    env.file_exists = function() return false end
    env.save_danmaku = function() end
    local state = {env = env, props = props, overlays = overlays, requests = requests,
        messages = messages, restore_sources = restore_sources, request_args = request_args}
    function state.emit(name)
        for _, fn in ipairs(events[name] or {}) do fn({}) end
    end
    function state.set(name, value)
        props[name] = value
        local copy = {}; for _, fn in ipairs(observers[name] or {}) do copy[#copy + 1] = fn end
        for _, fn in ipairs(copy) do fn(name, value) end
    end
    function state.advance(seconds, wake_delay)
        local finish = now + seconds
        for _ = 1, 10000 do
            local next_timer
            for _, timer in ipairs(timers) do
                if timer.enabled and timer.due <= finish and (not next_timer or timer.due < next_timer.due) then
                    next_timer = timer
                end
            end
            if not next_timer then break end
            now = next_timer.due + (wake_delay or 0)
            if now > finish then break end
            next_timer.enabled = next_timer.periodic or false
            next_timer.due = now + next_timer.timeout
            next_timer.callback()
        end
        now = finish
    end
    function state.start_render()
        load_script('modules/render.lua')
        env.ENABLED = true
        env.COMMENTS = {{start_time = 0, end_time = 30, move = {1920, 50, -1920, 50},
            text = '{\\move(1920,50,-1920,50)}test'}}
        for _, name in ipairs({'osd-width', 'osd-height', 'pause', 'display-fps'}) do state.set(name, props[name]) end
        env.show_danmaku_func()
        state.set('time-pos', 10)
    end
    function state.respond(index, data)
        assert(requests[index], 'Expected HTTP request ' .. index)
        local body = require('mp.utils').format_json(data)
        for _, arg in ipairs(request_args[index]) do if arg == '--include' then body = 'HTTP/1.1 200 OK\r\n\r\n' .. body; break end end
        requests[index](true, {status = 0, stdout = body})
        state.advance(0.1)
    end
    if integration then
        local history
        env.read_file = function() return history end
        env.write_json_file = function(_, value) history = require('mp.utils').format_json(value) end
        function state.set_history(value) history = value and require('mp.utils').format_json(value) end
        function state.history() return history and require('mp.utils').parse_json(history) end
        props['user-data/tigerest/emby/valid'] = true
        props['user-data/tigerest/emby/series-name'] = 'Fixture series'
        props['user-data/tigerest/emby/season-number'] = 1
        props['user-data/tigerest/emby/episode-number'] = 3
        props['media-title'] = 'Fixture series S01E03'
        -- Existing matcher regressions explicitly exercise third-party legacy APIs.
        if not mapping then env.options.api_server = 'http://legacy.example.test' end
    end
    return state
end

local cases = {}
local function mapping_reply(s, index, origin, episode, text)
    s.requests[index](true, {status=0, stdout='HTTP/1.1 200 OK\r\n\r\n' .. require('mp.utils').format_json({
        success=true, matched=true, match={origin=origin, bangumiId='tmdb-55', episodeId=episode,
            animeTitle='Chosen work', episodeTitle=text}, danmaku={count=1, comments={{p='10,1,16777215',m=text}}}})})
end
local function http_reply(s, index, status, data, headers, curl)
    s.requests[index](true, {status=curl or 0, stdout='HTTP/1.1 ' .. status .. ' Fixture\r\n' .. (headers or '') .. '\r\n' .. require('mp.utils').format_json(data or {})})
end
local function comment_request(s)
    s.env.ENABLED = true
    s.env.fetch_danmaku('198760001', false, 'https://nas.tigerest.top:18446')
end
function cases.comment_timeout_retries_once_then_loads()
    local s=sandbox(true,true); comment_request(s)
    s.requests[1](true,{status=28,stdout='',stderr='PRIVATE-RESPONSE'})
    assert(s.env.is_async_running(),'Retry backoff remains part of the active load')
    s.advance(0.9); assert(#s.requests==1,'Retry must be delayed')
    s.advance(0.2); assert(#s.requests==2,'Timeout must automatically retry once')
    http_reply(s,2,200,{count=1,comments={{p='10,1,16777215',m='Recovered'}}})
    assert(s.env.COMMENTS and #s.env.COMMENTS==1,'Retry response must reach renderer')
    assert(not s.env.is_async_running(),'Completed retry releases loading state')
    s.advance(10); assert(#s.requests==2,'Only one retry is allowed')
end
function cases.comment_gateway_failure_retries_but_stops_at_two_attempts()
    for _,status in ipairs({408,502,503,504}) do
        local s=sandbox(true,true); local notice=''; s.env.show_message=function(value) notice=value end
        comment_request(s); http_reply(s,1,status,{success=false}); s.advance(1.1)
        assert(#s.requests==2,'Transient HTTP failure retries')
        http_reply(s,2,status,{success=false}); s.advance(5)
        assert(#s.requests==2 and not s.env.is_async_running(),'Exhausted retry must stop and release loading state')
        assert(notice:find(tostring(status),1,true),'Final failure identifies the HTTP status')
    end
end
function cases.comment_empty_and_client_errors_are_not_retried()
    for _,status in ipairs({200,400,401,403,404,429}) do
        local s=sandbox(true,true); comment_request(s)
        http_reply(s,1,status,{count=0,comments={}},status==429 and 'Retry-After: 60\r\n' or nil)
        s.advance(2); assert(#s.requests==1,'Empty responses and client/rate errors must not retry')
        assert(s.env.COMMENTS==nil,'No fabricated comments on empty/error')
        assert(not s.env.is_async_running(),'Terminal response releases loading state')
        if status==429 then
            assert(s.env.mapping_retry_after('http://192.168.5.150:18443')>0,'GET limit applies to both NAS addresses')
            s.env.fetch_danmaku('198760002',false,'http://192.168.5.150:18443')
            assert(#s.requests==1,'GET limit must prevent another NAS request')
        end
    end
end
function cases.pending_comment_retry_is_cancelled_on_unload_or_manual_selection()
    for _,action in ipairs({'unload','manual','account'}) do
        local s=sandbox(true,true); comment_request(s)
        s.requests[1](true,{status=28,stdout=''});
        if action=='unload' then s.emit('on_unload')
        elseif action=='manual' then s.env.begin_manual_danmaku_selection()
        else s.set('user-data/tigerest/danmaku/auth-generation','1'); s.set('user-data/tigerest/danmaku/auth-generation','2') end
        s.advance(2); assert(#s.requests==1,'Cancelled playback/selection/account cannot start old retry')
        assert(not s.env.is_async_running(),'Cancelled retry releases loading state')
        http_reply(s,1,200,{count=1,comments={{p='10,1,16777215',m='STALE'}}})
        assert(s.env.COMMENTS==nil,'Late completion after cancellation cannot load')
    end
end
function cases.shared_lookup_retries_readonly_then_loads_without_get()
    local s=sandbox(true,true); s.emit('file-loaded'); http_reply(s,1,504,{success=false})
    s.advance(1.1); assert(#s.requests==2,'Shared lookup retries instead of starting legacy matching')
    assert(s.request_args[2][#s.request_args[2]]:find('/api/tigerest/v1/danmaku',1,true),'Retry stays on shared lookup')
    local args=s.request_args[2]; local body
    for i,value in ipairs(args) do if value=='--data-binary' then body=require('mp.utils').parse_json(args[i+1]) end end
    assert(body and not body.selection,'Automatic retry must never write a shared mapping')
    mapping_reply(s,2,'shared','198760001','Recovered shared comments')
    assert(#s.requests==2 and s.env.COMMENTS and #s.env.COMMENTS==1,'Successful shared retry must not issue redundant GET')
end
function cases.pending_shared_retry_is_cancelled_by_manual_choice()
    local s=sandbox(true,true); s.emit('file-loaded'); http_reply(s,1,503,{success=false})
    s.env.begin_manual_danmaku_selection();s.advance(2)
    assert(#s.requests==1,'Manual choice cancels pending shared retry and fallback')
end
function cases.terminal_http_error_wins_over_partial_body_transport_failure()
    for _,status in ipairs({400,401,403,404,429}) do
        for _,code in ipairs({18,28,56}) do
            local s=sandbox(true,true); comment_request(s)
            http_reply(s,1,status,{success=false},nil,code); s.advance(2)
            assert(#s.requests==1 and not s.env.is_async_running(),'Terminal HTTP status forbids retry even if its body is incomplete')
        end
    end
end
function cases.rate_limit_received_during_backoff_blocks_the_retry()
    local s=sandbox(true,true); comment_request(s)
    s.requests[1](true,{status=28,stdout=''})
    s.env.mapping_record_rate_limit('http://192.168.5.150:18443','120')
    s.advance(2)
    assert(#s.requests==1 and not s.env.is_async_running(),'New server cooldown must prevent queued retries')
end
function cases.http_network_failure_retries_but_tls_and_size_errors_do_not()
    for _,code in ipairs({6,7,18,28,52,55,56,60,63}) do
        local s=sandbox(true,true);comment_request(s)
        s.requests[1](true,{status=code,stdout='',stderr='PRIVATE-ERROR'})
        s.advance(1.1)
        assert(#s.requests==((code==60 or code==63) and 1 or 2),'Retry only transient network failures')
        s.emit('on_unload')
    end
end
function cases.http_redirect_and_proxy_headers_keep_final_body()
    local s=sandbox(true,true); comment_request(s)
    s.requests[1](true,{status=0,stdout='HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 302 Found\r\nLocation: /new\r\n\r\nHTTP/2 200\r\nContent-Type: application/json\r\n\r\n{"count":1,"comments":[{"p":"10,1,16777215","m":"Redirected"}]}'})
    assert(s.env.COMMENTS and #s.env.COMMENTS==1,'Only final headers may precede parsed comments')
end
function cases.successful_malformed_body_is_not_an_infinite_retry()
    local s=sandbox(true,true);comment_request(s)
    s.requests[1](true,{status=0,stdout='HTTP/1.1 200 OK\r\n\r\nnot json or xml'})
    s.advance(3)
    assert(#s.requests==1 and not s.env.is_async_running() and s.env.COMMENTS==nil,'Invalid bodies terminate without inventing comments or indefinite retries')
end
function cases.api_requests_have_connection_and_total_deadlines()
    local s=sandbox(true,true)
    local args=s.env.make_danmaku_request_args('GET','https://nas.tigerest.top:18446/api/v2/comment/198760001')
    local connection,total
    for i,v in ipairs(args) do if v=='--connect-timeout' then connection=tonumber(args[i+1]) elseif v=='--max-time' then total=tonumber(args[i+1]) end end
    assert(connection and connection<=5 and total and total<=20,'Legacy API subprocess must have bounded connection and total duration')
end
function cases.manual_selection_wins_over_delayed_shared_hit()
    local s = sandbox(true, true)
    s.emit('file-loaded')
    s.props['user-data/tigerest/danmaku/mapping-auth-file'] = '/private/header'
    s.env.io = setmetatable({open=function() return {read=function() return 'Authorization: Bearer fixture-token\n' end,close=function() end} end},{__index=io})
    s.env.set_episode_id('55555',true,'https://nas.tigerest.top:18446','tmdb-55',s.env.mapping_playback_token())
    mapping_reply(s,2,'manual','55555','MANUAL_CHOICE')
    mapping_reply(s,1,'shared','11111','DELAYED_AUTO')
    assert(s.env.DANMAKU.episode == 'MANUAL_CHOICE' and s.env.DANMAKU.mapping_origin == 'manual',
        'A delayed auto lookup for the same file must not replace an explicit selection')
end
function cases.manual_selection_prevents_delayed_lookup_fallback()
    local s = sandbox(true, true)
    s.emit('file-loaded')
    s.props['user-data/tigerest/danmaku/mapping-auth-file'] = '/private/header'
    s.env.io = setmetatable({open=function() return {read=function() return 'Authorization: Bearer fixture-token\n' end,close=function() end} end},{__index=io})
    s.env.set_episode_id('55555',true,'https://nas.tigerest.top:18446','tmdb-55',s.env.mapping_playback_token())
    mapping_reply(s,2,'manual','55555','MANUAL_CHOICE')
    s.requests[1](true,{status=0,stdout='HTTP/1.1 200 OK\r\n\r\n{"success":true,"matched":false}'})
    assert(#s.requests == 2,'An old lookup miss must not start a legacy chain after manual selection')
end
function cases.manual_selection_cancels_existing_legacy_chain()
    local s = sandbox(true, true)
    s.emit('file-loaded')
    s.requests[1](true,{status=0,stdout='HTTP/1.1 200 OK\r\n\r\n{"success":true,"matched":false}'})
    assert(#s.requests == 2,'Expected pending legacy anime lookup')
    s.props['user-data/tigerest/danmaku/mapping-auth-file'] = '/private/header'
    s.env.io = setmetatable({open=function() return {read=function() return 'Authorization: Bearer fixture-token\n' end,close=function() end} end},{__index=io})
    s.env.set_episode_id('55555',true,'https://nas.tigerest.top:18446','tmdb-55',s.env.mapping_playback_token())
    mapping_reply(s,3,'manual','55555','MANUAL_CHOICE')
    s.respond(2,{animes={{type='tvseries',animeTitle='Fixture series',bangumiId='42'}}})
    assert(#s.requests == 3,'Pending legacy matching must not resume after an explicit choice')
    assert(s.env.DANMAKU.episode == 'MANUAL_CHOICE','The existing legacy chain must preserve the manual choice')
end
function cases.anime_search_selection_keeps_original_playback_identity()
    local s = sandbox(true,true)
    s.env.uosc_available = true
    s.env.update_menu_uosc = function(_,_,items) return require('mp.utils').format_json({items=items}) end
    s.env.get_animes('Fixture series')
    s.respond(1,{animes={{animeTitle='Work A catalog',bangumiId='tmdb-11'}}})
    local menu = require('mp.utils').parse_json(s.env.latest_menu_anime)
    local row = menu.items[1].value
    s.emit('on_unload')
    s.props.path = 'https://example.test/replacement.mkv'
    s.props['user-data/tigerest/emby/series-name'] = 'Work B'
    s.messages['search-episodes-event'](unpack(row,4))
    assert(#s.requests == 1,'A cached anime selection from work A must not fetch or calibrate against work B')
    assert(s.env.latest_menu_anime == nil or s.env.latest_menu_anime == '' or #s.env.latest_menu_anime == 0,
        'Unload must invalidate cached anime menus')
end
function cases.shared_lookup_precedes_local_history_and_uses_complete_response()
    local s = sandbox(true, true)
    s.set_history({show_danmaku = true, ['Fixture series Season1'] = {
        fname = 'Fixture series S01E03', episodeNumber = 3, episodeId = 123,
        animeTitle = 'Wrong previous title', episodeTitle = 'Wrong previous episode'}})
    s.emit('file-loaded')
    local args = s.request_args[1]
    assert(args and args[#args] == 'https://nas.tigerest.top:18446/api/tigerest/v1/danmaku',
        'Every playback must look up shared mapping before reusing history')
    local body
    for i, value in ipairs(args) do if value == '--data-binary' then body = require('mp.utils').parse_json(args[i + 1]) end end
    assert(body and body.source.title == 'Fixture series' and body.source.season == 1 and body.source.episode == 3,
        'Lookup must retain exact original metadata identity')
    assert(not body.selection, 'Automatic lookup cannot calibrate')
    s.requests[1](true, {status = 0, stdout = 'HTTP/1.1 200 OK\r\n\r\n' .. require('mp.utils').format_json({
        success = true, matched = true, match = {origin = 'shared', bangumiId = 'tmdb-42',
            episodeId = '999999999', animeTitle = 'Catalog title', episodeTitle = 'Catalog episode'},
        danmaku = {count = 1, comments = {{p = '10,1,16777215', m = 'Shared response'}}}})})
    assert(#s.requests == 1 and s.env.COMMENTS and #s.env.COMMENTS == 1,
        'A shared hit must load the full response without another GET or history matching')
    assert(s.env.DANMAKU.mapping_origin == 'shared', 'Shared provenance must remain visible')
end
function cases.shared_lookup_miss_falls_back_and_stale_response_is_discarded()
    local s = sandbox(true, true)
    s.emit('file-loaded')
    assert(s.request_args[1][#s.request_args[1]]:find('/api/tigerest/v1/danmaku', 1, true), 'Expected shared lookup')
    s.requests[1](true, {status = 0, stdout = 'HTTP/1.1 200 OK\r\n\r\n{"success":true,"matched":false,"reason":"no-mapping"}'})
    assert(s.request_args[2][#s.request_args[2]]:find('/search/anime?', 1, true), 'A mapping miss must retain legacy matching')
    local stale = sandbox(true, true)
    stale.emit('file-loaded'); stale.emit('on_unload')
    stale.props['user-data/tigerest/emby/episode-number'] = 4
    stale.requests[1](true, {status = 0, stdout = 'HTTP/1.1 200 OK\r\n\r\n{"success":true,"matched":false}'})
    assert(#stale.requests == 1 and stale.env.COMMENTS == nil, 'Stale lookup must neither load nor start fallback for replacement media')
end
local function mapping_header(s)
    s.props['user-data/tigerest/danmaku/mapping-auth-file'] = '/private/fixture-header'
    s.env.io = setmetatable({open = function(path)
        assert(path == '/private/fixture-header', 'Only the private header may be opened')
        return {read=function() return 'Authorization: Bearer fixture-private-token\n' end, close=function() end}
    end}, {__index=io})
end
function cases.legacy_authorization_requires_explicit_generation_mode()
    local legacy = sandbox(true, true); mapping_header(legacy)
    legacy.props['user-data/tigerest/danmaku/auth-generation'] = 'legacy:9'
    legacy.env.set_episode_id('99000005',true,'https://nas.tigerest.top:18446','99',legacy.env.mapping_playback_token())
    assert(legacy.request_args[1][#legacy.request_args[1]]:find('/api/tigerest/v1/danmaku',1,true),
        'Explicit eligible legacy generation must preserve the configured mapping token')
    local ordinary = sandbox(true, true); mapping_header(ordinary)
    ordinary.props['user-data/tigerest/danmaku/auth-generation'] = '9'
    ordinary.env.set_episode_id('99000005',true,'https://nas.tigerest.top:18446','99',ordinary.env.mapping_playback_token())
    assert(ordinary.request_args[1][#ordinary.request_args[1]]:find('/comment/99000005?',1,true),
        'Ordinary session generation must never reinterpret a Bearer file as legacy authorization')
end
function cases.logged_in_emby_session_saves_without_admin_json_and_cancels_on_switch()
    local s = sandbox(true, true); mapping_header(s)
    s.props['user-data/tigerest/danmaku/auth-generation'] = '7'
    s.env.io = setmetatable({open = function()
        return {read=function() return 'X-Emby-Token: fixture-session-secret\r\nX-Emby-Server-Id: 62526c3bf747439c99327ddec5fed4a8\r\nX-Emby-User-Id: fixture-user\r\n' end, close=function() end}
    end}, {__index=io})
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', 'tmdb-99', s.env.mapping_playback_token())
    local args=s.request_args[1]
    assert(args[#args]:find('/api/tigerest/v1/danmaku',1,true), 'Ordinary Emby session must save shared binding without administrator JSON')
    for _,value in ipairs(args) do assert(not value:find('fixture-session-secret',1,true), 'Session token must stay out of command arguments') end
    s.props['user-data/tigerest/danmaku/auth-generation'] = '8'
    s.requests[1](true, {status=0,stdout='HTTP/1.1 401 Unauthorized\r\n\r\n{}'})
    assert(#s.requests==1, 'Account switch invalidates old response and its fallback')
end
function cases.explicit_selection_uses_original_identity_and_private_header_reference()
    local s = sandbox(true, true); mapping_header(s)
    s.env.DANMAKU.anime, s.env.DANMAKU.episode = 'Selected catalog title', 'Catalog E5'
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', 'tmdb-99', s.env.mapping_playback_token())
    local args, body = s.request_args[1]
    for i, value in ipairs(args) do
        assert(not value:find('fixture-private-token', 1, true), 'Credential cannot appear in subprocess arguments')
        if value == '--data-binary' then body = require('mp.utils').parse_json(args[i + 1]) end
    end
    assert(body.source.title == 'Fixture series' and body.source.episode == 3 and body.source.season == 1,
        'Manual selection must preserve the original source, even when selected catalog numbering differs')
    assert(body.selection.bangumiId == 'tmdb-99' and body.selection.episodeId == '99000005', 'Both selected IDs must travel unchanged')
    local header = false; for _, value in ipairs(args) do if value == '@/private/fixture-header' then header = true end end
    assert(header, 'curl receives only a reference to the private header')
    s.requests[1](true, {status=0, stdout='HTTP/1.1 200 OK\r\n\r\n' .. require('mp.utils').format_json({success=true,matched=true,
        match={origin='manual',episodeId='99000005',bangumiId='tmdb-99',animeTitle='Selected catalog title',episodeTitle='Catalog E5'},
        danmaku={count=1,comments={{p='10,1,16777215',m='Manual response'}}}})})
    assert(#s.requests == 1 and #s.env.COMMENTS == 1 and s.env.DANMAKU.mapping_origin == 'manual',
        'Successful manual POST replaces the GET entirely')
end
function cases.manual_post_failure_loads_exact_chosen_id_and_reports_unsaved_mapping()
    local s = sandbox(true, true); mapping_header(s)
    local notice
    s.env.show_message = function(value) notice = value end
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', 'tmdb-99', s.env.mapping_playback_token())
    s.requests[1](true, {status=0, stdout='HTTP/1.1 503 Busy\r\n\r\n{"success":false}'})
    assert(s.request_args[2][#s.request_args[2]]:find('/comment/99000005?',1,true), 'Failure must fetch the chosen episode without ID arithmetic')
    s.respond(2,{count=1,comments={{p='10,1,16777215',m='Legacy fallback'}}})
    assert(notice == '弹幕已加载，但共享匹配未保存', 'Fallback must not imply that calibration was saved')
end
function cases.no_token_third_party_unknown_season_and_stale_manual_are_legacy_only()
    local no_token = sandbox(true, true)
    no_token.env.set_episode_id('99000005',true,'https://nas.tigerest.top:18446','99',no_token.env.mapping_playback_token())
    assert(no_token.request_args[1][#no_token.request_args[1]]:find('/comment/99000005?',1,true), 'No token selects legacy GET')
    local third = sandbox(true, true); mapping_header(third)
    third.env.set_episode_id('99000005',true,'https://third.example.test','99',third.env.mapping_playback_token())
    assert(third.request_args[1][#third.request_args[1]]:find('https://third.example.test/api/v2/comment/',1,true), 'Third parties never receive the mapping protocol')
    for _, season in ipairs({-1,0,1.5,1001}) do
        local unknown = sandbox(true, true); unknown.props['user-data/tigerest/emby/season-number'] = season
        unknown.emit('file-loaded')
        assert(not unknown.request_args[1][#unknown.request_args[1]]:find('/tigerest/',1,true), 'Unknown seasons and specials must not be guessed')
    end
    local stale = sandbox(true,true); mapping_header(stale)
    local token = stale.env.mapping_playback_token(); stale.emit('on_unload')
    stale.env.set_episode_id('99000005',true,'https://nas.tigerest.top:18446','99',token)
    assert(#stale.requests == 0, 'Stale menu selection must never calibrate the replacement playback')
end
function cases.missing_write_token_does_not_imply_shared_binding_was_saved()
    local s = sandbox(true, true)
    local notice
    s.env.show_message = function(value) notice = value end
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', '99', s.env.mapping_playback_token())
    s.respond(1, {count=1, comments={{p='10,1,16777215', m='Chosen episode'}}})
    assert(s.env.COMMENTS and #s.env.COMMENTS == 1 and #s.requests == 1,
        'Missing credentials must preserve the selected episode via a single legacy GET')
    assert(notice and notice:find('未保存', 1, true) and notice:find('共享', 1, true) and not notice:find('未配置', 1, true),
        'Successful playback without write permission must explain why no shared binding was saved')
end
function cases.mapping_rate_limit_blocks_immediate_legacy_download()
    local s = sandbox(true, true); mapping_header(s)
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', '99', s.env.mapping_playback_token())
    s.requests[1](true, {status=0, stdout='HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{"success":false}'})
    assert(#s.requests == 1, 'A 429 must not immediately download through the same gateway legacy endpoint')
    s.env.fetch_danmaku('99000005', true, 'http://192.168.5.150:18443')
    assert(#s.requests == 1, 'LAN and DDNS addresses must share the same gateway cooldown')
    s.advance(121)
    s.env.fetch_danmaku('99000005', true, 'https://nas.tigerest.top:18446')
    assert(#s.requests == 2, 'Legacy download must become available after Retry-After expires')
end
function cases.rate_limit_cooldown_survives_playback_change()
    local s = sandbox(true,true)
    s.emit('file-loaded')
    s.requests[1](true,{status=0,stdout='HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{"success":false}'})
    s.emit('on_unload'); s.props['user-data/tigerest/emby/episode-number'] = 4
    local count = #s.requests
    s.env.auto_load_danmaku(s.props.path,'Fixture series Season1','Fixture series S01E04',4)
    assert(#s.requests == count, 'A new playback during Retry-After must skip both mapping and legacy requests')
end
function cases.cooldown_blocks_unknown_season_and_catalog_requests_but_allows_third_parties()
    local s = sandbox(true, true); mapping_header(s)
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', '99', s.env.mapping_playback_token())
    s.requests[1](true, {status=0, stdout='HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{"success":false}'})
    s.emit('on_unload'); s.props['user-data/tigerest/emby/season-number'] = 0
    s.env.auto_load_danmaku(s.props.path, 'Fixture series', 'Fixture series E04', 4)
    assert(#s.requests == 1, 'Unknown source metadata must not bypass the gateway cooldown through automatic search')
    s.env.uosc_available = true
    local menu, icon
    s.env.update_menu_uosc = function(_, _, value, _, _, _, next_icon) menu, icon = value, next_icon end
    s.env.get_episodes('Chosen catalog', '99', 'http://192.168.5.150:18443', s.env.mapping_playback_token())
    assert(#s.requests == 1 and type(menu) == 'string' and menu:find('120', 1, true) and icon ~= 'spinner',
        'Catalog cooldown must end its loading spinner and show the remaining wait')
    s.env.get_animes('Chosen catalog', s.env.mapping_playback_token()); s.advance(0.2)
    assert(#s.requests == 1 and type(menu) == 'table' and #menu > 0 and menu[1].title:find('120', 1, true),
        'Manual search must show cooldown without sending another gateway request')
    s.env.get_episodes('Third catalog', '99', 'https://third.example.test', s.env.mapping_playback_token())
    assert(#s.requests == 2, 'An unrelated third-party gateway remains available')
end
function cases.rate_limited_menu_selection_preserves_loaded_titles_and_comments()
    local s = sandbox(true, true); mapping_header(s)
    s.emit('file-loaded'); mapping_reply(s, 1, 'shared', '55000003', 'Original loaded episode')
    local comments, history = s.env.COMMENTS, require('mp.utils').format_json(s.history())
    s.messages['load-danmaku']('Rejected catalog', 'Rejected episode', '99000005',
        'https://nas.tigerest.top:18446', '99', s.env.mapping_playback_token())
    assert(s.env.DANMAKU.anime == 'Chosen work' and s.env.DANMAKU.episode == 'Original loaded episode',
        'Pending selection must not relabel comments before the response')
    s.requests[2](true, {status=0, stdout='HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{"success":false}'})
    assert(s.env.DANMAKU.anime == 'Chosen work' and s.env.DANMAKU.episode == 'Original loaded episode'
        and s.env.DANMAKU.mapping_origin == 'shared' and s.env.COMMENTS == comments
        and require('mp.utils').format_json(s.history()) == history,
        'Rejected selection must leave the loaded association and history intact')
end
function cases.gateway_cooldown_keeps_third_party_automatic_matching_available()
    local s = sandbox(true, true)
    s.env.options.api_server = 'https://nas.tigerest.top:18446,https://third.example.test'
    s.emit('file-loaded')
    s.requests[1](true, {status=0, stdout='HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{"success":false}'})
    assert(#s.requests == 2 and s.request_args[2][#s.request_args[2]]:find('https://third.example.test/api/v2/search/anime?', 1, true),
        'NAS cooldown must skip the NAS while preserving third-party automatic search')
    s.respond(2, {animes={{type='tvseries', animeTitle='Fixture series', bangumiId='42'}}})
    s.respond(3, {bangumi={episodes={{episodeNumber='3', episodeTitle='Episode three', episodeId=420003}}}})
    s.respond(4, {count=1, comments={{p='10,1,16777215',m='Third-party comment'}}})
    assert(s.env.COMMENTS and #s.env.COMMENTS == 1 and #s.requests == 4,
        'Third-party automatic matching must complete while the NAS remains in cooldown')
end
function cases.empty_legacy_response_reports_empty_comments_and_unsaved_binding()
    local s = sandbox(true, true)
    local notice
    s.env.show_message = function(value) notice = value end
    s.env.set_episode_id('99000005', true, 'https://nas.tigerest.top:18446', '99', s.env.mapping_playback_token())
    s.respond(1, {count=0, comments={}})
    assert(notice and notice:find('为空', 1, true) and notice:find('未保存', 1, true)
        and not notice:find('已加载', 1, true), 'An empty response cannot be advertised as loaded comments')
end
function cases.manual_menu_carries_catalog_and_original_generation_to_selection()
    local s = sandbox(true,true); mapping_header(s)
    s.env.uosc_available = true
    local items
    s.env.update_menu_uosc = function(_, _, value) if type(value) == 'table' then items = value end end
    s.env.get_episodes('Chosen catalog title','tmdb-99','https://nas.tigerest.top:18446',s.env.mapping_playback_token())
    s.respond(1,{bangumi={episodes={{episodeId='99000005',episodeTitle='Catalog E5',episodeNumber=5}}}})
    local event = items[2].value
    assert(event[8] == 'tmdb-99' and event[9] == s.env.mapping_playback_token(), 'Menu must preserve both catalog ID and playback identity')
    s.messages['load-danmaku'](event[4],event[5],event[6],event[7],event[8],event[9])
    assert(s.request_args[2][#s.request_args[2]]:find('/tigerest/',1,true), 'Real manual event must call calibration POST')
    s.emit('on_unload')
    s.messages['load-danmaku'](event[4],event[5],event[6],event[7],event[8],event[9])
    assert(#s.requests == 2, 'Old menu events cannot load or calibrate a replacement video')
end
function cases.rife_clock_owner_survives_comment_and_window_transitions()
    local s = sandbox()
    s.props['video-sync'] = 'audio'
    s.props['display-fps'] = 240
    s.props['estimated-vf-fps'] = 60
    s.props['user-data/tigerest/rife-clock-owned'] = true
    s.start_render()
    assert(s.props['video-sync'] == 'audio', 'RIFE audio clock must not be overwritten by danmaku')
    local before = s.overlays[1].updates
    s.advance(1)
    assert(s.overlays[1].updates - before <= 61, 'Do not submit 240 OSD updates when audio presentation consumes 60')
    assert(s.overlays[1].updates - before >= 58, 'RIFE comments must keep moving')
    s.set('video-sync', 'display-vdrop') -- An explicit display-clock owner is respected too.
    before = s.overlays[1].updates
    s.advance(1)
    assert(s.overlays[1].updates - before >= 238, 'Fullscreen retains high refresh animation')
    s.set('video-sync', 'audio')
    s.env.hide_danmaku_func(); s.env.show_danmaku_func()
    assert(s.props['video-sync'] == 'audio', 'Comment toggles cannot take over the RIFE clock')
    s.set('video-sync', 'display-resample') -- Restore before releasing ownership.
    s.set('user-data/tigerest/rife-clock-owned', false)
    assert(s.props['video-sync'] == 'display-resample', 'RIFE original preference must survive release')
    s.set('video-sync', 'audio')
    assert(s.props['video-sync'] == 'display-vdrop', 'Ordinary audio playback still gets independent comment cadence')
end

function cases.fresh_profile_autoloads_through_comment_rendering()
    local s = sandbox(true)
    s.emit('file-loaded')
    assert(#s.requests == 1, 'A fresh profile must start matching on file-loaded without a manual toggle')
    assert(s.request_args[1][#s.request_args[1]]:find('/search/anime?', 1, true), 'Expected anime search')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Episode three', episodeId = 420003}}}})
    assert(s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true), 'Must fetch the identified episode')
    s.respond(3, {count = 1, comments = {{p = '10,1,16777215', m = 'Fixture comment'}}})
    s.set('time-pos', 10); s.advance(0.05)
    assert(s.props['user-data/uosc_danmaku/has-danmaku'], 'Automatically fetched comments must become visible')
    assert(s.props['user-data/uosc_danmaku/danmaku-count'] == 1, 'Count must reach the player controls')
    assert(s.env.COMMENTS and #s.env.COMMENTS == 1, 'Response must pass through the actual comment parser')
    assert(s.history().show_danmaku == true, 'Fresh profile must retain its enabled preference')
end
function cases.bottom_comments_stay_off_the_subtitles()
    local s = sandbox(true)
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Episode three', episodeId = 420003}}}})
    s.respond(3, {count = 3, comments = {{p = '10,4,16777215', m = 'Bottom'}, {p = '10,5,16777215', m = 'Top'},
        {p = '10,1,16777215', m = 'Scroll'}}})
    local by = {}
    for _, comment in ipairs(s.env.COMMENTS or {}) do by[comment.clean_text] = comment end
    assert(by.Bottom and by.Bottom.style == 'R2L' and by.Bottom.move, 'Bottom comments must scroll instead of covering subtitles')
    assert(by.Top and by.Top.style == 'TOP' and by.Top.pos, 'Top comments stay fixed')
    -- Even at a 100% display area the bottom fifth of the picture is left to subtitles.
    local r = sandbox(); r.env.options.displayarea = 1; r.start_render()
    r.env.COMMENTS = {{start_time = 0, end_time = 30, style = 'R2L', move = {1920, 800, -1920, 800}, text = '{\\move(1920,800,-1920,800)}Upper'},
        {start_time = 0, end_time = 30, style = 'R2L', move = {1920, 1000, -1920, 1000}, text = '{\\move(1920,1000,-1920,1000)}Lower'}}
    r.set('time-pos', 11); r.advance(0.05)
    local drawn = ''
    for _, overlay in ipairs(r.overlays) do drawn = drawn .. (overlay.data or '') end
    assert(drawn:find('Upper', 1, true), 'Comments above the subtitle area are drawn')
    assert(not drawn:find('Lower', 1, true), 'Comments in the bottom fifth are not drawn')
end
function cases.explicit_off_is_preserved()
    local s = sandbox(true)
    s.set_history({show_danmaku = false})
    s.emit('file-loaded'); s.advance(1)
    assert(#s.requests == 0 and not s.env.ENABLED, 'Explicitly disabled danmaku must not issue requests')
    assert(s.history().show_danmaku == false, 'Explicitly disabled preference must survive loading')
end
function cases.sword_season_two_ignores_conflicting_missing_and_invalid_dates()
    for _, date in ipairs({'2026-10-15T00:00:00.0000000Z', '', 'invalid', '1989-04-15'}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/series-name'] = '转生成为魔剑了'
        s.props['user-data/tigerest/emby/season-number'] = 2
        s.props['user-data/tigerest/emby/episode-number'] = 2
        s.props['user-data/tigerest/emby/episode-name'] = '让·杜比很优秀'
        s.props['user-data/tigerest/emby/premiere-date'] = date
        s.emit('file-loaded')
        assert(s.request_args[1] and s.request_args[1][#s.request_args[1]]:find('/search/anime?', 1, true),
            'Emby streams without a real hash must query the catalog regardless of premiere date')
        s.respond(1, {animes = {
            {type = 'tvseries', animeTitle = '转生成为魔剑', bangumiId = '16785'},
            {type = 'tvseries', animeTitle = '转生成为魔剑 第二期', bangumiId = '17789'},
        }})
        assert(#s.requests == 2 and s.request_args[2][#s.request_args[2]]:find('/bangumi/17789', 1, true),
            'The real second-period title must identify season two and exclude season one')
        s.respond(2, {bangumi = {episodes = {
            {episodeId = 177890003, episodeNumber = '3', episodeTitle = '第3话 不死族很耐打', airDate = '2026-10-15T00:00:00'},
            {episodeId = 177890002, episodeNumber = '2', episodeTitle = '第2话 让·杜比很优秀', airDate = '2026-10-08T00:00:00'},
        }}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/177890002?', 1, true),
            'S02E02 must load episode 177890002 regardless of its Emby date: ' .. date)
        s.respond(3, {count = 1, comments = {{p = '10,1,16777215', m = 'Second episode'}}})
        assert(s.props['user-data/uosc_danmaku/has-danmaku'], 'The correct episode must reach comment rendering')
    end
end

function cases.dates_never_gate_a_matching_work_season_and_episode()
    for _, date in ipairs({'1989-04-15', '2026-08-30', '', 'invalid'}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04'
        s.props['user-data/tigerest/emby/episode-name'] = 'Different translation'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Regular story',
            episodeId = 420003, airDate = date}}}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
            'Dates must not reject a unique work/season/E3: ' .. date)
    end
end
function cases.title_overrides_number_even_when_both_dates_conflict()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/episode-number'] = 25
    s.props['user-data/tigerest/emby/episode-name'] = '修行与大餐'
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '25', episodeTitle = '第25话 Another story', episodeId = 420025, airDate = '2026-10-04'},
        {episodeNumber = '1', episodeTitle = '第1话 修行与大餐', episodeId = 420001, airDate = '1989-04-15'},
    }}})
    assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420001?', 1, true),
        'A unique title must identify cumulative E25 as release E1 before the number and irrespective of dates')
end
function cases.duplicate_titles_stay_ambiguous_even_with_a_unique_number_or_date()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/episode-name'] = 'Same story'
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = '第3话 Same story', episodeId = 420003, airDate = '2026-10-04'},
        {episodeNumber = '1', episodeTitle = '第1话 Same story', episodeId = 420001, airDate = '1989-04-15'},
    }}})
    assert(#s.requests == 2 and notice and notice ~= '', 'An ambiguous title must finish with manual matching')
end
function cases.title_matches_never_cross_explicit_seasons()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/season-number'] = 2
    s.props['user-data/tigerest/emby/episode-name'] = 'Same story'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    assert(#s.requests == 1 and notice and notice ~= '', 'Season two must not inspect a season-one work')
end
function cases.multi_digit_ordinal_seasons_keep_the_whole_season_number()
    for _, entry in ipairs({{11, '11th'}, {12, '12th'}, {21, '21st'}, {23, '23rd'}}) do
        local s = sandbox(true)
        local title = 'Fixture series ' .. entry[2] .. ' season'
        s.props['user-data/tigerest/emby/series-name'] = title
        s.props['user-data/tigerest/emby/season-number'] = entry[1]
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = title, bangumiId = '42'}}})
        assert(s.request_args[2], 'The complete multi-digit season must identify the requested work')
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Episode 3', episodeId = 420003}}}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
            'The requested multi-digit season must load its matching episode')
    end
end

function cases.a_query_title_with_its_own_season_keeps_matching_season_evidence()
    for _, candidate_title in ipairs({'Fixture series 第二季', 'Fixture series Season 2',
        'Fixture series 第二期', 'Fixture series 第2期'}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/series-name'] = 'Fixture series 第二季'
        s.props['user-data/tigerest/emby/season-number'] = 2
        s.props['user-data/tigerest/emby/episode-name'] = 'Expected story'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = candidate_title, bangumiId = '42'}}})
        assert(s.request_args[2] and s.request_args[2][#s.request_args[2]]:find('/bangumi/42', 1, true),
            'A matching explicit season in the full query title must not hide the requested work')
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Expected story', episodeId = 420003}}}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
            'The matching full work/season title must load its unique episode')
    end
end
function cases.explicit_query_and_candidate_seasons_must_not_conflict()
    for _, pair in ipairs({{'Fixture series 第二季', 'Fixture series 第三季'},
        {'Fixture series 第二季', 'Fixture series'}, {'Fixture series 第三季', 'Fixture series 第三季'},
        {'Fixture series 第二季', 'Unrelated different work 第二季'},
        {'Fixture series 第二季', 'Fixture series 第三期'},
        {'Fixture series 第三期', 'Fixture series 第二期'}}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/series-name'] = pair[1]
        s.props['user-data/tigerest/emby/season-number'] = 2
        local notice
        s.env.show_message = function(message) notice = message end
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = pair[2], bangumiId = '42'}}})
        local queried_aliases = pair[2] == 'Unrelated different work 第二季'
        if queried_aliases then s.respond(2, {bangumi = {titles = {}, episodes = {{episodeNumber='3',episodeTitle='Episode 3',episodeId=420003}}}}) end
        assert(#s.requests == (queried_aliases and 2 or 1) and notice and notice ~= '',
            'Conflicting seasons or an unrelated release without authoritative aliases must keep manual matching')
    end
end
function cases.numeric_theme_tracks_never_supply_a_regular_episode_match()
    local s = sandbox(true)
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = 'OP1 Opening', episodeId = 429101},
        {episodeNumber = '3', episodeTitle = 'ED Ending', episodeId = 429102},
        {episodeNumber = '3', episodeTitle = 'Music video', episodeId = 429103},
    }}})
    assert(#s.requests == 2 and notice and notice ~= '', 'Numeric credit/music tracks cannot stand in for E3')
end
function cases.work_season_and_title_resolve_cumulative_episode_numbers()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/series-name'] = '乱马½'
    s.props['user-data/tigerest/emby/season-number'] = 3
    s.props['user-data/tigerest/emby/episode-number'] = 25
    s.props['user-data/tigerest/emby/episode-name'] = '修行与大餐'
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04'
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = '乱马1/2', bangumiId = '4576'},
        {type = 'tvseries', animeTitle = '乱马1/2 第三季', bangumiId = '19972'},
    }})
    assert(s.request_args[2] and s.request_args[2][#s.request_args[2]]:find('/bangumi/19972', 1, true),
        'Only the requested third season may supply a cumulative episode match')
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '1', episodeTitle = '第1话 修行与大餐', episodeId = 199720001, airDate = '1989-04-15'},
    }}})
    assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/199720001?', 1, true),
        'A unique title maps cumulative E25 to release E1 without any date confirmation')
    s.respond(3, {count = 1, comments = {{p = '10,1,16777215', m = 'Correct season'}}})
    assert(s.props['user-data/uosc_danmaku/has-danmaku'], 'Resolved season must automatically render')
end

function cases.matching_date_alone_never_identifies_an_episode()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04'
    s.props['user-data/tigerest/emby/episode-name'] = 'Expected story'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '1', episodeTitle = 'Different story', episodeId = 420001, airDate = '2026-10-04'},
    }}})
    assert(#s.requests == 2 and notice and notice ~= '', 'A date with no matching title or number must finish with manual matching')
end

function cases.matching_titles_and_numbers_render_on_the_first_attempt()
    for _, dates in ipairs({
        {'2026-07-20', '2026-07-17'}, -- The reported production failure.
        {'2026-08-03', '2026-07-27'}, -- Seven days, crossing a month.
        {'2026-12-28', '2027-01-04'}, -- Seven days in the other direction.
        {'2024-03-02', '2024-02-24'}, -- Leap-year boundary.
        {'1963-01-04', '1963-01-01'}, -- Dates before the Windows CRT epoch.
        {'1900-03-03', '1900-02-24'}, -- Century years are not always leap years.
    }) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = dates[1] .. 'T00:00:00Z'
        s.props['user-data/tigerest/emby/episode-name'] = '被怀疑是私生子，还要陪她去初次冒险'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(2, {bangumi = {episodes = {
            {episodeNumber = '4', episodeTitle = '第4话 Another episode', episodeId = 420004, airDate = dates[2]},
            {episodeNumber = '3', episodeTitle = '第3话 被怀疑是私生子 还要陪她去初次冒险', episodeId = 420003, airDate = dates[2]},
        }}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
            'The matching title/number must load E3 instead of E4: ' .. dates[1])
        s.respond(3, {count = 1, comments = {{p = '10,1,16777215', m = 'Matched without manual search'}}})
        assert(s.props['user-data/uosc_danmaku/has-danmaku'], 'The first automatic match must render its comments')
    end
end
function cases.credit_tracks_do_not_block_a_corroborated_regular_episode()
    for _, expected_title in ipairs({'开始与结束', '第1集'}) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        local title = '「凭你也想讨伐魔王？」被勇者小队逐出队伍，只好在王都自在过活'
        s.props['user-data/tigerest/emby/series-name'] = title
        s.props['user-data/tigerest/emby/episode-number'] = 1
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-01-08T16:00:00.0000000Z'
        s.props['user-data/tigerest/emby/episode-name'] = expected_title
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = title, bangumiId = '19310'}}})
        s.respond(2, {bangumi = {episodes = {
            {episodeNumber = '1', episodeTitle = '第1话 开始与结束', episodeId = 193100001, airDate = '2026-01-09T00:00:00'},
            {episodeNumber = '2', episodeTitle = '第2话 偶然与命运', episodeId = 193100002, airDate = '2026-01-16T00:00:00'},
            {episodeNumber = 'C1', episodeTitle = 'C1 Opening', episodeId = 193109101, airDate = '2026-01-09T00:00:00'},
            {episodeNumber = 'C2', episodeTitle = 'C2 Ending', episodeId = 193109102, airDate = '2026-01-09T00:00:00'},
        }}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/193100001?', 1, true),
            'Explicit C1/C2 credit tracks must not block the unique regular E1: ' .. expected_title)
        s.respond(3, {count = 1, comments = {{p = '10,1,16777215', m = 'Automatic regular episode'}}})
        assert(s.props['user-data/uosc_danmaku/has-danmaku'], 'Regular episode comments must load automatically')
    end
end

function cases.credit_tracks_do_not_resolve_duplicate_regular_titles()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420003, airDate = '2026-07-19'},
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420103, airDate = '2026-07-21'},
        {episodeNumber = 'C1', episodeTitle = 'Opening', episodeId = 429101, airDate = '2026-07-20'},
    }}})
    assert(#s.requests == 2, 'Different regular episode IDs with the same title must remain ambiguous')
end

function cases.an_unconfirmed_title_and_wrong_number_are_not_a_match()
    for _, date in ipairs({'1989-07-17', '2026-07-20', 'invalid'}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
        s.props['user-data/tigerest/emby/episode-name'] = 'Expected story'
        local notice
        s.env.show_message = function(message) notice = message end
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '4', episodeTitle = '第4话 Another story',
            episodeId = 420004, airDate = date}}}})
        assert(#s.requests == 2 and notice and notice ~= '', 'Wrong number without a title match must not load: ' .. date)
    end
end

function cases.generic_episode_titles_match_the_unique_work_season_and_number()
    for _, expected in ipairs({'', '第8集', '第 8 集', '第8话'}) do
        for _, date in ipairs({'2026-08-21', '2026-08-16', '2026-08-30'}) do
            local s = sandbox(true)
            s.props['user-data/tigerest/emby/series-name'] = '『你们先走我断后』，于是10年后我成为了传说'
            s.props['user-data/tigerest/emby/episode-number'] = 8
            s.props['user-data/tigerest/emby/episode-name'] = expected
            s.props['user-data/tigerest/emby/premiere-date'] = '2026-08-23T16:00:00.0000000Z'
            s.emit('file-loaded')
            s.respond(1, {animes = {{type = 'tvseries',
                animeTitle = '『你们先走我断后』，于是10年后我成为了传说', bangumiId = '19635'}}})
            s.respond(2, {bangumi = {episodes = {
                {episodeNumber = '5', episodeTitle = '第5话 十年后 居然有人让我先走', episodeId = 196350005, airDate = '2026-07-31'},
                {episodeNumber = '8', episodeTitle = '第8话 时隔十年 小队重聚', episodeId = 196350008, airDate = date},
            }}})
            assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/196350008?', 1, true),
                'A unique E8 must load even without a real episode title: ' .. expected .. ' / ' .. date)
            s.respond(3, {count = 1, comments = {{p = '10,1,16777215', m = 'E8 automatically loaded'}}})
            assert(s.props['user-data/uosc_danmaku/has-danmaku'], 'Generic-title matching must render on the first attempt')
        end
    end
end
function cases.translated_episode_titles_use_the_regular_number_match()
    for _, date in ipairs({'2026-07-17', '', '2026-07-00'}) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
        s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Different translation',
            episodeId = 420003, airDate = date}}}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
            'An available regular episode should remain usable when text differs or its date is unavailable: ' .. date)
    end
end

function cases.regular_episode_ranking_is_independent_of_response_order()
    for _, reversed in ipairs({false, true}) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
        s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        local episodes = {
            {episodeNumber = '3', episodeTitle = '第3话 Different translation', episodeId = 420033, airDate = '2026-07-19'},
            {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420003, airDate = '2026-07-17'},
        }
        if reversed then episodes[1], episodes[2] = episodes[2], episodes[1] end
        s.respond(2, {bangumi = {episodes = episodes}})
        assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
            'A stronger episode title should win regardless of the response order or a slightly closer date')
    end
end

function cases.generic_episode_titles_require_the_correct_number_without_a_date_boundary()
    for _, record in ipairs({
        {date = '1989-07-12', number = '3'}, {date = '2026-07-28', number = '3'},
        {date = '2026-07-20', number = '4'},
    }) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/episode-name'] = '第3集'
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(2, {bangumi = {episodes = {{episodeNumber = record.number,
            episodeTitle = 'Actual story title', episodeId = 420003, airDate = record.date}}}})
        assert(#s.requests == (record.number == '3' and 3 or 2), 'The episode number alone must decide when the title is generic')
    end
end

function cases.weak_work_names_cannot_supply_an_episode_title_or_number_match()
    for _, another_release in ipairs({false, true}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/episode-name'] = 'Expected story'
        s.emit('file-loaded')
        local animes = {{type = 'tvseries', animeTitle = 'Other serial', bangumiId = '43'}}
        if another_release then table.insert(animes, 1, {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}) end
        s.respond(1, {animes = animes})
        if another_release then
            s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Expected story', episodeId = 420003}}}})
            s.respond(3, {bangumi = {titles = {}, episodes = {{episodeNumber = '3', episodeTitle = 'Expected story', episodeId = 430003}}}})
            assert(#s.requests == 4 and s.env.DANMAKU.anime == 'Fixture series', 'A weak release without a matching alias must not supply the episode')
        else
            s.respond(2, {bangumi = {titles = {}, episodes = {{episodeNumber = '3', episodeTitle = 'Expected story', episodeId = 430003}}}})
            assert(#s.requests == 2, 'Episode title/number alone cannot validate a weak release after its aliases are checked')
        end
    end
end

function cases.authoritative_alias_matches_blue_box_without_crossing_seasons()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/series-name'] = '青之箱'
    s.props['user-data/tigerest/emby/season-number'] = 1
    s.props['user-data/tigerest/emby/episode-number'] = 1
    s.props['user-data/tigerest/emby/episode-name'] = '千夏前辈'
    s.emit('file-loaded')
    s.respond(1, {animes={{type='tvseries',animeTitle='蓝箱',bangumiId='18278'},
        {type='tvseries',animeTitle='青之箱 第二季',bangumiId='19249'}}})
    assert(s.request_args[2][#s.request_args[2]]:find('/bangumi/18278',1,true))
    s.respond(2, {bangumi={titles={{title='青之箱'},{title='Blue Box'}},
        episodes={{episodeNumber='1',episodeTitle='第1话 千夏前辈',episodeId=182780001}}}})
    assert(#s.requests==3 and s.request_args[3][#s.request_args[3]]:find('/comment/182780001?',1,true),
        'Official release aliases must allow 青之箱 S1E1 to select 蓝箱 without reading season two')
end

function cases.alias_detail_reads_are_bounded_below_the_title_threshold()
    local s = sandbox(true)
    s.emit('file-loaded')
    local animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}
    for index = 1, 8 do
        animes[#animes + 1] = {type = 'tvseries', animeTitle = 'Unrelated catalog ' .. index, bangumiId = tostring(100 + index)}
    end
    s.respond(1, {animes = animes})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Episode 3', episodeId = 420003}}}})
    for index = 3, 7 do s.respond(index, {bangumi = {titles = {}, episodes = {}}}) end
    local details = 0
    for _, args in ipairs(s.request_args) do
        if args[#args]:find('/bangumi/', 1, true) then details = details + 1 end
    end
    assert(details == 6, 'A strong title plus at most five weak releases may be read for aliases, got ' .. details)
    assert(s.request_args[8] and s.request_args[8][#s.request_args[8]]:find('/comment/420003?', 1, true),
        'Bounding alias reads must still select the strong release')
end

function cases.equal_score_alias_reads_preserve_search_order()
    local s = sandbox(true)
    s.emit('file-loaded')
    local animes = {}
    for index = 1, 8 do
        animes[index] = {type = 'tvseries', animeTitle = 'Unrelated catalog ' .. index, bangumiId = tostring(100 + index)}
    end
    s.respond(1, {animes = animes})
    local looked_up = {}
    for request = 2, 6 do
        local args = assert(s.request_args[request], 'Expected bounded alias detail request')
        local id = assert(args[#args]:match('/bangumi/(%d+)$'), 'Expected release detail URL')
        looked_up[#looked_up + 1] = id
        s.respond(request, {bangumi = {titles = id == '102' and {{title = 'Fixture series'}} or {},
            episodes = {{episodeNumber = '3', episodeTitle = 'Episode 3', episodeId = tonumber(id) * 10000 + 3}}}})
    end
    assert(s.request_args[7] and s.request_args[7][#s.request_args[7]]:find('/comment/1020003?', 1, true),
        'The second search result must remain in the five alias reads and supply its uniquely matching episode')
    assert(table.concat(looked_up, ',') == '101,102,103,104,105',
        'Equal title scores must preserve provider search order before the five-release limit')
end

function cases.generic_episode_titles_keep_a_valid_candidate_when_other_results_are_incomplete()
    for _, conflict in ipairs({'duplicate', 'incomplete', 'failed', 'provider', 'missing-date', 'invalid-date'}) do
        local s = sandbox(true)
        s.props['user-data/tigerest/emby/episode-name'] = '第3集'
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
        if conflict == 'provider' then s.env.options.api_server = 'http://first.example.test,http://second.example.test' end
        s.emit('file-loaded')
        local anime = {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}
        local other = {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '43'}
        local episode = {episodeNumber = '3', episodeTitle = 'Actual story title', episodeId = 420003, airDate = '2026-07-17'}
        if conflict == 'provider' then
            s.respond(1, {animes = {anime}}); s.respond(2, {animes = {anime}})
            s.respond(3, {bangumi = {episodes = {episode}}}); s.respond(4, {bangumi = {episodes = {episode}}})
        else
            s.respond(1, {animes = {anime, other}})
            s.respond(2, {bangumi = {episodes = {episode}}})
            if conflict == 'duplicate' then s.respond(3, {bangumi = {episodes = {episode}}})
            elseif conflict == 'failed' then s.requests[3](false, {status = 22, stdout = ''}, 'controlled failure'); s.advance(0.1)
            elseif conflict == 'missing-date' or conflict == 'invalid-date' then
                s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Another story title',
                    episodeId = 430003, airDate = conflict == 'missing-date' and '' or '2026-07-00'}}}})
            else s.respond(3, {}) end
        end
        local last = conflict == 'provider' and 5 or 4
        if conflict == 'failed' or conflict == 'incomplete' then
            assert(s.request_args[last] and s.request_args[last][#s.request_args[last]]:find('/comment/420003?', 1, true),
                'A usable candidate must survive a failed alternative: ' .. conflict)
        else
            assert(#s.requests == last - 1, 'Equally matched distinct releases/providers must remain ambiguous: ' .. conflict)
        end
    end
    for _, record in ipairs({{}, {title = ''}, {title = false}, {title = 77}}) do
        local s = sandbox(true)
        local notice
        s.env.show_message = function(message) notice = message end
        s.props['user-data/tigerest/emby/episode-name'] = '第3集'
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20'
        s.emit('file-loaded')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = record.title,
            episodeId = 420003, airDate = '2026-07-17'}}}})
        assert(#s.requests == 2 and notice and notice ~= '', 'Malformed provider titles must finish with a manual hint')
    end
end
function cases.work_identity_outranks_a_conflicting_exact_date()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
        {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = '43'},
    }})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 420003, airDate = '2026-07-17'}}}})
    assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/bangumi/43', 1, true),
        'The release scan must finish before selecting a unique work/episode')
    s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 430003, airDate = '2026-07-20'}}}})
    assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/420003?', 1, true),
        'The stronger work must win regardless of an alternative exact date')
end
function cases.multiple_releases_prefer_the_stronger_work_title()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
        {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = '43'},
    }})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 420003, airDate = '2026-07-17'}}}})
    s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 430003, airDate = '2026-07-18'}}}})
    assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/420003?', 1, true),
        'The exact work title should outrank a remake even when its date is one day farther away')
    s.respond(4, {count = 1, comments = {{p = '10,1,16777215', m = 'Ranked match'}}})
    assert(notice and notice:find('Fixture series', 1, true) and notice:find('Confirmed episode', 1, true)
        and notice:find('手动纠正', 1, true), 'The selected work, episode and correction hint must appear on OSD')
end
function cases.duplicate_titles_cannot_be_resolved_by_date_distance()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420003, airDate = '2026-07-17'},
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420033, airDate = '2026-07-18'},
    }}})
    assert(#s.requests == 2, 'Different regular episode IDs with the same title must remain ambiguous')
end
function cases.multiple_exact_titles_remain_ambiguous_regardless_of_dates()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420003, airDate = '2026-07-20'},
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420033, airDate = '2026-07-20'},
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420333, airDate = '2026-07-17'},
    }}})
    assert(#s.requests == 2, 'Different regular episode IDs with the same title must remain ambiguous')
end
function cases.a_weaker_work_cannot_resolve_ambiguous_titles_in_the_requested_work()
    local s = sandbox(true)
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
        {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = '43'},
    }})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode', episodeId = 420003},
        {episodeNumber = '1', episodeTitle = '第1话 Confirmed episode', episodeId = 420001},
    }}})
    s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = 'Confirmed episode', episodeId = 430003}}}})
    assert(#s.requests == 3 and notice and notice ~= '', 'Ambiguous titles in the strongest work must keep manual matching')
end

function cases.incomplete_release_details_do_not_veto_a_supported_match()
    for _, failed in ipairs({true, false}) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
        s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
        s.emit('file-loaded')
        s.respond(1, {animes = {
            {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
            {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = '43'},
        }})
        s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
            episodeId = 420003, airDate = '2026-07-17'}}}})
        if failed then s.requests[3](false, {status = 22, stdout = ''}, 'controlled request failure'); s.advance(0.1)
        else s.respond(3, {}) end
        assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/420003?', 1, true),
            'A failed alternative must not veto the valid candidate already collected')
    end
end
function cases.automatic_matching_waits_for_all_provider_searches()
    for _, failed in ipairs({true, false}) do
        local s = sandbox(true)
        s.env.options.api_server = 'http://first.example.test,http://second.example.test'
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
        s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
        s.emit('file-loaded')
        assert(#s.requests == 2, 'Both configured providers must be searched')
        s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
        s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
            episodeId = 420003, airDate = '2026-07-17'}}}})
        assert(#s.requests == 3, 'An automatic result must wait for the slower provider')
        if failed then
            s.requests[2](false, {status = 22, stdout = ''}, 'controlled request failure'); s.advance(0.1)
            assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/420003?', 1, true),
                'A failed provider should not veto the candidate returned by the available provider')
        else
            s.respond(2, {animes = {}})
            assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/420003?', 1, true),
                'A successful empty provider response permits the single corroborated nearby result')
        end
    end
end
function cases.stalled_release_details_finish_with_the_available_match_and_ignore_late_responses()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
        {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = '43'},
    }})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 420003, airDate = '2026-07-17'}}}})
    s.advance(16)
    assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/420003?', 1, true),
        'The available candidate should load after another release times out')
    s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 430003, airDate = '2026-07-20'}}}})
    assert(#s.requests == 4, 'A late response after the deadline must not overwrite the selected match')
end
function cases.candidate_ids_are_scoped_to_provider_and_release()
    for _, multiple_providers in ipairs({false, true}) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
        s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
        local notice
        s.env.show_message = function(message) notice = message end
        if multiple_providers then s.env.options.api_server = 'http://first.example.test,http://second.example.test' end
        s.emit('file-loaded')
        local first = {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}
        local second = {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = multiple_providers and '42' or '43'}
        local response = function(date) return {bangumi = {episodes = {{episodeNumber = '3',
            episodeTitle = '第3话 Confirmed episode', episodeId = 10002, airDate = date}}}} end
        if multiple_providers then
            s.respond(1, {animes = {first}})
            s.respond(2, {animes = {second}})
            s.respond(3, response('2026-07-17'))
            s.respond(4, response('2026-07-18'))
        else
            s.respond(1, {animes = {first, second}})
            s.respond(2, response('2026-07-17'))
            s.respond(3, response('2026-07-18'))
        end
        local last = multiple_providers and 5 or 4
        assert(s.request_args[last] and s.request_args[last][#s.request_args[last]]:find('/comment/10002?', 1, true),
            'Opaque IDs remain scoped while the strongest provider/release is selected')
        assert(s.env.DANMAKU.anime == 'Fixture series', 'A shared opaque ID must not overwrite the stronger work title')
    end
end
function cases.duplicate_records_in_one_release_are_not_ambiguous()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = 'Confirmed episode'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    local episode = {episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 420003, airDate = '2026-07-17'}
    s.respond(2, {bangumi = {episodes = {episode, episode}}})
    assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
        'Repeated records for one provider/release/episode must still be one candidate')
end
function cases.malformed_candidate_entries_finish_with_a_manual_hint()
    for _, stage in ipairs({'anime', 'missing-id', 'episode'}) do
        local s = sandbox(true)
        s.set_history({show_danmaku = true})
        s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
        local notice
        s.env.show_message = function(message) notice = message end
        s.emit('file-loaded')
        local anime = {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}
        if stage == 'anime' then
            s.respond(1, {animes = {false}})
        elseif stage == 'missing-id' then
            anime.bangumiId = nil
            s.respond(1, {animes = {anime}})
        else
            s.respond(1, {animes = {anime}})
            s.respond(2, {bangumi = {episodes = {false}}})
        end
        s.advance(16)
        assert(notice and notice ~= '', 'Malformed ' .. stage .. ' entries must finish with manual matching')
        assert(#s.requests == (stage == 'episode' and 2 or 1), 'Malformed entries must not load comments')
    end
end
function cases.number_match_survives_an_incomplete_candidate_scan()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
        {type = 'tvseries', animeTitle = 'Fixture series remake', bangumiId = '43'},
    }})
    s.respond(2, {})
    s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 430003, airDate = '2026-07-20'}}}})
    assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/430003?', 1, true),
        'An incomplete alternative must not discard an available number match')
end
function cases.release_detail_deadlines_do_not_survive_file_unload()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-07-20T00:00:00Z'
    local notices = 0
    s.env.show_message = function() notices = notices + 1 end
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.emit('on_unload')
    local previous_notices = notices
    s.advance(16)
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 Confirmed episode',
        episodeId = 420003, airDate = '2026-07-20'}}}})
    assert(notices == previous_notices and #s.requests == 2,
        'Unloaded episode deadlines and late detail responses must not affect the next file')
end
function cases.batch_release_uses_episode_number_when_titles_are_translated()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = '第三集中文译名'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '1', episodeTitle = '第1话 First episode', episodeId = 420001, airDate = '2026-10-04T00:00:00'},
        {episodeNumber = '3', episodeTitle = '第3话 A translated title', episodeId = 420003, airDate = '2026-10-04T00:00:00'},
    }}})
    assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420003?', 1, true),
        'Several episodes sharing an air date must resolve to Emby E3, not the first episode returned')
end
function cases.batch_release_prefers_exact_episode_title_for_remapped_number()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-name'] = '修行与大餐'
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '3', episodeTitle = '第3话 另一集', episodeId = 420003, airDate = '2026-10-04T00:00:00'},
        {episodeNumber = '1', episodeTitle = '第1话 修行与大餐', episodeId = 420001, airDate = '2026-10-04T00:00:00'},
    }}})
    assert(s.request_args[3] and s.request_args[3][#s.request_args[3]]:find('/comment/420001?', 1, true),
        'An exact normalized episode title must identify a remapped episode before relying on its number')
end
function cases.batch_release_without_title_or_number_confirmation_declines()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/premiere-date'] = '2026-10-04T00:00:00Z'
    s.props['user-data/tigerest/emby/episode-number'] = 25
    s.props['user-data/tigerest/emby/episode-name'] = '不能确认的译名'
    local notice
    s.env.show_message = function(message) notice = message end
    s.emit('file-loaded')
    s.respond(1, {animes = {{type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'}}})
    s.respond(2, {bangumi = {episodes = {
        {episodeNumber = '1', episodeTitle = 'First episode', episodeId = 420001, airDate = '2026-10-04T00:00:00'},
        {episodeNumber = '2', episodeTitle = 'Second episode', episodeId = 420002, airDate = '2026-10-04T00:00:00'},
    }}})
    s.advance(1)
    assert(#s.requests == 2, 'A shared premiere date alone must not guess a cumulative episode mapping')
    assert(notice and notice ~= '', 'An ambiguous batch release must show a manual matching hint')
end
function cases.missing_episode_continues_to_supported_candidate()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.props['user-data/tigerest/emby/episode-name'] = 'A supported episode'
    s.emit('file-loaded')
    s.respond(1, {animes = {
        {type = 'tvseries', animeTitle = 'Fixture series', bangumiId = '42'},
        {type = 'tvseries', animeTitle = 'Fixture series (2024)', bangumiId = '43'},
    }})
    s.respond(2, {bangumi = {episodes = {{episodeNumber = '1', episodeTitle = 'Other episode', episodeId = 420001}}}})
    assert(s.requests[3], 'Missing numbered episode must continue searching candidates')
    s.respond(3, {bangumi = {episodes = {{episodeNumber = '3', episodeTitle = '第3话 A supported episode', episodeId = 430003}}}})
    assert(s.request_args[4] and s.request_args[4][#s.request_args[4]]:find('/comment/430003?', 1, true),
        'Candidate with corroborated episode title must reach comment loading')
end
function cases.new_episode_does_not_offset_ids_across_release_seasons()
    local s = sandbox(true)
    s.set_history({show_danmaku = true, ['Fixture series Season1'] = {
        animeTitle = 'Fixture series Third season', episodeTitle = '第1话 A later episode',
        episodeNumber = 25, episodeId = 199720001, fname = 'Fixture series S01E25',
    }})
    s.props['user-data/tigerest/emby/premiere-date'] = '2024-10-20T00:00:00Z'
    s.emit('file-loaded')
    assert(s.request_args[1] and s.request_args[1][#s.request_args[1]]:find('/search/anime?', 1, true),
        'A new episode must resolve its release instead of adding an offset to a prior season ID')
end
function cases.stream_without_hash_uses_work_season_episode_and_title()
    local s = sandbox(true)
    s.set_history({show_danmaku = true})
    s.env.MD5 = {sum = function() end}
    s.emit('file-loaded')
    s.respond(1, {}) -- The stream range request did not produce a hashable file.
    assert(s.request_args[2] and s.request_args[2][#s.request_args[2]]:find('/search/anime?', 1, true),
        'A stream without a real content hash must use work, season, episode and title even without dates')
end
function cases.relay_history_keeps_source_preferences()
    local s = sandbox()
    local remote = 'https://nas.tigerest.top:18446'
    local old = 'https://danmaku-api.152468.xyz/api/v2/comment/123?withRelated=true&chConvert=0'
    local custom = 'https://custom.example/api/v2/comment/456'
    local utils = require('mp.utils')
    s.props['user-data/tigerest/danmaku/api-server'] = remote
    s.env.read_file = function() return utils.format_json({movie = {sources = {
        [old] = {from = 'api_server', blocked = true, delay_segments = {{start = 0, delay = 3}}},
        [custom] = {from = 'user_custom', blocked = true},
    }}}) end
    s.env.DANMAKU.sources = {}
    s.restore_sources('movie')
    local active = remote .. '/api/v2/comment/123?withRelated=true&chConvert=0'
    assert(s.env.DANMAKU.sources[old] == nil, 'Stale history source was retained')
    local restored = s.env.DANMAKU.sources[active]
    assert(restored and restored.blocked and restored.from_history, 'History lost blocked state')
    assert(restored.delay_segments[1].delay == 3, 'History lost timing correction')
    assert(s.env.DANMAKU.sources[custom].blocked, 'Custom source was overwritten')
end
function cases.late_media_properties()
    local s = sandbox()
    local calls = 0; s.env.init = function() calls = calls + 1 end
    s.props['current-tracks/video'], s.props.duration, s.props['container-fps'] = nil, 0, 0
    s.emit('file-loaded')
    assert(s.env.ENABLED, 'Saved enabled state must survive incomplete file-loaded properties')
    s.set('current-tracks/video', {}); s.set('duration', 1200)
    s.emit('playback-restart'); s.advance(1)
    assert(calls == 1, 'Ready stream must initialize once without toggling; got ' .. calls)
    s.emit('playback-restart'); s.advance(1)
    assert(calls == 1, 'Repeated restart must not duplicate loading')
end
function cases.unknown_fps()
    local s = sandbox()
    local calls = 0; s.env.init = function() calls = calls + 1 end
    s.props['container-fps'] = 0
    s.emit('file-loaded'); s.advance(1)
    assert(calls == 1, 'Missing container FPS must not block an otherwise ready video')
end
function cases.display_animation()
    local s = sandbox(); s.start_render()
    local data, count = s.overlays[1].data, s.overlays[1].updates
    s.advance(0.03)
    assert(s.overlays[1].data ~= data, 'Danmaku must move between 24fps video timestamps')
    assert(s.overlays[1].updates - count >= 3, '120Hz display needs multiple updates within a video frame')
    s.set('pause', true); count = s.overlays[1].updates
    s.advance(0.1); assert(s.overlays[1].updates == count, 'Pause must stop animation work')
    s.set('time-pos', 20)
    assert(s.overlays[1].data ~= data, 'Seek while paused must redraw at its new position')
    s.set('pause', false); s.set('paused-for-cache', true)
    count = s.overlays[1].updates; s.advance(0.1)
    assert(s.overlays[1].updates == count, 'Buffering must stop animation work')
    s.set('paused-for-cache', false); s.env.hide_danmaku_func()
    count = s.overlays[1].updates; s.advance(0.1)
    assert(s.overlays[1].updates == count and s.overlays[1].removed, 'Hidden danmaku must stay hidden')
end
function cases.audio_clock_keeps_display_rate_danmaku()
    local s = sandbox(); s.props['video-sync'] = 'audio'; s.start_render()
    assert(s.props['video-sync'] == 'display-vdrop', 'Visible danmaku needs refresh-driven presentation even with audio timing')
    s.env.hide_danmaku_func()
    assert(s.props['video-sync'] == 'audio', 'Hiding danmaku must restore the original audio mode')
    s.env.show_danmaku_func()
    s.set('video-sync', 'display-resample')
    s.env.hide_danmaku_func()
    assert(s.props['video-sync'] == 'display-resample', 'A newer user synchronization choice must survive hiding')
    s.set('video-sync', 'audio'); s.env.show_danmaku_func(); s.emit('on_unload')
    assert(s.props['video-sync'] == 'audio', 'End of file must release the temporary presentation mode')
end
function cases.display_clock_is_preserved()
    for _, mode in ipairs({'display-resample', 'display-vdrop', 'display-adrop'}) do
        local s = sandbox(); s.props['video-sync'] = mode; s.start_render()
        assert(s.props['video-sync'] == mode, 'Visible danmaku must preserve display-driven clock choices')
        s.env.hide_danmaku_func()
        assert(s.props['video-sync'] == mode, 'Hiding danmaku cannot change an unowned mode')
    end
end
function cases.stale_requests()
    local s = sandbox()
    local called = false
    s.env.call_cmd_async({'test'}, function() called = true end)
    s.emit('on_unload'); s.emit('start-file')
    assert(not s.env.is_async_running(), 'Previous file requests must not block next file initialization')
    s.env.call_cmd_async({'next'}, function() end)
    s.requests[1](true, {status = 0, stdout = '{}'})
    assert(not called, 'A previous episode response must not write to the current episode')
    assert(s.env.is_async_running(), 'Stale callback must not decrement current request count')
end
function cases.measured_fps_jitter()
    local s = sandbox(); s.start_render()
    local count = s.overlays[1].updates
    for i = 1, 20 do
        s.advance(0.004)
        s.set('estimated-display-fps', 119 + i / 100)
    end
    assert(s.overlays[1].updates - count >= 9, 'Measured FPS noise must not cancel display timer ticks')
    s.set('display-fps', 60)
    count = s.overlays[1].updates; s.advance(0.05)
    assert(s.overlays[1].updates - count >= 2 and s.overlays[1].updates - count <= 3,
        'Moving to a 60Hz display must update the rendering cadence')
end
function cases.timer_wakeup_drift()
    local s = sandbox(); s.start_render()
    local count = s.overlays[1].updates
    s.advance(1, 0.001)
    assert(s.overlays[1].updates - count >= 119,
        'Small wakeup delays must not accumulate and turn 120Hz into roughly 107Hz')
end
function cases.timestamp_jitter()
    local s = sandbox(); s.start_render()
    s.advance(0.07)
    local x = tonumber(s.overlays[1].data:match('\\pos%(([-%d%.]+),'))
    s.set('time-pos', 10 + 1 / 24)
    s.advance(0.01)
    local next_x = tonumber(s.overlays[1].data:match('\\pos%(([-%d%.]+),'))
    assert(next_x < x, 'A late video timestamp must not move rolling comments backwards')
end
function cases.cancelled_parallel_requests()
    local s = sandbox()
    local callbacks = 0
    s.env.parallel_requests({'test'}, function() return {'test'} end,
        function() callbacks = callbacks + 1 end, function() callbacks = callbacks + 1 end,
        {per_request_timeout = 0.1})
    s.emit('on_unload'); s.advance(0.2)
    assert(callbacks == 0, 'Unloaded request timeout must not trigger fallback on the next file')
end
function cases.disabled_file_restores_history()
    local s = sandbox()
    local restored = 0
    s.env.get_danmaku_visibility = function() return false end
    s.env.read_danmaku_source_record = function() restored = restored + 1 end
    s.emit('file-loaded')
    assert(restored == 1, 'Custom sources and delays must restore even when starting with danmaku off')
end
function cases.early_manual_enable()
    local s = sandbox()
    s.props['current-tracks/video'], s.props.duration = nil, 0
    local calls = 0
    s.env.init = function()
        assert(s.props['current-tracks/video'] and s.props.duration > 0, 'Manual enable must await ready media')
        calls = calls + 1
    end
    s.messages.show_danmaku_keyboard()
    s.set('current-tracks/video', {}); s.set('duration', 1200); s.advance(1)
    assert(calls == 1, 'Manual early enable must initialize once metadata arrives')
end

original_mp.register_script_message('tigerest-danmaku-runtime-probe', function()
    local failures = {}
    for name, test in pairs(cases) do
        local ok, err = pcall(test)
        if not ok then failures[#failures + 1] = name .. ': ' .. tostring(err) end
    end
    original_mp.set_property('user-data/tigerest-test/error', table.concat(failures, '\n'))
    original_mp.set_property_bool('user-data/tigerest-test/done', true)
end)
