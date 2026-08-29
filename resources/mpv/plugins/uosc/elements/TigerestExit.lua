local Button = require('elements/Button')

---@class TigerestExit : Button
local TigerestExit = class(Button)

function TigerestExit:new() return Class.new(self) --[[@as TigerestExit]] end
function TigerestExit:init()
	Button.init(self, 'tigerest_exit', {
		icon = 'close',
		tooltip = '退出播放并返回媒体库',
		on_click = function() mp.command('stop') end,
		render_order = 9998,
		anchor_id = 'controls',
		ignores_curtain = true,
	})
	-- Follow UOSC's own controls visibility. A separate idle timer can expire
	-- independently of the controls and make the escape hatch appear missing.
	self:update_dimensions()
end

function TigerestExit:update_dimensions()
	local margin = round(12 * state.scale)
	local size = round(44 * state.scale)
	self:set_coordinates(margin, margin, margin + size, margin + size)
end

function TigerestExit:on_display() self:update_dimensions() end
function TigerestExit:on_options() self:update_dimensions() end

function TigerestExit:render()
	if not state.is_video then return end
	return Button.render(self)
end

return TigerestExit
