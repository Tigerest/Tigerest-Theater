-- Private NAS mapping transport. Credential values never enter subprocess arguments,
-- mpv properties, ordinary options, history, or diagnostics.
local utils = require('mp.utils')
local generation, attempted, cooldown = 0, {}, {}
local selection_revision = 0
local MAX_BODY = 16 * 1024 * 1024

local function integer(value, maximum)
    local number = tonumber(value)
    if number and number >= 1 and number <= maximum and number == math.floor(number) then return number end
end

function mapping_source()
    -- A filename-only E03 supplies no trustworthy season. Use original metadata;
    -- parse_title() deliberately retains its legacy guesses for legacy matching.
    if not mp.get_property_bool('user-data/tigerest/emby/valid', false) then return nil end
    local title = mp.get_property_native('user-data/tigerest/emby/series-name')
    local season = integer(mp.get_property_native('user-data/tigerest/emby/season-number'), 1000)
    local episode = integer(mp.get_property_native('user-data/tigerest/emby/episode-number'), 10000)
    if type(title) ~= 'string' or not title:match('%S') or #title > 800
        or #title:gsub('[\128-\191]', '') > 200 or not season or not episode then return nil end
    return {title = title, season = season, episode = episode}
end

function mapping_playback_token()
    return tostring(generation) .. '\n' .. tostring(mp.get_property('path', '')) .. '\n'
        .. utils.format_json(mapping_source() or {}) .. '\n'
        .. tostring(mp.get_property_native('user-data/tigerest/danmaku/auth-generation') or '')
end

local function current(token) return token == mapping_playback_token() end

function begin_manual_danmaku_selection(token)
    if token and not current(token) then return false end
    selection_revision = selection_revision + 1
    -- Legacy searches/hash/comment requests must not resume once a user chooses
    -- a source. Their playback generation alone cannot distinguish this race.
    cancel_danmaku_async_requests()
    return true
end

local function trusted(server)
    server = resolve_api_server(server)
    return server == 'http://nas.tigerest.top:18443' or server == 'http://192.168.5.150:18443'
end

function mapping_retry_after(server)
    if not trusted(server) then return 0 end
    return math.max(0, math.ceil((cooldown[resolve_api_server(server)] or 0) - mp.get_time()))
end

function mapping_rate_limit_message(server)
    local wait = mapping_retry_after(server)
    if wait > 0 then return string.format('弹幕接口请求过于频繁，请 %d 秒后重试', wait) end
end

local function show_rate_limit(server)
    show_message(mapping_rate_limit_message(server), 5)
end

local function private_header_file()
    local path = mp.get_property_native('user-data/tigerest/danmaku/mapping-auth-file')
    if type(path) ~= 'string' or path == '' then return nil end
    local file = io.open(path, 'rb')
    if not file then return nil end
    local contents = file:read(12289) or ''; file:close()
    local session = mp.get_property_native('user-data/tigerest/danmaku/auth-generation')
    if session ~= nil and tostring(session) ~= '' and not tostring(session):match('^legacy:%d+$') then
        local token, server, user = contents:match('^X%-Emby%-Token: ([%w%-%._~%+/=]+)\r?\nX%-Emby%-Server%-Id: ([%w%-]+)\r?\nX%-Emby%-User%-Id: ([%w%-]+)\r?\n$')
        if #contents > 12288 or not token or #token > 4000 or not server or not user then return nil end
    elseif #contents > 4096 or not contents:match('^Authorization: Bearer [%w%-%._~%+/=]+\r?\n?$') then return nil end
    return path
end

local function retry_seconds(value)
    if not value then return 60 end
    local seconds = value:match('^%s*(%d+)%s*$')
    if seconds then return tonumber(seconds) or 60 end
    local day, month, year, hour, minute, second = value:match('%a+, (%d+) (%a+) (%d+) (%d+):(%d+):(%d+) GMT')
    local months = {Jan=1,Feb=2,Mar=3,Apr=4,May=5,Jun=6,Jul=7,Aug=8,Sep=9,Oct=10,Nov=11,Dec=12}
    if not day or not months[month] then return 60 end
    -- Convert a GMT date to a duration without assuming the host timezone.
    local local_time = os.time()
    local utc_as_local = os.time(os.date('!*t', local_time))
    local date = os.time({year=tonumber(year), month=months[month], day=tonumber(day),
        hour=tonumber(hour), min=tonumber(minute), sec=tonumber(second), isdst=false})
    return date and math.max(0, date - utc_as_local) or 60
end

function mapping_record_rate_limit(server, retry)
    if not trusted(server) then return end
    server = resolve_api_server(server)
    local until_time = math.max(cooldown[server] or 0, mp.get_time() + retry_seconds(retry))
    -- Both addresses reach the same NAS and share its request budget.
    cooldown['http://nas.tigerest.top:18443'] = until_time
    cooldown['http://192.168.5.150:18443'] = until_time
