"""Builds the technique library in refs/: one small, runnable spec per technique, with notes on
when and how to use it. `bemotion refs` searches it and `generate --ref` hands entries to Claude.

Run: python scripts/build-refs.py   (then `bemotion refs show <key>` to preview one)
"""
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'refs')

# Flow palette (docs/SPEC.md section 9).
FLOW_THEME = {
    'colors': {'bg': '#F6F6FB', 'text': '#14141F', 'muted': '#8B8BA0', 'border': '#E3E4EE', 'surface': '#FFFFFF',
               'primary': '#4F46E5', 'secondary': '#38BDF8'},
    'fonts': {'display': 'Inter', 'body': 'Inter'},
}
FLOW_POST = {'bloom': False, 'grain': 0, 'vignette': 0}
MIN_THEME = {'colors': {'text': '#1D1D1F', 'muted': '#86868B', 'primary': '#2F6BFF'}, 'fonts': {'display': 'Inter', 'body': 'Inter'}}
MIN_POST = {'bloom': False, 'grain': 0, 'vignette': 0, 'chromatic': 0}
GRAD = {'type': 'linear', 'from': '$primary', 'to': '$secondary', 'angle': 135}


def video(title, scenes, theme=FLOW_THEME, post=FLOW_POST, **extra):
    v = {'title': title, 'theme': theme, 'post': post, 'sfx': {'kit': 'soft'}, 'scenes': scenes}
    v.update(extra)
    return v


def text(t, **kw):
    d = {'type': 'text', 'text': t, 'size': 72, 'weight': 500, 'letterSpacing': -0.025}
    d.update(kw)
    return d


def kf(*pairs, ease=None):
    out = []
    for i, (t, v) in enumerate(pairs):
        k = {'t': t, 'v': v}
        if ease and i > 0:
            k['ease'] = ease
        out.append(k)
    return out


REFS = []


def ref(key, name, style, aliases, tags, summary, how, spec):
    REFS.append({'key': key, 'name': name, 'style': style, 'aliases': aliases, 'tags': tags, 'summary': summary, 'how': how, 'spec': spec})


# 1. LangEase morph -------------------------------------------------------------------------------
ref('langease-morph', 'LangEase morph', 'flow',
    ['langease', 'continuous morph', 'button to sparkle', 'button morph', 'morph into logo', 'one take'],
    ['morph', 'cursor', 'sparkle', 'motion path', 'trail', 'confetti', 'logo'],
    'A click on a button makes it swell into a blob, turn into a sparkle that flies on a trail and lands as the logo mark beside the wordmark. One continuous take, no cuts.',
    ['A hand cursor clicks the button (cursor clicks), and the click causes everything after it.',
     'The button is a pill shape with width, height and radius keyframes: it swells into a circle.',
     'morphTo "sparkle" with morph keyframed 0 to 1 turns the circle into the sparkle.',
     'motionPath with a trail flies the sparkle to its place beside the wordmark; the wordmark arrives with focusIn as it lands.',
     'A small confetti burst on the click sells the moment. Keep the label as its own text layer and fade it before the swell.'],
    video('LangEase morph', [{
        'id': 'morph', 'duration': 6.5, 'background': '$bg',
        'camera': {'moves': [{'preset': 'pushIn', 'amount': 80, 'duration': 6.5, 'ease': 'inOutSine'}]},
        'layers': [
            text('Ready when you are.', y=170, size=68, animate={'preset': 'build'}, animateOut={'preset': 'auto'}, end=2.3),
            {'type': 'shape', 'shape': 'pill', 'id': 'cta', 'width': 280, 'height': 84, 'radius': 42, 'fill': GRAD, 'y': -30,
             'shadow': {'blur': 40, 'y': -16, 'opacity': 0.18, 'color': '$primary'},
             'morphTo': 'sparkle', 'in': {'preset': 'scaleIn', 'from': 0.8, 'at': 0.5},
             'keyframes': {
                 'scale': [{'t': 1.6, 'v': 1}, {'t': 1.72, 'v': 0.93, 'ease': 'outQuad'}, {'t': 1.95, 'v': 1, 'ease': 'outBack'}],
                 'width': kf((1.95, 280), (2.55, 130), ease='inOutCubic'),
                 'height': kf((1.95, 84), (2.55, 130), ease='inOutCubic'),
                 'radius': kf((1.95, 42), (2.55, 65), ease='inOutCubic'),
                 'morph': kf((2.6, 0), (3.05, 1), ease='inOutCubic'),
                 'rotate': kf((2.6, 0), (4.3, 180), ease='inOutCubic'),
             },
             'motionPath': {'points': [[0, -30], [230, 120], [-40, 210], [-230, 40]], 'at': 3.05, 'duration': 1.1, 'ease': 'inOutCubic',
                            'trail': {'color': '$primary', 'width': 10, 'length': 0.4, 'intensity': 1}}},
            text('Generate', y=-30, size=30, weight=600, color='#FFFFFF', start=0.5, in_={'preset': 'fade', 'at': 0.6},
                 keyframes={'opacity': kf((1.9, 1), (2.1, 0))}),
            {'type': 'confetti', 'y': -30, 'at': 1.75, 'count': 70, 'power': 700, 'colors': ['#4F46E5', '#38BDF8', '#A5B4FC']},
            text('Lumen', x=-170, y=40, size=110, weight=600, anchor='left', align='left', start=4.0, **{'in': {'preset': 'focusIn', 'duration': 0.8}}),
            {'type': 'cursor', 'style': 'hand', 'z': 40, 'start': 0.6, 'end': 2.4,
             'path': [{'t': 0.6, 'x': 620, 'y': -460}, {'t': 1.45, 'x': 40, 'y': -60, 'ease': 'inOutCubic'}],
             'clicks': [1.65], 'out': {'preset': 'fade', 'duration': 0.25}},
        ]}], score={'style': 'warm'}))

