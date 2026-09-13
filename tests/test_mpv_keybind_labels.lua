return function(root)
    local label = dofile(root .. '/tigerest_keybind_labels.lua')
    local cases = {
        {'cycle pause', '暂停 / 继续'},
        {'no-osd seek -5 exact', '后退 5 秒'},
        {'seek 50 absolute-percent', '跳转到 50%'},
        {'add volume -5', '音量减少 5'},
        {'add speed 0.1', '倍速增加 0.1'},
        {'set speed 1.0', '恢复正常倍速'},
        {'script-binding profile_menu/apply-default', '切换到默认画质'},
        {'script-binding uosc/keybinds', '查看快捷键'},
        {'script-binding commands/open', '打开 MPV 控制台'},
        {'script-binding stats/display-page-2', '显示帧处理统计'},
        {'cycle sub down', '切换字幕轨道（反向）'},
        {'show-text "quoted; cycle pause"', '自定义命令'},
    }
    for _, test in ipairs(cases) do
        local actual = label(test[1])
        assert(actual:find(test[2], 1, true), test[1] .. ' => ' .. tostring(actual))
        assert(actual:find(test[1], 1, true), 'Original command lost: ' .. test[1])
    end
end
