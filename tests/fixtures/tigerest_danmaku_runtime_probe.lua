-- Run the real Lua entry points with a deterministic mpv event loop. Network,
-- OSD submission and media properties are the only substituted boundaries.
local original_mp = mp
local fixture = debug.getinfo(1, 'S').source:sub(2):match('^(.*)[/\\]')
local root = fixture .. '/../../resources/mpv/plugins/uosc_danmaku/'

local function sandbox()
    local env = setmetatable({}, {__index = _G})
    env._G = env
    local props = {pause = false, ['time-pos'] = 10, ['display-fps'] = 120,
        ['osd-width'] = 1920, ['osd-height'] = 1080, vf = {}, speed = 1,
        path = 'https://example.test/video.mkv', ['filename/no-ext'] = 'video',
        ['current-tracks/video'] = {}, duration = 1200, ['container-fps'] = 24}
    local events, observers, messages, timers, overlays, requests = {}, {}, {}, {}, {}, {}
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
    function api.set_property_native(name, value) props[name] = value end
    api.set_property_bool = api.set_property_native
    function api.get_time() return now end
    function api.get_script_name() return 'uosc_danmaku' end
    function api.commandv() end
    function api.command_native(args) return args[2] end
    function api.command_native_async(_, callback)
        requests[#requests + 1] = callback
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
        if name == 'modules/utils' or name == 'modules/options' then return load_script(name .. '.lua') end
        return {}
    end
    load_script('main.lua')
    env.get_danmaku_visibility = function() return visible end
    env.set_danmaku_visibility = function(value) visible = value end
    env.toggle_danmaku_switch = function() end
    env.read_danmaku_source_record = function() end
    env.show_message = function() end
    env.show_loaded = function() end
    env.file_exists = function() return false end
    env.save_danmaku = function() end
    local state = {env = env, props = props, overlays = overlays, requests = requests, messages = messages}
    function state.emit(name)
        for _, fn in ipairs(events[name] or {}) do fn({}) end
    end
    function state.set(name, value)
        props[name] = value
        local copy = {}; for _, fn in ipairs(observers[name] or {}) do copy[#copy + 1] = fn end
        for _, fn in ipairs(copy) do fn(name, value) end
    end
    function state.advance(seconds)
        local finish = now + seconds
        for _ = 1, 10000 do
            local next_timer
            for _, timer in ipairs(timers) do
                if timer.enabled and timer.due <= finish and (not next_timer or timer.due < next_timer.due) then
                    next_timer = timer
                end
            end
            if not next_timer then break end
            now = next_timer.due
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
    return state
end

local cases = {}
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
