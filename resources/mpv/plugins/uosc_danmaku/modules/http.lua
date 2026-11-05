-- Bounded comment transport. Retry reads only; never replay a mapping write.
local msg = require('mp.msg')
local active = {}
local MAX_BODY = 16 * 1024 * 1024
local transient_http = {[408]=true, [502]=true, [503]=true, [504]=true}
local transient_curl = {[6]=true, [7]=true, [18]=true, [28]=true, [52]=true, [55]=true, [56]=true}

local function response(stdout)
    if type(stdout) ~= 'string' or #stdout > MAX_BODY + 65536 then return nil end
    local function split(value)
        local _, finish = value:find('\r\n\r\n', 1, true)
        if not finish then _, finish = value:find('\n\n', 1, true) end
        if not finish then return nil end
        local headers = value:sub(1, finish)
        return tonumber(headers:match('^HTTP/[%d.]+ (%d+)')), headers, value:sub(finish + 1)
    end
    local status, headers, body = split(stdout)
    -- Redirects, proxy CONNECT and 100 Continue can prepend header blocks.
    while status and body and body:match('^HTTP/') do status, headers, body = split(body) end
    if not status or not body or #body > MAX_BODY then return nil end
    local retry
    for line in (headers .. '\n'):gmatch('(.-)\r?\n') do
        local key, value = line:match('^([^:]+):%s*(.*)$')
        if key and key:lower() == 'retry-after' then retry = value end
    end
    return status, body, retry
end

function cancel_danmaku_http_requests()
    local previous = active
    active = {}
    for cancel in pairs(previous) do cancel() end
end

function request_danmaku_http(args, policy, callback)
    local command = {}
    for i, value in ipairs(curl_command(args)) do command[i] = value end
    local function option(flag, value)
        for _, existing in ipairs(command) do if existing == flag then return end end
        table.insert(command, #command, flag)
        if value then table.insert(command, #command, value) end
    end
    option('--silent'); option('--show-error'); option('--include')
    option('--connect-timeout', '5'); option('--max-time', tostring(policy.timeout or 20))
    option('--max-filesize', tostring(MAX_BODY))
    local server = command[#command]:match('^https?://[^/]+')
    local stopped, request_id, timer, attempts = false, nil, nil, 0
    local cancel, finish, start
    mark_async_start()
    cancel = function()
        if stopped then return end
        stopped = true; active[cancel] = nil
        if timer then timer:kill(); timer = nil end
        if request_id then mp.abort_async_command(request_id); request_id = nil end
        mark_async_end()
    end
    active[cancel] = true
    finish = function(result)
        cancel()
        callback(result)
    end
    start = function()
        timer = nil
        if stopped then return end
        if policy.current and not policy.current() then cancel(); return end
        -- A different request may have received 429 during our backoff.
        local wait = mapping_retry_after(server)
        if wait > 0 then finish({ok=false, status=429, retryAfter=tostring(wait)}); return end
        attempts = attempts + 1
        request_id = mp.command_native_async({name='subprocess', args=command, playback_only=true,
            capture_stdout=true, capture_stderr=true, capture_size=MAX_BODY + 65536}, function(ok, result)
            if stopped then return end
            request_id = nil
            if policy.current and not policy.current() then cancel(); return end
            local status, body, retry = response(result and result.stdout)
            local code = result and result.status
            if status == 429 then mapping_record_rate_limit(server, retry, body) end
            local success = ok and code == 0 and status and status >= 200 and status < 300
            if success then finish({ok=true, status=status, body=body}); return end
            local terminal_http = status and status >= 400 and status < 500 and status ~= 408
            local transient = not terminal_http and (transient_curl[code] or (ok and code == 0 and transient_http[status]))
            -- Log only status metadata. Response bodies/URLs/stderr may contain credentials.
            msg.warn(string.format('Danmaku HTTP %s: kind=%s status=%s curl=%s attempt=%d',
                transient and policy.retry and attempts < 2 and 'retry' or 'failed',
                policy.kind or 'comment', tostring(status or 0), tostring(code or -1), attempts))
            if transient and policy.retry and attempts < 2 then
                show_message('弹幕请求暂时失败，1 秒后重试（1/1）', 3)
                timer = mp.add_timeout(1, start)
            else finish({ok=false, status=status, curl=code, retryAfter=retry}) end
        end)
    end
    start()
    return cancel
end
