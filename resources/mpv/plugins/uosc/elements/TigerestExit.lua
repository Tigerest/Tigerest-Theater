local Button = require('elements/Button')

---@class TigerestExit : Button
local TigerestExit = class(Button)

function TigerestExit:new() return Class.new(self) --[[@as TigerestExit]] end
function TigerestExit:init()
	Button.init(self, 'tigerest_exit', {
		icon = 'exit_to_app',
		tooltip = '退出播放并返回媒体库',
		on_click = function() mp.command('stop') end,
		render_order = 9998,
	})
	-- The playback escape hatch is independent from the normal control bar,
	-- but should not remain burned into the picture. Show it when playback
	-- starts or the pointer moves, then hide it after a short idle period.
	self.idle_visibility = 1
	self.ignores_curtain = true
	self.idle_timer = mp.add_timeout(3, function()
		self.idle_visibility = 0
		request_render()
	end)
	self:register_disposer(function() self.idle_timer:kill() end)

	local function reveal()
		self.idle_visibility = 1
		self.idle_timer:kill()
		self.idle_timer:resume()
		request_render()
	end
	self.last_cursor_x, self.last_cursor_y = cursor.x, cursor.y
	self:register_disposer(cursor:on('move', function()
		-- libmpv can publish duplicate mouse-pos notifications while the mouse
		-- is stationary. Only a real coordinate change resets the idle timer.
		if self.last_cursor_x == cursor.x and self.last_cursor_y == cursor.y then return end
		self.last_cursor_x, self.last_cursor_y = cursor.x, cursor.y
		reveal()
	end))
	self:register_mp_event('file-loaded', reveal)
	self:update_dimensions()
end

function TigerestExit:update_dimensions()
	local margin = round(12 * state.scale)
	local size = round(44 * state.scale)
	self:set_coordinates(margin, margin, margin + size, margin + size)
end

function TigerestExit:on_display() self:update_dimensions() end
function TigerestExit:on_options() self:update_dimensions() end

function TigerestExit:get_visibility()
	return self.idle_visibility
end

function TigerestExit:render()
	if not state.is_video then return end
	return Button.render(self)
end

return TigerestExit
