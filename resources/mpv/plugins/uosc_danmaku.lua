-- Tigerest Theater loader for uosc_danmaku's directory-style distribution.
-- The named entry point keeps script bindings and user-data under the stable
-- `uosc_danmaku` namespace expected by the bundled menus.
local loader_path = debug.getinfo(1, 'S').source
if loader_path:sub(1, 1) == '@' then loader_path = loader_path:sub(2) end
local loader_dir = loader_path:match('^(.*)[/\\]') or '.'
local package_root = loader_dir .. '/uosc_danmaku'
mp.get_script_directory = function() return package_root end
package.path = package_root .. '/?.lua;' .. package_root .. '/?/init.lua;' .. package.path
dofile(package_root .. '/main.lua')
