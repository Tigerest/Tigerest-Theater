local msg = require('mp.msg')
local utils = require("mp.utils")

local function extract_url(url)
    local path = url:match("^https?://[^/]+(/[^%?]*)")
    return path
end

local function generateXSignature(url, time, appid, app_accept)
    local url_path = extract_url(url)
    if not url_path then
        return nil
    end

    local dataToHash = string.format("%s%d%s%s", AES.ECB.decrypt(KEY, Base64.decode(appid)),
    time, url_path, AES.ECB.decrypt(KEY, Base64.decode(app_accept)))
    local hash = Sha256(dataToHash)
    local base64Hash = Base64.encode(hex_to_bin(hash))
    return base64Hash
end

-- 写入history.json
-- 读取episodeId获取danmaku
function prepare_episode_id(input, selected_server)
    DANMAKU.source = "dandanplay"
    for url, source in pairs(DANMAKU.sources) do
        if source.from == "api_server" then
            if not source.from_history then
                DANMAKU.sources[url] = nil
            else
                DANMAKU.sources[url]["data"] = nil
            end
        end
    end

    if not selected_server then
        if DANMAKU.api_server ~= nil then
            selected_server = DANMAKU.api_server
        else
            local servers = get_api_server_list(options.api_server)
            if servers and #servers > 0 then
                selected_server = servers[1]
            end
        end
    end

    selected_server = resolve_api_server(selected_server)
    DANMAKU.api_server = selected_server

    write_history(input, selected_server)
    set_danmaku_button()
    DANMAKU.mapping_origin = nil
    return selected_server
end

function set_episode_id(input, from_menu, api_server, bangumi_id, playback_token, anime_title, episode_title)
    if from_menu and not begin_manual_danmaku_selection(playback_token) then return end
    local selected_server = resolve_api_server(api_server or DANMAKU.api_server
        or get_api_server_list(options.api_server)[1])
    local function legacy(save_failed)
        local notice = mapping_rate_limit_message(selected_server)
        if notice then show_message(notice, 5); return end
        if anime_title then DANMAKU.anime = anime_title end
        if episode_title then DANMAKU.episode = episode_title end
        prepare_episode_id(input, selected_server)
        fetch_danmaku(input, from_menu or false, selected_server, save_failed)
    end
    if from_menu and select_shared_danmaku(input, bangumi_id, selected_server, playback_token, legacy) then return end
    legacy()
end

-- 回退使用额外的弹幕获取方式
function get_danmaku_fallback(query)
    local function do_fallback()
        if options.fallback_server == "" then return end
        local url = options.fallback_server .. "/?ac=dm&url=" .. query
        msg.verbose("尝试获取弹幕：" .. url)

        local args = make_danmaku_request_args("GET", url)
        if not args then return end

        fetch_danmaku_data(args, function(data)
            if data ~= nil and data["xml"] ~= nil then
                if DANMAKU.sources[query] ~= nil then
                    DANMAKU.sources[query]["data"] = data["xml"]
                else
                    DANMAKU.sources[query] = {from = "user_custom", data = data["xml"]}
                end
                load_danmaku(true)
                return
            end

            if not data or not data["comments"] or data["count"] <= 1 then
                msg.info("备用服务器无数据或返回格式不正确")
                show_message("备用服务器无数据或返回格式不正确", 3)
                return
            end

            save_danmaku_data(data["comments"], query, "user_custom")
            load_danmaku(true)
        end)
    end

    if query:find('bilibili.com') or query:find('bilivideo.c[nom]+') then
        load_danmaku_for_bilibili(query, function(success)
            if not success then do_fallback() end
        end)
        return
    end

    if query:find('bahamut.akamaized.net') then
        load_danmaku_for_bahamut(query, function(success)
            if not success then do_fallback() end
        end)
        return
    end

    if query:find('mgtv.com') then
        load_danmaku_for_mgtv(query, function(success)
            if not success then do_fallback() end
        end)
        return
    end

    if query:find('iqiyi.com') then
        load_danmaku_for_iqiyi(query, function(success)
            if not success then do_fallback() end
        end)
        return
    end

    if query:find('v.qq.com') then
        load_danmaku_for_tencent(query, function(success)
            if not success then do_fallback() end
        end)
        return
    end

    if query:find('v.youku.com') then
        load_danmaku_for_youku(query, function(success)
            if not success then do_fallback() end
        end)
        return
    end

    do_fallback()
