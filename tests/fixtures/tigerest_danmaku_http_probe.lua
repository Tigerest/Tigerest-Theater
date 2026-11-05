-- Native transport probe: real mpv timers/subprocesses/curl, local HTTP only.
local utils = require('mp.utils')
local output, root
local function save(name, value)
    local file = assert(io.open(output .. '/' .. name .. '.json', 'wb'))
    file:write(utils.format_json(value)); file:close()
end
function show_message() end

-- Old Windows inbox curl (no zlib). Only the `curl -V` answer is replaced;
-- every request still runs the real curl.
local PLAIN_CURL = 'curl 7.55.1 (Windows) libcurl/7.55.1 WinSSL\r\nRelease-Date: [unreleased]\r\n'
    .. 'Protocols: dict file ftp ftps http https imap imaps pop3 pop3s smtp smtps telnet tftp\r\n'
    .. 'Features: AsynchDNS IPv6 Largefile SSPI Kerberos SPNEGO NTLM SSL\r\n'
local curl_version
local real_command_native = mp.command_native
mp.command_native = function(command, ...)
    if curl_version and type(command) == 'table' and command.name == 'subprocess'
        and type(command.args) == 'table' and command.args[1] == 'curl' and command.args[2] == '-V' then
        return {status = 0, stdout = curl_version, stderr = ''}
    end
    return real_command_native(command, ...)
end

local function load_modules()
    dofile(root .. '/modules/utils.lua')
    dofile(root .. '/modules/http.lua')
    dofile(root .. '/modules/mapping.lua')
end
local function origin(url) return url:match('^https?://[^/]+') end

mp.register_script_message('http-probe-init', function(directory, results)
    root, output = directory, results
    package.path = root .. '/?.lua;' .. package.path
    load_modules()
    save('ready', {ready=true})
end)
-- Fresh module state (no cooldown, no cached curl features) with the loopback
-- server standing in for the Tigerest API; `plain` also swaps in the old curl.
mp.register_script_message('http-probe-managed', function(server, mode)
    curl_version = mode == 'plain' and PLAIN_CURL or nil
    load_modules()
    TIGEREST_REMOTE_API, TIGEREST_LOCAL_API = server, server
    dofile(root .. '/sites/bilibili.lua')
    save('managed-' .. mode, {ready=true})
end)
mp.register_script_message('http-probe-request', function(name, url, compressed)
    local args = {'curl', '--noproxy', '*', url}
    if compressed == 'compressed' then table.insert(args, 4, '--compressed') end
    request_danmaku_http(args, {retry=true, kind='comment'}, function(result)
        result.running = is_async_running()
        result.notice = mapping_rate_limit_message(origin(url))
        save(name, result)
    end)
end)
-- Searches and catalog reads: call_cmd_async, no --include.
mp.register_script_message('http-probe-command', function(name, url)
    call_cmd_async({'curl', '--silent', '--noproxy', '*', '--compressed', url}, function(err, body)
        body = type(body) == 'string' and body or ''
        local xml = bilibili_comment_xml and bilibili_comment_xml(body)
        save(name, {err=err, notice=mapping_rate_limit_message(origin(url)),
            json=body:sub(1, 1) == '{' and body or nil,
            raw=body:sub(1, 1) == '<', xml=type(xml) == 'string' and xml:sub(1, 1) == '<' and xml or nil})
    end)
end)
-- Compile (not run) every packaged plugin file in mpv's own Lua.
mp.register_script_message('http-probe-compile', function()
    local errors, files = {}, 0
    local function walk(dir)
        for _, name in ipairs(utils.readdir(dir, 'files') or {}) do
            if name:match('%.lua$') then
                files = files + 1
                local _, err = loadfile(dir .. '/' .. name)
                if err then errors[#errors + 1] = err end
            end
        end
        for _, name in ipairs(utils.readdir(dir, 'dirs') or {}) do walk(dir .. '/' .. name) end
    end
    walk(root)
    save('compiled', {files=files, count=#errors, errors=errors})
end)
mp.register_script_message('http-probe-cancel', function()
    cancel_danmaku_async_requests()
    save('cancelled', {running=is_async_running()})
end)