# 2. Sentence build -------------------------------------------------------------------------------
ref('sentence-build', 'Sentence build and dive', 'flow',
    ['sentence build', 'word by word', 'build opener', 'explainer opener', 'kinetic opener'],
    ['text', 'build', 'highlight', 'camera dive', 'moveTo'],
    'The opening line assembles word by word while staying centered, one word turns to the accent color, then the camera dives into the product.',
    ['animate { "preset": "build" } on a centered line: each word blurs into focus and the line glides so it stays centered.',
     'highlight one word in the accent ($primary). One or two accent words per line at most.',
     'The supporting line uses "auto" so it arrives differently.',
     'A camera moveTo dives toward the UI below before a short blur hand-off into the next scene.'],
    video('Sentence build', [
        {'id': 'line', 'duration': 4.6, 'background': '$bg',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 60, 'duration': 3.4, 'ease': 'inOutSine'},
                              {'preset': 'moveTo', 'x': 0, 'y': -330, 'zoom': 2.6, 'at': 3.5, 'duration': 1.1, 'ease': 'inOutCubic'}]},
         'layers': [
             text('Write once. Ship everywhere.', y=60, size=92, animate={'preset': 'build', 'at': 0.2},
                  highlight=[{'text': 'everywhere', 'color': '$primary'}]),
             text('Docs, changelogs and release notes from one draft.', y=-40, size=34, color='$muted',
                  animate={'preset': 'auto', 'at': 1.9}),
             {'type': 'shape', 'width': 760, 'height': 130, 'radius': 22, 'fill': '#FFFFFF', 'stroke': '$border', 'strokeWidth': 1.5, 'y': -330,
              'shadow': {'blur': 40, 'y': -14, 'opacity': 0.12, 'color': '$primary'}, 'start': 2.6, 'in': {'preset': 'slideUp', 'distance': 40, 'duration': 0.8}},
             text('Release notes, v4.2', x=-330, y=-310, size=28, weight=600, anchor='left', align='left', start=2.7, **{'in': {'preset': 'fade'}}),
             text('Drafted from 14 merged pull requests', x=-330, y=-350, size=22, color='$muted', anchor='left', align='left', start=2.8, **{'in': {'preset': 'fade'}}),
         ]},
        {'id': 'doc', 'duration': 3, 'background': '$bg', 'transition': {'type': 'blur', 'duration': 0.4},
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 50, 'duration': 3}]},
         'layers': [
             {'type': 'browser', 'theme': 'light', 'width': 1200, 'height': 700, 'url': 'notes.app/v4.2', 'in': {'preset': 'focusIn'},
              'children': [text('Release notes, v4.2', x=-520, y=270, size=44, weight=600, anchor='left', align='left'),
                           {'type': 'shape', 'x': -150, 'y': 180, 'width': 740, 'height': 14, 'radius': 7, 'fill': '#E9EAF3'},
                           {'type': 'shape', 'x': -230, 'y': 140, 'width': 580, 'height': 14, 'radius': 7, 'fill': '#E9EAF3'},
                           {'type': 'shape', 'x': -190, 'y': 100, 'width': 660, 'height': 14, 'radius': 7, 'fill': '#E9EAF3'},
                           text('Published to', x=-520, y=-80, size=26, color='$muted', anchor='left', align='left', start=0.5, **{'in': {'preset': 'fade'}}),
                           {'type': 'badge', 'label': 'Docs', 'icon': 'check', 'x': -440, 'y': -140, 'start': 0.7, 'in': {'preset': 'popIn'}},
                           {'type': 'badge', 'label': 'Changelog', 'icon': 'check', 'x': -280, 'y': -140, 'start': 0.85, 'in': {'preset': 'popIn'}},
                           {'type': 'badge', 'label': 'Email', 'icon': 'check', 'x': -120, 'y': -140, 'start': 1.0, 'in': {'preset': 'popIn'}}]},
         ]},
    ], score={'style': 'warm'}))

# 3. Camera dive ----------------------------------------------------------------------------------
ref('camera-dive', 'UI tip-up and camera dive', 'flow',
    ['camera dive', 'dive into ui', 'zoom into dashboard', 'ui tip up', 'product dive'],
    ['browser', 'rotateX', 'moveTo', 'share', 'chart', 'dof'],
    'A light browser tips up from lying back, settles, then the camera dives into one panel and the panel carries into the next scene full size.',
    ['Browser keyframes rotateX 16 to 0 and z -300 to 0 over about 1.6 s with outQuart: the UI rises to face the viewer.',
     'Stagger the cards inside (start 0.05-0.2 s apart).',
     'Camera moveTo onto the panel (x, y in scene px) with zoom 2-3 just before the scene ends.',
     'The panel has share "chart" and the next scene has the same share: it flies from its place to full size during a 0.8 s fade.'],
    video('Camera dive', [
        {'id': 'dash', 'duration': 5, 'background': '$bg',
         'camera': {'moves': [{'preset': 'moveTo', 'x': 230, 'y': -110, 'zoom': 2.2, 'at': 3.4, 'duration': 1.4, 'ease': 'inOutCubic'}]},
         'layers': [
             {'type': 'browser', 'theme': 'light', 'width': 1280, 'height': 740, 'url': 'app.northwind.io',
              'keyframes': {'rotateX': kf((0, 16), (1.6, 0), ease='outQuart'), 'z': kf((0, -300), (1.6, 0), ease='outQuart'),
                            'opacity': kf((0, 0), (0.5, 1))},
              'children': [
                  {'type': 'shape', 'x': -540, 'y': -20, 'width': 200, 'height': 680, 'fill': '#F3F4FA'},
                  {'type': 'card', 'x': -230, 'y': 220, 'width': 300, 'height': 150, 'title': 'Revenue', 'subtitle': '$48,210', 'start': 1.0, 'in': {'preset': 'scaleIn', 'from': 0.9}},
                  {'type': 'card', 'x': 100, 'y': 220, 'width': 300, 'height': 150, 'title': 'Customers', 'subtitle': '1,284', 'start': 1.1, 'in': {'preset': 'scaleIn', 'from': 0.9}},
                  {'type': 'card', 'x': 430, 'y': 220, 'width': 300, 'height': 150, 'title': 'Churn', 'subtitle': '1.8%', 'start': 1.2, 'in': {'preset': 'scaleIn', 'from': 0.9}},
                  {'type': 'chart', 'share': 'chart', 'kind': 'area', 'x': 100, 'y': -110, 'width': 960, 'height': 400, 'color': '$primary',
                   'data': [12, 18, 15, 24, 28, 26, 35, 41, 39, 52], 'at': 1.3, 'duration': 1.6},
              ]},
         ]},
        {'id': 'chart', 'duration': 3.2, 'background': '#FFFFFF', 'transition': {'type': 'fade', 'duration': 0.8},
         'layers': [
             {'type': 'chart', 'share': 'chart', 'kind': 'area', 'y': -60, 'width': 1500, 'height': 640, 'color': '$primary',
              'data': [12, 18, 15, 24, 28, 26, 35, 41, 39, 52], 'at': 0, 'duration': 0.01},
             text('Up 4x since March.', y=380, size=64, animate={'preset': 'auto', 'at': 0.9}),
         ]},
    ], score={'style': 'warm'}))

