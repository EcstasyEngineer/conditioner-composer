/* Static authoring UI. Validation uses the shared Python contract via Pyodide. */
const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const VOICES = {
  kokoro: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_aoede'],
  edge: ['en-US-JennyNeural', 'en-US-AvaNeural', 'en-US-EmmaNeural', 'en-US-AriaNeural', 'en-US-MichelleNeural', 'en-GB-LibbyNeural'],
};
const REVERBS = ['off', 'low', 'medium', 'high', 'max'];
const BACKGROUNDS = ['none', 'bimbo-drone', 'reactor', 'descent', 'dreamy', 'celestial', 'warm', 'floating', 'sacred'];
const LEGACY_KEYS = ['tts', 'pan', 'gain_db', 'reverb', 'transform'];
const $ = (id) => document.getElementById(id);

let plan = null;
let library = null;
let jsonDirty = false;
let inputEpoch = 0;
let validateRun = 0;
let validatorPromise = null;

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function setStatus(text, kind = '') {
  const node = $('status');
  node.textContent = text || '';
  node.className = kind;
}

function setValidator(text, kind = '') {
  const node = $('validator-state');
  node.textContent = text;
  node.className = kind;
}

function syncJson({ keepStatus = false } = {}) {
  const box = $('plan-json');
  const next = JSON.stringify(plan, null, 2);
  if (document.activeElement !== box) box.value = next;
  inputEpoch += 1;
  jsonDirty = false;
  setFormEditing(true);
  if (!keepStatus) setStatus('');
}

function setFormEditing(enabled) {
  for (const id of ['presets', 'blocks', 'arrangement', 'background']) $(id).inert = !enabled;
}

function mode() {
  const hasTracks = Object.prototype.hasOwnProperty.call(plan, 'tracks');
  const hasChapters = Object.prototype.hasOwnProperty.call(plan, 'chapters');
  if (hasTracks && hasChapters) return 'both';
  if (hasTracks) return 'tracks';
  if (hasChapters) return 'chapters';
  return 'empty';
}

function chapterEntries() {
  if (mode() === 'tracks') return [{ chapter: { tracks: plan.tracks }, index: 0, shorthand: true }];
  if (Array.isArray(plan.chapters)) return plan.chapters.map((chapter, index) => ({ chapter, index, shorthand: false }));
  return [];
}

function parseInstruction(text) {
  if (typeof text !== 'string') return { kind: 'raw' };
  const match = /^(wait|[^[\]]+?)(?:\[([^\]]+)\])?$/.exec(text);
  if (!match) return { kind: 'raw' };
  const block = match[1];
  const suffix = match[2];
  if (block !== 'wait' && (block !== block.trim() || block.startsWith('@'))) return { kind: 'raw' };
  if (!suffix) return block === 'wait' ? { kind: 'raw' } : { kind: 'once', block };
  if (block !== 'wait' && /^[1-9]\d*x$/.test(suffix)) return { kind: 'count', block };
  if (/^[1-9]\d*s$/.test(suffix)) return { kind: 'time', block };
  if (/^[1-9]\d*m(?:(?:[0-9]|[0-5]\d)s)?$/.test(suffix)) return { kind: 'time', block };
  if (suffix === '@end' || /^@[A-Za-z_][A-Za-z0-9_-]*(?::[1-9]\d*)?$/.test(suffix)) return { kind: 'until', block };
  return { kind: 'raw' };
}

function blockNames() {
  const blocks = plan.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) return [];
  return Object.keys(blocks);
}

function presetNames() {
  const audio = plan.audio;
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)) return [];
  return Object.keys(audio);
}

function defaultBlock() {
  return blockNames()[0] || 'main';
}

function firstMarker() {
  for (const lines of Object.values(plan.blocks || {})) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line === 'string' && /^@[A-Za-z_][A-Za-z0-9_-]*$/.test(line) && line !== '@end') return line;
    }
  }
  return '@cue';
}

function uniqueName(object, base) {
  let name = base || 'item';
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(object, name)) {
    name = `${base}${n}`;
    n += 1;
  }
  return name;
}

function ensureMap(key) {
  const value = plan[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) plan[key] = {};
  return plan[key];
}

function referencedBlocks() {
  const names = new Set();
  for (const { chapter } of chapterEntries()) {
    for (const track of chapter?.tracks || []) {
      if (!track || !Array.isArray(track.blocks)) continue;
      for (const ref of track.blocks) {
        const parsed = parseInstruction(ref);
        if (parsed.kind !== 'raw' && parsed.block && parsed.block !== 'wait') names.add(parsed.block);
      }
    }
  }
  return names;
}

function resolveLibraryIntoPlan() {
  if (!library) return [];
  const blocks = ensureMap('blocks');
  const copied = [];
  for (const name of referencedBlocks()) {
    if (Object.prototype.hasOwnProperty.call(blocks, name)) continue;
    if (!Object.prototype.hasOwnProperty.call(library, name)) continue;
    Object.defineProperty(blocks, name, {value: structuredClone(library[name]), enumerable: true, writable: true, configurable: true});
    copied.push(name);
  }
  return copied;
}