end

-- 返回弹幕请求参数
function make_danmaku_request_args(method, url, headers, body)
    url = resolve_managed_api_url(url)
    local notice = mapping_rate_limit_message(url:match('^https?://[^/]+'))
    if notice then show_message(notice, 5); return nil, notice end
    local args = {
        "curl",
        "-L",
        "--connect-timeout", "5",
        "--max-time", "20",
        "-X",
        method,
        "-H",
        "Accept: application/json",
        "-H",
        "User-Agent: " .. options.user_agent,
    }

    for _, header in ipairs(managed_client_headers(url)) do
        table.insert(args, '-H')
        table.insert(args, header)
    end

    if headers then
        for k, v in pairs(headers) do
            table.insert(args, '-H')
            table.insert(args, string.format('%s: %s', k, v))
        end
    end

    if body then
        table.insert(args, '-d')
        table.insert(args, utils.format_json(body))
        table.insert(args, '-H')
        table.insert(args, 'Content-Type: application/json')
    end

    table.insert(args, '--compressed')

    if url:find("api%.dandanplay%.") then
        local time = os.time()
        local appid = "UgjRIH45lE1BBLNmir1WKw=="
        local app_accept = "SzuWlFZAPRMqeWf9qmfp8dcvYr3hvxuSrIRZuAeEfko="
        table.insert(args, '-H')
        table.insert(args, string.format('X-AppId: %s', AES.ECB.decrypt(KEY, Base64.decode(appid))))
        table.insert(args, '-H')
        table.insert(args, string.format('X-Signature: %s', generateXSignature(url, time, appid, app_accept)))
        table.insert(args, '-H')
        table.insert(args, string.format('X-Timestamp: %s', time))
    end

    if options.proxy ~= "" then
        table.insert(args, '-x')
        table.insert(args, options.proxy)
    end

    table.insert(args, url)

    return args
end