# 4. Shared element -------------------------------------------------------------------------------
LOGO = lambda r, size: {'type': 'group', 'share': 'logo', 'children': [
    {'type': 'shape', 'shape': 'circle', 'x': -size * 1.55, 'width': r, 'height': r, 'fill': GRAD},
    text('Nimbus', x=-size * 1.55 + r * 0.75, size=size, weight=600, anchor='left', align='left')]}
ref('shared-element', 'Shared element across a cut', 'any',
    ['shared element', 'magic move', 'logo becomes hero', 'headline carries over', 'share'],
    ['share', 'transition', 'logo', 'headline'],
    'A small corner logo becomes the hero of the next scene and the headline shrinks into its new place, both flying across the transition instead of cutting.',
    ['Give the two copies the same share name in consecutive scenes; any layer type works, including groups.',
     'The outgoing copy must still be on screen when the transition starts; the incoming one visible from its scene start.',
     'Use a fade or blur of 0.7-1.0 s for the transition: the rest of the scene crossfades underneath the flight.',
     'Sizes can differ freely: the flight scales without stretching and blends color.'],
    video('Shared element', [
        {'id': 'a', 'duration': 3.2, 'background': '$bg',
         'layers': [
             dict(LOGO(52, 44), x=-610, y=410, **{'in': {'preset': 'fade', 'at': 0.2}}),
             text('Notes that find you.', share='title', size=120, animate={'preset': 'auto', 'at': 0.3}),
         ]},
        {'id': 'b', 'duration': 3.4, 'background': '#FFFFFF', 'transition': {'type': 'fade', 'duration': 0.9},
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 60, 'duration': 3.4, 'ease': 'inOutSine'}]},
         'layers': [
             dict(LOGO(120, 104), x=40, y=60),
             text('Notes that find you.', share='title', y=-150, size=44, color='$muted'),
         ]},
    ], score={'style': 'warm'}))

# 5. Apple product reveal -------------------------------------------------------------------------
ref('apple-product-reveal', 'Apple product reveal', 'minimal',
    ['apple', 'product reveal', 'keynote reveal', 'laptop reveal', 'device reveal', 'apple product reveal'],
    ['laptop', 'rotateX', 'glow', 'lift', 'minimal'],
    'A laptop rises from lying back into view on black while a quiet glow lights it, then a two-line statement lifts in above, the second line in gray.',
    ['Keyframe rotateX from 12-20 to 0 and z from -260 to 0 over about 2.5 s with outQuart or smooth: slow is premium.',
     'One glow behind the subject at low intensity (0.1-0.2); no other color.',
     'Two-line statement: line one white, line two gray (#86868B), lift by word, tight tracking (-0.03).',
     'One gentle pushIn (50-150, inOutSine). No punches, no bounce.'],
    video('Apple product reveal', [
        {'id': 'reveal', 'duration': 7, 'background': '#000000',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 90, 'duration': 7, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'glow', 'y': -150, 'size': 1300, 'color': '#2F6BFF', 'intensity': 0.16, 'in': {'preset': 'fade', 'duration': 2}},
             {'type': 'laptop', 'y': -230, 'width': 900, 'open': 100, 'color': '#C9CCD3', 'screen': '#0E1A3A',
              'keyframes': {'rotateX': kf((0, 18), (2.6, 0), ease='outQuart'), 'z': kf((0, -260), (2.6, 0), ease='outQuart'), 'opacity': kf((0, 0), (0.8, 1))},
              'children': [
                  {'type': 'glow', 'color': '#2F6BFF', 'size': 700, 'intensity': 0.35},
                  text('Tempo', y=10, size=64, weight=600, color='#FFFFFF'),
              ]},
             text('Your week,', y=420, size=72, weight=600, color='#FFFFFF', letterSpacing=-0.03, animate={'preset': 'lift', 'by': 'word', 'at': 2.4}),
             text('finally in focus.', y=335, size=72, weight=600, color='#86868B', letterSpacing=-0.03, animate={'preset': 'lift', 'by': 'word', 'at': 3.0}),
         ]},
    ], theme=MIN_THEME, post=MIN_POST, score={'style': 'ambient'}))

# 6. Keynote type film ----------------------------------------------------------------------------
ref('keynote-type', 'Keynote type film', 'minimal',
    ['keynote type', 'type film', 'apple keynote', 'word morph', 'magic move text', 'kinetic type minimal'],
    ['text', 'morph', 'gradient', 'cut', 'auto'],
    'One to three words at a time on alternating black and white scenes with hard cuts; a word morphs into its twist and lands as one big gradient word.',
    ['Every line centered and arriving differently: animate "auto" with animateOut "auto".',
     'Alternate black and white backgrounds and cut between them (transition cut).',
     'morph steps answer a word with its twist: "IT" to "IT demands." to a big gradient "demands.".',
     'Paint the one big word with a warm gradient (amber, rose, violet); everything else stays black and white.'],
    video('Keynote type', [
        {'id': 'one', 'duration': 1.8, 'background': '#000000',
         'layers': [text('Small teams.', size=130, weight=600, color='#FFFFFF', letterSpacing=-0.035, animate={'preset': 'auto'}, animateOut={'preset': 'auto'})]},
        {'id': 'two', 'duration': 1.8, 'background': '#FFFFFF', 'transition': {'type': 'cut'},
         'layers': [text('Big IT.', size=130, weight=600, color='#1D1D1F', letterSpacing=-0.035, animate={'preset': 'auto'}, animateOut={'preset': 'auto'})]},
        {'id': 'three', 'duration': 3.4, 'background': '#000000', 'transition': {'type': 'cut'},
         'layers': [text('IT', size=130, weight=600, color='#FFFFFF', letterSpacing=-0.035, animate={'preset': 'auto'},
                         morph=[{'text': 'IT demands.', 'at': 0.9},
                                {'text': 'demands.', 'at': 1.9, 'duration': 0.8, 'size': 260,
                                 'gradient': {'colors': ['#E8A15A', '#C2607E', '#7B3FC4'], 'angle': 100}}])]},
    ], theme=MIN_THEME, post=MIN_POST))