function entryKind(value) {
  if (typeof value === 'string' && /^@[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) return 'marker';
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && typeof value.sfx === 'string') return 'sfx';
  if (typeof value === 'string') return 'line';
  return 'raw';
}

function field(label, node) {
  return el('label', {}, label, node);
}

function numberInput(value, onValue) {
  const input = el('input', { type: 'number', step: 'any' });
  if (value != null && value !== '') input.value = String(value);
  input.addEventListener('input', () => {
    if (input.value === '') onValue(undefined);
    else if (Number.isFinite(Number(input.value))) onValue(Number(input.value));
    syncJson();
  });
  return input;
}

function voiceSelect(settings) {
  const select = el('select', { 'aria-label': 'Voice' });
  select.append(el('option', { value: '', text: 'No voice (sound only)' }));
  for (const [provider, voices] of Object.entries(VOICES)) {
    const group = el('optgroup', { label: provider });
    for (const voice of voices) {
      const id = `${provider}/${voice}`;
      group.append(el('option', { value: id, text: id }));
    }
    select.append(group);
  }
  const current = typeof settings.voice === 'string' ? settings.voice : '';
  if (current && !select.querySelector(`option[value="${CSS.escape(current)}"]`)) {
    select.append(el('option', { value: current, text: current }));
  }
  select.value = current;
  select.addEventListener('change', () => {
    if (select.value) settings.voice = select.value;
    else delete settings.voice;
    syncJson();
  });
  return field('Voice', select);
}

function mountSettings(container, settings) {
  container.append(voiceSelect(settings));
  const panMode = el('select', { 'aria-label': 'Pan mode' });
  for (const [value, text] of [['default', 'Default center'], ['static', 'Static pan'], ['moving', 'Moving pan'], ['raw', 'Keep current pan JSON']]) {
    panMode.append(el('option', { value, text }));
  }
  const pan = settings.pan;
  const mode = pan == null ? 'default' : typeof pan === 'number' ? 'static' : (pan && typeof pan === 'object' && !Array.isArray(pan) ? 'moving' : 'raw');
  panMode.value = mode === 'raw' ? 'raw' : mode;
  if (mode !== 'raw') panMode.querySelector('option[value="raw"]').remove();
  const panFields = el('div', { class: 'row' });
  function drawPan() {
    panFields.replaceChildren();
    if (typeof settings.pan === 'number') {
      panFields.append(field('Pan (-1 left to 1 right)', numberInput(settings.pan, (value) => { settings.pan = value == null ? 0 : value; })));
    } else if (settings.pan && typeof settings.pan === 'object' && !Array.isArray(settings.pan)) {
      const panObject = settings.pan;
      panFields.append(
        field('Pan from', numberInput(panObject.from, (value) => { if (value == null) delete panObject.from; else panObject.from = value; })),
        field('Pan to', numberInput(panObject.to, (value) => { if (value == null) delete panObject.to; else panObject.to = value; })),
        field('Pan period (seconds)', numberInput(panObject.period_s, (value) => { if (value == null) delete panObject.period_s; else panObject.period_s = value; })),
      );
    }
  }
  panMode.addEventListener('change', () => {
    if (panMode.value === 'default') delete settings.pan;
    else if (panMode.value === 'static') settings.pan = typeof settings.pan === 'number' ? settings.pan : 0;
    else if (panMode.value === 'moving') {
      settings.pan = settings.pan && typeof settings.pan === 'object' && !Array.isArray(settings.pan)
        ? settings.pan : { from: -1, to: 1, period_s: 8 };
    }
    drawPan();
    syncJson();
  });
  drawPan();
  container.append(field('Pan', panMode), panFields);
  container.append(field('Volume (dB)', numberInput(settings.volume_db, (value) => {
    if (value == null) delete settings.volume_db; else settings.volume_db = value;
  })));
  const reverb = el('select', { 'aria-label': 'Reverb' });
  reverb.append(el('option', { value: '', text: 'Default (off)' }));
  const currentReverb = typeof settings.reverb === 'string' ? settings.reverb : '';
  for (const name of REVERBS.concat(currentReverb && !REVERBS.includes(currentReverb) ? [currentReverb] : [])) {
    reverb.append(el('option', { value: name, text: name }));
  }
  reverb.value = currentReverb;
  reverb.addEventListener('change', () => {
    if (reverb.value) settings.reverb = reverb.value;
    else delete settings.reverb;
    syncJson();
  });
  container.append(field('Reverb', reverb));
  container.append(field('Pitch (semitones)', numberInput(settings.pitch_semitones, (value) => {
    if (value == null) delete settings.pitch_semitones; else settings.pitch_semitones = value;
  })));
  container.append(field('Speed', numberInput(settings.speed, (value) => {
    if (value == null) delete settings.speed; else settings.speed = value;
  })));
  container.append(field('Resample', numberInput(settings.resample, (value) => {
    if (value == null) delete settings.resample; else settings.resample = value;
  })));
  const known = new Set(['voice', 'pan', 'volume_db', 'reverb', 'pitch_semitones', 'speed', 'resample']);
  const extra = Object.keys(settings).filter((key) => !known.has(key));
  if (extra.length) container.append(el('p', { class: 'help', text: `Additional preset fields stay in the JSON: ${extra.join(', ')}` }));
}

