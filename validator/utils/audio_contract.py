"""Strict, dependency-free audio input contract shared by bot and worker."""
from copy import deepcopy
import json
import math
import re

ORDERS = {'linear', 'shuffle_lines', 'shuffle_blocks', 'shuffle_both', 'pooled'}
REVERBS = {'off', 'low', 'medium', 'mid', 'high', 'max'}
VOICES = {
    'kokoro': {'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_aoede'},
    'edge': {'en-US-JennyNeural', 'en-US-AvaNeural', 'en-US-EmmaNeural',
             'en-US-AriaNeural', 'en-US-MichelleNeural', 'en-GB-LibbyNeural'},
}
PRESETS = {'none', 'bimbo-drone', 'reactor', 'descent', 'dreamy', 'celestial',
           'warm', 'floating', 'sacred'}
DEFAULT_LIMITS = dict(tracks=3, chapters=12, request_bytes=131072, lines=500,
                      unique_clips=300, duration_s=1800, events=20000,
                      concurrent_jobs=1, queued_jobs=4, gap_ms=880,
                      attachment_bytes=25000000)


class AudioInputError(ValueError):
    """One diagnostic for Discord, worker receipts, and future editor fields."""
    def __init__(self, message, *, path=None, code='invalid_plan', hint=None, context=None):
        super().__init__(message)
        self.path, self.code, self.hint = path, code, hint
        self.context = context or {}

    def diagnostic(self):
        return dict(code=self.code, path=self.path, message=str(self),
                    hint=self.hint, context=self.context)

    def explain(self):
        location = self.path or ''
        match = re.match(r'chapters\[(\d+)\]\.tracks\[(\d+)\]', location)
        if match:
            location = f'Chapter {int(match[1]) + 1}, track {int(match[2]) + 1} · {location}'
        elif re.match(r'chapters\[(\d+)\]', location):
            location = f'Chapter {int(re.match(r"chapters\[(\d+)\]", location)[1]) + 1} · {location}'
        message = str(self)
        if self.path and message.startswith(self.path + ': '):
            message = message[len(self.path) + 2:]
        parts = ([f'Where: {location}'] if location else []) + [message]
        if self.hint:
            parts.append('Fix: ' + self.hint)
        return '\n'.join(parts)


def fail(path, message, *, code='invalid_plan', hint=None, context=None):
    raise AudioInputError(f'{path}: {message}', path=path, code=code,
                          hint=hint or f'Edit {path} in your JSON: {message}.', context=context)


def track_label(track, index):
    return f'track {index + 1}' + (f' ({track["id"]})' if track.get('id') else '')


def require_lead(tracks, path):
    leads = [i for i, track in enumerate(tracks) if track['lead']]
    if len(leads) != 1:
        chosen = ', '.join(track_label(tracks[i], i) for i in leads) or 'none'
        fail(path + '.tracks', f'exactly one track must have lead: true; found {len(leads)} ({chosen})',
             code='lead_count', hint='Set "lead": true on the track that determines this chapter’s length; set it to false on every other track.',
             context={'lead_tracks': leads})
    return leads[0]


def clip_at(get_clip, tts, text, path, track):
    """Preserve source diagnostics; transforms run before durations are scheduled."""
    context = {'track': track.get('id'), **(tts or {})}
    if isinstance(text, dict):
        context['sfx'] = text.get('sfx')
    try:
        clip = get_clip(tts, text)
        transform = getattr(get_clip, 'transform', None)
        return transform(*clip, track) if transform else clip
    except AudioInputError as exc:
        raise AudioInputError(str(exc), path=path, code=exc.code,
                              hint=exc.hint or 'Check this audio event or choose another supported voice.',
                              context={**exc.context, **context}) from exc
    except Exception as exc:
        raise AudioInputError('Could not render this audio event.', path=path,
                              code='tts_failed' if tts else 'asset_failed',
                              hint='Check the approved asset or voice, then share the job ID with an administrator if it repeats.',
                              context=context) from exc


def limits_from(raw=None):
    limits = dict(DEFAULT_LIMITS)
    for key, value in (raw or {}).items():
        if key not in limits:
            fail('audio_limits', f'unknown limit {key!r}')
        if type(value) is not int or value < (0 if key == 'gap_ms' else 1):
            fail(f'audio_limits.{key}', 'expected a positive integer (gap_ms may be zero)')
        limits[key] = value
    return limits


