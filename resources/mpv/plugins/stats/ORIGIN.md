# Chinese mpv statistics overlay

`../stats.lua` is the complete mpv `player/lua/stats.lua` from commit
`dd5d17d3285a095a0f712fa9d116e22a076492de`:
https://github.com/mpv-player/mpv/blob/dd5d17d3285a095a0f712fa9d116e22a076492de/player/lua/stats.lua

The upstream authors and attribution remain in the script header and upstream
Git history. mpv's project licensing notice is included as `UPSTREAM-Copyright`;
the GPL version 2 text is included as `LICENSE.GPL`. This vendored version and
its Tigerest modifications are distributed under GPL version 2 or later.

Tigerest changes (2026-10-05): Chinese visible labels and navigation, page 6 with
brief troubleshooting guidance, current synchronization mode, hiding the display
refresh estimate while display synchronization is inactive, output-drop display
even if the decoder counter is absent, and explicit limits of rendering timings.
The owned `@tigerest-rife` video filter uses a compact name/factor/model summary
instead of displaying its internal script, engine and runtime paths and JSON.
Factor and model come from the filter's `user-data` JSON; absent or invalid
metadata does not produce invented values. Path-valued models display only the
last path component. Other filters retain upstream parameter display, and no
raw mpv filter properties are changed.
Tigerest change (2026-10-27): `plot_perfdata` defaults to on, so page 2 draws a
timing graph beside each rendering pass. At 4K 240 Hz on an RTX 4090 the graphs
added about 17 µs of overlay GPU time per frame and no measurable CPU over the
text-only page; `script-opts=stats-plot_perfdata=no` restores the upstream view.
Shader names, API property names, rendering pass data, graphs, scrolling and the
upstream script-binding names remain intact. Native RIFE inference time is not
fabricated or derived from rendering timing.

Bindings: `stats/display-stats-toggle` (Ctrl+J), `stats/display-page-2`
(Ctrl+Shift+J), and `stats/display-page-6` (help). Page keys 0–6 work while stats
are displayed; upstream Up/Down scrolling and Escape are preserved.

Runtime fixture verification on Windows:

```powershell
. ./dev/windows/Enter-TestEnvironment.ps1
python tests/test_mpv_stats_overlay.py
```

The fixture loads the shipped script in the bundled libmpv Lua runtime and
controls read-only video metrics and OSD capture. It verifies API compatibility
and display behavior, not production media, actual GPU costs or visual smoothness.
The RIFE regression cases verify compact valid metadata, malformed JSON handling,
preservation of the raw filter properties, and unchanged custom VS-filter output.