function renderPresets() {
  const list = $('preset-list');
  list.replaceChildren();
  const audio = plan.audio;
  if (audio != null && (typeof audio !== 'object' || Array.isArray(audio))) {
    list.append(el('p', { class: 'help', text: 'audio is not an object, so it is left untouched in the JSON.' }));
    return;
  }
  for (const name of presetNames()) {
    const settings = audio[name];
    const card = el('fieldset');
    const nameInput = el('input', { type: 'text', value: name, 'aria-label': `Preset name ${name}` });
    nameInput.addEventListener('change', () => {
      const next = nameInput.value.trim();
      if (!next || next === name) { nameInput.value = name; return; }
      if (Object.prototype.hasOwnProperty.call(audio, next)) {
        setStatus(`An audio preset named ${next} already exists.`, 'error');
        nameInput.value = name;
        return;
      }
      plan.audio = Object.fromEntries(Object.entries(audio).map(([key, value]) => [key === name ? next : key, value]));
      for (const { chapter } of chapterEntries()) {
        for (const track of chapter?.tracks || []) {
          if (track && track.audio === name) track.audio = next;
        }
      }
      render();
      syncJson();
    });
    card.append(field('Preset name', nameInput));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      card.append(el('p', { class: 'help', text: 'This preset is not an object and is kept in the JSON.' }));
    } else {
      mountSettings(card, settings);
    }
    card.append(el('button', { type: 'button', text: 'Delete preset', onclick: () => deletePreset(name) }));
    list.append(card);
  }
}

function deletePreset(name) {
  const users = [];
  chapterEntries().forEach(({ chapter, index }) => {
    (chapter?.tracks || []).forEach((track, trackIndex) => {
      if (track && track.audio === name) users.push(`chapter ${index + 1} track ${trackIndex + 1}`);
    });
  });
  if (users.length) {
    setStatus(`Preset ${name} is still used by ${users.join(', ')}. Point those tracks somewhere else first.`, 'error');
    return;
  }
  delete plan.audio[name];
  render();
  syncJson();
}

function renderBlocks() {
  const list = $('block-list');
  list.replaceChildren();
  const blocks = plan.blocks;
  if (blocks != null && (typeof blocks !== 'object' || Array.isArray(blocks))) {
    list.append(el('p', { class: 'help', text: 'blocks is not an object, so it is left untouched in the JSON.' }));
    return;
  }
  for (const name of blockNames()) {
    const lines = blocks[name];
    const card = el('fieldset');
    const nameInput = el('input', { type: 'text', value: name, 'aria-label': `Block name ${name}` });
    nameInput.addEventListener('change', () => renameBlock(name, nameInput));
    card.append(field('Block name', nameInput));
    if (!Array.isArray(lines)) {
      card.append(el('p', { class: 'help', text: 'This block is not an array and is kept in the JSON.' }));
    } else {
      lines.forEach((value, index) => card.append(renderEntry(name, index, value)));
      const row = el('div', { class: 'row' });
      row.append(
        el('button', { type: 'button', text: 'Add line', onclick: () => { lines.push('New line.'); render(); syncJson(); } }),
        el('button', { type: 'button', text: 'Add marker', onclick: () => { lines.push(firstMarker() === '@cue' ? '@cue' : '@marker'); render(); syncJson(); } }),
        el('button', { type: 'button', text: 'Add sound effect', onclick: () => { lines.push({ sfx: 'bell' }); render(); syncJson(); } }),
      );
      card.append(row);
    }
    card.append(el('button', { type: 'button', text: 'Delete block', onclick: () => deleteBlock(name) }));
    list.append(card);
  }
}

function renderEntry(blockName, index, value) {
  const lines = plan.blocks[blockName];
  const row = el('div', { class: 'row' });
  const kind = entryKind(value);
  if (kind === 'line') {
    const input = el('input', { type: 'text', value, 'aria-label': `Spoken line ${index + 1} of ${blockName}` });
    input.addEventListener('input', () => { lines[index] = input.value; syncJson(); });
    row.append(field('Spoken line', input));
  } else if (kind === 'marker') {
    const input = el('input', { type: 'text', value, 'aria-label': `Marker ${index + 1} of ${blockName}` });
    input.addEventListener('input', () => { lines[index] = input.value; syncJson(); });
    row.append(field('Marker', input));
  } else if (kind === 'sfx') {
    const input = el('input', { type: 'text', value: value.sfx, 'aria-label': `Sound effect id ${index + 1} of ${blockName}`, pattern: '[A-Za-z0-9_-]{1,80}' });
    input.addEventListener('input', () => { value.sfx = input.value; syncJson(); });
    row.append(field('Sound effect id', input));
  } else {
    const raw = el('textarea', { rows: '4', 'aria-label': `Preserved entry ${index + 1} of ${blockName}` });
    raw.value = JSON.stringify(value, null, 2);
    raw.addEventListener('change', () => {
      parseAuthoring(raw.value).then((parsed) => { lines[index] = parsed; syncJson(); }).catch((error) => {
        setStatus(`Entry ${index + 1} of ${blockName}: ${error.message}`, 'error');
      });
    });
    row.append(field('Preserved entry JSON', raw));
  }
  row.append(el('button', { type: 'button', text: 'Delete entry', onclick: () => { lines.splice(index, 1); render(); syncJson(); } }));
  return row;
}