# 7. Mask number dive -----------------------------------------------------------------------------
ref('mask-number-dive', 'Number mask dive', 'minimal',
    ['mask transition', 'dive through number', 'number mask', 'through the letters', '150 mask'],
    ['counter', 'mask', 'transition'],
    'A big number counts up, then the next scene appears inside its digits and the view dives through them until it fills the frame.',
    ['A counter with an id counts up and holds; its supporting line exits just before the transition.',
     'The next scene uses transition { "type": "mask", "from": "<counter id>", "duration": 1.3 }: the mask starts on the counter\'s own letters.',
     'Make the next scene clearly different (dark versus light) so the window into it reads.'],
    video('Number mask dive', [
        {'id': 'count', 'duration': 3.6, 'background': '#FFFFFF',
         'layers': [
             {'type': 'counter', 'id': 'num', 'from': 0, 'to': 150, 'at': 0.2, 'duration': 1.4, 'size': 340, 'weight': 700, 'color': '#1D1D1F', 'letterSpacing': -0.04, 'y': 40},
             text('devices. One dashboard.', y=-170, size=46, weight=600, color='#86868B', animate={'preset': 'auto', 'at': 1.0}, end=2.2, animateOut={'preset': 'auto'}),
         ]},
        {'id': 'inside', 'duration': 3.2, 'background': '#05060A', 'transition': {'type': 'mask', 'from': 'num', 'duration': 1.3},
         'layers': [
             {'type': 'background', 'style': 'radial', 'colors': ['#05060A', '#1B2A55'], 'intensity': 1.1},
             text('Every one, managed.', size=96, weight=600, color='#FFFFFF', animate={'preset': 'auto', 'at': 1.2}),
         ]},
    ], theme=MIN_THEME, post=MIN_POST))

# 8. Cursor causes --------------------------------------------------------------------------------
ref('cursor-click-cause', 'Cursor click that causes', 'flow',
    ['cursor click', 'hand cursor', 'click causes', 'button press', 'toast', 'product demo click'],
    ['cursor', 'button', 'toast', 'browser', 'press'],
    'A hand cursor glides to a button and presses it; the press visibly causes the next thing: a toast slides in and the row updates.',
    ['Cursor at scene level with z 40 or more, style "hand", a path that eases into the button and a click time.',
     'The button\'s press time equals the click time, so it squishes and flashes on the click.',
     'Everything after the click starts within 0.1-0.3 s of it: the cause must read.',
     'Fade the cursor out once its job is done.'],
    video('Cursor click', [
        {'id': 'send', 'duration': 5.5, 'background': '$bg',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 70, 'duration': 5.5, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'browser', 'theme': 'light', 'width': 1180, 'height': 680, 'url': 'ledger.app/invoices', 'in': {'preset': 'focusIn'},
              'children': [
                  text('Invoice #1042', x=-520, y=250, size=40, weight=600, anchor='left', align='left'),
                  text('Northwind Studio  ·  $4,800  ·  due Nov 30', x=-520, y=200, size=24, color='$muted', anchor='left', align='left'),
                  {'type': 'shape', 'x': -220, 'y': 60, 'width': 600, 'height': 16, 'radius': 8, 'fill': '#ECEDF5'},
                  {'type': 'shape', 'x': -280, 'y': 20, 'width': 480, 'height': 16, 'radius': 8, 'fill': '#ECEDF5'},
                  {'type': 'badge', 'label': 'Draft', 'x': 430, 'y': 250, 'keyframes': {'opacity': kf((2.25, 1), (2.4, 0))}},
                  {'type': 'badge', 'label': 'Sent', 'icon': 'check', 'color': '#15803D', 'fill': '#DCFCE7', 'x': 430, 'y': 250, 'start': 2.3, 'in': {'preset': 'popIn'}},
                  {'type': 'button', 'label': 'Send invoice', 'icon': 'send', 'x': 380, 'y': -220, 'fill': '$primary', 'color': '#FFFFFF', 'press': 2.1},
              ]},
             {'type': 'toast', 'title': 'Invoice sent', 'body': 'Northwind Studio will get it in seconds.', 'icon': 'check-circle', 'accent': '#16A34A',
              'x': 560, 'y': 400, 'width': 520, 'theme': 'light', 'start': 2.35, 'in': {'preset': 'slideLeft', 'distance': 80}},
             {'type': 'cursor', 'style': 'hand', 'z': 60, 'start': 0.8, 'end': 3.2,
              'path': [{'t': 0.8, 'x': -200, 'y': -500}, {'t': 1.9, 'x': 400, 'y': -240, 'ease': 'inOutCubic'}],
              'clicks': [2.1], 'out': {'preset': 'fade', 'duration': 0.3}},
         ]},
    ], score={'style': 'warm'}))