def obj(value, allowed, required, path):
    if not isinstance(value, dict):
        fail(path, 'expected an object')
    if set(value) - set(allowed):
        fail(path, f'unknown fields: {sorted(set(value) - set(allowed))}', code='unknown_fields',
             hint=f'Remove or rename those keys. Allowed here: {", ".join(sorted(allowed))}.')
    if set(required) - set(value):
        fail(path, f'missing fields: {sorted(set(required) - set(value))}')


def number(value, path, low, high, integer=False):
    if type(value) not in ((int,) if integer else (int, float)):
        fail(path, 'expected an integer' if integer else 'expected a number')
    if not low <= value <= high or not math.isfinite(value):
        fail(path, f'must be finite and between {low} and {high}')
    return value


def name(value, path):
    if not isinstance(value, str) or not value.strip() or len(value) > 80:
        fail(path, 'expected a nonblank name of at most 80 characters')
    if any(c in value for c in '\r\n'):
        fail(path, 'names must be a single line')
    return value


CANONICAL_AUDIO = {'voice', 'pan', 'volume_db', 'reverb', 'pitch_semitones', 'speed', 'resample'}
FLAT_AUDIO = {'tts', 'pan', 'gain_db', 'reverb', 'transform'}
# Canonical names that are not also deployed flat fields. They belong under `audio`.
AUTHORING_AUDIO = CANONICAL_AUDIO - {'pan', 'reverb'}


def _reverb(value, path):
    if not isinstance(value, str) or value.strip().lower() not in REVERBS:
        fail(path, 'expected off, low, medium, high, or max')
    value = value.strip().lower()
    return 'medium' if value == 'mid' else value


def _pan(value, path):
    if isinstance(value, dict):
        obj(value, {'from', 'to', 'period_s'}, {'from', 'to', 'period_s'}, path)
        return {'from': number(value['from'], path + '.from', -1, 1),
                'to': number(value['to'], path + '.to', -1, 1),
                'period_s': number(value['period_s'], path + '.period_s', 0.1, 3600)}
    return number(value, path, -1, 1)


def _voice(value, path):
    if not isinstance(value, str) or value.count('/') != 1:
        fail(path, 'expected provider/voice, for example kokoro/af_sarah or edge/en-US-JennyNeural')
    provider, voice = value.split('/', 1)
    if provider not in VOICES:
        fail(path, 'expected a kokoro/ or edge/ voice')
    if voice not in VOICES[provider]:
        fail(path, f'choose one of {sorted(VOICES[provider])}')
    return {'provider': provider, 'voice': voice}


def _tts(value, path):
    obj(value, {'provider', 'voice'}, {'provider', 'voice'}, path)
    provider, voice = value['provider'], value['voice']
    if not isinstance(provider, str) or provider not in VOICES:
        fail(path + '.provider', 'expected edge or kokoro')
    if not isinstance(voice, str) or voice not in VOICES[provider]:
        fail(path + '.voice', f'choose one of {sorted(VOICES[provider])}')
    return {'provider': provider, 'voice': voice}


def settings_internal(source, path, *, canonical):
    """Map one settings object onto worker fields. No nested settings inheritance."""
    if canonical:
        obj(source, CANONICAL_AUDIO, (), path)
        tts = _voice(source['voice'], path + '.voice') if 'voice' in source else None
        gain = number(source.get('volume_db', 0), path + '.volume_db', -30, 6)
        transform = dict(
            pitch_semitones=number(source.get('pitch_semitones', 0), path + '.pitch_semitones', -12, 12),
            tempo=number(source.get('speed', 1), path + '.speed', 0.5, 2),
            resample=number(source.get('resample', 1), path + '.resample', 0.5, 2))
    else:
        obj(source, FLAT_AUDIO, (), path)
        tts = _tts(source['tts'], path + '.tts') if 'tts' in source else None
        gain = number(source.get('gain_db', 0), path + '.gain_db', -30, 6)
        spec = source.get('transform', {})
        obj(spec, {'pitch_semitones', 'tempo', 'resample'}, (), path + '.transform')
        transform = dict(
            pitch_semitones=number(spec.get('pitch_semitones', 0), path + '.transform.pitch_semitones', -12, 12),
            tempo=number(spec.get('tempo', 1), path + '.transform.tempo', 0.5, 2),
            resample=number(spec.get('resample', 1), path + '.transform.resample', 0.5, 2))
    result = dict(reverb=_reverb(source.get('reverb', 'off'), path + '.reverb'),
                  pan=_pan(source.get('pan', 0), path + '.pan'),
                  transform=transform, gain_db=gain)
    if tts is not None:
        result['tts'] = tts
    return result