function renameBlock(oldName, input) {
  const next = input.value.trim();
  if (!next || next === oldName) { input.value = oldName; return; }
  if (Object.prototype.hasOwnProperty.call(plan.blocks, next)) {
    setStatus(`A block named ${next} already exists.`, 'error');
    input.value = oldName;
    return;
  }
  plan.blocks = Object.fromEntries(Object.entries(plan.blocks).map(([key, value]) => [key === oldName ? next : key, value]));
  for (const { chapter } of chapterEntries()) {
    for (const track of chapter?.tracks || []) {
      if (!track || !Array.isArray(track.blocks)) continue;
      track.blocks = track.blocks.map((ref) => retarget(ref, oldName, next));
    }
  }
  render();
  syncJson();
}

function retarget(text, oldName, next) {
  const parsed = parseInstruction(text);
  if (parsed.kind === 'raw' || parsed.block !== oldName) return text;
  const bracket = text.indexOf('[');
  return next + (bracket === -1 ? '' : text.slice(bracket));
}

function deleteBlock(name) {
  const users = [];
  for (const ref of referencedBlocks()) {
    if (ref === name) users.push(name);
  }
  if (users.length) {
    setStatus(`Block ${name} is still used by a track. Remove those instructions first.`, 'error');
    return;
  }
  delete plan.blocks[name];
  render();
  syncJson();
}

function hasLegacy(track) {
  return LEGACY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(track, key));
}

function renderArrangement() {
  const list = $('chapter-list');
  list.replaceChildren();
  if (mode() === 'both') {
    list.append(el('p', { class: 'help', text: 'This plan has both tracks and chapters. Both stay in the JSON. Remove one of them before the plan can validate.' }));
  }
  if (mode() === 'empty') {
    list.append(el('p', { class: 'help', text: 'Add a chapter to start a track list.' }));
    return;
  }
  for (const entry of chapterEntries()) renderChapter(list, entry);
  if (mode() === 'chapters' && plan.chapters.length === 1 && Object.keys(plan.chapters[0] || {}).every((key) => key === 'tracks')) {
    list.append(el('button', { type: 'button', text: 'Write as single chapter', onclick: () => {
      plan.tracks = plan.chapters[0].tracks;
      delete plan.chapters;
      render();
      syncJson();
    } }));
  }
}

function renderChapter(list, entry) {
  const { chapter, index, shorthand } = entry;
  const card = el('fieldset');
  card.append(el('h3', { text: shorthand ? 'Chapter 1 (single-chapter tracks)' : `Chapter ${index + 1}` }));
  if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) {
    card.append(el('p', { class: 'help', text: 'This chapter is not an object and is kept in the JSON.' }));
    list.append(card);
    return;
  }
  const tracks = Array.isArray(chapter.tracks) ? chapter.tracks : null;
  if (!tracks) {
    card.append(el('p', { class: 'help', text: 'tracks is missing or not an array and is kept in the JSON.' }));
  } else {
    tracks.forEach((track, trackIndex) => card.append(renderTrack(chapter, index, trackIndex, track)));
    card.append(el('button', { type: 'button', text: 'Add track', onclick: () => addTrack(chapter) }));
  }
  if (!shorthand && Array.isArray(plan.chapters) && plan.chapters.length > 1) {
    card.append(el('button', { type: 'button', text: 'Delete chapter', onclick: () => {
      plan.chapters.splice(index, 1);
      render();
      syncJson();
    } }));
  }
  const extra = Object.keys(chapter).filter((key) => key !== 'tracks');
  if (extra.length) card.append(el('p', { class: 'help', text: `Other chapter fields stay in the JSON: ${extra.join(', ')}` }));
  list.append(card);
}

function addTrack(chapter) {
  if (!Array.isArray(chapter.tracks)) chapter.tracks = [];
  const blocks = ensureMap('blocks');
  if (!Object.keys(blocks).length) blocks.main = ['Say this once.'];
  const names = presetNames();
  const track = { blocks: [Object.keys(blocks)[0]] };
  if (names.length) track.audio = names[0];
  else track.audio = { voice: 'kokoro/af_sarah' };
  if (!chapter.tracks.some((item) => item && item.lead === true)) track.lead = true;
  chapter.tracks.push(track);
  render();
  syncJson();
}