# 9. Scatter cloud with focus rack ----------------------------------------------------------------
CARD_TITLES = ['Slack', 'Notion', 'Gmail', 'GitHub', 'Linear', 'Figma', 'Drive']
ref('scatter-cloud-dof', 'Scatter cloud and focus rack', 'flow',
    ['scatter cloud', 'card cloud', 'depth of field', 'rack focus', 'integrations cloud', 'dreamy cards'],
    ['repeat', 'scatter', 'dof', 'dofZ', 'cards'],
    'Cards scatter through depth around a headline; the camera\'s focus racks from the cloud to the line as the camera pushes in.',
    ['repeat with layout "scatter", an area with real depth ([w, h, 1500]) and jitter 20-35 degrees.',
     'Camera dof { z, strength 0.03-0.05, max 24 }; keyframe dofZ for the rack focus.',
     'The headline sits in front (positive z) and comes into focus as dofZ reaches it.',
     'Stagger the cards (0.03-0.06 s) with scaleIn from 0.6.'],
    video('Scatter cloud', [
        {'id': 'cloud', 'duration': 6, 'background': '$bg',
         'camera': {'dof': {'z': -400, 'strength': 0.04, 'max': 24},
                    'keyframes': {'dofZ': kf((0, -400), (2.4, 200), ease='inOutCubic')},
                    'moves': [{'preset': 'pushIn', 'amount': 220, 'duration': 6, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'repeat', 'count': 16, 'layout': 'scatter', 'area': [2300, 1200, 1500], 'jitter': 28, 'stagger': 0.05, 'seed': 3, 'z': -300,
              'children': [{'type': 'card', 'width': 280, 'height': 170, 'title': t, 'subtitle': 'Connected', 'icon': 'link',
                            'in': {'preset': 'scaleIn', 'from': 0.6}} for t in CARD_TITLES]},
             {'type': 'shape', 'width': 1150, 'height': 230, 'radius': 115, 'fill': '#F6F6FB', 'blur': 40, 'z': 200, 'opacity': 0.9, 'start': 1.6, 'in': {'preset': 'fade', 'duration': 0.8}},
             text('Every tool, one answer.', z=200, size=92, animate={'preset': 'auto', 'at': 1.8}, highlight=[{'text': 'one answer', 'color': '$primary'}]),
         ]},
    ], score={'style': 'warm'}))

# 10. Hype slam -----------------------------------------------------------------------------------
HYPE_THEME = {'colors': {'bg': '#06060B', 'primary': '#7C5CFF', 'secondary': '#22D3EE', 'accent': '#F472B6'}, 'fonts': {'display': 'Sora', 'body': 'Inter'}}
ref('hype-slam', 'Hype slam and whip', 'hype',
    ['hype', 'slam', 'trailer', 'punch', 'whip', 'energetic', 'bold launch'],
    ['slam', 'punch', 'whip', 'counter', 'aurora', 'flash'],
    'Words crash in with a camera punch on each, a whip pan into a stat that slams, then a flash into the call to action.',
    ['Text animate "slam" by word, and a camera punch at each word\'s landing time.',
     'drift on every scene so the camera never stops.',
     'Transitions whip (0.35-0.45) and flash into the CTA.',
     'Counters land hard: slam entrance plus a punch. Bloom on, chromatic 1-2, motionBlur samples 10.'],
    video('Hype slam', [
        {'id': 'slam', 'duration': 2.4, 'background': '$bg',
         'camera': {'moves': [{'preset': 'drift', 'amount': 10}, {'preset': 'punch', 'at': 0.35}, {'preset': 'punch', 'at': 0.75}]},
         'layers': [{'type': 'background', 'style': 'aurora', 'colors': ['#06060B', '#2B1A6B', '#0E4A6B'], 'intensity': 0.8},
                    text('SHIP. FASTER.', size=170, weight=800, color='#ECECF4', animate={'preset': 'slam', 'by': 'word', 'at': 0.2, 'stagger': 0.4},
                         highlight=[{'text': 'FASTER.', 'color': '$primary'}])]},
        {'id': 'stat', 'duration': 2.4, 'background': '$bg', 'transition': {'type': 'whip', 'duration': 0.4, 'direction': 'left'},
         'camera': {'moves': [{'preset': 'drift', 'amount': 10}, {'preset': 'punch', 'at': 0.6, 'amount': 6}]},
         'layers': [{'type': 'glow', 'color': '$primary', 'size': 900, 'intensity': 0.5},
                    {'type': 'counter', 'from': 1, 'to': 10, 'suffix': 'x', 'at': 0.3, 'duration': 0.6, 'size': 300, 'weight': 800, 'color': '#ECECF4', 'y': 40, 'in': 'slam'},
                    text('faster deploys', y=-150, size=56, weight=700, color='$secondary', animate={'preset': 'auto', 'at': 0.8})]},
        {'id': 'cta', 'duration': 2.6, 'background': '$bg', 'transition': {'type': 'flash', 'duration': 0.35},
         'camera': {'moves': [{'preset': 'drift', 'amount': 8}, {'preset': 'pushIn', 'amount': 200, 'duration': 2.6}]},
         'layers': [text('Flowstack', size=150, weight=800, color='#ECECF4', y=60, **{'in': 'focusIn'}),
                    {'type': 'button', 'label': 'Start free', 'y': -120, 'fill': '$primary', 'color': '#FFFFFF', 'glow': {'color': '$primary', 'size': 30, 'intensity': 0.7}, 'start': 0.5, 'in': 'popIn'}]},
    ], theme=HYPE_THEME, post={'bloom': {'strength': 0.9}, 'chromatic': 1.2, 'grain': 0.03, 'vignette': 0.3}, motionBlur={'samples': 10, 'shutter': 0.6}, score={'style': 'bright'}))

# 11. Data chart story ----------------------------------------------------------------------------
ref('data-chart-story', 'Data chart story', 'any',
    ['chart story', 'line chart', 'growth chart', 'retirement chart', 'data story', 'chart events', 'projection'],
    ['chart', 'range', 'axes', 'events', 'rider', 'readout'],
    'A line draws across real axes; labeled events pop on as the line passes them, a dot rides the tip and a readout counts the value under it.',
    ['Use a chart with kind "line" and data as [x, y] pairs; range maps values to the box, axes label the ticks.',
     'events put a ring on the line with a label above the curve, clear of it and of each other.',
     'rider: true adds the dot on the tip; readout counts the value under it and ends exactly on the last value.',
     'Let the chart draw slowly (4-5 s); add a one-line takeaway after it lands.'],
    video('Data chart story', [
        {'id': 'growth', 'duration': 7.5, 'background': '#FFFFFF',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 60, 'duration': 7.5, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'chart', 'kind': 'line', 'y': -40, 'width': 1300, 'height': 560, 'at': 0.6, 'duration': 4.5, 'lineWidth': 3, 'color': '$primary',
              'data': [[1, 4200], [2, 5100], [3, 6800], [4, 7400], [5, 9900], [6, 12800], [7, 15100], [8, 19800], [9, 24600], [10, 31200], [11, 38400], [12, 48200]],
              'range': {'x': [1, 12], 'y': [0, 50000]},
              'axes': {'x': {'step': 1}, 'y': {'ticks': [10000, 20000, 30000, 40000], 'prefix': '$', 'scale': 1000, 'suffix': 'k'}},
              'events': [{'x': 5, 'label': 'Launched on Product Hunt'}, {'x': 9, 'label': 'Team plan'}],
              'rider': True, 'labelSize': 22, 'readout': {'prefix': '$', 'x': -560, 'y': 300, 'size': 44}},
             text('MRR, first year.', x=-650, y=420, size=40, weight=600, anchor='left', align='left', animate={'preset': 'auto', 'at': 0.2}),
         ]},
    ], score={'style': 'warm'}))

