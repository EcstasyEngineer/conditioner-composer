"""Version 2 audio plan grammar and sample-clock scheduling."""
from copy import deepcopy
from collections import Counter
import random
import re

from .audio_contract import (AudioInputError, fail, obj, name, line,
                             validate_binaural, limits_from, require_lead, clip_at,
                             track_audio, audio_catalog)

SR = 44100
MARKER = re.compile(r'@([A-Za-z_][A-Za-z0-9_-]{0,79})\Z')
# x = complete passes. s = seconds. m / m+s = minutes, with 0–59 seconds after m.
SUFFIX = (
    r'[1-9][0-9]*x'
    r'|[1-9][0-9]*s'
    r'|[1-9][0-9]*m(?:(?:[0-9]|[0-5][0-9])s)?'
    r'|@[A-Za-z_][A-Za-z0-9_-]*(?::[1-9][0-9]*)?'
    r'|@end'
)
ENTRY = re.compile(rf'([^\[\]]+?)(?:\[({SUFFIX})\])?\Z')
DURATION = re.compile(
    r'(?P<plain>[1-9][0-9]*)s'
    r'|(?P<minutes>[1-9][0-9]*)m(?:(?P<clock>[0-9]|[0-5][0-9])s)?'
)


def duration_seconds(suffix):
    if not suffix or suffix[0] == '@':
        return None
    match = DURATION.fullmatch(suffix)
    if not match:
        return None
    if match.group('plain') is not None:
        return int(match.group('plain'))
    return int(match.group('minutes')) * 60 + int(match.group('clock') or 0)


def repeat_count(suffix):
    if not suffix or suffix[0] == '@' or not suffix.endswith('x'):
        return None
    count = suffix[:-1]
    if not count.isdigit() or count[0] == '0':
        return None
    return int(count)


def directive(value):
    return isinstance(value, str) and value.startswith('@') and not value.startswith('@@')


def spoken(value):
    return value[1:] if isinstance(value, str) and value.startswith('@@') else value


def parse_entry(value, path):
    if not isinstance(value, str):
        fail(path, 'v2 entries must be instruction strings')
    match = ENTRY.fullmatch(value)
    if not match:
        fail(path, 'expected a block, block[5x], block[300s], block[1m30s], block[@checkpoint], or wait[5s]')
    key, suffix = match.groups()
    if key != key.strip() or key.startswith('@') or len(key) > 80:
        fail(path, 'invalid block name')
    if key == 'wait':
        if duration_seconds(suffix) is None and not (suffix and suffix.startswith('@')):
            fail(path, 'wait requires a duration or a named checkpoint')
    if suffix and suffix.startswith('@') and suffix != '@end':
        target, _, occurrence = suffix[1:].partition(':')
        if not MARKER.fullmatch('@' + target) or target == 'end':
            fail(path, 'invalid checkpoint reference')
        if occurrence and int(occurrence) < 1:
            fail(path, 'checkpoint occurrence must be positive')
    return key, suffix


