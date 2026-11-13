local Element = require('elements/Element')

-- Emby's intro marker for the playing item. The client publishes it as JSON in
-- user-data/tigerest/intro-skip ({start, end, auto}, seconds) once the server's
-- user setting allows it. Inside the intro this element shows a "skip intro"
-- button, or jumps past the intro itself when the setting is automatic. Emby's
-- own button lives in its HTML OSD, which is not shown while UOSC owns the
-- playback surface.
---@class TigerestSkipIntro : Element
local TigerestSkipIntro = class(Element)

local PROPERTY = 'user-data/tigerest/intro-skip'
-- The button's rectangle while it is offered, false otherwise: for the host
-- and for tests, which have no other way to see what UOSC draws.
local BUTTON_PROPERTY = 'user-data/tigerest/intro-skip-button'
-- Emby's own margins: the offer ends 2 s before the intro does, and 5 s before
-- once it has been taken, so a seek that lands just short of the end does not
-- bring it back.
local MARGIN, MARGIN_AFTER_SKIP = 2, 5
local LABEL = '跳过片头'

function TigerestSkipIntro:new() return Class.new(self) --[[@as TigerestSkipIntro]] end
function TigerestSkipIntro:init()
	Element.init(self, 'tigerest_skip_intro', {render_order = 4})
	---@type {start: number, finish: number, auto: boolean}|nil
	self.intro = nil
	self.margin = MARGIN
	self.offered = false
	self.seeking = false
	---@type string|false|nil The rectangle last published; nil before the first.
	self.published = nil
	self.font_size = 0
	self:publish()
	-- Read natively: as a string, a user-data value arrives JSON-encoded once more.
	self:observe_mp_property(PROPERTY, 'native', function(_, value) self:set_intro(value) end)
	-- A seek is over: a position inside the intro is where the viewer is now.
	self:register_mp_event('playback-restart', function()
		self.seeking = false
		self:decide()
	end)
end

function TigerestSkipIntro:destroy()
	self.offered = false
	self:publish()
	Element.destroy(self)
end

---@param json any The property's value: a JSON string, or nothing.
function TigerestSkipIntro:set_intro(json)
	local data = type(json) == 'string' and json ~= '' and utils.parse_json(json) or nil
	if type(data) ~= 'table' then data = nil end
	local start, finish = data and tonumber(data.start), data and tonumber(data['end'])
	if start and finish and start >= 0 and finish > start then
		self.intro = {start = start, finish = finish, auto = data.auto == true}
	else
		self.intro = nil
	end
	self.margin, self.seeking = MARGIN, false
	self:decide()
end

function TigerestSkipIntro:decide()
	local intro, time = self.intro, state.time
	if intro and time and time <= intro.start then self.margin = MARGIN end
	local inside = intro ~= nil and time ~= nil and not self.seeking
		and time >= intro.start and time < intro.finish - self.margin
	if inside ~= self.offered then
		self.offered = inside
		if inside and intro.auto then
			self:skip()
			mp.commandv('show-text', '已跳过片头', 2000)
		end
		request_render()
	end
	self:publish()
end

-- Jumps past the intro while it is offered: the button, automatic skipping and
-- `script-binding uosc/skip-intro` all end here.
function TigerestSkipIntro:skip()
	local intro = self.intro
	if not intro or not self.offered then return end
	-- Positions reported until the seek lands are still inside the intro.
	self.margin, self.seeking, self.offered = MARGIN_AFTER_SKIP, true, false
	mp.commandv('seek', intro.finish, 'absolute+exact')
	-- A seek that never restarts playback must not hide the offer for good.
	mp.add_timeout(3, function() self.seeking = false end)
	self:publish()
	request_render()
end

function TigerestSkipIntro:has_button()
	return self.offered and self.intro ~= nil and not self.intro.auto and state.is_video
end

function TigerestSkipIntro:publish()
	local shown = self:has_button()
	if shown then self:layout() end
	local rectangle = shown and table.concat({self.ax, self.ay, self.bx, self.by}, ',') or false
	if rectangle == self.published then return end
	self.published = rectangle
	mp.set_property_native(BUTTON_PROPERTY,
		shown and {ax = self.ax, ay = self.ay, bx = self.bx, by = self.by} or false)
end

-- Above the controls and clear of the volume slider on the right edge. Worked
-- out when the button is shown, from where those elements are now: the events
-- that announce their layout reach this element before some of them have moved.
function TigerestSkipIntro:layout()
	local scale = state.scale
	self.font_size = round(18 * scale)
	local height, padding, margin = round(42 * scale), round(20 * scale), round(20 * scale)
	-- Four full-width characters, each one em wide.
	local width = self.font_size * 4 + padding * 2
	local border = Elements:v('window_border', 'size', 0)
	local bottom = (Elements:v('controls', 'ay') or Elements:v('timeline', 'ay') or display.height - border) - margin
	local right = (options.volume == 'right' and Elements:v('volume', 'ax') or display.width - border) - margin
	local ax, ay = right - width, bottom - height
	if ax ~= self.ax or ay ~= self.ay or right ~= self.bx or bottom ~= self.by then
		self:set_coordinates(ax, ay, right, bottom)
	end
end

function TigerestSkipIntro:on_prop_is_video() self:publish() end
function TigerestSkipIntro:on_prop_time() self:decide() end

function TigerestSkipIntro:render()
	-- A menu owns the screen while its curtain is up.
	if not self:has_button() or Elements.curtain.opacity > 0 then return end
	self:publish()

	-- The callback runs on the next tick, as for UOSC's own buttons: a handler
	-- that changes the element stack must not see the click that started it.
	cursor:zone('primary_down', self, function() mp.add_timeout(0.01, function() self:skip() end) end)

	local ass = assdraw.ass_new()
	local hover = self.proximity_raw <= 0
	ass:rect(self.ax, self.ay, self.bx, self.by, {
		color = hover and fg or bg,
		radius = state.radius,
		opacity = hover and 0.95 or 0.72,
		border = 1,
		border_color = fg,
	})
	ass:txt(round((self.ax + self.bx) / 2), round((self.ay + self.by) / 2), 5, LABEL, {
		size = self.font_size,
		bold = true,
		color = hover and bg or fg,
	})
	return ass
end

return TigerestSkipIntro