# 12. Typed prompt follow -------------------------------------------------------------------------
TYPE_TIMES = [0, 0.05, 0.11, 0.16, 0.2, 0.27, 0.31, 0.36, 0.5, 0.55, 0.6, 0.66, 0.7, 0.76, 0.8, 0.86, 0.93, 0.98, 1.03, 1.2, 1.25, 1.3, 1.36, 1.4, 1.46, 1.52, 1.57, 1.62, 1.7, 1.75]
ref('typed-prompt-follow', 'Typed prompt, camera follows', 'flow',
    ['typing', 'typed prompt', 'chat', 'ai assistant', 'ask', 'camera follows text', 'typewriter'],
    ['typewriter', 'times', 'moveTo', 'target', 'chat'],
    'A question is typed into an input with human rhythm while the camera follows the caret, then the answer arrives word by word and the camera reads along before pulling back.',
    ['Typewriter with explicit times (bursts and pauses) reads like a person typing.',
     'Camera moveTo with target "<text id>" follows the letter being revealed; start it just before the typing.',
     'Chain a second moveTo targeting the answer, then a plain moveTo back to zoom 1.',
     'Keep the input and answer as real UI (a pill input, a card) rather than floating text.'],
    video('Typed prompt', [
        {'id': 'ask', 'duration': 8, 'background': '$bg',
         'camera': {'moves': [{'preset': 'moveTo', 'target': 'prompt', 'zoom': 1.6, 'at': 0.4},
                              {'preset': 'moveTo', 'target': 'answer', 'zoom': 1.45, 'at': 3.6},
                              {'preset': 'moveTo', 'x': 0, 'y': 0, 'zoom': 1, 'at': 6.2, 'duration': 1.2}]},
         'layers': [
             {'type': 'shape', 'shape': 'pill', 'y': 200, 'width': 1100, 'height': 96, 'fill': '#FFFFFF', 'stroke': '$border', 'strokeWidth': 1.5,
              'shadow': {'blur': 40, 'y': -12, 'opacity': 0.1, 'color': '$primary'}, 'in': {'preset': 'scaleIn', 'from': 0.9}},
             text('Which customers churned last month?', id='prompt', x=-500, y=200, size=34, anchor='left', align='left',
                  animate={'preset': 'typewriter', 'at': 0.6, 'times': TYPE_TIMES}),
             {'type': 'shape', 'y': -60, 'width': 1100, 'height': 300, 'radius': 24, 'fill': '#FFFFFF', 'stroke': '$border', 'strokeWidth': 1.5,
              'start': 3.2, 'in': {'preset': 'slideUp', 'distance': 30}},
             text('Twelve accounts left in October. Nine of them never connected their calendar in the first week.', id='answer',
                  x=-500, y=-20, size=32, anchor='left', align='left', maxWidth=1000, lineHeight=1.4,
                  animate={'preset': 'lift', 'by': 'word', 'at': 3.5, 'stagger': 0.07}, highlight=[{'text': 'never connected their calendar', 'color': '$primary'}]),
         ]},
    ], score={'style': 'warm'}))

# 13. Logo end card -------------------------------------------------------------------------------
MARK = 'M 50 4 C 25 4 4 25 4 50 C 4 75 25 96 50 96 C 75 96 96 75 96 50 C 96 25 75 4 50 4 Z M 50 22 L 70 50 L 50 78 L 30 50 Z'
ref('logo-end-card', 'Logo end card', 'any',
    ['end card', 'logo reveal', 'outro', 'cta card', 'logo draw', 'sign off', '3d logo'],
    ['svg', 'progress', 'logo', 'cta', 'url', 'mesh svg'],
    'The logo mark draws on as an outline, fills, the wordmark focuses in beside it, then the promise and the URL lift in. Holds long enough to read.',
    ['An svg layer with fill "none", a stroke and progress keyframed 0 to 1 draws the outline; a second copy with the fill fades in over it.',
     'Wordmark focusIn as the fill lands; tagline and URL lift in after, URL highlighted in the brand color.',
     'Hold the final card at least 2.5 s. For a 3D version use a mesh with geometry "svg" and the same path, a spin or a camera orbit.'],
    video('Logo end card', [
        {'id': 'end', 'duration': 6, 'background': '$bg',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 60, 'duration': 6, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'svg', 'd': MARK, 'viewBox': [0, 0, 100, 100], 'width': 130, 'x': -250, 'y': 60, 'fill': 'none', 'stroke': '$primary', 'strokeWidth': 2.5,
              'keyframes': {'progress': kf((0.2, 0), (1.2, 1), ease='inOutCubic')}, 'out': {'preset': 'fade', 'duration': 0.4}, 'end': 1.7},
             {'type': 'svg', 'd': MARK, 'viewBox': [0, 0, 100, 100], 'width': 130, 'x': -250, 'y': 60, 'fill': '$primary', 'start': 1.1, 'in': {'preset': 'fade', 'duration': 0.5}},
             text('Prism', x=-160, y=60, size=120, weight=600, anchor='left', align='left', start=1.3, **{'in': {'preset': 'focusIn', 'duration': 0.8}}),
             text('Your data, finally clear.', y=-110, size=46, color='$muted', animate={'preset': 'auto', 'at': 2.1}),
             text('Start free at prism.app', y=-200, size=34, highlight=[{'text': 'prism.app', 'color': '$primary'}], animate={'preset': 'auto', 'at': 2.6}),
         ]},
    ], score={'style': 'warm'}))