local function normalize_danmaku_response(d)
    if not d then return d end
    -- 已经是 comments/count 格式则直接返回
    if d.comments or d.count then return d end

    if d.danmuku and type(d.danmuku) == "table" then
        local out = {}
        for _, item in ipairs(d.danmuku) do
            -- item 预期为数组，索引: 1=time, 2=pos(right/top/bottom), 3=color(hex), 5=content
            local time = tonumber(item[1]) or 0
            local pos = item[2] or "right"
            local color = item[3] or ""
            local content = item[5] or item[4] or ""

            local mode = 1
            if pos == "right" then
                mode = 1
            elseif pos == "top" then
                mode = 5
            elseif pos == "bottom" then
                mode = 4
            end

            local colorDec = 16777215
            if type(color) == "number" then
                colorDec = color
            elseif type(color) == "string" then
                colorDec = hex_to_int_color(color)
            end

            local p = string.format("%.2f,%d,%d", time, mode, colorDec)
            table.insert(out, { p = p, m = content })
        end
        return { comments = out, count = tonumber(d.danum) or #out }
    end

    return d
end

-- Match the work and season before using episode titles or numbers.
local function match_text(value)
    local text = tostring(value or ''):lower():gsub('½', '1/2')
    text = text:gsub('[%s%p]', '')
    for char in ('，。！？；：、·「」『』“”‘’（）【】《》〈〉—…　'):gmatch('[%z\1-\127\194-\244][\128-\191]*') do
        text = text:gsub(char, '')
    end
    return text
end

local function episode_title(value)
    local text = tostring(value or ''):gsub('^第%s*%d+%s*话%s*', ''):gsub('^第%s*%d+%s*話%s*', '')
        :gsub('^第%s*%d+%s*集%s*', '')
    text = match_text(text)
    if text:match('^episode%d+$') or text:match('^ep%d+$') or text:match('^%d+$') then return '' end
    return text
end

local function valid_api_id(value)
    return type(value) == 'number' or (type(value) == 'string' and value ~= '')
end

local function credit_episode(episode)
    local text = episode_title(episode.episodeTitle)
    return text == 'op' or text == 'ed' or text == 'opening' or text == 'ending'
        or text:match('^op%d+') or text:match('^ed%d+') or text:match('^ncop') or text:match('^nced')
        or text:match('^opopening') or text:match('^edending') or text:match('^optheme') or text:match('^edtheme')
        or text:match('^openingtheme') or text:match('^endingtheme') or text:match('^openingcredits')
        or text:match('^endingcredits') or text:match('^musicvideo') or text:match('^片头曲')
        or text:match('^片尾曲') or text:match('^主题曲') or text:match('^主題曲')
end

local function work_title_and_season(value)
    local title = match_text(value)
    local words = {'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'}
    -- Longer numeric ordinals must precede their shorter suffixes (11th/1th).
    for index = 99, 1, -1 do
        local chinese = number_to_chinese(index)
        local suffixes = {'第' .. index .. '季', '第' .. chinese .. '季', '第' .. index .. '期', '第' .. chinese .. '期',
            '第' .. index .. '部', '第' .. chinese .. '部',
            'season' .. index, 's' .. index, string.format('s%02d', index), index .. 'stseason', index .. 'ndseason',
            index .. 'rdseason', index .. 'thseason'}
        if words[index] then suffixes[#suffixes + 1] = words[index] .. 'season' end
        for _, suffix in ipairs(suffixes) do
            if #title > #suffix and title:sub(-#suffix) == suffix then
                return title:sub(1, #title - #suffix), index
            end
        end
    end
    return title
end

local function match_episode(anime, episode_num, expected_title, api_server, callback)
    local url = api_server .. '/api/v2/bangumi/' .. anime.bangumiId
    local args = make_danmaku_request_args('GET', url)
    if not args then callback({}, true); return end
    parallel_requests({api_server}, function() return args end, function(_, error, json)
        if error then msg.error(error); callback({}, true); return end
        local data = utils.parse_json(json)
        if type(data) ~= 'table' or type(data.bangumi) ~= 'table' or type(data.bangumi.episodes) ~= 'table' then
            callback({}, true); return
        end
        local titled, numbered, seen = {}, {}, {}
        local excluded_credits, malformed = 0, false
        for _, episode in ipairs(data.bangumi.episodes) do
            local valid = type(episode) == 'table'
            local number = valid and tonumber(episode.episodeNumber)
            if valid and (credit_episode(episode) or (type(episode.episodeNumber) == 'string'
                and episode.episodeNumber:match('^[cC]%d+$'))) then
                excluded_credits = excluded_credits + 1
            elseif number and number >= 0 and number < math.huge and valid_api_id(episode.episodeId)
                and type(episode.episodeTitle) == 'string' and episode.episodeTitle:match('%S') then
                local id = tostring(episode.episodeId)
                if not seen[id] then
                    seen[id] = true
                    if expected_title ~= '' and episode_title(episode.episodeTitle) == expected_title then
                        titled[#titled + 1] = episode
                    end
                    if number == tonumber(episode_num) then numbered[#numbered + 1] = episode end
                end
            else malformed = true end
        end
        -- An ambiguous title stays ambiguous; the number cannot undo title priority.
        local by_title = #titled > 0
        local supported = by_title and titled or numbered
        msg.debug(('Auto-match release: titles=%d numbers=%d credits_excluded=%d incomplete=%s')
            :format(#titled, #numbered, excluded_credits, tostring(malformed)))
        callback(supported, malformed, by_title, data.bangumi)
    end, nil, {per_request_timeout = 15})
end

local function match_anime()
    local anime_type = 'tvseries'
    local title, season_num, episode_num = parse_title()
    if not title or not episode_num then msg.info('无法解析剧集信息'); return end
    if title:match('OVA') or title:match('OAD') then anime_type = 'ova' end
    local encoded_query = url_encode(title)
    local servers = get_api_server_list(options.api_server)
    local searches_finished, pending_candidates, matched = false, 0, false
    local candidates, incomplete = {}, false
    local expected_title = ''
    if mp.get_property_bool('user-data/tigerest/emby/valid', false) then
        expected_title = episode_title(mp.get_property_native('user-data/tigerest/emby/episode-name'))
    end

    local function title_score(anime_title, primary_title)
        local raw = tostring(anime_title or ''):gsub('^%s*(.-)%s*$', '%1')
            :gsub('%s*%(.-%)%s*$', ''):gsub('%s*【.-】.*$', '')
        local base, query_season = work_title_and_season(title)
        local candidate, alias_season = work_title_and_season(raw)
        local release = tostring(primary_title or raw):gsub('^%s*(.-)%s*$', '%1')
            :gsub('%s*%(.-%)%s*$', ''):gsub('%s*【.-】.*$', '')
        local _, explicit_season = work_title_and_season(release)
        if base == '' or candidate == '' then return nil end
        local special = release:lower():find('ova', 1, true) or release:lower():find('oad', 1, true)
            or release:lower():find('special', 1, true) or release:find('特别篇', 1, true) or release:find('特別篇', 1, true)
            or release:find('番外', 1, true)
        local season = tonumber(season_num)
        if query_season and season and season > 0 and query_season ~= season then return nil end
        if season == 0 and not special then return nil end
        if season and season > 0 and special and not title:lower():find('ova', 1, true)
            and not title:lower():find('oad', 1, true) then return nil end
        if explicit_season and season and explicit_season ~= season then return nil end
        if alias_season and season and alias_season ~= season then return nil end
        if season and season > 1 and explicit_season ~= season then return nil end
        local special_title = match_text(raw:gsub('[oO][vV][aA]', ''):gsub('[oO][aA][dD]', '')
            :gsub('[sS][pP][eE][cC][iI][aA][lL]', ''):gsub('特别篇', ''):gsub('特別篇', ''):gsub('番外', ''))
        local score = ((explicit_season and base == candidate) or (season == 0 and special_title == base)) and 1
            or math.min(1, jaro_winkler(base, candidate))
        return score
    end

    local function finish()
        if not searches_finished or pending_candidates ~= 0 or matched then return end
        local best_score, best_title, supported = -1, false, {}
        for _, candidate in pairs(candidates) do
            if candidate.score > best_score or (candidate.score == best_score and candidate.by_title and not best_title) then
                best_score, best_title, supported = candidate.score, candidate.by_title, {candidate}
            elseif candidate.score == best_score and candidate.by_title == best_title then
                supported[#supported + 1] = candidate
            end
        end
        if #supported == 1 then
            local selected = supported[1]
            matched = true
            DANMAKU.anime, DANMAKU.episode = selected.anime.animeTitle, selected.episode.episodeTitle
            msg.info(('Auto-match selected regular episode: by_title=%s alternatives_incomplete=%s')
                :format(tostring(selected.by_title), tostring(incomplete)))
            set_episode_id(selected.episode.episodeId, nil, selected.server)
        else
            msg.info('没有找到唯一对应剧集的弹幕')
            show_message('未找到唯一对应剧集的弹幕，可在弹幕菜单中手动匹配', 5)
        end
    end

    local function per_response(server, err, out)
        if err then incomplete = true; return end
        local data = utils.parse_json(out)
        if type(data) ~= 'table' or type(data.animes) ~= 'table' then incomplete = true; return end
        local works, seen = {}, {}
        for search_order, anime in ipairs(data.animes) do
            if type(anime) ~= 'table' then incomplete = true
            elseif anime.type == anime_type then
                local score = title_score(anime.animeTitle)
                if score then
                    if valid_api_id(anime.bangumiId) then
                        local id = tostring(anime.bangumiId)
                        if not seen[id] then
                            seen[id] = true
                            works[#works + 1] = {anime = anime, score = score, search_order = search_order}
                        end
                    else incomplete = true end
                end
            end
        end
        table.sort(works, function(a, b)
            if a.score == b.score then return a.search_order < b.search_order end
            return a.score > b.score
        end)
        -- Below the primary-title threshold only detail aliases can admit a
        -- release. Bound those sequential reads; strong titles are all checked.
        local bounded, weak = {}, 0
        for _, work in ipairs(works) do
            if work.score >= 0.85 then bounded[#bounded + 1] = work
            elseif weak < 5 then weak = weak + 1; bounded[#bounded + 1] = work end
        end
        works = bounded
        if #works == 0 then return end
        pending_candidates = pending_candidates + 1
        local function try_candidate(index)
            local work = works[index]
            if not work then pending_candidates = pending_candidates - 1; finish(); return end
            match_episode(work.anime, episode_num, expected_title, server, function(episodes, uncertain, by_title, release)
                incomplete = incomplete or uncertain
                -- Search results can use a different language's primary title.
                -- Only aliases from this release's detail endpoint are authoritative.
                for _, alias in ipairs(type(release) == 'table' and type(release.titles) == 'table' and release.titles or {}) do
                    if type(alias) == 'table' and type(alias.title) == 'string' then
                        work.score = math.max(work.score, title_score(alias.title, work.anime.animeTitle) or 0)
                    end
                end
                for _, episode in ipairs(work.score >= 0.85 and episodes or {}) do
                    -- IDs are deployment-local: only duplicate rows from this release/provider collapse.
                    local key = server .. '\0' .. tostring(work.anime.bangumiId) .. '\0' .. tostring(episode.episodeId)
                    candidates[key] = {anime = work.anime, episode = episode, server = server, score = work.score, by_title = by_title}
                end
                try_candidate(index + 1)
            end)
        end
        try_candidate(1)
    end
    parallel_requests(servers, function(server)
        return make_danmaku_request_args('GET', server .. '/api/v2/search/anime?keyword=' .. encoded_query)
    end, per_response, function() searches_finished = true; finish() end, {concurrency = 5, per_request_timeout = 15})
end

-- 执行哈希匹配获取弹幕
local function match_file(file_path, file_name, callback)
    -- 计算文件哈希
    local hash = nil
    local file_info = utils.file_info(file_path)
    if file_info and file_info.size >= 16 * 1024 * 1024 then
        local file, error = io.open(normalize(file_path), 'rb')
        if file and not error then
            local m = MD5.new()
            for _ = 1, 16 * 1024 do
                local content = file:read(1024)
                if not content then
                    break
                end
                m:update(content)
            end
            file:close()
            hash = m:finish()
        end
    end

    if hash then msg.info('hash:', hash) end

    -- Without a real content hash, use the known work/season/episode and title.
    if not hash and mp.get_property_bool('user-data/tigerest/emby/valid', false) then
        match_anime()
        return
    end

    local title, season_num, episode_num = parse_title()
    if title and episode_num then
        if season_num then
            file_name = title .. " S" .. season_num .. "E" .. episode_num
        else
            file_name = title .. " E" .. episode_num
        end
    else
        file_name = title
    end

    local servers = get_api_server_list(options.api_server)

    local matched = false
    local cancel_fn = nil

    local function build_args(server)
        local url = server .. "/api/v2/match"
        return make_danmaku_request_args("POST", url, { ["Content-Type"] = "application/json" }, {
            fileName = file_name,
            fileHash = hash or "a1b2c3d4e5f67890abcd1234ef567890",
            matchMode = "hashAndFileName"
        })
    end

    local function per_response(server, err, out)
        if matched then return end
        if err then
            msg.debug(("match failed for %s: %s"):format(server, tostring(err)))
            return
        end
        local data = utils.parse_json(out)
        if not data or not data.isMatched then
            return
        end
        matched = true
        DANMAKU.anime = data.matches[1].animeTitle
        DANMAKU.episode = data.matches[1].episodeTitle

        set_episode_id(data.matches[1].episodeId, nil, server)
        if cancel_fn then pcall(cancel_fn) end
        if callback then pcall(callback) end
    end

    local function final_cb()
        if not matched then
            callback("没有匹配的剧集")
        end
    end

    cancel_fn = parallel_requests(servers, build_args, per_response, final_cb, { concurrency = 5, per_request_timeout = 15 })
end

-- 异步获取弹幕数据
function fetch_danmaku_data(args, callback)
    request_danmaku_http(args, {retry=true, kind='comment'}, function(result)
        if not result.ok then
            local notice = result.status == 429 and (mapping_rate_limit_message(args[#args]:match('^https?://[^/]+')) or '弹幕接口请求过于频繁，请稍后重试')
                or result.curl == 28 and '弹幕请求超时，请稍后手动重试'
                or result.status and ('弹幕请求失败（HTTP ' .. result.status .. '），请稍后重试')
                or '弹幕请求失败，请检查网络后重试'
            show_message(notice, 5)
            return
        end
        local json = result.body
        local data = utils.parse_json(json)
        if data ~= nil then
            data = normalize_danmaku_response(data)
        else
            local danmaku = parse_xml_danmaku(json)
            if #danmaku > 0 then
                data = {}
                data["xml"] = danmaku
            end
        end
        callback(data)
    end)
end

-- 保存弹幕数据
function save_danmaku_data(comments, query, danmaku_source)
    local danmaku_list = save_danmaku_to_list(comments)

    if DANMAKU.sources[query] ~= nil then
        DANMAKU.sources[query]["data"] = danmaku_list
    else
        DANMAKU.sources[query] = {from = danmaku_source, data = danmaku_list}
    end
end

function save_danmaku_xml(url, xml_string)
    local danmaku_list = parse_xml_danmaku(xml_string)

    if DANMAKU.sources[url] ~= nil then
        DANMAKU.sources[url]["data"] = danmaku_list
    else
        DANMAKU.sources[url] = {from = "user_custom", data = danmaku_list}
    end
end

function save_danmaku_json(url, json_string)
    local danmaku_list = parse_json_danmaku(json_string)

    if DANMAKU.sources[url] ~= nil then
        DANMAKU.sources[url]["data"] = danmaku_list
    else
        DANMAKU.sources[url] = {from = "user_custom", data = danmaku_list}
    end
end

function save_danmaku_downloaded(url, downloaded_file)
    local danmaku_list = parse_danmaku_file(downloaded_file)
    if file_exists(downloaded_file) then
        os.remove(downloaded_file)
    end
    if DANMAKU.sources[url] ~= nil then
        DANMAKU.sources[url]["data"] = danmaku_list
    else
        DANMAKU.sources[url] = {from = "user_custom", data = danmaku_list}
    end
end

-- 处理获取到的数据
function handle_fetched_danmaku(data, url, from_menu)
    if data and data["comments"] then
        if data["count"] == 0 then
            if DANMAKU.sources[url] == nil then
                DANMAKU.sources[url] = {from = "api_server"}
            end
            show_message("该集弹幕内容为空，结束加载", 3)
            msg.verbose("该集弹幕内容为空，结束加载")
            return
        end
        save_danmaku_data(data["comments"], url, "api_server")
        load_danmaku(from_menu)
    else
        show_message("无数据", 3)
        msg.info("无数据")
    end
end

-- 匹配弹幕库 comment, 仅匹配dandan本身弹幕库
-- 通过danmaku api（url）+id获取弹幕
function fetch_danmaku(episodeId, from_menu, api_server, save_failed)
    api_server = resolve_api_server(api_server)
    local wait = mapping_retry_after(api_server)
    if wait > 0 then
        show_message(string.format('弹幕接口请求过于频繁，请 %d 秒后重试', wait), 5)
        return
    end
    local url = api_server .. "/api/v2/comment/" .. episodeId .. "?withRelated=true&chConvert=0"
    show_message("弹幕加载中...", 30)
    msg.verbose("尝试获取弹幕：" .. url)
    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    fetch_danmaku_data(args, function(data)
        handle_fetched_danmaku(data, url, from_menu)
        if save_failed and data and data.comments then
            local outcome = (data.count == 0 or #data.comments == 0)
                and '该集弹幕内容为空' or '弹幕已加载'
            show_message(outcome .. (save_failed == 'missing-token'
                and '，但当前账户暂不可保存共享匹配，绑定未保存'
                or '，但共享匹配未保存'), 5)
        end
    end)
end

-- 从用户添加过的弹幕源添加弹幕
function addon_danmaku(dir, from_menu)
    if dir then
        local history_json = read_file(HISTORY_PATH)
        local history = utils.parse_json(history_json) or {}
        if history[dir] and history[dir].extra ~= nil then
            return
        end
    end
    for url, source in pairs(DANMAKU.sources) do
        if source.from ~= "api_server" then
            add_danmaku_source(url, from_menu)
        end
    end
end

--通过输入源url获取弹幕库
function add_danmaku_source(query, from_menu)
    if DANMAKU.sources[query] == nil then
        DANMAKU.sources[query] = {from = "user_custom"}
    end

    from_menu = from_menu or false
    if from_menu then
        add_source_to_history(query, DANMAKU.sources[query])
    end

    if is_protocol(query) then
        add_danmaku_source_online(query, from_menu)
    else
        add_danmaku_source_local(query, from_menu)
    end
end

function add_danmaku_source_local(query, from_menu)
    local path = normalize(query)
    if not file_exists(path) then
        msg.warn("无效的文件路径")
        return
    end
    if not (string.match(path, "%.xml$") or string.match(path, "%.json$")) then
        msg.warn("仅支持弹幕文件")
        return
    end

    if DANMAKU.sources[query] ~= nil then
        DANMAKU.sources[query]["from"] = "user_local"
        DANMAKU.sources[query]["data"] = parse_danmaku_file(path)
    else
        DANMAKU.sources[query] = {from = "user_local", data = parse_danmaku_file(path)}
    end

    set_danmaku_button()
    load_danmaku(from_menu)
end

--通过输入源url获取弹幕库
function add_danmaku_source_online(query, from_menu)
    set_danmaku_button()
    show_message("弹幕加载中...", 30)
    msg.verbose("尝试获取弹幕：" .. query)

    local servers = get_api_server_list(options.api_server)

    -- 过滤掉指向 dandanplay.net 的服务器
    local filtered = {}
    for _, s in ipairs(servers) do
        if type(s) == "string" and not s:lower():find("dandanplay%.net") then
            table.insert(filtered, s)
        end
    end
    servers = filtered
    if #servers == 0 then
        get_danmaku_fallback(query)
        return
    end

    local matched = false
    local cancel_fn = nil

    local function build_args(server)
        local url = server .. "/api/v2/extcomment?url=" .. url_encode(query)
        return make_danmaku_request_args("GET", url)
    end

    local function per_response(server, err, out)
        if matched then return end
        if err then
            msg.debug(("extcomment failed for %s: %s"):format(server, tostring(err)))
            return
        end
        local data = utils.parse_json(out)
        data = normalize_danmaku_response(data)
        if not data or not data["comments"] or data["count"] <= 1 then
            return
        end
        matched = true
        -- 保存并加载弹幕
        save_danmaku_data(data["comments"], query, "user_custom")
        load_danmaku(from_menu)
        -- 取消其他未完成请求
        if cancel_fn then pcall(cancel_fn) end
    end

    local function final_cb()
        if not matched then
            -- 所有服务器都未返回有效弹幕，回退到备用服务器
            msg.info("所有服务器均无有效弹幕，尝试备用服务器")
            get_danmaku_fallback(query)
        end
    end

    cancel_fn = parallel_requests(servers, build_args, per_response, final_cb, { concurrency = 3, per_request_timeout = 30 })
end

-- 将弹幕转换为 Lua table
function save_danmaku_to_list(comments)
    local danmaku_list = {}

    for _, comment in ipairs(comments) do
        local p = comment["p"]
        local shift = comment["shift"]
        if p then
            local fields = split(p, ",")
            if shift ~= nil then
                fields[1] = tonumber(fields[1]) + tonumber(shift)
            end
            local time = tonumber(fields[1])
            local type = tonumber(fields[2])
            local color = tonumber(fields[3]) or 0xFFFFFF
            local size = 25
            local m_value = comment["m"]
                            :gsub("[%z\1-\31]", "")
                            :gsub("\\", "")
                            :gsub("\"", "")
            table.insert(danmaku_list, {
                time = time,
                type = type,
                size = size,
                color = color,
                text = m_value
            })
        end
    end

    return danmaku_list
end

-- 通过文件前 16M 的 hash 值进行弹幕匹配
function get_danmaku_with_hash(file_name, file_path)
    if type(MD5) ~= "table" or not MD5.sum then
        msg.warn("MD5 模块不支持 Lua 5.1，回退到文件名匹配")
        match_anime()
        return
    end
    if is_protocol(file_path) then
        set_danmaku_button()
        local temp_file = "temp-" .. PID .. ".mp4"
        local arg = {
            "curl",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--range",
            "0-16777215",
            "--user-agent",
            options.user_agent,
            "--output",
            utils.join_path(DANMAKU_PATH, temp_file),
            "-L",
            file_path,
        }

        if options.proxy ~= "" then
            table.insert(arg, '-x')
            table.insert(arg, options.proxy)
        end

        call_cmd_async(arg, function(error)
            file_path = utils.join_path(DANMAKU_PATH, temp_file)

            match_file(file_path, file_name, function(error)
                if error then
                    msg.error(error)
                    msg.info("尝试通过解析文件名获取弹幕")
                    match_anime()
                end
            end)
        end)
    else
        local dir = get_parent_directory(file_path)
        local excluded_path = utils.parse_json(options.excluded_path)
        if PLATFORM == "windows" then
            for i, path in pairs(excluded_path) do
                excluded_path[i] = path:gsub("/", "\\")
            end
        end
        if contains_any(excluded_path, dir) then
            match_anime()
            return
        end
        match_file(file_path, file_name, function(error)
            if error then
                msg.error(error)
                msg.info("尝试通过解析文件名获取弹幕")
                match_anime()
            end
        end)
    end
end
