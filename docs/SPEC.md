# Bemotion Scene Spec

A Bemotion video is one JSON file. It describes scenes, layers, animation and camera work. The engine renders it with real 3D, motion blur, bloom and shader transitions. This guide is the complete reference for writing one. It is written for both humans and AI agents.

## 1. Mental model

- **Canvas.** Default 1920x1080 at 30 fps. Coordinates are **pixels**, origin at the **center** of the frame, **+x right, +y up, +z toward the camera**. The visible area is x in [-960, 960], y in [-540, 540]. Keep important content inside x in [-860, 860], y in [-470, 470].
- **Everything is 3D.** Every layer sits in a real perspective scene. `z`, `rotateX` and `rotateY` give true depth and parallax. A layer at z = 0 renders at exactly its pixel size. Positive z is closer and bigger.
- **Scenes** play in order. A scene's `transition` brings it in and overlaps the end of the previous scene by the transition's duration.
- **Times are scene-local.** `0` is the moment the scene starts. A time is a number of seconds or a string: `"1.5s"`, `"250ms"`, `"12f"` (frames), `"4b"` (beats, needs top-level `bpm`).
- **Paint order.** Flat layers (text, shapes, UI) draw in array order: later layers draw on top. Children draw on top of their parent. 3D meshes use real depth.
- **Colors.** Hex (`#7C5CFF`, `#7C5CFF80` with alpha), `rgb()/rgba()/hsl()`, or theme tokens like `$primary`. A token takes an alpha suffix in percent: `$primary/30`.

## 2. Top-level fields

```json
{
  "title": "Acme Launch",
  "width": 1920, "height": 1080, "fps": 30,
  "bpm": 120,
  "theme": {
    "colors": { "primary": "#7C5CFF", "secondary": "#22D3EE", "accent": "#F472B6" },
    "fonts": { "display": "Sora", "body": "Inter", "mono": "JetBrains Mono" }
  },
  "fonts": { "Brand Sans": "fonts/brand.woff" },
  "background": "$bg",
  "post": { "bloom": { "strength": 0.7 }, "grain": 0.03, "vignette": 0.3, "chromatic": 1 },
  "motionBlur": { "samples": 10, "shutter": 0.6 },
  "audio": [{ "src": "music.mp3", "volume": 0.9, "fadeOut": 1.5 }],
  "scenes": [ ... ]
}
```

