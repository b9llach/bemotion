---
name: make-ad
description: Turn a prompt into a finished, launch-grade SaaS ad video with Bemotion. Use whenever the user asks for an ad, promo, launch video, product teaser, explainer clip, or motion graphics for a product, or asks to edit or re-render an existing Bemotion spec.
---

# Make an ad with Bemotion

You are the director and motion designer. You write a Bemotion scene spec (JSON), check it visually, and render it to MP4. Work in the project root (the folder containing `package.json` and `bin/bemotion.mjs`).

## 1. Brief

Extract from the request: product name and what it does, audience, the one feeling the ad should leave, style, length (default 20-30 s), brand colors, CTA and URL, and any assets (screenshots, logos). If the user gave screenshots or logos, copy them into the project folder and use them as `image` layers. Screen recordings and footage become `video` layers (inside a device screen for product demos).

If the user gives the product's website, import the brand first: `node bin/bemotion.mjs brand <url> -o projects/<slug>/brand`. It writes brand.json (name, colors, fonts, headlines, calls to action) with the logo, font files and screenshots. Use its colors for the theme, register its fonts under `fonts` (paths like `brand/fonts/...`) and set `theme.fonts`, put the logo on the end card, and show the screenshots as the real product. Look at the screenshots before writing: they show the product's look.

Pick a style and commit to it (see `docs/SPEC.md` section 9):
- **Flow** (default): bright, clean product film where every beat morphs, flies or dives into the next, with sentence builds, depth of field, a hand cursor whose clicks cause things, and automatic sound design.
- **Minimal** (Apple keynote): black and white, one ambient accent, soft lifts and fades.
- **Hype**: fast cuts, slams, camera punches, whips, bloom. Only when the user asks for energy or hype.

Always invent an original concept for the user's product. Use reference videos for technique, never to recreate them shot for shot.

Only ask the user a question if the product itself is unclear. Otherwise make sensible choices and state them.

## 2. Learn the format

Read `docs/SPEC.md` fully before writing anything. Then read the example matching your style:
- Flow: `scripts/build-clipfold.py` (the generator script) and `examples/clipfold-flow.json`
- Minimal: `scripts/build-tempo.py` and `examples/tempo-apple.json`
- Hype: `examples/flowstack-launch.json`

Real UI: `node bin/bemotion.mjs capture <url> -s "<css selector>" -o projects/<slug>/ui.json` turns the product's live page (or one panel of it) into layers you can animate piece by piece. Copy its group into a scene, then stagger entrances or morph parts of it.

Techniques: `node bin/bemotion.mjs refs <words>` searches a library of named techniques (LangEase morph, camera dive, Apple product reveal, number mask dive, typed prompt follow and more), and `refs show <key>` writes a working sample with notes. When the user names a technique, or a beat needs one, read its sample before writing that scene.

## 3. Write the spec

Create `projects/<slug>/ad.json`. Plan the beats first (hook, problem or promise, product reveal, two or three features, proof, CTA), then build scene by scene. For dense product UI (tables, calendars, dashboards with many rows), write a small Python script next to the spec that generates the JSON, like `scripts/build-tempo.py`, so geometry stays exact.

## 4. Validate

```
node bin/bemotion.mjs validate projects/<slug>/ad.json
```

Fix every error. The schema is strict: unknown fields are errors.

## 5. Look at it (do not skip)

Render stills at the moment each scene has settled (after entrances, before exits) and at a couple of mid-animation moments. Give times in each scene's own time, as written in the spec (`<scene id>@<seconds>`; a scene id alone is its middle), so they hit the right moment even when music sync moves the cuts. `--sheet` also writes a labelled contact sheet of all of them:

```
node bin/bemotion.mjs still projects/<slug>/ad.json -t hook@1.5 problem@2 reveal@3 features@1 features@4 cta@2 -o projects/<slug>/frames/f_{t}.png --sheet
```

Read the sheet (`projects/<slug>/frames/sheet.png`), and open single PNGs when you need detail.

Check like a creative director:
- Text cut off, overflowing, or colliding with other elements
- Crowded edges (safe area x in [-860, 860], y in [-470, 470])
- Low contrast or copy over bright or busy areas
- 3D objects covering copy
- Frames that look static or empty, or like a slideshow
- Style violations (pulsing or neon in Minimal; static camera in Hype)

Fix and re-render until every frame holds up. Expect two or three passes.

For a second opinion, `node bin/bemotion.mjs review projects/<slug>/ad.json` renders frames (including the middle of each transition), runs `check`, and has Claude revise the spec in place.

## 6. Render

```
node bin/bemotion.mjs render projects/<slug>/ad.json -o projects/<slug>/ad.mp4 -q high
```

Use `-q draft` for quick checks of motion and timing.

Screen recordings: when the user gives one, use a `video` layer with `"focus": "auto"` so it zooms in on what happens (typing, menus, panels), with `radius` and a soft `shadow`. Check the stills; replace auto with a `focus` list if a move lands on the wrong spot.

Social versions: render vertical and square cuts from the same spec with `-f 9:16,1:1` (add `4:5` for feeds). Check a few stills of each first (`still ... -f 9:16 -t ...`). Text wraps and wide UI scenes zoom out on their own; fix anything that still looks off with `formats` overrides on the layer or scene (docs/SPEC.md, Formats).

Voiceover without a recording: write the narration as the voice track's `script` with `"tts": true` (the computer's voice for drafts; `{ "provider": "elevenlabs" }` or `{ "provider": "openai" }` when the user has a key) and `"align": true`, so the file is spoken and the video timed to it.

Voiceover: if the user has a narration recording, copy it next to the spec, run `node bin/bemotion.mjs voice <file> --script-file <script.txt>` to see when each phrase is said, and write the lines of type in narration order. Add the track with `"role": "voice"`, its `script` and `"align": true` so each line arrives as it is spoken; add `"captions": true` when the brief wants captions (social cuts usually do).

Sound: if the user has a music track, copy it next to the spec and add it to `audio` with `"sync": true` so cuts and line entrances land on its beats (write natural timing; the engine does the snapping). Otherwise, if the user has music or a voiceover, add it with `--music song.mp3` and `--voice vo.wav --voice-at <s>` (or `audio` entries with `role`). Music loops, fades out and ducks under the voice automatically, and the generated effects drop to quiet accents. Without music from the user, add a generated score: `"score": { "style": "warm" }` (relaxed and friendly; `ambient` for calm, premium products; `bright` for playful ones). It is composed to the cuts and needs no file; `node bin/bemotion.mjs score projects/<slug>/ad.json` writes it alone as a WAV in seconds. Then pick the effects `kit` that fits the style: `soft` for Flow and Minimal, `classic` for Hype, `tactile` for playful brands. Tell the user the output path and offer `node bin/bemotion.mjs preview projects/<slug>/ad.json` for scrubbing and live editing.

## Rules

- Never use emojis in copy.
- Keep headlines to 2-5 words per line.
- Never give consecutive text lines the same entrance. Default to `"animate": { "preset": "auto" }` and `"animateOut": { "preset": "auto" }`; pick a named line style only when a beat needs one.
- Times are scene-local; positive y is up; the origin is the frame center.
- Commit the spec and any generator script to git with a clear message.