def validate_sequence_plan(raw, saved_blocks=None, limits=None):
    limits = limits_from(limits)
    obj(raw, {'version', 'blocks', 'chapters', 'binaural', 'audio'}, {'version', 'chapters'}, 'session')
    if type(raw['version']) is not int or raw['version'] != 2:
        fail('version', 'expected 2')
    catalog = audio_catalog(raw)
    supplied = raw.get('blocks', {})
    obj(supplied, supplied.keys() if isinstance(supplied, dict) else (), (), 'blocks')
    resolved, warnings = {}, []
    def resolve(key, path):
        if key == 'wait' or key.startswith('@') or key != key.strip() or '[' in key or ']' in key:
            fail(path, 'invalid v2 block name')
        name(key, path)
        if key in resolved:
            return
        values = supplied[key] if key in supplied else (saved_blocks or {}).get(key)
        if not isinstance(values, list) or not values:
            fail(path, f'block {key!r} is missing or empty')
        result, speech = [], 0
        for i, value in enumerate(values):
            p = f'blocks.{key}[{i}]'
            if isinstance(value, str):
                value = value.strip()
            if isinstance(value, dict):
                obj(value, {'sfx'}, {'sfx'}, p)
                sfx = value['sfx']
                if not isinstance(sfx, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', sfx):
                    fail(p + '.sfx', 'expected an approved sfx id (letters, digits, underscore, or hyphen)')
                result.append({'sfx': sfx})
                speech += 1
            elif directive(value):
                if not MARKER.fullmatch(value) or value == '@end':
                    fail(p, 'invalid checkpoint definition')
                result.append(value)
            else:
                if not isinstance(value, str):
                    fail(p, 'expected text or checkpoint')
                decoded = line(spoken(value), p)
                result.append('@' + decoded if value.startswith('@@') else decoded)
                speech += 1
        if not speech:
            fail(path, 'each block needs at least one spoken line or sfx event')
        resolved[key] = result
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
            obj(track, {'audio', 'tts', 'blocks', 'lead', 'loop', 'finish', 'order', 'pan', 'gain_db',
                        'start_delay_ms', 'gap_ms', 'id', 'reverb', 'transform',
                        'voice', 'volume_db', 'pitch_semitones', 'speed', 'resample'}, {'blocks'}, p)
            if type(track.get('lead', False)) is not bool or type(track.get('loop', False)) is not bool:
                fail(p, 'lead and loop must be booleans')
            lead, loop = track.get('lead', False), track.get('loop', False)
            if lead and loop:
                fail(p + '.loop', 'a lead cannot loop', code='lead_loop', hint='Set "loop": false on the lead. Repeat a block with "main[5x]" instead.')
            audio = track_audio(track, p, limits, speech_required=False, catalog=catalog)
            tts = audio.get('tts')
            order = track.get('order', 'linear')
            if order not in ('linear', 'shuffle_lines'):
                fail(p + '.order', 'expected linear or shuffle_lines')
            finish = track.get('finish', 'line')
            if finish not in ('line', 'block'):
                fail(p + '.finish', 'expected line or block')
            if 'id' in track:
                label = name(track['id'], p + '.id')
                if label in ids:
                    fail(p + '.id', 'duplicate track ID')
                ids.add(label)
            refs = track['blocks']
            if not isinstance(refs, list) or not 1 <= len(refs) <= 100:
                fail(p + '.blocks', 'expected 1–100 instruction strings')
            checkpoint_refs = False
            for ri, ref in enumerate(refs):
                key, suffix = parse_entry(ref, f'{p}.blocks[{ri}]')
                if suffix and suffix.startswith('@'):
                    checkpoint_refs = True
                    if lead:
                        fail(p + '.blocks', 'checkpoint references are follower-only')
                    if suffix == '@end' and ri != len(refs) - 1:
                        fail(p + '.blocks', '@end must be the final entry')
                if key != 'wait':
                    resolve(key, f'{p}.blocks[{ri}]')
                    for text in resolved[key]:
                        if isinstance(text, dict):
                            unique.add(('sfx', text['sfx']))
                        elif not directive(text):
                            if not tts:
                                where = p + '.audio' if 'audio' in track else p + '.tts'
                                fail(where, 'a track containing spoken lines needs a voice; sfx-only tracks can omit it',
                                     hint='Set voice in this track’s audio settings, for example "voice": "kokoro/af_sarah". If audio names a preset, edit that preset under root audio.')
                            unique.add((tts['provider'], tts['voice'], spoken(text)))
            if loop and checkpoint_refs:
                fail(p + '.loop', 'a checkpoint-controlled sequence cannot loop', hint='Set "loop": false. The checkpoint entries already repeat their blocks until their targets; use a final "block[@end]" to fill the rest.')
            if lead and order != 'linear' and any(directive(v) for ref in refs if parse_entry(ref, p)[0] != 'wait' for v in resolved[parse_entry(ref, p)[0]]):
                fail(p + '.order', 'lead with checkpoints must use linear')
            out_track = {'blocks': list(refs), 'lead': lead, 'loop': loop, 'finish': finish, 'order': order, **audio}
            if 'id' in track:
                out_track['id'] = label
            normalized.append(out_track)
        leads = [require_lead(normalized, cp)]
        lead_keys = [parse_entry(ref, cp)[0] for ref in normalized[leads[0]]['blocks']]
        definitions = Counter(marker for key in set(lead_keys) if key != 'wait' for marker in resolved[key] if directive(marker))
        if any(count != 1 for count in definitions.values()):
            fail(cp, 'each lead checkpoint name must have one definition among its blocks')
        for ti, track in enumerate(normalized):
            for ri, ref in enumerate(track['blocks']):
                _, suffix = parse_entry(ref, cp)
                if suffix and suffix.startswith('@') and suffix != '@end' and suffix.split(':')[0] not in definitions:
                    fail(f'{cp}.tracks[{ti}].blocks[{ri}]', f'missing checkpoint definition {suffix}', code='checkpoint_missing', hint=f'Add "{suffix.split(":")[0]}" as a separate line in a block used by the lead, or correct the reference spelling. Available: {", ".join(sorted(definitions)) or "none"}.')
        out.append({'tracks': normalized})
    if sum(map(len, resolved.values())) > limits['lines']:
        fail('blocks', f'too many lines (maximum {limits["lines"]})')
    if len(unique) > limits['unique_clips']:
        fail('tracks', f'too many unique clips (maximum {limits["unique_clips"]})')
    binaural = deepcopy(raw.get('binaural', 'bimbo-drone'))
    validate_binaural(binaural)
    return {'version': 2, 'blocks': resolved, 'chapters': out, 'binaural': binaural}, warnings


def schedule_sequence_plan(plan, get_clip, limits, seed):
    """Resolve lead checkpoints first, then schedule followers against their timestamps."""
    gap = round(limits['gap_ms'] * SR / 1000)
    maximum = limits['duration_s'] * SR
    events, chapters, warnings, transitions = [], [], [], []
    chapter_start = 0

    for ci, chapter in enumerate(plan['chapters']):
        tracks = chapter['tracks']
        lead_index = next(i for i, t in enumerate(tracks) if t['lead'])
        checkpoints = {}

        def render_track(ti, cutoff=None):
            track = tracks[ti]
            gap = round(track.get('gap_ms', limits['gap_ms']) * SR / 1000)
            rng = random.Random(f'{seed}:{ci}:{ti}')
            cursor = round(track['start_delay_ms'] * SR / 1000)
            last_end = cursor
            needs_gap = False
            release_time = cursor
            refs = track['blocks']
            count = 0
            omitted = []
            def check_time(moment):
                if chapter_start + moment > maximum:
                    fail(f'chapters[{ci}].tracks[{ti}].blocks', f'render: duration limit exceeded ({(chapter_start + moment) / SR:.1f}s > {limits["duration_s"]}s)', code='duration_limit', hint='Reduce timed seconds or loop counts on this track, use finish: line to limit overruns, or split the chapters into separate requests.')
            def target_time(suffix, path):
                if suffix == '@end':
                    return cutoff
                marker, _, occurrence = suffix[1:].partition(':')
                index = int(occurrence or 1)
                points = checkpoints.get(marker, [])
                if index > len(points):
                    fail(path, f'checkpoint {suffix} occurrence was not reached by the lead; {len(points)} occurrence(s) available', code='checkpoint_unreached', hint='Choose an available occurrence or extend the lead so it reaches this marker. Timed lead entries can stop before later markers.')
                return points[index - 1]
            if cutoff is not None and cursor >= cutoff:
                fail(f'chapters[{ci}].tracks[{ti}].start_delay_ms',
                     f'starts at {cursor / SR:g}s, at or beyond lead end ({cutoff / SR:g}s)',
                     code='start_delay', hint='Reduce start_delay_ms so this follower starts before the lead ends, or extend the lead.')
            while True:
                for ri, ref in enumerate(refs):
                    path = f'chapters[{ci}].tracks[{ti}].blocks[{ri}]'
                    key, suffix = parse_entry(ref, path)
                    first_start = max(cursor + (gap if needs_gap and key != 'wait' else 0), release_time)
                    if cutoff is not None and first_start >= cutoff:
                        omitted.extend(refs[ri:])
                        break
                    actual_start = first_start
                    if suffix and suffix.startswith('@'):
                        boundary = target_time(suffix, path)
                        if actual_start >= boundary:
                            fail(path, f'target {suffix} at {boundary / SR:g}s is at or before actual start {actual_start / SR:g}s', code='checkpoint_late', hint='Choose a later checkpoint occurrence, shorten the previous phase/wait, or change finish from block to line. Checkpoints remain fixed to the lead.', context={'target_seconds': boundary / SR, 'start_seconds': actual_start / SR})
                    elif (span := duration_seconds(suffix)) is not None:
                        boundary = actual_start + span * SR
                    else:
                        boundary = None
                    if key == 'wait':
                        transitions.append(dict(chapter=ci, track=ti, entry=ri, instruction=ref,
                                                start=chapter_start + actual_start, target=chapter_start + boundary,
                                                finished=chapter_start + (min(boundary, cutoff) if cutoff is not None else boundary)))
                        needs_gap = False
                        cursor = min(boundary, cutoff) if cutoff is not None else boundary
                        release_time = cursor
                        last_end = max(last_end, cursor)
                        check_time(cursor)
                        continue
                    passes = repeat_count(suffix)
                    played = 0
                    stop_entry = False
                    while not stop_entry:
                        played += 1
                        lines = list(enumerate(plan['blocks'][key]))
                        if track['order'] == 'shuffle_lines':
                            rng.shuffle(lines)
                        pass_has_speech = False
                        line_finished = False
                        for li, value in lines:
                            if directive(value):
                                if track['lead']:
                                    marker_time = last_end if pass_has_speech else max(cursor + (gap if needs_gap else 0), release_time)
                                    checkpoints.setdefault(value[1:], []).append(marker_time)
                                continue
                            if line_finished:
                                stop_entry = True
                                break
                            start = max(cursor + (gap if needs_gap else 0), release_time)
                            stop = min(v for v in (boundary, cutoff) if v is not None) if (boundary is not None or cutoff is not None) else None
                            if stop is not None and start >= stop:
                                # The previous line, if any, has already ended. A block
                                # finish continues this pass, including a gap within it.
                                if track['finish'] == 'line' or not pass_has_speech:
                                    stop_entry = True
                                    break
                            check_time(start)
                            clip, length = clip_at(get_clip, track.get('tts'), spoken(value), f'blocks.{key}[{li}]', track)
                            if length <= 0:
                                raise AudioInputError('render: empty synthesized clip')
                            end = start + length
                            check_time(end)
                            events.append(dict(chapter=ci, track=ti, block=key, clip=clip,
                                               start=chapter_start + start, end=chapter_start + end,
                                               pan=track['pan'], gain_db=track['gain_db'],
                                               entry=ri, cycle=count + 1, block_pass=played))
                            if len(events) > limits['events']:
                                raise AudioInputError('render: utterance event limit exceeded')
                            pass_has_speech = True
                            last_end = cursor = end
                            needs_gap = True
                            if stop is not None and end >= stop and track['finish'] == 'line':
                                line_finished = True
                        if line_finished:
                            stop_entry = True
                        if passes is not None and played >= passes:
                            stop_entry = True
                        if boundary is None and passes is None:
                            stop_entry = True
                        # A completed block pass at/after boundary never starts another.
                        if boundary is not None and (cursor >= boundary or cursor + (gap if needs_gap else 0) >= boundary):
                            stop_entry = True
                        if cutoff is not None and (cursor >= cutoff or cursor + (gap if needs_gap else 0) >= cutoff):
                            stop_entry = True
                    target = boundary if boundary is not None else cutoff
                    if boundary is not None or (cutoff is not None and last_end >= cutoff):
                        transitions.append(dict(chapter=ci, track=ti, entry=ri, instruction=ref,
                                                start=chapter_start + actual_start, target=chapter_start + target,
                                                finished=chapter_start + last_end))
                    if boundary is not None:
                        release_time = max(release_time, boundary)
                    if cutoff is not None and max(cursor, release_time) >= cutoff:
                        omitted.extend(refs[ri + 1:])
                        break
                if not track['loop'] or (cutoff is not None and max(cursor, release_time) >= cutoff):
                    break
                # A completed cycle whose next speech cannot start before cutoff
                # must not spin forever in the final pacing gap.
                if cutoff is not None and max(cursor + (gap if needs_gap else 0), release_time) >= cutoff and parse_entry(refs[0], 'loop')[0] != 'wait':
                    break
                count += 1
                if count > limits['events']:
                    raise AudioInputError('render: loop event limit exceeded')
            if omitted:
                warnings.append(f'chapters[{ci}].tracks[{ti}]: omitted {len(omitted)} remaining entries after lead end')
            return max(cursor if not needs_gap else last_end, last_end)

        cutoff = render_track(lead_index)
        for ti in range(len(tracks)):
            if ti != lead_index:
                render_track(ti, cutoff)
        end = max([chapter_start + cutoff] + [e['end'] for e in events if e['chapter'] == ci])
        if end > maximum:
            raise AudioInputError('render: duration limit exceeded')
        chapters.append(dict(start=chapter_start, cutoff=chapter_start + cutoff,
                             end=end, tracks=len(tracks), checkpoints={k: [chapter_start + p for p in v] for k, v in checkpoints.items()}))
        chapter_start = end
    return {'events': sorted(events, key=lambda e: (e['start'], e['track'])),
            'chapters': chapters, 'samples': chapter_start, 'sample_rate': SR,
            'warnings': warnings, 'transitions': transitions}