def audio_catalog(raw):
    """Named root `audio` settings, already mapped to worker fields."""
    if not isinstance(raw, dict) or 'audio' not in raw:
        return {}
    configs = raw['audio']
    obj(configs, configs.keys() if isinstance(configs, dict) else (), (), 'audio')
    catalog = {}
    for key, value in configs.items():
        name(key, 'audio')
        if not isinstance(value, dict):
            fail(f'audio.{key}', 'expected a settings object')
        catalog[key] = settings_internal(value, f'audio.{key}', canonical=True)
    return catalog


def track_audio(track, path, limits, *, speech_required=True, catalog=None):
    """Resolve canonical `audio` or deployed flat fields to one worker dict.

    Timing (`gap_ms`, `start_delay_ms`) stays on the track. A track that names
    or inlines `audio` cannot also carry flat settings.
    """
    flat_here = (FLAT_AUDIO | AUTHORING_AUDIO) & set(track)
    if 'audio' in track and flat_here:
        fail(path, f'audio cannot be combined with {sorted(flat_here)}',
             hint='Use a settings name or an inline audio object, or the saved tts, pan, gain_db, and reverb fields, not both.')
    if 'audio' in track:
        spec = track['audio']
        if isinstance(spec, str):
            if spec not in (catalog or {}):
                fail(path + '.audio', f'unknown audio settings {spec!r}',
                     hint='Define that name under root audio, or put a settings object inline.')
            internal = deepcopy(catalog[spec])
        elif isinstance(spec, dict):
            internal = settings_internal(spec, path + '.audio', canonical=True)
        else:
            fail(path + '.audio', 'expected a settings name or a settings object')
    else:
        moved = sorted(AUTHORING_AUDIO & set(track))
        if moved:
            fail(path, f'{moved} belong in audio settings',
                 hint='Put voice, pan, volume_db, reverb, pitch_semitones, speed, and resample under audio.')
        internal = settings_internal({k: track[k] for k in FLAT_AUDIO if k in track}, path, canonical=False)
    if speech_required and 'tts' not in internal:
        fail(path + '.tts', 'expected an object')
    internal['gap_ms'] = number(track.get('gap_ms', limits['gap_ms']), path + '.gap_ms', 0, 30000, integer=True)
    internal['start_delay_ms'] = number(track.get('start_delay_ms', 0), path + '.start_delay_ms',
                                         0, limits['duration_s'] * 1000, integer=True)
    return internal


def line(value, path):
    if not isinstance(value, str):
        fail(path, 'expected text')
    text = value.strip()
    if not text or len(text) > 200 or '\n' in text or '\r' in text:
        fail(path, 'expected one nonblank line, at most 200 characters; split longer text')
    # Preserve the shared cache's pause syntax, but reject pathological pauses
    # before concat_audio can allocate an enormous temporary silence file.
    pauses = re.findall(r'\[(\d+(?:\.\d+)?)(s|ms)?\]', text)
    pause_ms = sum(float(v) * (1000 if unit == 's' else 1) for v, unit in pauses)
    if pause_ms > 30000:
        fail(path, 'explicit pauses may total at most 30 seconds per line')
    return text


def parse_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail('JSON', f'duplicate key {key!r}')
            result[key] = value
        return result
    text = text.strip()
    if text.startswith('```'):
        lines = text.splitlines()
        if len(lines) < 3 or lines[-1].strip() != '```':
            fail('JSON', 'close the JSON code fence')
        text = '\n'.join(lines[1:-1])
    try:
        return json.loads(text, object_pairs_hook=pairs,
                          parse_constant=lambda v: fail('JSON', f'{v} is not finite'))
    except AudioInputError:
        raise
    except json.JSONDecodeError as exc:
        fail(f'JSON line {exc.lineno}, column {exc.colno}', exc.msg, code='json_syntax',
             hint='Check the comma, double quotes, or closing bracket at this position and just before it. JSON does not allow comments or trailing commas.',
             context={'line': exc.lineno, 'column': exc.colno, 'offset': exc.pos})
    except RecursionError:
        fail('JSON', 'nesting is too deep', hint='Remove unnecessary nested arrays or objects.')