# 14. Plan timeline -------------------------------------------------------------------------------
ref('plan-timeline', 'Plan on a timeline', 'any',
    ['timeline', 'roadmap', 'plan over time', 'milestones', 'life plan', 'age timeline', 'what we do over time'],
    ['timeline', 'items', 'moveTo', 'pins'],
    'An axis draws on and the features land on it where they happen in time, while the camera glides along; then it pulls back to show the whole plan.',
    ['The timeline component does the layout: points get a dot, a stem and a label; ranges a band. Labels pick sides and levels so nothing overlaps.',
     'Give each item a short label and a detail with one concrete number (highlight it): that is what makes it feel real.',
     'Zoom the camera to about 1.35 on the start and glide right as items land, then moveTo back to about 1 to show the whole plan.',
     'Good for features that happen at different moments: a roadmap, onboarding weeks, a retirement plan by age.'],
    video('Plan timeline', [
        {'id': 'plan', 'duration': 7, 'background': '$bg',
         'camera': {'moves': [{'preset': 'moveTo', 'x': -420, 'y': 80, 'zoom': 1.35, 'at': 0, 'duration': 0.01},
                              {'preset': 'moveTo', 'x': 330, 'y': 80, 'zoom': 1.35, 'at': 0.3, 'duration': 3.6, 'ease': 'inOutSine'},
                              {'preset': 'moveTo', 'x': 0, 'y': 60, 'zoom': 1.05, 'at': 4.0, 'duration': 1.1, 'ease': 'inOutCubic'}]},
         'layers': [
             {'type': 'timeline', 'from': 0, 'to': 12, 'labelStep': 2, 'axisLabel': 'Week', 'y': -40, 'at': 0.1,
              'items': [
                  {'from': 1, 'to': 4, 'label': 'Onboarding', 'detail': 'Weeks 1 to 4, one guided task a day'},
                  {'at': 2, 'label': 'First invoice', 'detail': 'Sent in 4 minutes', 'highlight': '4 minutes'},
                  {'at': 4, 'label': 'Bank synced', 'detail': '1,240 transactions matched', 'highlight': '1,240'},
                  {'at': 8, 'label': 'Quarterly taxes', 'detail': 'Filed on time: $2,310 saved', 'highlight': '$2,310'},
                  {'at': 10, 'label': 'Audit ready', 'detail': 'Every receipt in one place', 'side': 'down'},
                  {'at': 11.5, 'label': 'Year closed', 'detail': 'Books done in one afternoon'},
              ]},
         ]},
    ], score={'style': 'warm'}))


# 15-18. Openings ---------------------------------------------------------------------------------
# The first second and a half decide whether anyone keeps watching. Each of these puts motion and
# substance on screen in the first frame; generate hands their notes to every brief.

ref('open-product-in-action', 'Open on the product in action', 'flow',
    ['opening', 'hook', 'cold open', 'product in action', 'open mid action', 'first frame'],
    ['opening', 'hook', 'browser', 'cursor', 'pushIn', 'build'],
    'The first frame is already the product doing its job: a list filling, a cursor moving, a number changing, with the camera pushing in. The headline lands over it at about 0.8 s.',
    ['No intro: at 0.0 s the UI is on screen and something in it is already moving (rows arriving 0.08 s apart, a cursor gliding, a value ticking).',
     'The camera pushes in from the first frame (pushIn 80-140 over the scene) so even the stillest part drifts.',
     'The headline builds at 0.6-0.9 s over a calm area of the frame, or above the UI, 96 px or larger, naming the outcome, not the product.',
     'By 1.5 s the viewer knows what the product does without reading the headline.'],
    video('Product in action opening', [
        {'id': 'hook', 'duration': 4, 'background': '$bg',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 60, 'duration': 4, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'browser', 'theme': 'light', 'width': 1180, 'height': 540, 'y': -180, 'scale': 1.25, 'url': 'app.ledger.so/inbox',
              'children': [
                  *[{'type': 'card', 'x': -20, 'y': 172 - i * 114, 'width': 1060, 'height': 110, 'title': t, 'subtitle': s,
                     'start': 0.05 + i * 0.09, 'in': {'preset': 'slideUp', 'distance': 30, 'duration': 0.45}}
                    for i, (t, s) in enumerate([('Invoice #2041 matched', 'Northwind Labs, $4,800'),
                                                ('Invoice #2042 matched', 'Acme Corp, $1,250'),
                                                ('Invoice #2043 matched', 'Globex, $9,900'),
                                                ('Invoice #2044 matched', 'Initech, $3,400')])],
              ]},
             {'type': 'cursor', 'style': 'hand', 'z': 40, 'path': [{'t': 0, 'x': 640, 'y': -460}, {'t': 1.2, 'x': 420, 'y': -100, 'ease': 'inOutCubic'}],
              'out': {'preset': 'fade', 'at': 2.6, 'duration': 0.3}},
             text('Books that close themselves.', y=345, size=92, weight=600, animate={'preset': 'build', 'at': 0.7},
                  highlight=[{'text': 'close themselves', 'color': '$primary'}]),
         ]},
    ], score={'style': 'warm'}))

ref('open-problem-pileup', 'Open on the problem piling up', 'any',
    ['opening', 'hook', 'problem', 'pain point', 'pile up', 'overwhelm', 'chaos opener', 'notifications flood'],
    ['opening', 'hook', 'card', 'counter', 'scaleIn', 'stagger'],
    'The pain arrives before any words: notification cards pile in from every side, 0.05 s apart, while a counter in the corner climbs. Then one short line names it.',
    ['Start with the frame nearly full by 0.6 s: 10-16 small cards (real-looking senders and subjects) scaling in from 0.6 at scattered positions and slight angles.',
     'A counter climbs fast at the same time (to a specific, slightly absurd number: 147, not 100).',
     'At about 1.3 s the cards blur and dim (keyframe blur and opacity on their group) and one line builds over them at 100 px or more.',
     'The next scene answers it: the product clears the pile in one move.'],
    video('Problem pile-up opening', [
        {'id': 'hook', 'duration': 4, 'background': '$bg',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 90, 'duration': 4, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'group', 'keyframes': {'blur': kf((1.2, 0), (1.7, 10), ease='inOutCubic'), 'opacity': kf((1.2, 1), (1.7, 0.35), ease='inOutCubic')},
              'children': [
                  {'type': 'card', 'x': x, 'y': y, 'rotate': r, 'width': 380, 'height': 96, 'title': t, 'subtitle': 'Just now',
                   'start': 0.05 * i, 'in': {'preset': 'scaleIn', 'from': 0.6, 'duration': 0.35, 'ease': 'outBack'}}
                  for i, (x, y, r, t) in enumerate([(-560, 300, -4, 'Re: Q3 numbers?'), (420, 330, 3, 'Invoice overdue'), (-80, 120, -2, 'Can you review this'),
                                                    (600, 40, 5, 'Standup moved'), (-640, -40, 2, 'Urgent: contract'), (140, -160, -3, '3 new comments'),
                                                    (-360, -300, 4, 'Password expires'), (520, -320, -5, 'Re: Re: Re: launch'), (-120, 380, 2, 'Lunch?'),
                                                    (300, 210, -3, 'Build failed'), (-520, 140, 3, 'Calendar conflict'), (40, -380, -2, 'Weekly report')])]},
             {'type': 'counter', 'from': 0, 'to': 147, 'at': 0, 'duration': 1.2, 'x': 760, 'y': 430, 'size': 56, 'weight': 700, 'color': '#E5484D', 'suffix': ' unread'},
             text('Before 9am.', y=20, size=132, weight=700, animate={'preset': 'auto', 'at': 1.45}),
         ]},
    ], score={'style': 'bright'}))