end

local function request(server, source, selection, token, callback)
    if not current(token) then return end
    local revision = selection_revision
    if not trusted(server) or not source or (cooldown[server] or 0) > mp.get_time() then callback(nil); return end
    local auth_file = selection and private_header_file() or nil
    if selection and not auth_file then callback(nil); return end
    local body = {source = source, comment = {withRelated = true, chConvert = tonumber(options.chConvert) or 0}}
    if selection then body.selection = selection end
    local encoded = utils.format_json(body)
    if #encoded > 16384 then callback(nil); return end
    local args = {'curl', '--silent', '--show-error', '--request', 'POST', '--connect-timeout', '5',
        '--max-time', '35', '--max-filesize', tostring(MAX_BODY), '--include', '--compressed',
        '--header', 'Accept: application/json', '--header', 'Content-Type: application/json',
        '--header', 'User-Agent: TigerestTheater mapping', '--data-binary', encoded}
    for _, header in ipairs(managed_client_headers(server)) do args[#args + 1] = '--header'; args[#args + 1] = header end
    if auth_file then args[#args + 1] = '--header'; args[#args + 1] = '@' .. auth_file end
    if options.proxy ~= '' then args[#args + 1] = '--proxy'; args[#args + 1] = options.proxy end
    args[#args + 1] = server .. '/api/tigerest/v1/danmaku'
    if not current(token) then return end
    request_danmaku_http(args, {timeout=35, retry=not selection,
        kind=selection and 'mapping-write' or 'shared-lookup',
        current=function() return current(token) and revision == selection_revision end}, function(result)
        if not result.ok or result.status ~= 200 then callback(nil); return end
        local data = utils.parse_json(result.body)
        if type(data) ~= 'table' or data.success ~= true or data.matched ~= true
            or type(data.match) ~= 'table' or type(data.danmaku) ~= 'table'
            or type(data.danmaku.comments) ~= 'table'
            or data.match.origin ~= (selection and 'manual' or 'shared') then callback(nil); return end
        local episode = tostring(data.match.episodeId or '')
        if not episode:match('^%d+$') or #episode > 32 then callback(nil); return end
        callback(data)
    end)
end

local function apply(data, server, from_menu)
    DANMAKU.anime, DANMAKU.episode = data.match.animeTitle, data.match.episodeTitle
    prepare_episode_id(tostring(data.match.episodeId), server)
    DANMAKU.mapping_origin = data.match.origin == 'shared' and 'shared' or 'manual'
    local url = server .. '/api/v2/comment/' .. tostring(data.match.episodeId) .. '?withRelated=true&chConvert=0'
    handle_fetched_danmaku(data.danmaku, url, from_menu)
end

function lookup_shared_danmaku(fallback)
    local token, source = mapping_playback_token(), mapping_source()
    if not source then fallback(); return end
    local servers = get_api_server_list(options.api_server)
    local server
    for _, candidate in ipairs(servers) do if trusted(candidate) then server = resolve_api_server(candidate); break end end
    if not server then fallback(); return end
    if mapping_retry_after(server) > 0 then show_rate_limit(server); fallback(); return end
    if attempted[token] then fallback(); return end
    attempted[token] = true
    request(server, source, nil, token, function(data)
        if not current(token) then return end
        if data then apply(data, server, false)
        elseif mapping_retry_after(server) > 0 then show_rate_limit(server); fallback()
        else fallback() end
    end)
end

function select_shared_danmaku(episode_id, bangumi_id, server, token, fallback)
    -- Only the menu event can call this, carrying its original playback token.
    if token and not current(token) then return true end
    local source = mapping_source()
    if not token or not source or not trusted(server)
        or not tostring(bangumi_id or ''):match('^[%w%-]+$') then return false end
    if mapping_retry_after(server) > 0 then show_rate_limit(server); return true end
    if not private_header_file() then fallback('missing-token'); return true end
    request(server, source, {bangumiId=tostring(bangumi_id), episodeId=tostring(episode_id)}, token, function(data)
        if not current(token) then return end
        if data then apply(data, server, true)
        elseif mapping_retry_after(server) > 0 then show_rate_limit(server)
        else fallback(true) end
    end)
    return true
end

mp.add_hook('on_unload', 39, function()
    generation = generation + 1; selection_revision = 0; attempted = {}
end)
local observed_auth
mp.observe_property('user-data/tigerest/danmaku/auth-generation', 'native', function(_, value)
    if observed_auth ~= nil and observed_auth ~= value then
        begin_manual_danmaku_selection()
    end
    observed_auth = value
end)