function renderTrack(chapter, chapterIndex, trackIndex, track) {
  const card = el('div', { class: 'card' });
  const label = `chapter ${chapterIndex + 1} track ${trackIndex + 1}`;
  card.append(el('h4', { text: `Track ${trackIndex + 1}` }));
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    card.append(el('p', { class: 'help', text: 'This track is not an object and is kept in the JSON.' }));
    return card;
  }
  const idInput = el('input', { type: 'text', value: track.id || '', 'aria-label': `Track id ${label}` });
  idInput.addEventListener('input', () => {
    if (idInput.value === '') delete track.id;
    else track.id = idInput.value;
    syncJson();
  });
  card.append(field('Track id', idInput));
  card.append(audioChooser(track, label));
  if (hasLegacy(track) && Object.prototype.hasOwnProperty.call(track, 'audio')) {
    const warning = el('p', { class: 'help', text: 'This track mixes named audio with saved flat settings (tts, pan, gain_db, reverb, or transform). Both are kept until you remove one.' });
    const actions = el('div', { class: 'row' });
    actions.append(
      el('button', { type: 'button', text: 'Remove saved flat settings', onclick: () => { for (const key of LEGACY_KEYS) delete track[key]; render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Remove named audio', onclick: () => { delete track.audio; render(); syncJson(); } }),
    );
    card.append(warning, actions);
  } else if (hasLegacy(track)) {
    card.append(el('p', { class: 'help', text: 'Saved flat voice settings are still accepted. They stay as written until you convert them.' }));
    const raw = el('textarea', { rows: '6', 'aria-label': `Saved flat settings ${label}` });
    const slice = {};
    for (const key of LEGACY_KEYS) if (key in track) slice[key] = track[key];
    raw.value = JSON.stringify(slice, null, 2);
    raw.addEventListener('change', () => {
      parseAuthoring(raw.value).then((parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
        for (const key of LEGACY_KEYS) delete track[key];
        Object.assign(track, parsed);
        render();
        syncJson();
      }).catch((error) => setStatus(error.message, 'error'));
    });
    card.append(field('Saved flat settings', raw));
    card.append(el('button', { type: 'button', text: 'Convert saved settings to a named preset', onclick: () => convertLegacy(track) }));
  }
  const lead = el('input', { type: 'checkbox' });
  lead.checked = track.lead === true;
  lead.addEventListener('change', () => { track.lead = lead.checked; syncJson(); });
  const loop = el('input', { type: 'checkbox' });
  loop.checked = track.loop === true;
  loop.addEventListener('change', () => { track.loop = loop.checked; syncJson(); });
  card.append(field('Timing lead', lead), field('Loop the whole sequence', loop));
  card.append(choice(track, 'finish', 'Finish at a boundary', [['line', 'Finish the line'], ['block', 'Finish the block pass']], 'line'));
  card.append(choice(track, 'order', 'Line order', [['linear', 'Written order'], ['shuffle_lines', 'Shuffle lines each pass']], 'linear'));
  card.append(field('Line gap (ms)', numberInput(track.gap_ms, (value) => { if (value == null) delete track.gap_ms; else track.gap_ms = value; })));
  card.append(field('Start delay (ms)', numberInput(track.start_delay_ms, (value) => { if (value == null) delete track.start_delay_ms; else track.start_delay_ms = value; })));
  card.append(el('p', { class: 'help', text: 'Instructions stay in written order. Counted, timed, marker, and silence entries can share a track.' }));
  if (!Array.isArray(track.blocks)) {
    card.append(el('p', { class: 'help', text: 'blocks is not an array and is kept in the JSON.' }));
  } else {
    track.blocks.forEach((ref, refIndex) => {
      const input = el('input', { type: 'text', value: typeof ref === 'string' ? ref : JSON.stringify(ref), 'aria-label': `Instruction ${refIndex + 1} of ${label}` });
      input.addEventListener('input', () => {
        track.blocks[refIndex] = input.value;
        syncJson();
      });
      const row = el('div', { class: 'row' });
      row.append(field(`Instruction ${refIndex + 1}`, input));
      row.append(el('button', { type: 'button', text: 'Delete instruction', onclick: () => { track.blocks.splice(refIndex, 1); render(); syncJson(); } }));
      card.append(row);
    });
    const name = defaultBlock();
    const marker = firstMarker();
    const row = el('div', { class: 'row' });
    row.append(
      el('button', { type: 'button', text: 'Play once', onclick: () => { track.blocks.push(name); render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Add repeats', onclick: () => { track.blocks.push(`${name}[5x]`); render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Add timed play', onclick: () => { track.blocks.push(`${name}[90s]`); render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Add minute timer', onclick: () => { track.blocks.push(`${name}[1m30s]`); render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Add play until marker', onclick: () => { track.blocks.push(`${name}[${marker}]`); render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Add silence', onclick: () => { track.blocks.push('wait[5s]'); render(); syncJson(); } }),
      el('button', { type: 'button', text: 'Add silence until marker', onclick: () => { track.blocks.push(`wait[${marker}]`); render(); syncJson(); } }),
    );
    card.append(row);
  }
  card.append(el('button', { type: 'button', text: 'Delete track', onclick: () => {
    chapter.tracks.splice(trackIndex, 1);
    render();
    syncJson();
  } }));
  const known = new Set(['audio', 'blocks', 'lead', 'loop', 'finish', 'order', 'gap_ms', 'start_delay_ms', 'id', ...LEGACY_KEYS]);
  const extra = Object.keys(track).filter((key) => !known.has(key));
  if (extra.length) card.append(el('p', { class: 'help', text: `Other track fields stay in the JSON: ${extra.join(', ')}` }));
  return card;
}

function choice(track, key, label, options, defaultValue) {
  const select = el('select', { 'aria-label': label });
  const current = track[key] == null ? defaultValue : String(track[key]);
  const values = options.map(([value]) => value);
  for (const [value, text] of options) select.append(el('option', { value, text }));
  if (!values.includes(current)) select.append(el('option', { value: current, text: current }));
  select.value = current;
  select.addEventListener('change', () => { track[key] = select.value; syncJson(); });
  return field(label, select);
}

function audioChooser(track, label) {
  const wrap = el('div');
  const select = el('select', { 'aria-label': `Audio preset ${label}` });
  select.append(el('option', { value: '', text: 'Choose named audio' }));
  for (const name of presetNames()) select.append(el('option', { value: name, text: name }));
  select.append(el('option', { value: '__inline__', text: 'Custom settings on this track' }));
  if (typeof track.audio === 'string' && !presetNames().includes(track.audio)) {
    select.append(el('option', { value: track.audio, text: track.audio }));
  }
  if (typeof track.audio === 'string') select.value = track.audio;
  else if (track.audio && typeof track.audio === 'object' && !Array.isArray(track.audio)) select.value = '__inline__';
  else select.value = '';
  select.addEventListener('change', () => {
    if (select.value === '') return;
    if (select.value === '__inline__') {
      if (typeof track.audio === 'string' && plan.audio && plan.audio[track.audio] && typeof plan.audio[track.audio] === 'object') {
        track.audio = structuredClone(plan.audio[track.audio]);
      } else if (!track.audio || typeof track.audio !== 'object' || Array.isArray(track.audio)) {
        track.audio = { voice: 'kokoro/af_sarah' };
      }
    } else {
      track.audio = select.value;
    }
    render();
    syncJson();
  });
  wrap.append(field('Audio preset', select));
  if (track.audio && typeof track.audio === 'object' && !Array.isArray(track.audio)) {
    const inline = el('fieldset');
    inline.append(el('legend', { text: 'Inline audio settings' }));
    mountSettings(inline, track.audio);
    wrap.append(inline);
  } else if (track.audio != null && typeof track.audio !== 'string') {
    wrap.append(el('p', { class: 'help', text: 'audio is not a name or object and is kept in the JSON.' }));
  }
  return wrap;
}

function convertLegacy(track) {
  const settings = {};
  if (track.tts != null) {
    if (!track.tts || typeof track.tts !== 'object' || typeof track.tts.provider !== 'string' || typeof track.tts.voice !== 'string') {
      setStatus('Saved tts needs provider and voice strings before conversion.', 'error');
      return;
    }
    settings.voice = `${track.tts.provider}/${track.tts.voice}`;
  }
  if ('pan' in track) settings.pan = structuredClone(track.pan);
  if ('gain_db' in track) settings.volume_db = track.gain_db;
  if ('reverb' in track) settings.reverb = track.reverb;
  if (track.transform != null) {
    if (!track.transform || typeof track.transform !== 'object' || Array.isArray(track.transform)) {
      setStatus('Saved transform is not an object. Edit the JSON instead.', 'error');
      return;
    }
    const allowed = new Set(['pitch_semitones', 'tempo', 'resample']);
    const unknown = Object.keys(track.transform).filter((key) => !allowed.has(key));
    if (unknown.length) {
      setStatus(`Saved transform still has ${unknown.join(', ')}. Edit the JSON instead of converting it.`, 'error');
      return;
    }
    if ('pitch_semitones' in track.transform) settings.pitch_semitones = track.transform.pitch_semitones;
    if ('tempo' in track.transform) settings.speed = track.transform.tempo;
    if ('resample' in track.transform) settings.resample = track.transform.resample;
  }
  const audio = ensureMap('audio');
  const name = uniqueName(audio, track.id || 'saved');
  Object.defineProperty(audio, name, {value: settings, enumerable: true, writable: true, configurable: true});
  for (const key of LEGACY_KEYS) delete track[key];
  track.audio = name;
  render();
  syncJson();
  setStatus(`Converted saved settings into audio preset ${name}.`, 'ok');
}

function renderBackground() {
  const host = $('binaural-fields');
  host.replaceChildren();
  const select = el('select', { 'aria-label': 'Background' });
  select.append(el('option', { value: '', text: 'Default (bimbo-drone)' }));
  const current = plan.binaural;
  const names = BACKGROUNDS.slice();
  if (typeof current === 'string' && !names.includes(current)) names.push(current);
  for (const name of names) select.append(el('option', { value: name, text: name }));
  select.append(el('option', { value: '__custom__', text: 'Custom background object' }));
  if (current && typeof current === 'object') select.value = '__custom__';
  else if (typeof current === 'string') select.value = current;
  else select.value = '';
  select.addEventListener('change', () => {
    if (select.value === '') delete plan.binaural;
    else if (select.value === '__custom__') {
      if (!plan.binaural || typeof plan.binaural !== 'object') plan.binaural = { layers: [{ center_hz: 120, amplitude_db: -24 }] };
    } else plan.binaural = select.value;
    renderBackground();
    syncJson();
  });
  host.append(field('Background', select));
  if (plan.binaural && typeof plan.binaural === 'object') {
    const raw = el('textarea', { rows: '8', 'aria-label': 'Custom background JSON' });
    raw.value = JSON.stringify(plan.binaural, null, 2);
    raw.addEventListener('change', () => {
      parseAuthoring(raw.value).then((parsed) => { plan.binaural = parsed; syncJson(); }).catch((error) => setStatus(error.message, 'error'));
    });
    host.append(field('Custom background JSON', raw));
  }
}

function render() {
  renderPresets();
  renderBlocks();
  renderArrangement();
  renderBackground();
}

function formatDiagnostic(diagnostic) {
  if (!diagnostic) return 'Invalid JSON';
  return [diagnostic.path, diagnostic.message, diagnostic.hint].filter(Boolean).join('\n');
}

async function parseAuthoring(text) {
  const pyodide = await loadValidator();
  const raw = pyodide.runPython(`accept(${JSON.stringify(text)})`);
  const result = JSON.parse(raw);
  if (!result.ok) throw new Error(formatDiagnostic(result.diagnostic));
  return result.value;
}

async function applyJson({ keepStatus = false } = {}) {
  const text = $('plan-json').value;
  const epoch = inputEpoch;
  const parsed = await parseAuthoring(text);
  if (epoch !== inputEpoch || $('plan-json').value !== text) throw new Error('JSON changed while loading. Apply it again.');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Plan must be a JSON object');
  plan = parsed;
  jsonDirty = false;
  render();
  syncJson({ keepStatus });
}

function libraryMap(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Library must be an object of named blocks');
  if (data.blocks && typeof data.blocks === 'object' && !Array.isArray(data.blocks) && !data.audio && !data.tracks && !data.chapters) {
    return data.blocks;
  }
  if (data.blocks && typeof data.blocks === 'object' && !Array.isArray(data.blocks)) return data.blocks;
  return data;
}

function authoringText() {
  return JSON.stringify(plan, null, 2);
}

async function download() {
  try {
    await applyJson({ keepStatus: true });
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  const copied = resolveLibraryIntoPlan();
  const text = authoringText();
  $('plan-json').value = text;
  jsonDirty = false;
  inputEpoch += 1;
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.href = url;
  link.download = 'audio-plan.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  const note = copied.length ? `Copied saved blocks into the plan: ${copied.join(', ')}. ` : '';
  setStatus(`${note}Downloaded audio-plan.json.`, 'ok');
}

async function loadValidator() {
  if (!validatorPromise) {
    validatorPromise = (async () => {
      setValidator('Loading the Python validator…');
      await new Promise((resolve, reject) => {
        if (window.loadPyodide) { resolve(); return; }
        const script = document.createElement('script');
        script.src = `${PYODIDE_INDEX}pyodide.js`;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not download the Python runtime.'));
        document.head.append(script);
      });
      const pyodide = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
      pyodide.FS.mkdirTree('/validator/utils');
      const modules = await (await fetch('validator/modules.json')).json();
      for (const name of modules) {
        const response = await fetch(`validator/utils/${name}`);
        if (!response.ok) throw new Error(`Missing validator module ${name}`);
        pyodide.FS.writeFile(`/validator/utils/${name}`, await response.text());
      }
      pyodide.runPython(`
import json, sys
sys.path.insert(0, '/validator')
from utils.audio_contract import validate_plan, parse_json, AudioInputError, fail

def _nonfinite():
    return {'path': 'JSON', 'code': 'invalid_plan', 'message': 'non-finite number',
            'hint': 'Remove NaN, Infinity, and exponents that overflow.'}

def accept(text):
    try:
        value = parse_json(text)
        encoded = json.dumps(value, allow_nan=False)
    except AudioInputError as exc:
        return json.dumps({'ok': False, 'diagnostic': exc.diagnostic()})
    except ValueError:
        return json.dumps({'ok': False, 'diagnostic': _nonfinite()})
    return json.dumps({'ok': True, 'value': json.loads(encoded)})

def check(text, saved_text):
    try:
        authoring = parse_json(text)
        if not isinstance(authoring, dict):
            fail('JSON', 'expected an object')
        json.dumps(authoring, allow_nan=False)
        checked, warnings = validate_plan(authoring, saved_blocks=parse_json(saved_text))
        for name, values in checked['blocks'].items():
            if name not in authoring.get('blocks', {}):
                authoring.setdefault('blocks', {})[name] = values
        validate_plan(checked)
        notes = []
        for warning in list(warnings or []):
            notes.append(warning if isinstance(warning, str) else json.dumps(warning, allow_nan=False))
        return json.dumps({'ok': True, 'plan': authoring, 'warnings': notes}, allow_nan=False)
    except AudioInputError as exc:
        return json.dumps({'ok': False, 'diagnostic': exc.diagnostic()})
    except ValueError:
        return json.dumps({'ok': False, 'diagnostic': _nonfinite()})
`);
      setValidator('Validator ready. It checks this plan in the browser.', 'ok');
      return pyodide;
    })().catch((error) => {
      validatorPromise = null;
      setValidator(`Validator failed to load: ${error.message}`, 'error');
      throw error;
    });
  }
  return validatorPromise;
}

function showDiagnostic(diagnostic, prefix = '') {
  const lines = [prefix.trim(), diagnostic?.code ? `Code: ${diagnostic.code}` : '', diagnostic?.path ? `Where: ${diagnostic.path}` : '', diagnostic?.message || 'Invalid plan', diagnostic?.hint ? `Fix: ${diagnostic.hint}` : ''].filter(Boolean);
  setStatus(lines.join('\n'), 'error');
}

async function runCheck(pyodide, text) {
  const raw = pyodide.runPython(`check(${JSON.stringify(text)}, ${JSON.stringify(JSON.stringify(library || {}))})`);
  return JSON.parse(raw);
}

async function validate() {
  const run = ++validateRun;
  const text = $('plan-json').value;
  const epoch = inputEpoch;
  setStatus('Checking the plan…');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (run !== validateRun) return;
  let pyodide;
  try {
    pyodide = await loadValidator();
  } catch (error) {
    if (run === validateRun) setStatus(error.message, 'error');
    return;
  }
  if (run !== validateRun || epoch !== inputEpoch || $('plan-json').value !== text) {
    setStatus('Plan changed during validation. Validate again before trusting this result.', 'error');
    return;
  }
  let result;
  try {
    result = await runCheck(pyodide, text);
  } catch (error) {
    if (run === validateRun) setStatus(error.message, 'error');
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (run !== validateRun || epoch !== inputEpoch || $('plan-json').value !== text) {
    setStatus('Plan changed during validation. Validate again before trusting this result.', 'error');
    return;
  }
  if (!result.ok) {
    showDiagnostic(result.diagnostic);
    return;
  }
  plan = result.plan;
  render();
  syncJson({ keepStatus: true });
  const warnings = (result.warnings || []).join('\n');
  setStatus(`Valid plan.${warnings ? `\n${warnings}` : ''}`, 'ok');
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function loadExample() {
  const response = await fetch('example.json');
  if (!response.ok) throw new Error('Example file is missing');
  plan = await response.json();
  jsonDirty = false;
  render();
  syncJson({ keepStatus: true });
  setStatus('Example loaded. Presets, markers, silence, and the sound effect are in the form.', 'ok');
}

$('load-example').addEventListener('click', () => { loadExample().catch((error) => setStatus(error.message, 'error')); });
$('download').addEventListener('click', download);
$('validate').addEventListener('click', () => { validate(); });
$('apply-json').addEventListener('click', async () => {
  try { await applyJson(); setStatus('Form updated from JSON.', 'ok'); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('add-preset').addEventListener('click', () => {
  const audio = ensureMap('audio');
  audio[uniqueName(audio, 'preset')] = { voice: 'kokoro/af_sarah' };
  render();
  syncJson();
});
$('add-block').addEventListener('click', () => {
  const blocks = ensureMap('blocks');
  blocks[uniqueName(blocks, 'block')] = ['New line.'];
  render();
  syncJson();
});
$('add-chapter').addEventListener('click', () => {
  if (mode() === 'both') {
    setStatus('This plan already has both tracks and chapters. Remove one in the JSON first.', 'error');
    return;
  }
  if (mode() === 'tracks') {
    const tracks = plan.tracks;
    delete plan.tracks;
    plan.chapters = [{ tracks }, { tracks: [] }];
  } else if (mode() === 'empty') plan.chapters = [{ tracks: [] }];
  else plan.chapters.push({ tracks: [] });
  render();
  syncJson();
});
$('plan-json').addEventListener('input', () => { jsonDirty = true; inputEpoch += 1; setFormEditing(false); setStatus('JSON edits pending. Update the form or validate before editing fields.'); });
$('import-plan').addEventListener('change', async () => {
  const file = $('import-plan').files[0];
  if (!file) return;
  try {
    $('plan-json').value = await readFile(file);
    jsonDirty = true;
    inputEpoch += 1;
    await applyJson({ keepStatus: true });
    setStatus('Imported the plan.', 'ok');
  } catch (error) {
    jsonDirty = true;
    setStatus(error.message, 'error');
  }
  $('import-plan').value = '';
});
$('import-library').addEventListener('change', async () => {
  const file = $('import-library').files[0];
  if (!file) return;
  try {
    library = libraryMap(await parseAuthoring(await readFile(file)));
    setStatus('Saved block library loaded. Missing referenced blocks are copied into the plan on download or validate.', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
  $('import-library').value = '';
});

loadExample().catch((error) => setStatus(error.message, 'error'));
loadValidator().catch(() => {});