def _param(value, path, low, high):
    if not isinstance(value, list):
        return [number(value, path, low, high)]
    if not value or len(value) > 100:
        fail(path, 'expected 1–100 keyframes')
    vals, previous = [], -1
    for i, frame in enumerate(value):
        p = f'{path}[{i}]'
        obj(frame, {'time_sec', 'value'}, {'time_sec', 'value'}, p)
        t = number(frame['time_sec'], p + '.time_sec', 0, 86400)
        if t <= previous:
            fail(p, 'keyframe times must strictly increase')
        previous = t
        vals.append(number(frame['value'], p + '.value', low, high))
    return vals


def validate_binaural(value):
    if isinstance(value, str):
        if value not in PRESETS:
            fail('binaural', f'choose one of {sorted(PRESETS)}')
        return
    allowed = {'layers', 'duration_sec', 'ear_priority', 'binaural_hz', 'keyframes',
               'fade_in_sec', 'fade_out_sec', 'target_db'}
    obj(value, allowed, {'layers'}, 'binaural')
    if value.get('ear_priority', 'R') not in ('L', 'R'):
        fail('binaural.ear_priority', 'expected L or R')
    for field, bounds in [('duration_sec', (0.001, 86400)), ('fade_in_sec', (0, 60)),
                          ('fade_out_sec', (0, 60)), ('target_db', (-60, -6))]:
        if field in value:
            number(value[field], 'binaural.' + field, *bounds)
    global_beats = [number(value.get('binaural_hz', 0), 'binaural.binaural_hz', -1000, 1000)]
    if 'keyframes' in value:
        frames = value['keyframes']
        if not isinstance(frames, list) or not frames or len(frames) > 100:
            fail('binaural.keyframes', 'expected 1–100 frames')
        converted = []
        for frame in frames:
            obj(frame, {'time_sec', 'binaural_hz'}, {'time_sec', 'binaural_hz'}, 'binaural.keyframes')
            converted.append({'time_sec': frame['time_sec'], 'value': frame['binaural_hz']})
        global_beats = _param(converted, 'binaural.keyframes', -1000, 1000)
    layers = value['layers']
    if not isinstance(layers, list) or not 1 <= len(layers) <= 8:
        fail('binaural.layers', 'expected 1–8 layers')
    bounds = {'center_hz': (1, 20000), 'binaural_hz': (-1000, 1000),
              'pulse_hz': (0, 100), 'amplitude_db': (-60, 6)}
    for i, layer in enumerate(layers):
        p = f'binaural.layers[{i}]'
        obj(layer, set(bounds) | {'name', 'keyframes'}, set(), p)
        if 'name' in layer:
            name(layer['name'], p + '.name')
        vals = {}
        for key in bounds:
            if key in layer:
                vals[key] = _param(layer[key], p + '.' + key, *bounds[key])
        if 'keyframes' in layer:
            frames = layer['keyframes']
            if not isinstance(frames, list) or not frames or len(frames) > 100:
                fail(p + '.keyframes', 'expected 1–100 frames')
            previous = -1
            for j, frame in enumerate(frames):
                obj(frame, set(bounds) | {'time_sec'}, {'time_sec'}, p + '.keyframes')
                t = number(frame['time_sec'], p + '.time_sec', 0, 86400)
                if t <= previous:
                    fail(p + '.keyframes', 'times must strictly increase')
                previous = t
                for key in bounds:
                    if key in frame:
                        vals.setdefault(key, []).append(number(frame[key], p + '.' + key, *bounds[key]))
        if not {'center_hz', 'amplitude_db'} <= vals.keys():
            fail(p, 'center_hz and amplitude_db are required, directly or in keyframes')
        beats = vals.get('binaural_hz', global_beats)
        diff = max(abs(x) for x in beats) / 2
        if min(vals['center_hz']) <= diff or max(vals['center_hz']) + diff >= 22050:
            fail(p, 'both carrier frequencies must be positive and below 22050 Hz')