ref('open-big-number', 'Open on a number racing', 'any',
    ['opening', 'hook', 'big number', 'stat opener', 'counter opener', 'number hook', 'claim'],
    ['opening', 'hook', 'counter', 'pushIn', 'build', 'highlight'],
    'A huge number races up from the first frame while the sentence around it builds, so the claim is read as it lands. The camera pushes the whole time.',
    ['The counter starts at 0.0 s at 220-320 px, outExpo over 1.2-1.6 s, ending on a specific value (2.4M, 38%, 11 hours).',
     'The words around it build word by word starting at about 0.5 s, smaller (80-110 px), one in the accent color.',
     'pushIn 100-160 over the scene; a soft glow or gradient behind the number gives it weight without clutter.',
     'Say where the number comes from in a small line under it (customers, a study, last quarter): an unsourced claim reads as hype.'],
    video('Big number opening', [
        {'id': 'hook', 'duration': 4, 'background': '$bg',
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 150, 'duration': 4, 'ease': 'inOutSine'}]},
         'layers': [
             {'type': 'glow', 'y': 60, 'color': '$primary', 'size': 1400, 'intensity': 0.12, 'blend': 'normal'},
             {'type': 'counter', 'from': 0, 'to': 11, 'at': 0, 'duration': 1.4, 'ease': 'outExpo', 'y': 90, 'size': 300, 'weight': 700, 'suffix': ' hours', 'letterSpacing': -0.04},
             text('back every week.', y=-120, size=96, weight=600, animate={'preset': 'build', 'at': 0.6}, highlight=[{'text': 'every week', 'color': '$primary'}]),
             text('Median across 2,300 teams, last quarter', y=-230, size=30, color='$muted', animate={'preset': 'auto', 'at': 1.6}),
         ]},
    ], score={'style': 'bright'}))

ref('open-match-cut', 'Open on a match-cut montage', 'hype',
    ['opening', 'hook', 'match cut', 'montage', 'quick cuts', 'shape match', 'graphic match'],
    ['opening', 'hook', 'cut', 'shape', 'scaleIn', 'slam'],
    'Three shots of 0.4-0.5 s, hard cuts, each built around the same shape in the same place (a circle that is a notification dot, then a record button, then the logo), then the line.',
    ['Keep the shared shape at the same position and size across the cuts: the eye stays put while everything around it changes.',
     'Each shot has its own color and one moving part; cut on motion (mid-move), never on a still frame.',
     'The montage ends on the brand or the claim at about 1.5 s, held long enough to read.',
     'Use transition cut (or flash of 0.1 s) between the shots; this is the one place where a run of hard cuts is right.'],
    video('Match cut opening', [
        {'id': 'dot', 'duration': 0.5, 'background': '#0E1020',
         'layers': [{'type': 'shape', 'shape': 'circle', 'width': 160, 'height': 160, 'fill': '#E5484D', 'in': {'preset': 'scaleIn', 'from': 0.4, 'duration': 0.3}},
                    text('3', size=90, weight=700, color='#FFFFFF')]},
        {'id': 'record', 'duration': 0.5, 'background': '#F6F6FB', 'transition': {'type': 'cut'},
         'layers': [{'type': 'shape', 'shape': 'ring', 'width': 220, 'strokeWidth': 10, 'fill': '#14141F', 'progress': 1},
                    {'type': 'shape', 'shape': 'circle', 'width': 160, 'height': 160, 'fill': '#E5484D', 'keyframes': {'scale': kf((0, 1), (0.5, 0.85))}}]},
        {'id': 'brand', 'duration': 3, 'background': '#4F46E5', 'transition': {'type': 'cut'},
         'camera': {'moves': [{'preset': 'pushIn', 'amount': 80, 'duration': 3}]},
         'layers': [{'type': 'shape', 'shape': 'circle', 'width': 160, 'height': 160, 'fill': '#FFFFFF', 'x': -330, 'keyframes': {'x': kf((0, 0), (0.45, -330), ease='outCubic')}},
                    text('Loop', x=-210, y=0, size=170, weight=700, color='#FFFFFF', anchor='left', align='left', start=0.3, **{'in': {'preset': 'slideRight', 'distance': 60, 'duration': 0.4}}),
                    text('Record once. Share everywhere.', y=-200, size=56, color='#E0E7FF', animate={'preset': 'auto', 'at': 0.9})]},
    ], score={'style': 'cinematic'}))



def fix_in(o):
    """`in` is a Python keyword: text() takes in_ and it becomes `in` here."""
    if isinstance(o, dict):
        if 'in_' in o:
            o['in'] = o.pop('in_')
        for v in o.values():
            fix_in(v)
    elif isinstance(o, list):
        for v in o:
            fix_in(v)


def main():
    os.makedirs(ROOT, exist_ok=True)
    for r in REFS:
        fix_in(r)
        with open(os.path.join(ROOT, f"{r['key']}.json"), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(r, f, indent=2, ensure_ascii=False)
            f.write('\n')
    print(f'wrote {len(REFS)} techniques to refs/')


if __name__ == '__main__':
    main()