| Field | Notes |
|---|---|
| `bpm` | Enables beat times (`"2b"`). Cut on beats for punchy edits. |
| `theme.colors` | Overrides tokens. Defaults: `bg #07070B`, `surface #111118`, `surface2 #1A1A24`, `border #2A2A3A`, `text #F5F5FA`, `muted #9A9AB0`, `primary #7C5CFF`, `secondary #22D3EE`, `accent #F472B6`, `success #34D399`, `warning #FBBF24`, `danger #F87171`. You may add your own names. |
| `theme.fonts` | Maps `display`, `body`, `mono` (or any alias) to a family. |
| `fonts` | Custom `.woff`, `.ttf` or `.otf` files, relative to the spec file. Not `.woff2`. |
| `post` | Global post-processing, see section 8. |
| `environment` | What 3D materials reflect and are lit by. Presets: `room` (default, neutral), `softbox` (bright product studio for white sets; metals read rich, with a natural glare from the upper right), `studio` (dark studio with softbox strips for dark, luxurious sets). For photoreal lighting use a real HDRI photograph: `"hdri:<id>"` with any [Poly Haven](https://polyhaven.com/hdris) id (`studio_small_09` and `brown_photostudio_02` are bundled; others download once), a `.hdr`/`.exr` file next to the spec, or `{ "src": "hdri:studio_small_09", "intensity": 0.8, "rotation": 120, "res": "2k" }`. `rotation` (degrees) turns the studio to move where highlights fall. `bemotion hdri list` browses ids. |
| `lighting` | Real-time lighting, global or per scene: `{ "shadows": true, "ground": -380, "shadowOpacity": 0.15, "softness": 16, "key": [x, y, z], "intensity": 1 }`. `shadows` casts soft shadows from 3D meshes and models onto an invisible floor at y = `ground`. This is what makes objects sit on a white set. `key` is the light direction. |
| `motionBlur` | Final-render motion blur. `true` (default, 8 samples, shutter 0.5), `false`, or `{samples, shutter}`. Shutter is a fraction of a frame (0.5 = 180 degrees). |
| `audio` | Tracks mixed into the MP4: `src`, `role` (`music` default, `voice`, `sfx`), `at` (start time on the global timeline), `volume` (music defaults to 0.8), `trim` (skip into the file), `fadeIn`, `fadeOut` (music fades out over the last 1.5 s by default), `loop` (music loops to fill the video by default), `duck` (music dips automatically while a `voice` track speaks, default true), `sync` (cut the video to this track's beats, see below), `script` and `align` (voice tracks: follow the voiceover, see below). With music present the automatic sound effects play at half volume as accents. On the command line: `bemotion render ad.json --music song.mp3 --voice vo.wav --voice-at 0.5`. |
| `sfx` | Automatic sound design, on by default. The engine places synthesized effects on every entrance, word build, cursor click, button press, confetti burst, camera punch and transition. `false` disables; `{ "volume": 0.9, "mute": ["tick"], "kit": "soft", "seed": 4, "reverb": 0.2 }` tunes it. `kit`: `studio` (default: real recordings, so nothing sounds like a beep: paper taps for words, card swishes for slides and transitions, fanned cards and cloth for big moves, mouse clicks for typing and the cursor, wood knocks for pops, glass for sparkles, soft thumps for impacts; each cue picks a different take and a slightly different pitch, and runs of words rise gently), `soft` (synthesized felt taps and warm mallet notes in a small room), `tactile` (synthesized marimba and woodblock, playful), `classic` (bright synthetic clicks and hiss, for hype). In the synthesized kits pitched cues follow a pentatonic scale in a key picked per video, so a word-by-word build plays a short rising phrase. `seed` (default: from the title) changes the variations and key. |
| `formats` | Per-format settings for vertical and square versions, e.g. `{ "9:16": { "zoom": 0.9 } }`. See Formats below. |
| `captions` | Captions from the voiceover's `script`, timed to the speech: `true`, or `{ "size": 44, "color", "y", "weight", "font", "maxWords": 6 }`. Phrases break at pauses, commas and sentence ends; words reveal as they are said; the color follows each scene's background unless set. |
| `score` | Music composed for the video instead of a recorded track: `{ "style": "warm" }`. See Generated score below. |
| `sounds` | Extra effects at global times (in the spec's own timing: with a synced music track they move with the cuts): `[{ "sound": "chime", "at": 12.4, "gain": 0.8 }]`. With `scene` (an id or index) `at` counts from that scene's start, so the sound stays with its moment when earlier scenes change length: `{ "sound": "chime", "scene": "cta", "at": 1.2 }`. Prefer it over global times, and prefer a layer's own `sound` (section 5) over both: it follows the layer. Sounds: `whoosh`, `swoosh`, `soft`, `pop`, `tick`, `key`, `click`, `impact`, `sparkle`, `chime`, `glitch`. |

**Cutting to the music.** Set `"sync": true` on a music track in `audio` (the file must sit next to the spec) and the video is cut to its beats: the engine finds the tempo and beats, then plays the video through a gentle time warp so every scene change, transition and top-level layer that starts partway into a scene (lines of type, counters, confetti) lands on a beat. Between those moments time runs uniformly up to about 20% faster or slower, so keyframes, morphs and camera moves stay in proportion; moments that would need more, or that sit within 0.3 s of the previous one, stay where they are. The video's length changes by a fraction of a second. Write the spec with natural timing; do not hand-place times on beats. The preview's timeline shows the synced timing; times in the spec stay as written.

```json
"audio": [{ "src": "audio/track.mp3", "sync": true }]
```

**Generated score.** `"score": { "style": "warm" }` writes and plays music made for this video, with nothing to license and the same result every render. The video is cut to the score's beats (as with `sync`), each scene gets a section that starts on its cut, chords change as scenes cut in, a cadence leads into the last scene and the music resolves on the tonic as the ad lands. Energy builds from a quiet open to a full band in the last third and settles for the final scene; who plays follows the energy: a pad and electric piano throughout, bass as it starts to move, plucked guitar and brushed drums as it builds, a bell melody at the peak, a swell into each lift. Styles: `warm` (84 bpm: electric piano, pad, plucked guitar, round bass, brushed drums; relaxed, friendly, the default), `ambient` (72 bpm: pads, electric piano and bells, no drums; calm, premium), `bright` (104 bpm: plucks forward, claps; upbeat), `cinematic` (70 bpm: wide strings, a string ostinato that builds, low booms on the downbeats, piano melody, big hall; launches and reveals), `lofi` (80 bpm: electric piano with tape wobble, boom-bap drums with a lazy swing, vinyl crackle, a dark top; cozy, laid back), `piano` (76 bpm: solo acoustic piano, chords, left hand and melody, a little pad; personal, reflective). Under a voiceover with a `script` the arrangement thins out while the voice speaks (no melody or backbeat, softer comping) and comes back between phrases, besides the usual dip. Fields: `tempo` (bpm), `key` (`"D"`, `"Bb"`, `"F#"`...), `mode` (`major` default, `minor`), `volume` (default 1), `seed` (varies chords, patterns and melody; default from the title), `energy` (per scene id or index, 0 still to 1 full band, overriding the arc: `{ "hook": 0.2, "demo": 0.9 }`), `sync` (default true; `false` keeps the spec's timing and lets the music cross cuts mid-bar), `drums` (`false` leaves them out). Do not add a music track to `audio` as well. `bemotion score ad.json` writes the music alone to a WAV in seconds, for trying styles, keys and energies (`--style lofi`, `--key D`, `--seed 3`, or `--all` for one file per style). In the preview, the Sound panel's Score row picks the style and mode and makes a new take.

```json
"score": { "style": "warm", "key": "D", "energy": { "reveal": 0.9 } }
```

**Following a voiceover.** Give a `voice` track its `script` (what is said, word for word, with punctuation) and the engine works out when each word is spoken: it finds the speech in the recording and shares the script's words out over it (no speech model needed; accurate to about a tenth of a second for clear narration). With `"align": true` the video follows the voice: each top-level line of type (and each `morph` step) is matched, in order, to the moment its first words are said, and the video is retimed so the line arrives just as it is spoken; scenes lengthen or shorten with the narration. Lines that are not spoken stay in proportion between the ones that are. `"captions": true` adds captions. Write lines in narration order; numbers on screen may be spoken as words. `bemotion voice vo.wav --script-file script.txt` prints when each phrase is said, for planning a spec around a recording.

```json
"audio": [{ "src": "audio/vo.wav", "role": "voice", "align": true,
  "script": "When you work at a small business, IT can be a big deal." }],
"captions": { "size": 40 }
```

**Generated voiceover.** With no recording, add `"tts": true` to a voice track and its `script` is spoken into `src` before the video plays or renders (spoken again whenever the script or voice settings change), then aligned like a recording. `true` uses the computer's own voice (free, fine for drafts); `{ "provider": "elevenlabs", "voice": "<voice id>" }` (needs `ELEVENLABS_API_KEY`) or `{ "provider": "openai", "voice": "sage", "instructions": "warm and unhurried" }` (needs `OPENAI_API_KEY`) give a finished voice. `rate` (-10 to 10) sets the pace. `bemotion say "..." -o vo.wav` speaks a script alone; `bemotion say --voices` lists the computer's voices.

```json
"audio": [{ "src": "audio/vo.wav", "role": "voice", "tts": true, "align": true,
  "script": "Meet Lumen. Your notes, finally in one place." }]
```

With both, `align` takes precedence over a music track's `sync`.

**Formats (vertical and square versions).** Design the video at 16:9; the same spec also renders at `9:16` (1080x1920), `1:1` (1080x1080) and `4:5` (1080x1350) with `bemotion render ad.json -f 9:16,1:1` (writes `ad-9x16.mp4`, `ad-1x1.mp4`). Without any extra work:

- The narrower frame shows a narrower slice of the layout at the same scale (9:16) or slightly zoomed out (`zoom` 0.9 for 1:1 and 4:5; set your own with top-level `"formats": { "9:16": { "zoom": 0.85 } }`).
- Text without a `maxWidth` wraps when it would run past the frame, into evenly long lines.
- A scene whose shapes, images, video, UI frames (browser, laptop, chart, code, card) or phones reach past the frame zooms out as a whole (scene `zoom`, never below 0.6), so compositions stay intact. Groups and decorative fields that bleed off the edges are not counted.

Anything that should sit differently in a format says so with `formats` on the layer or scene. Fields replace the layer's (no deep merge); `false` leaves the layer out of that format:

```json
{ "type": "text", "text": "Every device.", "size": 120, "formats": { "9:16": { "y": 380, "size": 150 } } },
{ "type": "image", "src": "wide-banner.png", "formats": { "9:16": false, "1:1": { "width": 900 } } }
```

Scene `"formats": { "9:16": { "zoom": 0.8, "camera": { ... } } }` replaces scene fields the same way. Check each format with `bemotion still ad.json -f 9:16 -t ...` or the Format switch in the preview. Editing in the preview always edits the design itself.

For TikTok, Reels and Shorts, keep text, logos and buttons out of the app's interface: roughly the top 150 to 270 px, the bottom 420 to 670 px (caption and username) and the right 130 to 190 px from about mid-height down (action buttons) of the 1080x1920 frame. `bemotion check ad.json --platform tiktok,reels,shorts` reports what sits under them (it checks the 9:16 version); `bemotion preview ad.json --safe tiktok` draws them over the preview.

**Cutdowns.** `bemotion cutdown ad.json --length 15,6` writes `ad.cut15.json` and `ad.cut6.json`: the hook and the end card always stay, the scenes that name the product, echo the tagline or show a number come next, and the kept scenes are retimed together (every layer time, keyframe, `delay` and camera move scales with its scene; entrances keep their speed) but never below the time their lines need to be read. Give scenes ids that say their role (`hook`, `reveal`, `product`, `stats`, `cta`) to help it choose; `--keep hook,product,cta` chooses yourself. Shared elements whose partner was cut lose `share`, `sounds` of cut scenes go, a voiceover is left out, and a generated `score` follows the new scenes. `-f 9:16` checks the formats too, `--render` renders them.

**Templates.** Any string in a spec can hold a `{{name}}` placeholder (copy, an image `src`, a color, the URL), so one spec serves many products, customers or languages. A top-level `slots` block describes them: `"slots": { "company": { "label": "Company" }, "accent": { "default": "#4F46E5" } }`. A string that is only a placeholder and gets a number becomes a number (`"size": "{{size}}"`). `bemotion fill ad.json --set company=Acme` writes the filled spec; `bemotion batch ad.json rows.csv --render` writes and renders one video per CSV row (columns are the placeholder names; a `name` column names the files; image paths in the CSV are relative to it).

**Bundled font families:** Inter, Sora, Space Grotesk, Manrope, Bricolage Grotesque, Instrument Serif (400 only, has italic), JetBrains Mono. The nearest available weight is used.

## 3. Scenes

```json
{
  "id": "hook",
  "duration": 2.5,
  "background": "#05050A",
  "transition": { "type": "whip", "duration": 0.45, "direction": "left" },
  "camera": { "moves": [{ "preset": "pushIn", "amount": 300 }] },
  "post": { "bloom": { "strength": 1.2 } },
  "layers": [ ... ]
}
```

**Transitions** (`transition.type`, set on the scene being transitioned **into**):

| Type | Look | Typical duration |
|---|---|---|
| `cut` | Hard cut, no overlap | n/a |
| `fade` | Crossfade | 0.4-0.8 |
| `black` | Dip to black (or `color`) | 0.5-0.8 |
| `flash` | Blown-out white flash (or `color`) | 0.3-0.45 |
| `slide` | New scene slides over the old | 0.4-0.6 |
| `push` | New scene pushes the old one out | 0.4-0.6 |
| `whip` | Whip pan with heavy directional blur. The hype-ad staple. | 0.35-0.5 |
| `zoom` | Zoom-through with radial blur | 0.4-0.6 |
| `zoomOut` | Reverse zoom-through | 0.4-0.6 |
| `glitch` | RGB split and block displacement | 0.25-0.4 |
| `wipe` | Soft-edged directional wipe | 0.5-0.8 |
| `circle` | Iris reveal from center | 0.5-0.8 |
| `pixelate` | Pixelate out and back in | 0.4-0.6 |
| `blur` | Blur out and in | 0.5-0.8 |
| `split` | Horizontal bands slide in alternately | 0.5-0.8 |
| `mask` | The next scene appears inside a word (`text`, with optional `font` and `weight`, default 800) or a logo (`svg`: `{ "d": "<path data>", "viewBox": [0, 0, 24, 24] }`) at the center, then the view dives into the letter until it fills the frame. Clear the outgoing scene's copy just before it. With `from` (the id of a text or counter layer in the outgoing scene) the mask starts exactly over that layer's letters instead, taking its text (a counter's final number, a morphing text's last step), font, weight and `letterSpacing`, and replaces it: the number on screen becomes the window into the next scene. `text` is then optional. | 1.1-1.5 |

`direction` (`left`, `right`, `up`, `down`) is the direction the content moves. `ease` overrides the curve.

Scenes also take `zoom`: it scales every layer (backgrounds excluded) about the frame center, with camera positions following. Narrower formats set it automatically to fit wide UI.

**Shared elements.** Give a layer `"share": "<name>"` in one scene and a layer in the next scene the same name, and they become one element: during the transition (any type except `cut`) it flies from where it was to where it lands, growing or shrinking without stretching and blending into its new look (color, size, even a different shape), while the rest of the two scenes transitions underneath. This is how a logo in a corner becomes the hero of the next scene, a headline becomes the next scene's title, or a button becomes a card, without a cut. The outgoing copy's exit and the incoming copy's entrance are skipped (the flight replaces them), so the outgoing copy must still be on screen when the transition starts and the incoming copy must be visible from the scene's start. Works on any layer type, including groups and components. A `fade` or `blur` of 0.7-1.0 s suits it.

```json
{ "id": "a", "layers": [ { "type": "text", "text": "Every device.", "share": "title", "size": 120 } ] },
{ "id": "b", "transition": { "type": "fade", "duration": 0.9 },
  "layers": [ { "type": "text", "text": "Every device.", "share": "title", "size": 64, "y": -200 } ] }
```

## 4. Camera

Each scene has its own perspective camera. By default it frames the z = 0 plane at exactly 1 px per unit.

```json
"camera": {
  "fov": 30,
  "x": 0, "y": 0, "z": 0,
  "targetX": 0, "targetY": 0, "targetZ": 0,
  "keyframes": { "z": [{ "t": 0, "v": 400 }, { "t": 2, "v": 0, "ease": "outExpo" }] },
  "moves": [
    { "preset": "pushIn", "amount": 300, "duration": 4 },
    { "preset": "punch", "at": 1.2, "amount": 5 },
    { "preset": "drift", "amount": 10 }
  ]
}
```

`x`, `y` and `z` are offsets from the default position (z > 0 pulls back). If `targetX`/`targetY` are omitted the camera looks straight ahead (pans instead of rotating). Keyframeable: `x, y, z, targetX, targetY, targetZ, fov, roll, orbit, tilt, dofZ, dofStrength`.

**Following text.** Chain `moveTo` moves with `target` to read along a conversation without placing camera keys: `{ "preset": "moveTo", "target": "question", "zoom": 2.4, "at": 0 }`, then `{ "preset": "moveTo", "target": "answer", "zoom": 2, "at": 3.1 }`, then a plain `moveTo` back out. Start each one just before its text begins to appear.

**Follow camera.** `"follow": { "target": "card", "offset": [0, 80, 900] }` chases the layer with that `id` (for example one flying on a `motionPath`). Keyframe `follow` from 0 to 1 to ease into the chase and back to 0 to release it; keyframe `followX`/`followY`/`followZ` to change the offset. Orbit and tilt moves still apply, so the camera can bank around the subject while chasing.

**Depth of field.** `"dof": { "z": 0, "strength": 0.04, "max": 24 }` blurs every layer by `|layer world z - z| * strength` px (capped at `max`). Scatter cards at different z for a dreamy cloud; keyframe `dofZ` for a rack focus (for example from the app at z 0 to cards flying up to z 400). Layers with `"dof": false` (and the cursor) stay sharp.

**Moves** stack on top of each other. Each takes `at` (default 0), `duration` (default shown) and `ease`.

| Preset | Effect | Params (default) |
|---|---|---|
| `pushIn` / `pullOut` | Dolly toward or away | `amount` 450 px, 2 s |
| `panLeft` / `panRight` | Truck sideways | `amount` 300, 1.5 s |
| `craneUp` / `craneDown` | Move vertically | `amount` 250, 1.5 s |
| `orbit` | Rotate around the target (yaw) | `angle` 30 deg, 3 s |
| `tilt` | Rotate around the target (pitch) | `angle` 15, 2 s |
| `roll` | Dutch angle | `angle` 8, 1 s |
| `zoom` | Narrow the field of view | `amount` 8 deg, 1 s |
| `dollyZoom` | Vertigo effect | `amount` 25 deg, 2 s |
| `punch` | Fast zoom hit that settles back. Put one on every beat or text slam. | `amount` 4, 0.45 s |
| `shake` | Decaying impact shake | `amount` 18 px, `frequency` 30, 0.5 s |
| `drift` | Continuous handheld float for the whole scene | `amount` 14, `speed` 0.35 |
| `whip` | Fast pan that stays (camera-side whip) | `amount` (frame width), `direction` |
| `moveTo` | Glide so point (`x`, `y`) is centered at `zoom` times magnification. Magnification changes at an even visual rate (each step of the ease multiplies it by the same factor), so even a dive to `zoom` 15 into a letter reads smoothly. Use it to dive into a UI element before a transition. With `target` (a layer `id`) instead of `x`/`y`, the camera glides onto that layer and keeps tracking it until the next move: on text it follows the word or letter being revealed (a question being typed, an answer appearing word by word), then eases to the middle of the text, or only as far as keeps a line's end in view when the line is wider than the shot. | `x`, `y`, `zoom` (1), 1.2 s; `target`, `offset` `[x, y]`, `smooth` (0.5 s), `settle` (`false` stays on the last word) |

## 5. Layers: common fields

Every layer accepts:

| Field | Meaning |
|---|---|
| `id` | Optional name (also seeds deterministic randomness) |
| `share` | Shared element name. A layer with the same `share` in the next scene is the same element: during the transition it flies from here to there (see Shared elements) |
| `x`, `y`, `z` | Position of the layer's center (or its `anchor` point), in px |
| `rotate` (= `rotateZ`), `rotateX`, `rotateY` | Degrees |
| `scale`, `scaleX`, `scaleY` | Multipliers |
| `opacity` | 0-1, multiplies down through groups |
| `origin` | Pivot for rotation and scale: `center`, `left`, `right`, `top`, `bottom`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, or `[fx, fy]` in -0.5..0.5 |
| `anchor` | Which point of the layer `x`/`y` place, with the same names as `origin` (default `center`): `"anchor": "left"` puts the left edge at `x`, `"top-left"` the corner. A bar that grows from its left edge: `"x": -800, "width": 1600, "anchor": "left", "origin": "left", "in": "growX"`. Text keeps its own `anchor` (left, center, right of the line) |
| `sound` | This layer's sound, played at its entrance (its first `in` preset, else when it appears) and replacing its automatic entrance sound: `"sound": "chime"`, or `{ "sound": "impact", "at": 0.3, "gain": 0.6 }` (`at` is an offset from the entrance). `false` silences the layer's automatic sounds (a text build's ticks, a pop). Because it belongs to the layer, it moves with it when scenes change length, so prefer it over global `sounds`. |
| `start`, `end` | Visibility window (scene-local). Default: whole scene. |
| `delay` | Layers with children (groups and components): every time inside (children's `start`, `end`, keyframes, presets, `at`) runs this many seconds later. Delays add up through nested groups. Use it to retime a whole beat at once. |
| `in` | Entrance preset(s) |
| `out` | Exit preset(s). Default timing ends at `end` (or scene end). |
| `loop` | Continuous preset(s) |
| `keyframes` | Per-property tracks, see below |
| `blend` | `normal` or `add` (additive light) |
| `blur` | Blur radius in px (keyframeable). Groups pass it to their children. Cheap: shapes and images soften natively and text uses a blurred glyph silhouette. |
| `dof` | `false` keeps this layer and its children sharp under camera depth of field |
| `motionPath` | Fly along a curve: `{ "points": [[x, y], [x, y, z], ...], "at", "duration", "ease", "smooth" (true), "orient" (rotate along the path), "trail": { "color", "width", "length" (0-1 of the path), "intensity" } }`. Overrides `x`/`y`/`z`. The trail draws a fading comet streak. |

### Keyframes

```json
"keyframes": {
  "x": [{ "t": 0, "v": -400 }, { "t": 1.2, "v": 0, "ease": "outExpo" }],
  "fill": [{ "t": 0, "v": "#7C5CFF" }, { "t": 2, "v": "#22D3EE" }]
}
```

The `ease` on a keyframe controls the motion **arriving** at it (default `inOutCubic`). Numbers, number arrays and colors interpolate. Any numeric property of a layer can be keyframed (`x`, `y`, `z`, `rotate*`, `scale*`, `opacity`, `width`, `height`, `radius`, `progress`, `intensity`, `strokeWidth`...) and colors (`fill`, `fillTo`, `stroke`, `color`).

### Entrance and exit presets (`in`, `out`)

Shorthand `"in": "popIn"` or full `"in": { "preset": "slideUp", "at": 0.4, "duration": 0.6, "ease": "outExpo", "distance": 200 }`. Arrays apply several. Exits mirror the entrance (a `slideUp` exit leaves upward, accelerating).

| Preset | Motion | Params |
|---|---|---|
| `fade` | Opacity | |
| `slideUp` `slideDown` `slideLeft` `slideRight` / `slide` (+`direction`) | Slide with fade | `distance` 120, `fade` |
| `scaleIn` | Grow from 60% | `from` |
| `popIn` | Springy pop from 0 | `from` |
| `zoomIn` | Grow from 20% | `from` |
| `zoomOut` | Shrink from 180% | `from` |
| `slam` | Crash in from 320%. Pair with a camera `punch`. | `from` |
| `focusIn` | Real focus pull: settles from 108% while the blur clears | `from`, `blur` (28) |
| `blurIn` | Blur clears and opacity rises, no scale | `blur` (24) |
| `flipX` `flipY` | 3D flip | `angle` 90 |
| `riseIn` | Rise with forward tilt in 3D | `distance`, `angle` |
| `dropIn` | Fall and bounce | `distance` |
| `spinIn` | Spin and grow | `angle`, `from` |
| `swingIn` | Door swing on Y in 3D | `angle` 70 |
| `tiltIn` | Tip up from lying back in 3D | `angle` 60, `distance` |
| `pushIn` | Come from deep behind | `distance` 900 |
| `flyIn` | Fly from in front of the camera | `distance` 1400 |
| `growX` `growY` `grow` | Scale from 0 on an axis (combine with `origin`) | |
| `whip` | Whip from off-screen | `direction`, `distance` |

Default eases: slides `outExpo`, pops `springBouncy`, flips `outBack`.

### Loop presets (`loop`)

| Preset | Motion | Params (default) |
|---|---|---|
| `float` (= `hover`) | Slow vertical drift | `amount` 12, `period` 3, `phase` |
| `bob` | Quick bob | `amount` 8, `period` 1.2 |
| `pulse` | Breathing scale | `amount` 0.04, `period` 1.6 |
| `spin` | Constant rotation | `speed` 90 deg/s, `axis` `x`/`y`/`z` |
| `wobble` | Rotation wiggle | `amount` 4, `period` 1.4 |
| `sway` | 3D rocking | `amount` 12, `period` 4 |
| `breathe` | Opacity pulse | `amount` 0.35, `period` 2.4 |
| `drift` | Organic noise wander | `amount` 30, `speed` 0.25, `rotate` |
| `shake` | Jitter | `amount` 6, `frequency` 24 |
| `blink` | On/off | `period` 1 |
| `orbit` | Circle around the position | `radius` 60, `period` 6, `squash` |
| `glitch` | Random jumps and flickers | `amount`, `rate`, `chance` |

Loops take `at` (start) and `until`.

### Easing names

`linear`, `in/out/inOut` + `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce` (for example `outExpo`, `inOutBack`), plus motion-design curves `snap`, `swift`, `smooth`, `anticipate`, `overshoot`, springs `spring`, `springSoft`, `springBouncy`, `springStiff`, `spring(stiffness,damping)`, or a cubic-bezier array `[0.2, 0, 0, 1]`.

## 6. Primitive layer types

### `text`

```json
{ "type": "text", "text": "Ship faster.\nSleep better.", "size": 120, "weight": 800,
  "highlight": [{ "text": "faster", "color": "$primary" }],
  "animate": { "preset": "rise", "by": "char", "stagger": 0.03, "at": 0.2 } }
```

Fields: `text` (`\n` for line breaks), `font` (`display` default, `body`, `mono` or a family), `weight` (default 600), `italic`, `size` (default 72), `color` (default `$text`), `align` (`left`/`center`/`right`), `anchor` (which edge `x` refers to; follows `align` by default), `maxWidth` (wraps), `lineHeight` (default 1.12), `letterSpacing` (em, default -0.02), `uppercase`, `highlight` (color substrings: `[{ "text": "150 devices", "color": "$primary" }]`, or `"gradient"` instead of `color`; `"italic": true` sets those words in italic, for one stressed word in a line; `"nth": 2` colors only that occurrence, counting from 0), `justify` (`true` spreads the letters of every line but the last to fill the block width, `maxWidth` or the widest line; `"all"` includes the last line: type specimens, character sets, poster type), `gradient` (paint the whole text with a smooth gradient: `{ "colors": ["#E8A15A", "#C2607E", "#7B3FC4"], "angle": 100 }`, 2-4 evenly spaced stops, CSS-style angle, 90 = left to right; the Apple keynote look for one big word), `glow` `{color, size, intensity}`, `stroke` `{color, width}`, `intensity` (above 1 makes it glow through bloom).

**Text on a path.** `path: { "points": [[-600, -260], [-200, -150], [200, -350], [600, -220]] }` sets the letters along a curve (layer px, smooth unless `smooth: false`), each turned with it. `align` (`start`, `center`, `end`) places the text along the curve, `offset` (px, animatable as `pathOffset`) slides it, so keyframing `pathOffset` makes the text travel the curve. Entrance animations work per letter.

**Kinetic typography.** `animate` (entrance) and `animateOut` (exit) animate each character, word or line. Fields: `preset`, `by` (`char`/`word`/`line`), `at`, `duration` (per unit), `stagger`, `ease`, `from` (`start`, `end`, `center`, `edges`, `random`), `glide` (centered text only: the first word appears in the middle and each new word pushes the line left so the words shown so far stay centered, ending with the whole sentence centered; on by default for `build`. `"follow"` instead keeps the newest word at the center and eases the finished line back to center; `settle: false` leaves it on the last word). `{ "preset": "lift", "by": "word", "glide": true }` is the Apple keynote sentence: each word lifts into focus while the line re-centers. `times` replaces the even stagger with an explicit start for each unit after `at`, in order (spaces are not units): `{ "preset": "typewriter", "at": 0.8, "times": [0, 0.1, 0.13, 0.3] }` types the way a person does, with bursts and pauses; units past the end of the list continue at `stagger`.

| Preset | Default unit | Look |
|---|---|---|
| `rise` | word | Units rise into place. The workhorse. |
| `drop` | word | Units drop into place |
| `slideLeft` / `slideRight` | word | Units slide in sideways |
| `fade` | char | Soft per-letter fade |
| `pop` | char | Springy per-letter pop |
| `cascade` | char | Letters flip up from lying back in 3D |
| `flip` | char | Letters flip on Y |
| `spin` | char | Letters spin in |
| `slam` | word | Words crash in at 260% scale |
| `zoom` | char | Letters fly in from the camera |
| `blur` | char | Letters come into focus from a real blur while settling from 115% |
| `build` | word | The sentence assembles word by word; each word blurs into focus and the line glides so the visible words stay centered. The premium explainer opener. |
| `lift` | word | Words float up a short way while fading in and coming into focus. No clipping edge. The default premium entrance. Vary it per beat so lines never arrive the same way: `direction` (`up`, `down`, `left`, `right`, or `none`), `distance`, `depth` (px to come from behind), `scale` (start size: 1.4 for a focus pull from large, 0.6 to grow in), `tilt` (degrees to tip up from, with `by: "char"`), `blur`. Use `by: "line"` for `scale` or `depth` on multi-word lines so words do not overlap, and `from: "end"` with `direction: "right"`. |
| `mask` | line | Lines rise from behind an invisible hard edge (the bottom of each glyph is cut until it clears). Use sparingly; prefer `lift`. |
| `tracking` | char | Letters collapse from wide spacing |
| `typewriter` | char | Letters appear one by one |
| `scramble` | char | Random glyphs decode into the text. `chars`: `"lower"`, `"upper"` or your own string of stand-in letters (default capitals, digits and signs) |
| `glitch` | char | Jittery glitch-in |

To swap text mid-scene, use several text layers with `start`/`end` windows.

**Morphing text.** `morph` turns a text into other texts in sequence, like Keynote's Magic Move: letters the two texts share glide to their new places (and sizes and colors), letters that are not shared lift away or settle in. "IT" to "IT demands." keeps "IT" and slides it over while "demands." arrives; "Updates" to "Up to date" keeps U, p, d, a, t, e.

```json
{ "type": "text", "text": "small", "size": 110, "animate": { "preset": "auto" },
  "morph": [
    { "text": "smaller", "at": 1.0 },
    { "text": "Big.", "at": 2.0, "duration": 0.7, "size": 260, "color": "#E8A15A" }
  ] }
```

Each step: `text`, `at` (scene-local), `duration` (0.7), `ease` (`inOutCubic`), and optional new `size`, `color` or `gradient` (each letter takes the gradient's color at its place, and the colors blend as letters travel; the layer's own `gradient` colors the first text). `animate` plays letter by letter on the first text and `animateOut` on the last. Morphing text ignores `highlight`. Use it to answer a word with its twist instead of cutting to a new line.

**Line styles.** Named ways for a whole line to come together, centered, each with timing and motion scaled to the font size (every field can still be overridden):

| Preset | Look |
|---|---|
| `push` | The line grows from the middle: each new word arrives on the right and nudges the line left, ending centered |
| `pushPop` | Like `push`, each word popping in with a soft spring |
| `plop` | Words drop from above into their final places with a small bounce |
| `scatter` | Words pop up in place in a random order |
| `fromLeft` / `fromRight` | The whole line slides in from that side and settles in the center |
| `depth` | The line comes forward from behind, out of a blur |
| `focusPull` | The line settles down from large, like a lens pulling focus |
| `ripple` | Letters rise outward from the middle of the line |
| `tipUp` | Letters tip up from lying back |
| `collapse` | Letters burst out from the center (as an exit: gather to the center and vanish) |

**Exits.** Put any of these in `animateOut` so a line leaves instead of cutting away. The motion carries on in the same direction: `riseOut` (floats up and away), `sinkOut` (drops away), `exitLeft` / `exitRight` (slides off), `recede` (moves back into the distance), `collapse`, or an entrance style (`fromLeft` as an exit leaves to the right).

**Automatic variety (recommended).** `"animate": { "preset": "auto" }` picks a line style per line so consecutive lines never arrive the same way: it rotates through the styles above in viewing order, uses single-word styles for single words, starts the rotation at a different place for each video, and fits the timing to how long the line is on screen. `"animateOut": { "preset": "auto" }` adds the exit that carries on the entrance (`fromLeft` leaves right, `depth` recedes, `plop` sinks); lines shorter than 0.6 s keep a hard cut. Fields you set next to `auto` (`at`, `stagger`, `ease`...) are kept. Use auto for runs of kinetic type unless a beat needs a specific style.

### `counter`

Animated number. Text styling fields plus `from`, `to`, `decimals`, `prefix`, `suffix`, `separator` (thousands commas, default true), `at`, `duration` (1.6), `ease` (`outExpo`).

### `shape`

```json
{ "type": "shape", "shape": "rect", "width": 420, "height": 260, "radius": 24,
  "fill": { "type": "linear", "from": "$primary", "to": "$secondary", "angle": 135 },
  "stroke": "$border", "strokeWidth": 1,
  "shadow": { "blur": 60, "y": -28, "opacity": 0.45 },
  "glow": { "color": "$primary", "size": 30, "intensity": 0.6 } }
```

`shape`: `rect` (default), `circle` (ellipse if width differs from height), `pill`, `ring` (stroke-only circle with `progress` 0-1 sweep, thickness = `strokeWidth`, color = `fill`), `sparkle` (concave four-point star, great as a glint or logo accent).

**Morphing.** Every dimension is keyframeable, so a rect becomes a pill or a circle by keyframing `width`, `height` and `radius` (a button can swell into a blob, a drop zone can collapse into a progress bar). For a different outline set `morphTo` (`rect`, `circle`, `ring`, `sparkle`) and keyframe `morph` from 0 to 1. Keyframe `fill` (and `fillTo` for gradients) to recolor during the morph. `fill` is a color or gradient (`linear` with CSS-style `angle`, or `radial` with an optional `center` [fx, fy] in -0.5..0.5 of the size). A card-shaped `radial` gradient from white to transparent centered on a corner, with `blend: "add"` and keyframed `opacity`, makes a light glare that sweeps across a surface. The stroke is drawn inside the edge. `"fill": "none"` (or `"transparent"`) draws only the stroke, an outline; its `shadow` and `glow` then follow the outline too. `shadow` is a soft drop shadow (y negative = below). `glow` is an outer glow. `intensity` above 1 feeds bloom.

**Glass.** `glass` makes the shape a pane of frosted glass: it shows everything drawn below it (lower in the layer list), blurred, tinted and bent along its edge like a lens, as in a search bar floating over a grid of photos. `{ "blur": 26, "refract": 40, "edge": 60, "tint": "#D8E0FF", "tintAmount": 0.35, "rim": 0.2 }`: `blur` in px, `refract` is how far the edge pulls the backdrop inward (px), `edge` the width of that band, `tint` and `tintAmount` the color laid over it, `rim` a light along the edge. `profile: "lens"` bends across the whole shape like a thick lens instead of only near the edge (`rim`, the default), and `dispersion` (px) splits red and blue where the light bends. `fill`'s alpha is the pane's opacity. Layers after the glass (its text and icon) draw over it sharply. Glass costs an extra blur pass per frame, so use one or two panes per scene.

### `image`

`src` (relative to the spec file, or a URL), `width`/`height` (aspect kept if only one is set), `fit` (`cover`/`contain`/`fill`), `radius`, `shadow`, `stroke`. Use for product screenshots and logos.

`halftone` draws the image as a grid of round dots whose size follows its brightness (print and risograph looks, dotted portraits): `{ "columns": 32, "color": "#2A5FE4", "levels": [0, 0.22] }`. `columns` (dots across) or `cell` (pitch in px); `levels` is the brightness range that grows a dot from nothing to full size (`[0, 0.22]` makes everything above 22% brightness a full dot); `invert` gives the dark areas the big dots; `size` is the full dot's diameter as a fraction of the pitch (0.95). `gamma` curves the brightness first (below 1 grows dots in the midtones, above 1 shrinks them), to follow a photo more faithfully. Dots whose center falls outside the rounded corners are dropped whole. `amount` (animatable as `halftone`) blends from the image (0) to dots only (1), for a dotted picture that resolves into the photo. An image whose pixels are one per dot (a small grayscale map) gives exact control of every dot.

### `video`

A video clip (screen recording, product footage, b-roll), drawn like an `image` and playing in sync with the timeline.

```json
{ "type": "video", "src": "media/demo.mp4", "width": 1280, "radius": 24, "start": 0.5, "trim": 3.2, "speed": 1, "volume": 0 }
```

| Field | Notes |
|---|---|
| `src` | `.mp4`, `.mov` (ProRes too), `.webm`, `.m4v`, `.mkv`, relative to the spec |
| `width` / `height`, `fit`, `radius`, `shadow`, `stroke` | As for `image`. With only one of `width`/`height` the clip keeps its aspect |
| `trim` | Seconds into the clip where playback starts (when the layer appears) |
| `speed` | Playback rate (`2` = twice as fast, `0.5` = slow motion) |
| `repeat` | Play again from `trim` when the clip ends; otherwise it holds its last frame |
| `volume` | Mix the clip's own sound into the render, cut to the time the layer is on screen. Default 0 (silent) |
| `focus` | Zoom into the clip like an edited product demo. `"auto"` finds where things happen in a screen recording (typing, a menu opening, a panel loading) and glides in on each, holds, and pulls back out when the activity moves or stops; scrolls, cuts and idle stretches stay zoomed out. Or a list of moves: `[{ "at": 2, "x": 0.3, "y": 0.2, "zoom": 2, "duration": 0.8, "until": 4.5 }]` (`at`/`until` scene-local, `x`/`y` 0-1 from the clip's top-left, `zoom` 2, `duration` of the glide in 0.8). Moves that follow each other closely pan straight across |

`cursor` draws a pointer over the recording (for clips recorded without one, or to make it bigger): `true` or `{ "style": "hand", "size": 34, "color": "#FFFFFF" }`. It glides to each place where something happens (found like `focus: "auto"`, or the points of a `focus` list), arriving just before and clicking as it starts, and rests while you type into the same field. It stays on the same spot of the recording while the view zooms and pans.

For a product walkthrough, a screen recording with `"focus": "auto"`, `radius` 16-24 and a soft `shadow` on a light background reads like a hand-edited demo. Renders are frame exact. The first time a clip is used it is converted once into a seek-friendly copy (cached in `.bemotion-cache/` next to the spec). To show footage on a device, put the `video` layer in the screen: as a child of `phone`, `laptop` or `browser`, sized to the screen. In the preview, dropping a video file onto the window adds it to the scene under the playhead (saved into `media/`).

### `lottie`

A Lottie animation: Bodymovin JSON exported from After Effects, or downloaded from LottieFiles (icons, illustrations, loaders, animated logos). It plays on the timeline from the layer's `start`, frame-exact in renders, drawn like an `image`.

```json
{ "type": "lottie", "src": "media/success.json", "width": 360, "start": 1.2, "repeat": false }
```

`src` (the `.json`, relative to the spec; images it uses sit next to it), `width`/`height` (aspect kept if only one is set; default the animation's own size), `speed`, `repeat` (default true; `false` holds the last frame), `trim` (seconds into the animation to start from), `radius`, `resolution` (pixels per px, raise it when the layer is shown scaled up). All common fields apply: entrances, keyframes, motion paths, `share`. Use the `.json` export (not `.lottie` or dotLottie). Expressions are not run (they are code; a file from anywhere stays safe to play), so properties driven by an expression keep their keyframed values: bake expressions to keyframes on export when an animation depends on them.

### `path`

Polyline with draw-on animation: `points` `[[x,y],...]`, `width`, `color`, `smooth` (curve through points), `closed`, `progress` (0-1, keyframe it to draw the line), `area` (gradient fill under the line, color), `areaBase` (y of the fill bottom), `glow` `{size, intensity}`, `dash` (`[drawn, gap]` in px for a dashed line; also on `icon` and `svg` strokes).

### `icon`

Stroke icon: `name`, `size` (px, default 48), `color`, `strokeWidth` (on a 24 grid, default 2), `progress` (draw-on). Or `d` with your own 24x24 SVG path data (separate subpaths with `|`).

Names: check, check-circle, x, plus, minus, arrow-right, arrow-left, arrow-up, arrow-down, arrow-up-right, chevron-right, chevron-down, zap, bolt, sparkles, star, heart, bell, lock, unlock, shield, shield-check, rocket, bar-chart, trending-up, activity, pie-chart, users, user, mail, search, settings, clock, calendar, globe, code, terminal, layers, cpu, cloud, database, credit-card, wallet, play, pause, message, send, link, target, gift, home, folder, file, image, sun, moon, wand, eye, key, inbox, workflow, bot, brain, dollar, percent, infinity, command, grid, refresh, upload, download, filter, flag, trophy, smartphone, monitor, github.

### Masks

Any `group` can take a `mask`: one layer (a shape, an `svg`, text, an image) that is not drawn itself; the group's children show only inside it. `"maskInvert": true` shows them only outside it. The mask animates like any layer (keyframe its size to iris a picture open, use text to show footage through letters, slice a word into bands for a glitch).

```json
{ "type": "group", "mask": { "type": "text", "text": "Sky", "size": 260, "weight": 800 },
  "children": [{ "type": "video", "src": "media/clouds.mp4", "width": 900, "height": 500 }] }
```

### `svg`

Filled vector shape (logos, custom marks): `d` (SVG path data), `viewBox` `[x,y,w,h]`, `width` (scales to this width), `fill` (`"none"` for outline only), `stroke`, `strokeWidth`, `progress` (draws the stroke on, keyframeable), `dash`. `morphTo` takes a second path and `morph` (keyframe 0-1) blends between them. Any two outlines morph: a square into a ring, one logo into another, an icon into a letter. Parts are paired by position and size, holes with holes, and a part with no partner grows from (or shrinks to) its own center. When both paths use the same commands (the same glyph in another weight) the blend is exact number by number, for example a letter sweeping from light to bold.

### `mesh`

Real 3D object with physically based materials and studio reflections.

```json
{ "type": "mesh", "geometry": "torusKnot", "material": "iridescent", "color": "$primary",
  "size": 260, "z": -200, "spin": [10, 40, 0] }
```

`geometry`: `box`, `roundedBox`, `slab` (thick rounded rectangle, use `radius`), `sphere`, `torus`, `torusKnot`, `icosahedron`, `octahedron`, `dodecahedron`, `cylinder`, `cone`, `capsule`, `plane`, `ring`, `blob` (organic morphing sphere; keyframe `speed` and `amount`). `size` is a number or `[w, h, d]`; `radius`, `tube`, `detail` refine it.
`material`: `glossy` (default), `glass` (refracts what is behind it), `chrome`, `metal`, `gold` (polished gold), `brushed` (anisotropic brushed metal), `ceramic` (glazed plastic or ceramic: white devices), `matte`, `clay`, `iridescent`, `neon` (self-lit, blooms; `emissiveIntensity`), `wireframe`. Also `roughness`, `metalness`, `emissive`.
`spin`: degrees per second on [x, y, z]. `shadow: true` makes the mesh receive shadows from other objects (with `lighting.shadows`).

`extrude` builds custom hard-surface objects (device bodies, stands, rails) from a 2D outline: `profile` is a list of `[x, y]` points in pixels, and a third number rounds that corner (`[x, y, radius]`). `depth` is the thickness along z (default 100), `bevel` rounds the front and back edges (default 6), and `holes` cuts openings with the same point format. Turn the result with `rotateY: -90` to use the outline as a side profile (for example a wedge-shaped card terminal), and combine several meshes and flat layers in a `group` for detail.

```json
{ "type": "mesh", "geometry": "extrude", "depth": 560, "bevel": 18, "rotateY": -90, "material": "matte", "color": "#2A2C31",
  "profile": [[546, 0, 18], [546, 146, 30], [498, 188, 85], [-473, 710, 97], [-607, 680, 73], [-643, 0, 18]] }
```

`finish` adds real surface detail as normal and roughness maps generated in code: `"brushed"`, `"satin"`, `"sandblasted"`, `"hammered"`, `"polished"`, or `{ "type": "brushed", "scratches": 0.08, "smudges": 0.3, "angle": 0, "scale": 1, "strength": 1, "seed": 1 }`. `brushed` gives hairline grain with stretched anisotropic highlights; `scratches` (0-1) adds fine tapered scratches that catch the light; `smudges` (0-1) adds fingerprint-like shine variation. Subtle values look most real: a new premium card is about `scratches` 0.05 and `smudges` 0.2. Works on `mesh` and `model` layers.

Tip: place hero meshes at negative z (-400 to -1500) behind text so they add depth without covering copy.


**3D logos.** `"geometry": "svg"` extrudes SVG path data into a solid with beveled edges: `{ "type": "mesh", "geometry": "svg", "d": "M20 0 H80 ... Z", "width": 380, "depth": 70, "bevel": 8, "material": "glossy", "color": "$primary", "sideColor": "#C9CED8", "sideMaterial": "metal" }`. Paste the logo's path data (several parts and holes are fine; `fillRule: "evenodd"` when inner shapes should cut holes regardless of direction); `viewBox` [x, y, w, h] if the path has one, `width` in px, `depth` (default 12% of the width), `bevel` (px). `sideColor` and `sideMaterial` give the edges their own look, like a colored face on a metal body. Everything else of `mesh` applies: materials, `finish`, `spin`, keyframes, lighting. Pair with a camera orbit or a `spin` for the classic logo reveal.
**3D type.** `"geometry": "text"` sets words in solid 3D from the real font: `{ "type": "mesh", "geometry": "text", "text": "Lumen", "font": "Inter", "weight": 800, "size": 260, "material": "gold", "color": "#E3B04B" }`. `size` is the font size in px (the result keeps its natural width unless `width` is set), `
` breaks lines (centered), `letterSpacing` (em, -0.02) and `lineHeight` (1.1) as for text, `depth` (25% of the size) and `bevel` (1.2% of the size, thin enough for serifs). Any bundled or registered font works (not `.woff2`). Materials, `sideColor`, `finish`, `spin` and lighting apply as for logos. Metal materials take their tint from `color`.
### `model`

A real 3D model from a glTF or GLB file (export from Blender, Spline, Sketchfab and others). The model is centered and scaled so its largest dimension equals `size` px.

```json
{ "type": "model", "src": "models/headphones.glb", "size": 520, "rotateY": -20, "material": "ceramic", "color": "#F4F4F6", "animation": "Open" }
```

| Field | Notes |
|---|---|
| `src` | `.glb` or `.gltf`, relative to the spec file |
| `size` | Largest dimension in px (default 400) |
| `material`, `color`, `roughness`, `metalness` | Optional overrides. With `material` every mesh gets that preset; with only `color`/`roughness`/`metalness` the model's own materials are tinted |
| `animation` | Clip name or index to play (default: first clip; `false` for none). Seeks in sync with the timeline. `speed` scales it |
| `spin` | Degrees per second on [x, y, z] |
| `shadow` | Cast and receive shadows (default true) |

Combine with `environment: "softbox"` and `lighting.shadows` for product shots that look photographed.

**Building custom models in the spec.** You can also assemble product models from primitives in a `group`: a `mesh` `slab` (rounded, beveled block: cards, phones, readers, pucks) with flat layers placed on its faces (`z` just above the surface for the front, a `group` with `rotateY: 180` for the back, `rotateX: -90` to lie on a top surface). See the card and card reader in `scripts/build-gilt-swipe.py`. `scripts/devices.py` builds realistic phones, tablets and laptops this way (titanium and aluminum bodies from `extrude` meshes, glass, island or notch, keyboard, lid that opens), with UI layers placed on their screens; `examples/kestrel-business.json` uses them for a table of 150 devices and a laptop and phone hero shot.

### `particles`

`count` (300), `area` [w, h, d], `size` (number or [min, max]), `color`/`colors`, `motion` (`drift`, `rise`, `fall`, `warp` (hyperspace streaks toward camera), `burst` (explodes at `at`), `orbit`, `static`, `dust` (motes wandering slowly in a light, each catching it now and then; soft bokeh discs by default)), `speed`, `shape` (`dot`, `square`, `streak`, `spark`, `bokeh`), `seed`. Additive by default. Dust over a `lightLeak` is the warm, filmic look: `{ "type": "particles", "motion": "dust", "count": 140, "size": [6, 26], "colors": ["#FFE2B0"] }`.

### `background`

Full-frame background, always behind everything and locked to the screen. Stack several with `blend: "add"` for overlays.
`style`: `solid`, `linear` (multi-stop, `angle`), `radial` (`center` [x, y], `intensity` = radius scale), `aurora` (flowing color blobs), `mesh` (animated mesh gradient), `spotlight` (top light cone), `rays` (rotating light rays from `center`), `noise`, `dots` (dot grid fading from `center`), `liquid` (a slowly flowing, marbled gradient through the colors, dark to light), `lightLeak` (warm film light drifting in from the edges: colors after the first are the leaks; use it as an overlay with `blend: "add"` over another background), `ink` (the second color spreads from `center` over the first with a ragged edge, from when the layer appears; a third color tints the edge; `intensity` scales how far it spreads, `speed` how fast). `colors` (first is the base), `speed`, `intensity`, `seed`. Time-based styles count from the layer's `start`.

### `grid`

Perspective neon grid: `plane` (`floor` default, sits at y = -420, or `wall`), `size`, `cell` (120), `color`, `lineWidth`, `fade`, `speed` (scroll toward camera).

### `group`

`children` with shared transform, timing and animation. Child coordinates are relative to the group. `start`/`end` of children are still scene-local, unless the group has a `delay`: then every time inside counts from that many seconds into the scene, so `"delay": 0.5` moves a whole beat half a second later without touching its children.

**Rastered groups.** `raster: { "width": 640, "height": 420 }` draws the group's children into an image of that area (centered on the group) every frame, and shows the image instead. Image effects then apply to the whole group: `halftone` (as on images, animatable as `halftone`; turn a whole profile card into dots and back), `radius` (rounded corners of the captured area), and `blur` blurs it as one picture. The children stay live: their animations keep playing inside the image. `resolution` (default 1) is pixels per px of the area; raise it when the group is shown scaled up. `mask` works too (the image is masked). In the editor the children stay selectable, and `check` sees them, as in any group.

### `repeat`

Duplicates its `children` into a layout. With several children, copy `i` uses child `i % n`, so you can vary content. `stagger` delays each copy's `in`/`animate`.

| `layout` | Arrangement | Params |
|---|---|---|
| `line` | Horizontal row (waveforms, logo rows) | `spacing` |
| `grid` | Rows and columns | `columns`, `spacing` [x, y] |
| `ring` | Carousel around the vertical axis, facing out | `radius` |
| `tunnel` | Lining the walls of a tunnel around the camera axis, facing inward. Fly the camera through it and add `loop: spin` | `radius`, `rows`, `spacing` [x, y, z] |
| `scatter` | Random positions and tilts in a box (card clouds; pair with camera `dof`) | `area` [w, h, d], `jitter` (deg), `seed` |

```json
{ "type": "repeat", "count": 12, "layout": "scatter", "area": [2200, 1150, 1500], "jitter": 34, "stagger": 0.04,
  "children": [ { "type": "card", "width": 300, "height": 190, "in": { "preset": "scaleIn", "from": 0.6 } } ] }
```

### `dots`

A field of dots, each moving along its own recorded path, drawn in one pass (thousands are cheap). For dot fields traced from a reference video, particle choreography exported from another tool, or data points flying into a chart.

```json
{ "type": "dots", "src": "media/dots.json", "fps": 30, "at": 1.2, "color": "$primary", "fade": 1, "grow": 2 }
```

`src` is a JSON file (or `tracks` inline): `[{ "color": "#2A5FE4", "keys": [[frame, x, y, diameter], ...] }, ...]`, design px with y up. Between keys a dot moves in a straight line; motion blur streaks fast dots. `fps` is the keys' frame rate (default the video's), `at` when frame 0 plays (default the layer's start; negative when the data starts before the scene). `color` overrides every track's color. `fade` (frames, default 1) fades a dot in before its first key and out after its last; `grow` (frames) grows new dots in from 30%. `size` multiplies every diameter. `bemotion trace dots` writes this format from a video.

### `confetti`

3D paper confetti that bursts from the layer position at `at`: `count` (140), `colors`, `power` (1100), `direction` (90 = up), `spread` (360), `gravity`, `drag`, `size` [min, max], `duration` (2.6). `"pieces": "coin"` throws metallic coins instead of paper.

### `marquee`

Infinite horizontal scroller for logo walls: `children` placed `gap` px apart (center to center), `speed` px/s, `direction`, `width` of the visible band (items fade at its edges).

## 7. Components

Components are high-level UI pieces that expand into primitives. They accept every common field (`in`, `loop`, `x`...).

| Type | Purpose | Key fields |
|---|---|---|
| `browser` | macOS-style browser window. `children` are placed in the content area (origin = content center). | `width` 1280, `height` 780, `url`, `theme` `dark`/`light`, `radius`, `fill`, `shadow` |
| `phone` | 3D smartphone with bezel and dynamic island. `children` on the screen. | `width` 390, `height` 800, `color`, `screen`, `depth` |
| `laptop` | 3D laptop; keyframe `open` (degrees) to open the lid. `children` on the screen. | `width` 1100, `open` 100, `color`, `screen` |
| `card` | Surface card with optional icon tile, title and subtitle (top-left). `children` overlay the card. | `width`, `height`, `radius`, `fill`, `stroke`, `shadow`, `glow`, `icon`, `accent`, `title`, `subtitle`, `padding` |
| `button` | Pill CTA. `press` time plays a press-and-flash. | `label`, `icon` (after label), `size` 22, `width`, `height`, `fill`, `color`, `radius`, `glow`, `press` |
| `cursor` | Pointer following a path, with click ripples. `style: "hand"` is the pointing hand used in modern product films. | `path` `[{t, x, y, ease}]`, `clicks` [times], `style` (`arrow`/`hand`), `color`, `size` |
| `chart` | Animated `bar`, `line`, `area` or `donut` chart. Line and area charts can be drawn in data units (below). | `kind`, `data`, `labels`, `width`, `height`, `color`, `colors`, `at`, `duration`, `stagger`, `gridLines`, `radius`, `range`, `axes`, `events`, `rider`, `readout`, `lineWidth`, `smooth`, `labelSize` |
| `toast` | Notification with icon, title and body. | `title`, `body`, `icon`, `accent`, `width`, `theme` |
| `timeline` | An axis that draws on, then items land on it one after another: points (`at`: dot, stem, label) and ranges (`from`/`to`: a band). Labels place themselves so none overlap each other or a stem. | `from`, `to`, `width` 1600, `ticks` (step 1), `labelStep` 5 or `labels` [values], `prefix`, `suffix`, `axisLabel`, `at`, `duration`, `stagger` 0.5, `size` 34, `color`, `muted`, `line`, `accent`, `items` [{ `at` or `from`/`to`, `label`, `detail`, `highlight`, `time`, `side` up/down, `color` }] |
| `progress` | Progress bar that fills over time. | `width`, `height`, `value`, `from`, `at`, `duration`, `color` (fill/gradient), `track` |
| `badge` | Small pill label. | `label`, `icon`, `color`, `fill`, `stroke`, `size` |
| `avatar` | Circle with initials or an image. | `initials`, `src`, `size`, `fill`, `color`, `ring` |
| `code` | Code editor window with syntax colors, typing animation and caret. | `code`, `language`, `title`, `size`, `width`, `height`, `typing`, `at`, `speed` (chars/s) |
| `flash` | Full-frame light hit. | `at`, `duration`, `color`, `intensity` |
| `glow` | Soft radial light pool (additive). Great behind hero elements. | `color`, `size`, `intensity` |

**Data charts.** A `line` or `area` chart takes `data` as `[x, y]` pairs and does the layout math: `range` (`{ "x": [58, 95], "y": [0, 2500000] }`) maps values to the box, `axes` labels ticks (`x`/`y` each take `ticks` or `step`, plus `prefix`, `suffix`, `scale`, `decimals`; y ticks draw the grid lines), `events` (`[{ "x": 67, "label": "Social Security at 67" }]`) put a ring on the line with a hairline to the axis and a label above the curve, clear of it and of each other, each arriving as the line draws past it. `rider: true` (or `{ size, color }`) is a dot riding the tip of the line, and `readout` (`prefix`, `suffix`, `scale`, `decimals`, `size`, `x`, `y`, or `follow: true` to ride above the dot) counts the value under the tip, ending exactly on the last value. Use these instead of hand-placing paths, dots and counters over a chart.

```json
{ "type": "chart", "kind": "line", "data": [[58, 1200000], [67, 2130000], [95, 320000]], "width": 1240, "height": 520, "at": 0.6, "duration": 4.5, "lineWidth": 3,
  "range": { "x": [58, 95], "y": [0, 2500000] },
  "axes": { "x": { "step": 5 }, "y": { "ticks": [1000000, 2000000], "prefix": "$", "scale": 1000000, "suffix": "M", "decimals": 1 } },
  "events": [{ "x": 67, "label": "Social Security at 67" }], "rider": true, "readout": { "prefix": "$", "x": -620, "y": 330 } }
```

Cursor coordinates are in the cursor's parent space. Put the cursor at scene level (not inside a tilted browser) and give it `z: 40` or more so it floats above UI.

## 8. Post-processing (`post`, global or per scene)

| Field | Default | Notes |
|---|---|---|
| `bloom` | `{strength 0.7, radius 0.6, threshold 0.98}` | Only HDR pixels bloom: neon meshes, `intensity` > 1, glows, additive particles. `false` disables. |
| `chromatic` | 0 | Lens chromatic aberration at the edges, in px. 0.8-2 reads as premium. |
| `grain` | 0.035 | Film grain. |
| `vignette` | 0.25 | Edge darkening. |
| `exposure`, `contrast`, `saturation` | 1 | Grade. |
| `tonemap` | `soft` | `soft` leaves everything up to pure white untouched (white sets stay white, brand colors exact) and rolls overexposed highlights off toward white like film. `none` clips. `aces`/`agx` are filmic curves for dark 3D scenes (they gray out white backgrounds and shift brand colors). |

## 9. Directing a launch-grade SaaS ad

First pick a **style** from the brief and commit to it. Mixing them looks amateur.

- **Flow** (default): bright, clean product film where every beat morphs, flies or dives into the next. Use it unless the brief asks otherwise.
- **Minimal**: black and white, Apple-keynote restraint. Use when the brief says black, dark, Apple keynote, or very minimal.
- **Hype**: loud trailer energy. Only when the brief says hype, energetic, bold or trailer.

### Universal rules

1. **Short scenes.** 2-6 s each; 5-9 scenes for a 20-30 s spot. Total under 35 s unless asked.
2. **Stagger entrances.** Elements arrive 0.05-0.2 s apart. Never bring a whole layout in at once.
3. **Vary the type.** Never give consecutive lines the same entrance. Use `"animate": { "preset": "auto" }` and `"animateOut": { "preset": "auto" }` on text unless a beat needs a specific style.
4. **Show the product.** `browser`, `phone` or `laptop` with real-looking UI inside: sidebars, lists, metrics, charts, notifications. If the user provided screenshots, use `image` inside a device; if they provided screen recordings or footage, use `video` (inside a device for product demos).
5. **Typography.** Headlines 90-170 px, weight 600-800, `letterSpacing` -0.02 to -0.04. Supporting text 28-50 px. Keep lines short (2-5 words).
6. **End on the brand.** Logo, a one-line promise, the URL. Hold it at least 2.5 s.
7. **Readability.** Never put copy over busy or bright areas. Keep 3D meshes behind text (negative z).
8. **Brand consistency.** Set `theme.colors` once and use tokens.

### Style: Flow (default)

A continuous product story on a bright canvas. Nothing cuts: elements become the next thing. See `examples/clipfold-flow.json` and the script that builds it, `scripts/build-clipfold.py`.

- **Palette.** Off-white canvas (`#F6F6FB`), ink `#14141F`, muted `#8B8BA0`, hairlines `#E3E4EE`, one accent gradient (for example indigo `#4F46E5` to sky `#38BDF8`) used on highlights, buttons, thumbnails and the logo. White cards with soft accent-tinted shadows (`shadow.color` = accent, opacity 0.1-0.15). Post: `{ "bloom": false, "grain": 0, "vignette": 0 }`.
- **Type.** One family (Inter), weight 500 (600 for the wordmark), 64-90 px headlines, `letterSpacing` -0.025. Color one or two words with the accent. Open with `build`; supporting lines use `blur` by word or `lift`.
- **Continuity, not cuts.** Each beat hands off to the next:
  - text builds, then the camera `moveTo` dives into an object;
  - a drop zone collapses into a progress bar (keyframe `width`/`height`/`radius`);
  - waveform bars (`repeat` line) collapse into skeleton lines that reveal real text;
  - a button swells into a blob and `morph`s into a `sparkle` that flies on a `motionPath` with a `trail`;
  - cards fold into the logo mark;
  - a headline, logo or card carries across a scene change with `share` (Shared elements).

  Scene transitions are only short `blur` (0.35-0.45) or `fade` hand-offs between beats that already flow, or 0.7-1.0 s fades that carry a shared element.
- **Depth.** Real UI in a light `browser` that tips up from `rotateX` 16 and `z` -300. Camera `dof` with a keyframed `dofZ` rack focus when things lift off the UI. `repeat` scatter clouds of cards with `dof`.
- **Interaction.** `cursor` with `style: "hand"` clicks real buttons (`press`). Each click causes something: clips lift off, a toast arrives, a card zooms.
- **Motion.** Fast moves (0.6-1.1 s, `inOutCubic`/`inOutQuart`) followed by calm holds. Entrances `focusIn`, `blurIn`, `scaleIn` (`from` 0.6-0.9), `growX`/`growY`. Camera: gentle `pushIn` (50-170) every scene plus `moveTo` dives. No punches, shakes, neon or grain.
- **Sound.** Leave `sfx` on: builds tick, pops pop, clicks click, flights whoosh. Without a music track from the user, add `"score": { "style": "warm" }` (or `ambient` for calm, premium products; `bright` for playful ones; `cinematic` for big reveals; `lofi` for cozy, laid-back brands; `piano` for personal, reflective stories).

### Style: Minimal (Apple-like)

Black and white with one quiet accent. Confidence comes from restraint, space and timing. See `examples/tempo-apple.json`.

- **Palette.** Pure `#000000` and `#FFFFFF` backgrounds (alternate them between scenes), ink `#1D1D1F`, gray `#86868B`, one accent color used sparingly (a single highlighted event, one icon, one link). No gradients on text or UI. Light UI uses `browser` with `theme: "light"` and soft tinted surfaces (`#F5F5F7`, pale accent tints).
- **Ambient color only as light.** One `glow` per scene at low `intensity` (0.1-0.2) behind the subject, or a `radial` background from white to a barely tinted gray. No aurora, rays, grids, particles or neon.
- **Post.** `"post": { "bloom": false, "grain": 0, "vignette": 0, "chromatic": 0 }`.
- **Type.** One family (Inter), weight 600, tight tracking (-0.03 to -0.04). Two-line statements where line two is gray: "Your week," / "finally in focus." Lots of empty space; one idea per scene.
- **Motion.** Slow and smooth: `lift` (by word or line) and `fade` for text, `focusIn`, `fade`, small `slideUp` (`distance` 14-30) and `scaleIn` (`from` 0.9) for objects. Eases `outQuart`, `smooth`, `inOutSine`. Durations 0.8-1.4 s. Product reveals by keyframing `rotateX` from 12-20 to 0 and `z` from -260 to 0 over ~2.5 s.
- **Camera.** One gentle `pushIn` (50-150, `ease` `inOutSine`) per scene. No punch, shake, drift, orbit or whip.
- **Transitions.** `fade` (0.5-0.6), `black` (0.6-0.8), `blur` (0.6), or `cut`. Never whip, glitch, zoom or flash.
- **Avoid.** Pulsing, wobbling, bouncing, slams, counters with `slam`, colorful icon tiles, multiple accents, badges everywhere.
- **Keynote type film variant.** One to three words at a time, every line centered and each arriving differently (`"animate": { "preset": "auto" }` with `"animateOut": { "preset": "auto" }`, or line styles chosen per beat), black and white scenes alternating on `cut`, one big word painted with a warm `gradient` (amber, rose, violet), typing dots, a word that `morph`s into its twist ("IT" to "IT demands." to a big gradient "demands."), and a `mask` transition that dives through a number into black. See `examples/kestrel-business.json`.

### Style: Hype (launch trailer)

Fast, loud and physical. See `examples/flowstack-launch.json`.

- **Hook in the first 2 seconds.** Slammed words with camera punches, a warp field, or a product shot flying in.
- **Every scene moves the camera.** `drift` plus a `pushIn` (150-400), `punch` on beats and slams, an `orbit` on product shots.
- **Depth.** Background (aurora, rays, mesh, radial) + mid-ground (glow, particles, grid, mesh at negative z) + foreground UI and text. Tilt UI 4-20 degrees.
- **Transitions.** Mix `whip`, `zoom`, `glitch`, `push` and `flash`, 0.3-0.5 s. `flash` or `zoom` into the CTA.
- **Stats land hard.** Big `counter`s with `slam` and a camera `punch` at each.
- **Post.** Bloom on, `chromatic` 0.8-2, light grain, `motionBlur` with 10 samples. One highlighted word per headline in the accent color.

## 10. Common mistakes

- Text off-screen: a centered 150 px headline is roughly 0.55 x size x characters wide. Keep lines under about 1600 px.
- Forgetting that `y` is up: positive `y` moves things **up**.
- Putting a `background` inside a group or device. Backgrounds always fill the whole frame.
- Children `start`/`end` and `at` times are scene-local, not relative to the parent.
- Overlapping layouts: leave at least 40 px between cards and text blocks.
- A `cursor` inside a rotated browser: positions get rotated too. Keep it at scene level.
- Using `.woff2` fonts. Use `.woff`, `.ttf` or `.otf`.

## 11. Workflow

```
bemotion validate ad.json          # schema check + timeline
bemotion check ad.json             # plays it: text collisions, text that leaves before it can be read, stretches where nothing moves
bemotion check ad.json --platform tiktok  # also: text or logos under the TikTok interface at 9:16
bemotion cutdown ad.json -l 15,6   # shorter versions: ad.cut15.json, ad.cut6.json (checked)
bemotion render ad.json --height 1440   # 2560x1440 (or 2160 for 4K); the design scales, type and lines stay sharp
bemotion compare ad.json ref.mp4   # remakes: scores each moment against a reference video, saves the worst side by side
bemotion preview ad.json           # live preview and visual editor; edits write back into the JSON
bemotion still ad.json -t 1 4.5 9  # PNG frames for review
bemotion still ad.json -t hero@1.2 features cta@2 --sheet  # scene times (as written in the spec; a name alone is its middle), plus a labelled contact sheet
bemotion render ad.json -o ad.mp4  # final MP4 (-q draft|standard|high)
bemotion render ad.json --music song.mp3 --voice vo.wav   # add a soundtrack and voiceover
bemotion render ad.json -f 9:16,1:1    # vertical and square versions (ad-9x16.mp4, ad-1x1.mp4)
bemotion voice vo.wav --script-file script.txt   # when each phrase of a voiceover is said
bemotion score ad.json             # the generated score alone, as ad-score.wav
bemotion still ad.json -f 9:16 -t 2 6  # check a format
bemotion generate "prompt" -o ad.json   # AI writes the spec, renders frames, reviews and revises
bemotion refs camera dive          # the technique library: named techniques with runnable samples
bemotion capture site.com -s .hero # a live page (or one element) as editable layers, to animate piece by piece
bemotion comments ad.json          # notes left in the preview (C at the playhead); review --comments addresses them
```

Examples: `examples/tempo-apple.json` (Minimal, 22 s) and `examples/flowstack-launch.json` (Hype, 24 s).
