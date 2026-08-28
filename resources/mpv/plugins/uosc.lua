-- Tigerest Theater loader for uosc's directory-style distribution.
-- Keeping this entry point outside the package gives mpv the stable script
-- name `uosc`, while the wrapped directory remains the resource root used by
-- uosc for modules, translations, and the ziggy helper.
local loader_path = debug.getinfo(1, 'S').source
if loader_path:sub(1, 1) == '@' then loader_path = loader_path:sub(2) end
local loader_dir = loader_path:match('^(.*)[/\\]') or '.'
local package_root = loader_dir .. '/uosc'
mp.get_script_directory = function() return package_root end
package.path = package_root .. '/?.lua;' .. package_root .. '/?/init.lua;' .. package.path
dofile(package_root .. '/main.lua')