def validate_plan(raw, saved_blocks=None, limits=None):
    """Resolve authoring or saved flat fields to one worker snapshot.

    The snapshot has no root `audio` catalog. Track settings are `tts`, `pan`,
    `gain_db`, `reverb`, and `transform`, so validating it again is stable.
    """
    if isinstance(raw, dict) and raw.get('version') == 2 and 'tracks' in raw:
        if 'chapters' in raw:
            fail('tracks', 'use tracks for one chapter or chapters for several, not both')
        raw = deepcopy(raw)
        raw['chapters'] = [{'tracks': raw.pop('tracks')}]
    if isinstance(raw, dict) and 'version' in raw:
        from .audio_sequence import validate_sequence_plan
        return validate_sequence_plan(raw, saved_blocks, limits)
    limits = limits_from(limits)
    obj(raw, {'blocks', 'chapters', 'binaural'}, {'chapters'}, 'session')
    supplied = raw.get('blocks', {})
    obj(supplied, supplied.keys() if isinstance(supplied, dict) else (), (), 'blocks')
    resolved, warnings = {}, []

    def resolve(key, path):
        name(key, path)
        if key in resolved:
            return
        lines = supplied[key] if key in supplied else (saved_blocks or {}).get(key)
        if not isinstance(lines, list) or not lines:
            fail(path, f'block {key!r} is missing or empty (request and your saved library)')
        resolved[key] = [line(v, f'blocks.{key}[{i}]') for i, v in enumerate(lines)]

    for key in supplied:
        resolve(key, 'blocks')
    chapters = raw['chapters']
    if not isinstance(chapters, list) or not 1 <= len(chapters) <= limits['chapters']:
        fail('chapters', f'expected 1–{limits["chapters"]} chapters')
    out, unique = [], set()
    for ci, chapter in enumerate(chapters):
        cp = f'chapters[{ci}]'
        obj(chapter, {'tracks'}, {'tracks'}, cp)
        tracks = chapter['tracks']
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= limits['tracks']:
            fail(cp + '.tracks', f'expected 1–{limits["tracks"]} tracks')
        normalized, ids = [], set()
        for ti, track in enumerate(tracks):
            p = f'{cp}.tracks[{ti}]'
            obj(track, {'tts', 'blocks', 'lead', 'loop', 'order', 'pan', 'gain_db',
                        'start_delay_ms', 'gap_ms', 'id', 'reverb', 'transform'},
                {'tts', 'blocks', 'lead', 'loop'}, p)
            for key in ('lead', 'loop'):
                if type(track[key]) is not bool:
                    fail(p + '.' + key, 'expected true or false')
            if track['lead'] and track['loop']:
                fail(p + '.loop', 'a lead cannot loop', code='lead_loop',
                     hint='Set "loop": false on the lead. To repeat its content, use "main[5x]" with "version": 2, or repeat the block name in a legacy plan.')
            audio = track_audio(track, p, limits)
            provider, voice = audio['tts']['provider'], audio['tts']['voice']
            order = track.get('order', 'linear')
            if not isinstance(order, str) or order not in ORDERS:
                fail(p + '.order', f'choose one of {sorted(ORDERS)}')
            if 'id' in track:
                label = name(track['id'], p + '.id')
                if label in ids:
                    fail(p + '.id', 'duplicate track ID')
                ids.add(label)
            refs = track['blocks']
            if isinstance(refs, str):
                refs = [refs]
            if not isinstance(refs, list) or not refs or len(refs) > 100:
                fail(p + '.blocks', 'expected a name or names (1–100 entries)')
            for ri, ref in enumerate(refs):
                rp = f'{p}.blocks[{ri}]'
                if not isinstance(ref, str):
                    fail(rp, 'timed [name, seconds] pairs are gone. Use version 2, for example "main[90s]", "main[1m30s]", or "main[5x]".')
                resolve(ref, rp)
                unique.update((provider, voice, text) for text in resolved[ref])
            normalized.append({**deepcopy(track), **audio, 'blocks': deepcopy(refs), 'order': order})
        require_lead(normalized, cp)
        out.append({'tracks': normalized})
    if sum(map(len, resolved.values())) > limits['lines']:
        fail('blocks', f'too many lines (maximum {limits["lines"]})')
    if len(unique) > limits['unique_clips']:
        fail('tracks', f'too many unique text/voice combinations (maximum {limits["unique_clips"]})')
    binaural = deepcopy(raw.get('binaural', 'bimbo-drone'))
    validate_binaural(binaural)
    return {'blocks': resolved, 'chapters': out, 'binaural': binaural}, warnings
