import { FONT_FAMILIES, MIN_LENGTH, clamp, round, emptyProject, makeClip, distribute, effectiveFade, moveClip, formatTime, validateProject, clipLanes, replaceClipText, textBoundaries, duplicateClips, STYLE_KEYS, graphemes, styleAt, styleValues, applyTextStyle, editTimeline, overwriteClips, makeCues, insertClips, anchorFirstCue, fontWeights, normalizeFontWeights } from './core.js';
import { drawFrame, measureClip, loadProjectFonts, checkBounds, advancedText } from './renderer.js';
import { loadLocalFont } from './local-fonts.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
const preview = $('preview');
let project = emptyProject();
let buffer = null, sourceUrl = '', selectedId = null, time = 0, peaks = null;
let undoStack = [], redoStack = [], loading = false, loadGeneration = 0;
let toastTimer, saveTimer, frameRequest, exportController = null, exportUrl = '', dirty = false;
let savedSnapshot = JSON.stringify(project), exportModule;
let selectedIds = [], inlineId = null, composing = false, formatRange = null;
const availableFonts = new Set(Object.keys(FONT_FAMILIES).filter(id => FONT_FAMILIES[id].bundled));
const availableFontWeights = new Map([...availableFonts].map(id => [id,fontWeights(id)]));
const duration = () => buffer?.duration || project.audio?.duration || 60;
const selected = () => project.clips.find(c => c.id === selectedId);
const snapshot = () => structuredClone(project);
const message = (text, error = false) => {
  clearTimeout(toastTimer); $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, error ? 7000 : 4000);
};
function checkpoint() { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
function changed() {
  project.clips.forEach(anchorFirstCue);
  project.clips.forEach(c => normalizeFontWeights(c,availableFontWeights));
  normalizeSelection();
  dirty = JSON.stringify(project) !== savedSnapshot;
  $('save-state').textContent = dirty ? '変更あり' : '保存済み';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('tomei-draft-v1', JSON.stringify(project)); $('save-state').textContent = dirty ? '端末に一時保存' : '保存済み'; }
    catch { $('save-state').textContent = 'ファイルに保存してください'; }
  }, 500);
  renderTimeline(); renderPreview(); updateButtons();
}
function change(mutator) { checkpoint(); mutator(project); changed(); renderInspector(); }
function updateButtons() {
  for (const id of ['bulk-open', 'bulk-empty', 'add-text', 'play', 'export-button']) $(id).disabled = !buffer || loading;
  $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length;
  $('choose-audio').disabled = loading; $('choose-audio-main').disabled = loading;
}
function undo(redo = false) {
  const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
  if (!from.length) return;
  to.push(snapshot()); project = from.pop();
  if (!selected()) selectedId = null;
  changed(); renderInspector(); renderMaster();
}
function seek(value) {
  if (inlineId) finishInline();
  time = clamp(value, 0, duration());
  if (buffer) audio.currentTime = time;
  renderPreview(); renderTime();
}
function stop() { audio.pause(); cancelAnimationFrame(frameRequest); $('play-symbol').setAttribute('d', 'M8 5 20 12 8 19Z'); $('play').setAttribute('aria-label', '再生'); }
async function togglePlay() {
  finishInline();
  if (!buffer || exportController) return;
  if (!audio.paused) return stop();
  if (time >= duration() - 0.01) seek(0);
  try {
    await audio.play(); $('play-symbol').setAttribute('d', 'M7 5h3v14H7ZM14 5h3v14h-3Z'); $('play').setAttribute('aria-label', '一時停止');
    const tick = () => {
      time = audio.currentTime; renderPreview(); renderTime();
      const scroll = $('timeline-scroll'), pos = time / duration() * $('timeline-content').clientWidth;
      if (pos > scroll.scrollLeft + scroll.clientWidth - 30 || pos < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, pos - 40);
      if (!audio.paused) frameRequest = requestAnimationFrame(tick);
    };
    frameRequest = requestAnimationFrame(tick);
  } catch { message('音源を再生できませんでした。別の音声形式でお試しください。', true); }
}
function renderTime() {
  $('time-display').replaceChildren(document.createTextNode(formatTime(time) + ' '));
  const span = document.createElement('span'); span.textContent = '/ ' + formatTime(project.audio ? duration() : 0); $('time-display').append(span);
  $('playhead').style.left = `${time / duration() * 100}%`;
}
function renderPreview() {
  // Rasterize at the display's physical resolution instead of shrinking a 1080p bitmap.
  const rect = preview.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
  if (preview.width !== width || preview.height !== height) { preview.width = width; preview.height = height; }
  drawFrame(preview, inlineId ? { ...project, clips: project.clips.filter(c => c.id !== inlineId) } : project, time);
  $('empty-preview').hidden = !!project.audio;
  const clip = selected(), outline = $('selection-outline');
  outline.hidden = !!inlineId || !clip || time < clip.start || time >= clip.end || !audio.paused || !!exportController;
  if (!outline.hidden) {
    const box = measureClip(preview.getContext('2d'), clip);
    outline.style.left = `${box.left / 19.2}%`; outline.style.top = `${box.top / 10.8}%`;
    outline.style.width = `${box.width / 19.2}%`; outline.style.height = `${box.height / 10.8}%`;
  }
  renderSelectionExtras();
  if (inlineId) styleInline();
}
function renderMaster() { $('master-in').value = project.master.in; $('master-out').value = project.master.out; }
function renderInspector() {
  normalizeSelection(); renderSelectionActions();
  const clip = selected();
  $('clip-form').hidden = !clip; $('inspector-empty').hidden = !!clip;
  $('selection-type').textContent = clip ? clip.kind === 'title' ? '曲名' : '歌詞' : '未選択';
  if (!clip) return;
  for (const [name, key] of [['text', 'text'], ['start', 'start'], ['end', 'end'], ['line-height', 'lineHeight'], ['x', 'x'], ['y', 'y']]) $('clip-' + name).value = clip[key];
  renderTextSettings(clip);
  $('clip-writing-mode').value = clip.writingMode ?? 'horizontal';
  $('clip-track').replaceChildren(...Array.from({length:project.tracks ?? 1},(_,i)=>new Option('歌詞 '+(i+1),String(i))));$('clip-track').value=String(clip.track ?? 0);
  const alignLabels = clip.writingMode === 'vertical' ? {left:'上揃え',center:'中央揃え',right:'下揃え'} : {left:'左揃え',center:'中央揃え',right:'右揃え'};
  for (const b of $('alignment').children) {
    b.setAttribute('aria-pressed', b.dataset.align === clip.align);
    b.textContent = alignLabels[b.dataset.align];
    b.setAttribute('aria-label', b.textContent);
  }
  $('clip-start').max = round(clip.end - MIN_LENGTH); $('clip-end').max = duration(); $('clip-end').min = round(clip.start + MIN_LENGTH);
  $('use-master').checked = clip.fade === null;
  const f = clip.fade ?? project.master;
  $('clip-fade-in').value = f.in; $('clip-fade-out').value = f.out;
  $('fade-scope').textContent = clip.fade === null ? 'マスターフェード（共通）' : '個別フェード';
  $('fade-note').textContent = (clip.fade === null ? 'ここで変更すると、マスターを使用するすべてのブロックに反映されます。' : 'このテキストだけに適用されます。') + (f.in + f.out > clip.end - clip.start ? ' 表示時間に収まるよう、イン・アウトを同じ比率で短縮します。' : '');
}
function selectClip(id, jump = true, extend = false, preserve = false) {
  finishInline();
  if (extend) {
    selectedIds = selectedIds.includes(id) ? selectedIds.filter(v => v !== id) : [...selectedIds, id];
    selectedId = selectedIds.includes(id) ? id : selectedIds.at(-1) ?? null;
  } else { selectedId = id; if (!preserve) selectedIds = id ? [id] : []; }
  const clip = selected();
  if (jump && clip && (time < clip.start || time >= clip.end)) { stop(); seek(Math.min(clip.end - 0.001, clip.start + Math.min(0.5, (clip.end - clip.start) / 2))); }
  renderInspector(); renderTimeline(); renderPreview();
  if (clip) loadProjectFonts({ clips: [clip] }).then(renderPreview).catch(() => message('フォントを読み込めませんでした。接続を確認してください。', true));
}
function renderTimeline() {
  normalizeSelection();
  const content = $('timeline-content');
  const width = Math.max(1, $('timeline-scroll').clientWidth) * Number($('zoom').value);
  content.style.width = `${width}px`;
  const scroll = $('timeline-scroll'), fits = width <= scroll.clientWidth + 0.5;
  scroll.classList.toggle('scroll-disabled', fits);
  if (fits) scroll.scrollLeft = 0;
  const ruler = $('ruler'); ruler.replaceChildren();
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find(s => s / duration() * width >= 65) || 3600;
  for (let t = 0; t < duration(); t += step) {
    const tick = document.createElement('span'); tick.className = 'tick'; tick.style.left = `${t / duration() * 100}%`; tick.textContent = formatTime(t, step < 1); ruler.append(tick);
  }
  const track = $('text-track'); track.replaceChildren();
  {
    const placed = clipLanes(project.clips);
    const rows = Math.max(1, project.tracks ?? 1, ...placed.map(p => p.lane + 1));
    document.body.classList.toggle('many-tracks', rows >= 3);document.documentElement.style.setProperty('--track-rows',rows);
    track.dataset.rows=rows;const labels=document.querySelector('.text-label');labels.replaceChildren(...Array.from({length:rows},(_,i)=>{const label=document.createElement('span');label.textContent=rows>1?'歌詞 '+(i+1):'歌詞';return label;}));
    track.style.height = `${rows * 50}px`;
    document.querySelector('.text-label').style.height = `${rows * 50}px`;
    for (const { clip, lane } of placed) {
      const bar = document.createElement('div'); bar.className = `clip-bar ${clip.kind === 'title' ? 'title-clip' : ''} ${selectedIds.includes(clip.id) ? 'selected' : ''} ${selectedIds.length > 1 && clip.id === selectedIds[0] ? 'key-object' : ''}`;
      bar.dataset.id = clip.id; bar.style.left = `${clip.start / duration() * 100}%`; bar.style.width = `${(clip.end - clip.start) / duration() * 100}%`; bar.style.top = `${7 + lane * 50}px`;
      bar.tabIndex = 0; bar.setAttribute('role', 'button'); bar.setAttribute('aria-label', `${clip.kind === 'title' ? '曲名' : '歌詞'}: ${clip.text} (${formatTime(clip.start)}–${formatTime(clip.end)})`);
      bar.title = `${clip.text}\n${formatTime(clip.start)} → ${formatTime(clip.end)}${clip.fade ? '\n個別フェード' : ''}`;
      const fade = effectiveFade(clip, project.master);
      for (const side of ['in', 'out']) { const g = document.createElement('span'); g.className = 'fade-glyph ' + side; g.style.width = `${fade[side] / (clip.end - clip.start) * 100}%`; bar.append(g); }
      for (const side of ['left', 'right']) { const handle = document.createElement('span'); handle.className = 'handle ' + side; handle.dataset.mode = side === 'left' ? 'start' : 'end'; bar.append(handle); }
      const name = document.createElement('span'); name.className = 'clip-name'; name.textContent = (clip.kind === 'title' ? '曲名 · ' : '') + clip.text.replace(/\n/g, ' / '); bar.append(name);
      if(selectedId===clip.id) appendCueMarkers(bar,clip);
      bar.addEventListener('pointerdown', startClipDrag);
      bar.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); selectClip(clip.id); $('clip-text').focus(); }
        if (!e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault(); selectedId = clip.id; change(() => { project.clips=editTimeline(project.clips,clip.id,'move',(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?1:1/30),duration()); });
          document.querySelector(`[data-id="${clip.id}"]`)?.focus();
        }
      });
      track.append(bar);
    }
  }
  drawWaveform(); renderTime();
}
function drawWaveform() {
  const canvas = $('waveform'), width = $('timeline-content').clientWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(width * dpr); canvas.height = 76 * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#d1d1d1'; ctx.beginPath(); ctx.moveTo(0, 38); ctx.lineTo(width, 38); ctx.stroke();
  $('wave-empty').hidden = !!peaks;
  if (!peaks) return;
  ctx.fillStyle = '#888888';
  const max = Math.max(0.12, ...peaks);
  for (let x = 0; x < width; x += 3) {
    const from = Math.floor(x / width * peaks.length), to = Math.max(from + 1, Math.ceil((x + 3) / width * peaks.length));
    let peak = 0; for (let i = from; i < Math.min(to, peaks.length); i++) peak = Math.max(peak, peaks[i]);
    const height = Math.max(1, peak / max * 58); ctx.fillRect(x, 38 - height / 2, 2, height);
  }
}
function startClipDrag(event) {
  if (event.button !== 0 || exportController) return;
  event.preventDefault(); stop(); finishInline();
  if (event.shiftKey) { selectClip(event.currentTarget.dataset.id, false, true); return; }
  const element = event.currentTarget, id = element.dataset.id, originals = structuredClone(project.clips);
  selectedId = id; selectedIds = [id]; element.focus({ preventScroll: true }); renderInspector(); renderPreview();
  const initialX = event.clientX, initialY = event.clientY, width = $('timeline-content').clientWidth, initialScroll = $('timeline-scroll').scrollLeft;
  const mode = event.target.dataset.mode || 'move';
  let moved = false, dragError = '', lastPoint = event;
  element.setPointerCapture(event.pointerId);
  element.classList.add('selected');
  const move = e => {
    lastPoint = {clientX:e.clientX,clientY:e.clientY,ctrlKey:e.ctrlKey};
    const dx = e.clientX - initialX + $('timeline-scroll').scrollLeft - initialScroll;
    if (!moved && Math.abs(dx) < 3 && (mode !== 'move' || Math.abs(e.clientY-initialY) < 3)) return;
    const track = clamp(Math.floor((e.clientY-$('text-track').getBoundingClientRect().top)/50),0,(project.tracks??1)-1);
    let next;
    try {
      next=editTimeline(originals,id,mode,dx/width*duration(),duration(),{stretchCues:e.ctrlKey,track});
      dragError='';element.classList.remove('drop-blocked');
    } catch (error) {
      dragError=error.message;element.classList.add('drop-blocked');return;
    }
    if (!moved) { checkpoint(); moved = true; }
    project.clips=next;
    for(const bar of $('text-track').querySelectorAll('.clip-bar')) {
      const other=project.clips.find(c=>c.id===bar.dataset.id);bar.hidden=!other;
      if(!other)continue;
      bar.style.left=`${other.start/duration()*100}%`;bar.style.width=`${(other.end-other.start)/duration()*100}%`;bar.style.top=`${7+(other.track??0)*50}px`;
      const fade=effectiveFade(other,project.master);
      for(const side of ['in','out'])bar.querySelector('.fade-glyph.'+side).style.width=`${fade[side]/(other.end-other.start)*100}%`;
      for(const marker of bar.querySelectorAll('.cue-marker'))marker.remove();
      if(other.id===selectedId)appendCueMarkers(bar,other);
    }
    element.classList.add('dragging'); renderInspector(); renderPreview();
  };
  const modifier = e => {if(e.key==='Control'&&moved&&mode!=='move')move({...lastPoint,ctrlKey:e.type==='keydown'});};
  const finish = e => {
    if(e.type==='pointerup'&&moved)move(e);
    element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', finish); element.removeEventListener('pointercancel', finish);
    window.removeEventListener('keydown',modifier);window.removeEventListener('keyup',modifier);
    if (moved) changed(); selectClip(id, true);
    if(dragError)message(dragError,true);
    document.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  };
  element.addEventListener('pointermove', move); element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish);
  window.addEventListener('keydown',modifier);window.addEventListener('keyup',modifier);
}
async function computePeaks(decoded) {
  const count = Math.min(12000, decoded.length), data = new Float32Array(count);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  for (let p = 0; p < count; p++) {
    const start = Math.floor(p * decoded.length / count), end = Math.floor((p + 1) * decoded.length / count);
    let peak = 0;
    for (let i = start; i < end; i++) for (const c of channels) peak = Math.max(peak, Math.abs(c[i]));
    data[p] = peak;
    if (p % 800 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return data;
}
async function loadAudio(file) {
  if (!file || loading) return;
  if (file.size > 1024 * 1024 * 1024) return message('この版では1GB以下の音声ファイルを選択してください。', true);
  const generation = ++loadGeneration; loading = true; stop(); updateButtons();
  document.body.classList.add('busy'); $('audio-details').textContent = '音源と波形を読み込み中…';
  let context;
  try {
    context = new AudioContext({ sampleRate: 48000 });
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration < MIN_LENGTH || decoded.duration > 21600) throw new Error('0.04秒以上、6時間以内の音源を選択してください。');
    if (decoded.numberOfChannels > 2) throw new Error('モノラルまたはステレオの音源を選択してください。');
    if (generation !== loadGeneration) return;
    const exceeds = project.clips.some(c => c.end > decoded.duration);
    if (exceeds && !window.confirm('この音源は配置済みの歌詞より短いため、曲の範囲外のテキストを短縮または削除します。音源を変更しますか？')) return;
    const nextPeaks = await computePeaks(decoded);
    if (generation !== loadGeneration) return;
    const expected = project.audio;
    const reattached = !buffer && expected && file.name === expected.name && file.size === expected.size && Math.abs(decoded.duration - expected.duration) < 0.05;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    buffer = decoded; peaks = nextPeaks; sourceUrl = URL.createObjectURL(file); audio.src = sourceUrl;
    project.audio = { name: file.name, size: file.size, duration: decoded.duration };
    project.clips = project.clips.filter(c => c.start <= decoded.duration - MIN_LENGTH).map(c => ({ ...c, end: Math.min(c.end, decoded.duration) }));
    if (!selected()) selectedId = null;
    // History belongs to a specific audio timeline; do not restore metadata for an old source.
    undoStack = []; redoStack = []; seek(0); changed(); renderInspector();
    $('audio-name').textContent = file.name;
    message(reattached ? '音源を再接続しました。編集を続けられます。' : expected && !reattached ? '音源を変更しました。歌詞のタイミングを確認してください。' : '音源を読み込みました。歌詞を配置しましょう。');
  } catch (error) { message(error.name === 'EncodingError' ? 'この音源を読み込めません。WAVやMP3でお試しください。' : error.message, true); }
  finally {
    await context?.close().catch(() => {}); loading = false; document.body.classList.remove('busy'); updateButtons();
    $('audio-details').textContent = buffer ? `${formatTime(buffer.duration)} · ${buffer.numberOfChannels === 1 ? 'モノラル' : 'ステレオ'} · ローカル音源` : project.audio ? '保存時の音源を選び直してください' : '音源を端末から読み込みます';
  }
}
function openBulk() {
  if (!buffer) return;
  stop(); $('bulk-title').value = project.title; $('bulk-lyrics').value = project.clips.filter(c => c.kind === 'lyric').sort((a,b) => a.start-b.start).map(c => c.text).join('\n\n');
  $('bulk-start').value = project.title ? Math.min(3, Math.floor(duration() * 100) / 1000) : 0; $('bulk-end').value = Math.floor(duration() * 1000) / 1000; $('bulk-end').max = duration();
  $('bulk-existing').hidden = project.clips.length === 0; $('bulk-dialog').showModal();
}
function openAdd(at = time) {
  if (!buffer) return;
  stop(); const lastStart = Math.floor((duration() - MIN_LENGTH) * 1000) / 1000;
  $('add-start').value = round(clamp(at, 0, lastStart)); $('add-start').max = lastStart;
  $('add-content').value = ''; $('add-dialog').showModal(); $('add-content').focus();
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const safeName = text => (text || '無題').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
function saveProject() {
  download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), safeName(project.title) + '.tomei.json');
  savedSnapshot = JSON.stringify(project); dirty = false; $('save-state').textContent = '保存済み';
  message('編集データを保存しました。再開時は元の音源も選択してください。');
}
async function applyProject(next) {
  stop(); ++loadGeneration;
  finishInline(); selectedIds = [];
  project = next; selectedId = null; buffer = null; peaks = null; time = 0; undoStack = []; redoStack = [];
  audio.removeAttribute('src'); audio.load(); if (sourceUrl) URL.revokeObjectURL(sourceUrl); sourceUrl = '';
  savedSnapshot = JSON.stringify(project); dirty = false;
  $('audio-name').textContent = project.audio?.name || '曲ファイルが未選択です'; $('audio-details').textContent = project.audio ? '保存時の音源を選び直してください' : '音源を端末から読み込みます';
  for(const clip of project.clips) for(const r of clip.styles??[]) if(r.style.font&&!availableFonts.has(r.style.font))r.style.font='noto-sans';
  for (const clip of project.clips) if (!availableFonts.has(clip.font)) { clip.font = 'noto-sans'; message('この端末にないフォントをNoto Sans JPに置き換えました。', true); }
  changed(); renderMaster(); renderInspector(); await loadProjectFonts(project); renderPreview();
}
function deleteSelected() {
  if (!selected()) return;
  change(() => { const ids = new Set(selectedIds); project.clips = project.clips.filter(c => !ids.has(c.id)); selectedId = null; selectedIds = []; });
}
async function initFonts() {
  for (const [id, f] of Object.entries(FONT_FAMILIES)) {
    if (!f.bundled) {
      const weights = await loadLocalFont(f);
      if (!weights.length) continue;
      availableFonts.add(id); availableFontWeights.set(id, weights);
    }
    const option = document.createElement('option'); option.value = id; option.textContent = f.label; $('clip-font').append(option);
  }
}
function timeAt(event) { const rect = $('timeline-content').getBoundingClientRect(); return clamp((event.clientX - rect.left) / rect.width * duration(), 0, duration()); }

for (const id of ['choose-audio', 'choose-audio-main']) $(id).onclick = () => $('audio-input').click();
$('audio-input').onchange = e => { loadAudio(e.target.files[0]); e.target.value = ''; };
for (const id of ['bulk-open', 'bulk-empty']) $(id).onclick = openBulk;
$('bulk-title').addEventListener('input', () => {
  if ($('bulk-title').value.trim() && Number($('bulk-start').value) === 0) $('bulk-start').value = Math.min(3, Math.floor(duration() * 100) / 1000);
});
$('bulk-form').onsubmit = e => {
  e.preventDefault();
  try {
    const start = Number($('bulk-start').value), end = Number($('bulk-end').value), title = $('bulk-title').value.trim();
    if (end > duration() + 0.002) throw new Error('配置終了は曲の長さ以内にしてください。');
    if (title && start < MIN_LENGTH) throw new Error(`曲名を入れる場合は、歌詞の配置開始を${MIN_LENGTH}秒以降にしてください。`);
    const clips = distribute($('bulk-lyrics').value, start, Math.min(end, duration()));
    if (clips.length + (title ? 1 : 0) > 2000) throw new Error('曲名とセンテンスは合計2000個までにしてください。');
    if (title) clips.unshift(makeClip(title, 0, Math.max(MIN_LENGTH, Math.min(start > 0 ? start : 3, duration())), 'title'));
    change(() => { project.title = title; project.clips = clips; selectedId = clips[0].id; });
    $('bulk-dialog').close(); selectClip(selectedId); message('均等に配置しました。バーを動かしてタイミングを合わせられます。');
  } catch (error) { message(error.message, true); }
};
$('add-text').onclick = () => {addTrackIndex=selected()?.track??0;openAdd();};
let addTrackIndex=0;
const addCursor = $('add-cursor');
function hideAddCursor() { addCursor.hidden = true; }
{
  const area = $('wave-area');
  let startedOnEmpty = false;
  area.onclick = e => { if (!startedOnEmpty || !buffer) return; hideAddCursor();addTrackIndex=0; seek(timeAt(e)); openAdd(time); };
  area.addEventListener('pointermove', e => {
    const active = !!buffer && !loading && !e.buttons && !e.target.closest('.clip-bar') && !document.querySelector('dialog[open]');
    area.classList.toggle('can-add', active); addCursor.hidden = !active;
    if (active) {
      addCursor.style.left = e.clientX + 'px'; addCursor.style.top = e.clientY + 'px';
      const tooltipX = clamp(e.clientX, 66, innerWidth - 66) - e.clientX;
      addCursor.style.setProperty('--tooltip-x', tooltipX + 'px');
    }
  });
  area.addEventListener('pointerleave', hideAddCursor);
  area.addEventListener('pointerdown', e => { startedOnEmpty = !e.target.closest('.clip-bar'); hideAddCursor(); });
}
$('timeline-scroll').addEventListener('scroll', hideAddCursor);
window.addEventListener('blur', hideAddCursor);
$('ruler').onpointerdown = e => {
  if (e.button !== 0) return;
  e.preventDefault(); stop(); hideAddCursor(); const ruler = e.currentTarget;
  // preventDefault keeps pointer scrubbing smooth but also cancels native focus transfer.
  // Move focus explicitly so pending field edits commit and Space controls playback.
  ruler.focus({ preventScroll: true });
  ruler.setPointerCapture(e.pointerId); seek(timeAt(e));
  const move = event => seek(timeAt(event));
  const end = () => { ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', end); ruler.removeEventListener('pointercancel', end); };
  ruler.addEventListener('pointermove', move); ruler.addEventListener('pointerup', end); ruler.addEventListener('pointercancel', end);
};
$('add-form').onsubmit = e => {
  e.preventDefault(); const text = $('add-content').value.trim(); if (!text) return message('テキストを入力してください。', true);
  if (project.clips.length >= 2000) return message('テキストは2000個までにしてください。', true);
  const start = clamp(Number($('add-start').value), 0, duration() - MIN_LENGTH), kind = $('add-kind').value;
  const clip = makeClip(text, start, Math.min(start + 3, duration()), kind);clip.track=addTrackIndex;
  let inserted;try{inserted=insertClips(project.clips,[clip],duration());}catch(error){return message(error.message,true);}
  change(() => { project.clips=inserted; selectedId = clip.id; if (kind === 'title' && !project.title) project.title = text; });
  $('add-dialog').close(); selectClip(clip.id);
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
$('open-help').onclick = () => { finishInline(); stop(); hideAddCursor(); $('help-dialog').showModal(); };
$('clip-form').onsubmit = e => e.preventDefault();
$('clip-text').addEventListener('focus', () => { if (selected()) checkpoint(); });
$('clip-text').oninput = () => { const c = selected(); if (!c) return; replaceClipText(c, $('clip-text').value); if (c.kind === 'title') project.title = c.text; changed(); loadProjectFonts({ clips: [c] }).then(renderPreview).catch(() => {}); };
for (const [name, key, min, max] of [['start', 'start', 0, 21600], ['end', 'end', MIN_LENGTH, 21600], ['line-height', 'lineHeight', 0.5, 4], ['x', 'x', 0, 100], ['y', 'y', 0, 100]]) {
  $('clip-' + name).onchange = () => {
    const c = selected(); if (!c) return;
    let value = Number($('clip-' + name).value); if (!Number.isFinite(value)) return renderInspector();
    value = clamp(value, min, max);
    if (key === 'start') value = Math.min(value, c.end - MIN_LENGTH);
    if (key === 'end') value = clamp(value, c.start + MIN_LENGTH, duration());
    if(key==='start'||key==='end') change(()=>{project.clips=editTimeline(project.clips,c.id,key,value-c[key],duration());});
    else change(() => c[key] = round(value));
  };
}
$('alignment').onclick = e => { if (!e.target.dataset.align || !selected()) return; change(() => selected().align = e.target.dataset.align); };
$('center-text').onclick = () => change(() => { selected().x = 50; selected().y = 50; });
$('use-master').onchange = () => { const enabled = $('use-master').checked; change(() => selected().fade = enabled ? null : { ...project.master }); };
for (const side of ['in', 'out']) {
  $('clip-fade-' + side).onchange = () => {
    const clip = selected(); if (!clip) return;
    const value = clamp(Number($('clip-fade-' + side).value) || 0, 0, 60);
    change(() => (clip.fade ?? project.master)[side] = value);
    renderMaster();
  };
  $('master-' + side).onchange = () => { const value = clamp(Number($('master-' + side).value) || 0, 0, 60); change(() => project.master[side] = value); renderMaster(); };
}
$('selection-outline').onpointerdown = startPreviewDrag;
preview.onpointerdown = e => {
  if (e.button !== 0 || exportController) return;
  finishInline(); const clip = hitPreview(e);
  if (clip) { selectClip(clip.id, false, e.shiftKey); if (!e.shiftKey) startPreviewDrag(e); }
  else { selectClip(null, false); }
};
$('preview-frame').ondblclick = e => {
  if (e.target.closest('#inline-editor') || e.target.closest('.resize-handle')) return;
  const clip = hitPreview(e); if (clip) beginInline(clip.id);
};
$('delete-clip').onclick = deleteSelected;
$('play').onclick = togglePlay; $('to-start').onclick = () => { stop(); seek(0); };
audio.onended = () => { stop(); time = duration(); renderTime(); renderPreview(); };
audio.onseeked = () => { time = audio.currentTime; renderTime(); renderPreview(); };
$('volume').oninput = () => audio.volume = Number($('volume').value); audio.volume = 0.8;
$('undo').onclick = () => undo(); $('redo').onclick = () => undo(true);
function zoomTimeline(value, anchor = time, screenX = $('timeline-scroll').clientWidth / 2) {
  const scroll = $('timeline-scroll');
  $('zoom').value = clamp(value, 1, 8); renderTimeline();
  scroll.scrollLeft = anchor / duration() * $('timeline-content').clientWidth - screenX;
  hideAddCursor();
}
$('zoom').oninput = () => zoomTimeline(Number($('zoom').value));
$('timeline-scroll').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!e.deltaY) return;
  const rect = $('timeline-scroll').getBoundingClientRect();
  zoomTimeline(Number($('zoom').value) + (e.deltaY < 0 ? 0.25 : -0.25), timeAt(e), e.clientX - rect.left);
}, { passive: false });
function renderGrid() {
  $('preview-grid').hidden = !$('show-grid').checked;
  const step=Number($('grid-step').value);$('preview-grid').style.backgroundSize=`${step/1920*100}% ${step/1080*100}%`;
}
$('show-grid').onchange = renderGrid;
$('grid-step').onchange = renderGrid;
renderGrid();
$('save-project').onclick = saveProject;
$('open-project').onclick = () => { if (loading) return; $('project-input').click(); };
$('project-input').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    if (file.size > 10_000_000) throw new Error('プロジェクトファイルが大きすぎます。');
    const next = validateProject(JSON.parse(await file.text()));
    if (dirty && !window.confirm('現在の編集を閉じてプロジェクトを開きますか？必要な場合は先に保存してください。')) return;
    await applyProject(next); message('プロジェクトを開きました。元の音源を選択すると再生・書き出しできます。');
  } catch (error) { message(error instanceof SyntaxError ? 'JSON形式のプロジェクトを選択してください。' : error.message, true); }
};
document.addEventListener('keydown', e => {
  const editing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  if (document.querySelector('dialog[open]') || editing || exportController) return;
  if (e.target.closest?.('#selection-outline') && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) && !e.altKey) { e.preventDefault();const amount=e.shiftKey?10:1;change(()=>{for(const c of selectionClips()){c.x=round(clamp(c.x+(e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0)/19.2,0,100));c.y=round(clamp(c.y+(e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0)/10.8,0,100));}});return;}
  if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key) && selected()) { e.preventDefault(); change(() => { for (const c of selectionClips()) applyTextStyle(c,{letterSpacing:round(clamp(Math.max(...styleValues(c,'letterSpacing'),c.letterSpacing) + (e.key === 'ArrowRight' ? 1 : -1), -5, 100))}); }); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  if (e.key === 'Escape') { selectedId = null; selectedIds = []; renderInspector(); renderTimeline(); renderPreview(); }
});
window.addEventListener('beforeunload', e => { if (dirty || exportController) { e.preventDefault(); e.returnValue = ''; } });
document.fonts.addEventListener('loadingdone', renderPreview);
new ResizeObserver(renderTimeline).observe($('timeline-scroll'));
new ResizeObserver(renderPreview).observe($('preview-frame'));
window.addEventListener('resize', renderPreview);

$('export-button').onclick = async () => {
  stop(); $('export-dialog').showModal(); $('export-start').hidden = false; $('export-download').hidden = true; $('export-progress-wrap').hidden = true; $('export-cancel').textContent = '閉じる';
  $('export-start').disabled = true;
  try {
    await loadProjectFonts(project);
    const overflow = checkBounds(project), warning = [];
    if (overflow.length) warning.push(`${overflow.length}個のテキストが画面からはみ出しています。位置やサイズを確認してください。`);
    const overlap = clipLanes(project.clips).some(p => p.lane > 0);
    if (overlap) warning.push('同時に表示されるテキストがあります。プレビューで重なりを確認してください。');
    if (project.clips.some(c => !c.text.trim())) warning.push('空のテキストがあります。');
    $('export-warnings').textContent = warning.join('\n'); $('export-warnings').hidden = !warning.length;
    $('export-start').disabled = false;
  } catch { $('export-warnings').hidden = false; $('export-warnings').textContent = 'フォントを読み込めませんでした。接続を確認してから再度お試しください。'; }
};
$('export-start').onclick = async () => {
  if (!buffer || exportController) return;
  exportController = new AbortController(); const controller = exportController;
  $('export-start').disabled = true; $('export-close').disabled = true; $('export-progress-wrap').hidden = false; $('export-cancel').textContent = '中止する'; $('export-progress').value = 0; $('export-status').textContent = '書き出しを準備しています…';
  renderPreview();
  try {
    exportModule ??= await import('./vendor/exporter.js');
    const blob = await exportModule.exportVideo(snapshot(), buffer, { signal: controller.signal, onProgress: value => { $('export-progress').value = value; $('export-status').textContent = value >= 99 ? '動画を仕上げています…' : `${Math.floor(value)}% · 動画を作成しています`; } });
    if (exportUrl) URL.revokeObjectURL(exportUrl); exportUrl = URL.createObjectURL(blob);
    $('export-download').href = exportUrl; $('export-download').download = safeName(project.title) + '.mp4'; $('export-download').hidden = false; $('export-start').hidden = true;
    $('export-status').textContent = `完成しました · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  } catch (error) { $('export-status').textContent = error.name === 'AbortError' ? '書き出しを中止しました。' : error.message; }
  finally { exportController = null; $('export-start').disabled = false; $('export-close').disabled = false; $('export-cancel').textContent = '閉じる'; renderPreview(); }
};
$('export-cancel').onclick = () => exportController ? exportController.abort() : $('export-dialog').close();
$('export-dialog').addEventListener('cancel', e => { if (exportController) { e.preventDefault(); exportController.abort(); } });

function normalizeSelection() {
  const valid = new Set(project.clips.map(c => c.id));
  selectedIds = selectedIds.filter(id => valid.has(id));
  if (!selectedId || !valid.has(selectedId)) { selectedId = selectedIds.at(-1) ?? null; }
  if (selectedId && !selectedIds.includes(selectedId)) selectedIds = [selectedId];
}
function selectionClips() { return selectedIds.map(id => project.clips.find(c => c.id === id)).filter(Boolean); }
function renderSelectionActions() {
  $('multi-align').hidden = selectedIds.length < 2;
  const key = selectionClips()[0];
  $('selection-summary').textContent = `${selectedIds.length}個選択 · 基準: ${key?.text.split('\n')[0].slice(0, 24) ?? ''}`;
  $('delete-clip').textContent = selectedIds.length > 1 ? `選択した${selectedIds.length}個を削除` : 'このテキストを削除';
}
function positionOutline(element, clip) {
  const b = measureClip(preview.getContext('2d'), clip);
  Object.assign(element.style, { left: `${b.left / 19.2}%`, top: `${b.top / 10.8}%`, width: `${b.width / 19.2}%`, height: `${b.height / 10.8}%` });
}
function renderSelectionExtras() {
  const container = $('other-outlines'); container.replaceChildren();
  $('selection-outline').classList.toggle('key-object', selectedIds.length > 1 && selectedId === selectedIds[0]);
  if (!audio.paused || exportController || inlineId) return;
  for (const c of selectionClips()) {
    if (c.id === selectedId || time < c.start || time >= c.end) continue;
    const outline = document.createElement('div'); outline.className = 'other-outline' + (c.id === selectedIds[0] ? ' key-object' : '');
    positionOutline(outline, c); container.append(outline);
  }
}
function hitPreview(e) {
  const r = preview.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 1920, y = (e.clientY - r.top) / r.height * 1080;
  return [...project.clips].reverse().find(c => {
    if (time < c.start || time >= c.end) return false;
    const b = measureClip(preview.getContext('2d'), c);
    return x >= b.left - 5 && x <= b.left + Math.max(b.width, 20) + 5 && y >= b.top && y <= b.top + b.height;
  });
}
function startPreviewDrag(e) {
  if (e.button !== 0 || !selected() || exportController || inlineId) return;
  e.preventDefault(); stop();
  const element = $('selection-outline'), rect = preview.getBoundingClientRect(), c = selected(), original = { ...c };
  const box = measureClip(preview.getContext('2d'), c), corner = e.target.dataset.corner;
  const signX = corner?.includes('w') ? -1 : 1, signY = corner?.includes('n') ? -1 : 1;
  const fixedX = box.left + (signX < 0 ? box.width : 0), fixedY = box.top + (signY < 0 ? box.height : 0);
  const x = e.clientX, y = e.clientY;
  let moved = false;
  element.focus({ preventScroll: true }); element.setPointerCapture(e.pointerId);
  const move = ev => {
    const dx = (ev.clientX - x) / rect.width * 1920, dy = (ev.clientY - y) / rect.height * 1080;
    if (!moved && Math.hypot(ev.clientX - x, ev.clientY - y) < 3) return;
    if (!moved) { checkpoint(); moved = true; }
    if (corner) {
      const scale = 1 + (dx * signX * box.width + dy * signY * box.height) / Math.max(1, box.width ** 2 + box.height ** 2);
      c.size = round(clamp(original.size * scale, 16, 240));
      c.styles=(original.styles??[]).map(r=>({...r,style:{...r.style,...(r.style.size?{size:round(clamp(r.style.size*scale,16,240))}:{})}}));
      const resized = measureClip(preview.getContext('2d'), c);
      c.x = round(clamp((fixedX + signX * resized.width / 2) / 19.2, 0, 100));
      c.y = round(clamp((fixedY + signY * resized.height / 2) / 10.8, 0, 100));
    } else {
      c.x = round(clamp(original.x + dx / 19.2, 0, 100)); c.y = round(clamp(original.y + dy / 10.8, 0, 100));
      if ($('snap-grid').checked) { const step = Number($('grid-step').value); c.x=round(clamp(Math.round(c.x*19.2/step)*step/19.2,0,100));c.y=round(clamp(Math.round(c.y*10.8/step)*step/10.8,0,100)); }
    }
    renderPreview(); renderInspector();
  };
  const end = () => {
    element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end);
    if (moved) changed();
  };
  element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end);
}
$('multi-align').onclick = e => {
  const mode = e.target.dataset.objectAlign, clips = selectionClips();
  if (!mode || clips.length < 2) return;
  if (mode === 'size') {
    const size = clips[0].size;
    if (clips.slice(1).some(c => c.size !== size || styleValues(c,'size').some(v=>v!==size))) change(() => { for (const c of clips.slice(1)) applyTextStyle(c,{size}); });
    return;
  }
  const ctx = preview.getContext('2d'), key = clips[0], ref = measureClip(ctx, key);
  const updates = clips.slice(1).map(c => {
    const b = measureClip(ctx, c);
    const x = mode === 'left' ? (ref.left + b.width / 2) / 19.2 : mode === 'right' ? (ref.left + ref.width - b.width / 2) / 19.2 : mode === 'center' ? key.x : c.x;
    const y = mode === 'top' ? (ref.top + b.height / 2) / 10.8 : mode === 'bottom' ? (ref.top + ref.height - b.height / 2) / 10.8 : mode === 'middle' ? key.y : c.y;
    return { c, x, y };
  });
  if (updates.some(u => u.x < 0 || u.x > 100 || u.y < 0 || u.y > 100)) return message('整列すると表示位置が画面外になります。基準のブロックを内側に移動してください。', true);
  change(() => { for (const { c, x, y } of updates) { c.x = round(x); c.y = round(y); } });
};

// Native clipboard events keep normal text copy/paste intact inside editing fields.
const clipboardType = 'lyric-video-editor/blocks';
function serializeBlocks() {
  finishInline(); const clips = selectionClips();
  if (!clips.length) return null;
  return JSON.stringify({ type: clipboardType, clips: structuredClone(clips) });
}
function pasteBlocks(raw) {
  if (!project.audio || loading || exportController) return message('先に音源を選択してください。');
  try {
    const data = JSON.parse(raw);
    if (data.type !== clipboardType || !Array.isArray(data.clips)) throw new Error('このエディタでコピーしたブロックを貼り付けてください。');
    const checked = validateProject({ ...emptyProject(), clips: data.clips }).clips;
    if (!checked.length) return;
    if (project.clips.length + checked.length > 2000) throw new Error('テキストは2000個までです。');
    const copies = duplicateClips(checked, time, duration());
    const inserted=insertClips(project.clips,copies,duration());
    change(() => { project.clips=inserted;project.tracks=Math.max(project.tracks??1,...copies.map(c=>(c.track??0)+1)); selectedIds = copies.map(c => c.id); selectedId = copies[0].id; });
    selectClip(selectedId, true, false, true); $('selection-outline').focus({ preventScroll: true });
    message(`${copies.length}個のブロックを貼り付けました。`);
  } catch (e) { message(e.message && !(e instanceof SyntaxError) ? e.message : 'このエディタでコピーしたブロックを貼り付けてください。', true); }
}
const isTextInput = target => /INPUT|TEXTAREA|SELECT/.test(target?.tagName) || target?.isContentEditable;
document.addEventListener('copy', e => {
  if (isTextInput(e.target) || document.querySelector('dialog[open]') || !selectedIds.length) return;
  const data = serializeBlocks(); if (!data) return;
  e.preventDefault(); e.clipboardData.setData('text/plain', data); message(`${selectedIds.length}個のブロックをコピーしました。`);
});
document.addEventListener('paste', e => {
  if (isTextInput(e.target) || document.querySelector('dialog[open]')) return;
  const raw = e.clipboardData.getData('text/plain');
  if (!raw.includes(clipboardType)) return;
  e.preventDefault(); pasteBlocks(raw);
});

const inlineEditor = $('inline-editor');
function inlineSelection() {
  const s = window.getSelection();
  if (!s?.rangeCount || !inlineEditor.contains(s.anchorNode) || !inlineEditor.contains(s.focusNode)) return { start: 0, end: 0 };
  const range = s.getRangeAt(0), before = range.cloneRange(); before.selectNodeContents(inlineEditor); before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}
function restoreInlineSelection(start, end = start) {
  const walker = document.createTreeWalker(inlineEditor, NodeFilter.SHOW_TEXT); const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  if (!nodes.length) { inlineEditor.append(document.createTextNode('')); nodes.push(inlineEditor.firstChild); }
  const locate = offset => { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } return [nodes.at(-1), nodes.at(-1).length]; };
  const range = document.createRange(); range.setStart(...locate(start)); range.setEnd(...locate(end));
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
}
function populateInline(selection = null) {
  const c = project.clips.find(c => c.id === inlineId); if (!c) return;
  inlineEditor.replaceChildren();
  if(advancedText(c)) {
    for(const g of graphemes(c.text)) {
      if(g.text==='\n'){inlineEditor.append(document.createTextNode('\n'));continue;}
      const st=styleAt(c,g.start),span=document.createElement('span');span.textContent=g.text;
      Object.assign(span.style,{fontFamily:'"'+FONT_FAMILIES[st.font].family+'"',fontSize:st.size+'px',fontWeight:st.weight,letterSpacing:st.letterSpacing+'px',display:'inline-block',verticalAlign:st.baselineShift+'px',transform:'rotate('+st.rotation+'deg)',marginInlineStart:((c.kerning??[]).find(k=>k.at===g.start)?.value??0)+'px'});
      inlineEditor.append(span);
    }
    if(!c.text||c.text.endsWith('\n'))inlineEditor.append(document.createElement('br'));
    if(selection)restoreInlineSelection(selection.start,selection.end);return;
  }
  let from = 0;
  for (const k of [...(c.kerning ?? [])].sort((a,b) => a.at - b.at)) {
    const span = document.createElement('span'); span.textContent = c.text.slice(from, k.at); span.style.marginRight = k.value + 'px'; inlineEditor.append(span); from = k.at;
  }
  inlineEditor.append(document.createTextNode(c.text.slice(from)));
  // A terminal newline needs an empty visual line for the browser to keep its caret there.
  if (!c.text || c.text.endsWith('\n')) inlineEditor.append(document.createElement('br'));
  if (selection) restoreInlineSelection(selection.start, selection.end);
}
function styleInline() {
  const c = project.clips.find(c => c.id === inlineId); if (!c) return;
  const box = measureClip(preview.getContext('2d'), c), scale = preview.clientWidth / 1920;
  Object.assign(inlineEditor.style, {
    left: `${box.left / 19.2}%`, top: `${box.top / 10.8}%`, width: `${Math.max(c.size, box.width)}px`, minHeight: `${box.height}px`,height:c.writingMode==='vertical'?box.height+'px':'auto',writingMode:c.writingMode==='vertical'?'vertical-rl':'horizontal-tb',textOrientation:'mixed',
    fontFamily: `"${FONT_FAMILIES[c.font].family}"`, fontSize: `${c.size}px`, fontWeight: String(c.weight),
    lineHeight: String(c.lineHeight), letterSpacing: `${c.letterSpacing}px`, textAlign: c.align, transform: `scale(${scale})`,
  });
}
function beginInline(id) {
  if (!id || exportController) return;
  stop(); selectClip(id, false); inlineId = id; inlineEditor.hidden = false;
  populateInline(); renderPreview(); inlineEditor.focus({ preventScroll: true });
  restoreInlineSelection(selected().text.length);
}
function finishInline() {
  if (!inlineId) return;
  if (composing) syncInline();
  inlineId = null; formatRange=null;composing = false; inlineEditor.hidden = true; renderPreview();renderInspector();
}
function syncInline() {
  const c = project.clips.find(c => c.id === inlineId); if (!c) return;
  const selection = inlineSelection(), text = inlineEditor.textContent.replace(/\r\n?/g, '\n').slice(0, 20000);
  if (text !== c.text) {
    checkpoint(); replaceClipText(c, text); if (c.kind === 'title') project.title = text;
    changed(); renderInspector(); loadProjectFonts({ clips: [c] }).then(renderPreview).catch(() => {});
  }
  populateInline(selection); styleInline();
}
function insertInlineText(text) {
  const s = window.getSelection(); if (!s.rangeCount) return;
  const range = s.getRangeAt(0); range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node);
  range.setStartAfter(node); range.collapse(true); s.removeAllRanges(); s.addRange(range); syncInline();
}
inlineEditor.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); insertInlineText('\n'); }
});
inlineEditor.addEventListener('input', e => { if (!composing && !e.isComposing) syncInline(); });
inlineEditor.addEventListener('compositionstart', () => composing = true);
inlineEditor.addEventListener('compositionend', () => { composing = false; syncInline(); });
inlineEditor.addEventListener('paste', e => { e.preventDefault(); insertInlineText(e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')); });
inlineEditor.addEventListener('blur', e => { if (!e.relatedTarget?.closest('.inspector') && !e.relatedTarget?.closest('#cues-dialog')) finishInline(); });
inlineEditor.addEventListener('keydown', e => {
  if (composing || e.isComposing) return;
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); finishInline(); $('selection-outline').focus({ preventScroll: true }); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); const caret = inlineSelection(); undo(e.shiftKey); populateInline(caret); styleInline(); return;
  }
  if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation(); const c = selected(), selection = inlineSelection(), boundaries = textBoundaries(c.text);
    const positions = boundaries.filter(at => selection.start === selection.end ? at === selection.start : at > selection.start && at < selection.end);
    if (!positions.length) return;
    change(() => {
      const values = new Map((c.kerning ?? []).map(k => [k.at, k.value]));
      for (const at of positions) values.set(at, round(clamp((values.get(at) ?? 0) + (e.key === 'ArrowRight' ? 1 : -1), -100, 100)));
      c.kerning = [...values].filter(([, value]) => value !== 0).map(([at, value]) => ({ at, value }));
    });
    populateInline(selection); styleInline();
  }
});

const textControls = {font:'clip-font',size:'clip-size',weight:'clip-weight',letterSpacing:'clip-letter-spacing',baselineShift:'clip-baseline-shift',rotation:'clip-rotation'};
function activeFormatRange() { return inlineId === selectedId && formatRange && formatRange.end > formatRange.start ? formatRange : null; }
function renderTextSettings(c) {
  const range=activeFormatRange();
  const fonts=styleValues(c,'font',range),allowed=fonts.length?fonts:[c.font];
  const weights=[400,700].filter(weight=>allowed.every(font=>(availableFontWeights.get(font)??fontWeights(font)).includes(weight)));
  const mixedOption=new Option('','');mixedOption.hidden=true;
  $('clip-weight').replaceChildren(mixedOption,...weights.map(weight=>new Option(weight===400?'標準':'太字',String(weight))));
  $('format-scope').textContent=range?'選択した文字に適用':'ブロック全体に適用';
  for(const [key,id] of Object.entries(textControls)) {
    const values=styleValues(c,key,range),el=$(id),mixed=values.length>1;
    el.value=mixed?'':(values[0]??c[key]??0);el.dataset.mixed=String(mixed);
    el.dataset.maximum=String(Math.max(...(values.length?values:[c[key]??0]).filter(v=>typeof v==='number')));
    el.title=mixed?'書式が混在しています。上下操作は最大値を基準に統一します。':'';
  }
}
function setCharacterStyle(key,value) {
  const c=selected();if(!c)return;const range=activeFormatRange();
  change(()=>applyTextStyle(c,{[key]:value},range));
  if(inlineId){const active=document.activeElement;populateInline(range);styleInline();if(active!==inlineEditor)active.focus({preventScroll:true});}
  loadProjectFonts({clips:[c]}).then(renderPreview).catch(()=>message('フォントを読み込めませんでした。',true));
}
for(const [key,id] of Object.entries(textControls)) {
  const el=$(id);
  el.onchange=()=>{if(el.value==='')return;const value=key==='font'?el.value:clamp(Number(el.value),Number(el.min||0),Number(el.max||700));if(key!=='font'&&!Number.isFinite(value))return;setCharacterStyle(key,value);};
  const stepMixed=direction=>{const value=clamp(Number(el.dataset.maximum)+direction*Number(el.step||1),Number(el.min),Number(el.max));setCharacterStyle(key,round(value));};
  if(el.type==='number') {
    el.addEventListener('keydown',e=>{if(el.value===''&&el.dataset.mixed==='true'&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();stepMixed(e.key==='ArrowUp'?1:-1);}});
    el.addEventListener('pointerdown',e=>{const r=el.getBoundingClientRect();if(el.value===''&&el.dataset.mixed==='true'&&e.clientX>r.right-19){e.preventDefault();el.focus({preventScroll:true});stepMixed(e.clientY<r.top+r.height/2?1:-1);}});
  }
}
document.addEventListener('selectionchange',()=>{
  if(!inlineId||composing)return;const selection=getSelection();
  if(!inlineEditor.contains(selection?.anchorNode)||!inlineEditor.contains(selection?.focusNode))return;
  const next=inlineSelection();formatRange=next.end>next.start?next:null;
  if(selected())renderTextSettings(selected());
});
document.addEventListener('pointerdown',e=>{if(inlineId&&!e.target.closest('#inline-editor,.inspector,#cues-dialog'))finishInline();},true);
$('clip-writing-mode').onchange=()=>{change(()=>selected().writingMode=$('clip-writing-mode').value);if(inlineId)populateInline(activeFormatRange());};
document.querySelector('.inspector-tabs').onclick=e=>{
  const tab=e.target.dataset.settingsTab;if(!tab)return;
  for(const b of document.querySelectorAll('[data-settings-tab]'))b.setAttribute('aria-selected',String(b===e.target));
  $('settings-type').hidden=tab!=='type';$('settings-timing').hidden=tab!=='timing';$('settings-position').hidden=tab!=='timing';
};
$('add-track').onclick=()=>{if((project.tracks??1)>=32)return;change(()=>project.tracks=(project.tracks??1)+1);};
$('remove-track').onclick=()=>{const last=(project.tracks??1)-1;if(last<1)return;if(project.clips.some(c=>c.track===last))return message('末尾のトラックにあるブロックを移動・削除してから減らしてください。');change(()=>project.tracks--);};
$('clip-track').onchange=()=>{const c=structuredClone(selected());c.track=Number($('clip-track').value);try{const next=insertClips(project.clips.filter(v=>v.id!==c.id),[c],duration());change(()=>project.clips=next);}catch(e){message(e.message,true);renderInspector();}};
function renderCues() {
  const c=selected();if(!c)return;$('reveal-mode').value=c.revealMode??'accumulate';
  const list=$('cue-list');list.replaceChildren();
  $('selection-cue').disabled=!activeFormatRange();
  if(!c.cues?.length){const p=document.createElement('p');p.className='field-help';p.textContent='開始点はまだありません。行・単語・文字ごとに作成するか、選択した文字に追加してください。';list.append(p);}
  for(const cue of c.cues??[]) {
    const first = cue === c.cues[0];
    const row=document.createElement('div');row.className='cue-row';const label=document.createElement('label');label.textContent=c.text.slice(cue.start,cue.end);label.title=label.textContent;
    const input=document.createElement('input');input.type='number';input.min=String(Math.min(0,cue.at));input.max=String(Math.max(0,c.end-c.start-MIN_LENGTH));input.step='.01';input.value=cue.at;input.setAttribute('aria-label',label.textContent+' の表示開始（秒）');if(cue.at<0)input.title='先頭を短くしたため、ブロック開始より前の表示時刻を保持しています。';
    input.onchange=()=>{change(()=>cue.at=round(clamp(Number(input.value)||0,Number(input.min),c.end-c.start-MIN_LENGTH)));renderCues();};
    if(first){input.value='0';input.disabled=true;input.title='最初の要素はブロック先頭（0秒）に固定されています。';}
    const now=document.createElement('button');now.className='button quiet small';now.textContent='現在位置';now.onclick=()=>{change(()=>cue.at=round(clamp(time-c.start,0,c.end-c.start-MIN_LENGTH)));renderCues();};
    now.disabled=first;
    const jump=document.createElement('button');jump.className='button quiet small';jump.textContent='確認';jump.onclick=()=>seek(c.start+clamp(cue.at+.01,0,c.end-c.start-.001));
    const remove=document.createElement('button');remove.className='icon-button';remove.textContent='×';remove.setAttribute('aria-label','開始点を削除');remove.onclick=()=>{change(()=>c.cues=c.cues.filter(v=>v!==cue));renderCues();};
    label.append(input);row.append(label,now,jump,remove);list.append(row);
  }
}
$('open-cues').onclick=()=>{stop();renderCues();$('cues-dialog').showModal();};
$('reveal-mode').onchange=()=>change(()=>selected().revealMode=$('reveal-mode').value);
$('generate-cues').onclick=()=>{change(()=>selected().cues=makeCues(selected(),$('cue-unit').value));renderCues();};
$('clear-cues').onclick=()=>{change(()=>selected().cues=[]);renderCues();};
$('selection-cue').onclick=()=>{const c=selected(),range=activeFormatRange();if(!range)return;change(()=>{c.cues=(c.cues??[]).filter(q=>q.end<=range.start||q.start>=range.end);c.cues.push({...range,at:round(clamp(time-c.start,0,c.end-c.start-MIN_LENGTH))});c.cues.sort((a,b)=>a.start-b.start);});renderCues();};
function appendCueMarkers(bar,c) {
  for(const cue of (c.cues??[]).slice(1)) {
    if(cue.at<0||cue.at>=c.end-c.start)continue;
    const marker=document.createElement('button');marker.type='button';marker.className='cue-marker';marker.title=c.text.slice(cue.start,cue.end)+' · '+formatTime(c.start+cue.at);marker.setAttribute('aria-label',marker.title);marker.style.left=`${cue.at/(c.end-c.start)*100}%`;
    marker.onpointerdown=e=>{
      if(e.button!==0)return;e.stopPropagation();e.preventDefault();stop();marker.focus({preventScroll:true});
      const start=e.clientX,original=cue.at,width=bar.getBoundingClientRect().width;let moved=false;marker.setPointerCapture(e.pointerId);
      const move=ev=>{if(!moved&&Math.abs(ev.clientX-start)<2)return;if(!moved){checkpoint();moved=true;}cue.at=round(clamp(original+(ev.clientX-start)/width*(c.end-c.start),0,c.end-c.start-MIN_LENGTH));marker.style.left=`${cue.at/(c.end-c.start)*100}%`;renderPreview();};
      const end=()=>{marker.removeEventListener('pointermove',move);marker.removeEventListener('pointerup',end);marker.removeEventListener('pointercancel',end);if(moved)changed();else seek(c.start+cue.at+.001);};
      marker.addEventListener('pointermove',move);marker.addEventListener('pointerup',end);marker.addEventListener('pointercancel',end);
    };
    marker.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();e.stopPropagation();change(()=>cue.at=round(clamp(cue.at+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?.1:1/30),0,c.end-c.start-MIN_LENGTH)));};bar.append(marker);
  }
}

await initFonts();
renderInspector(); renderMaster(); renderTimeline(); renderPreview(); updateButtons();
try {
  const raw = localStorage.getItem('tomei-draft-v1');
  const draft = raw ? validateProject(JSON.parse(raw)) : null;
  if (draft && (draft.audio || draft.clips.length)) {
    const banner = document.createElement('div'); banner.className = 'recover-banner';
    const text = document.createElement('span'); text.textContent = 'この端末に前回の編集が残っています。';
    const restore = document.createElement('button'); restore.className = 'button secondary small'; restore.textContent = '編集を復元';
    restore.onclick = async () => { if (loading) return; banner.remove(); await applyProject(draft); message('編集を復元しました。元の音源を選択してください。'); };
    const dismiss = document.createElement('button'); dismiss.className = 'text-button'; dismiss.textContent = '閉じる'; dismiss.onclick = () => banner.remove();
    banner.append(text, restore, dismiss); document.querySelector('.app-header').after(banner);
  }
} catch { /* A broken/obsolete draft must never prevent opening the editor. */ }

// Optional browser agent integration, sharing the visible editor's state and actions.
const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  for (const tool of [
    {
      name: 'get_lyric_project', title: '歌詞の配置を確認',
      description: 'Read text timings and fade settings in the local project. Does not read or send audio bytes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) { if (!input || Object.keys(input).length) throw new Error('引数は空のオブジェクトにしてください。'); return { ...snapshot(), audioLoaded: !!buffer, currentTime: time }; },
    },
    {
      name: 'add_lyric_text', title: '歌詞を追加',
      description: 'Add one lyric screen to the loaded audio timeline with explicit start and end times in seconds. Undo is available.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0.04 } }, required: ['text', 'start', 'end'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        if (!buffer || loading || exportController) throw new Error('音源を読み込み、処理が終わってから追加してください。');
        if (!input || Object.keys(input).some(k => !['text', 'start', 'end'].includes(k)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000 || !Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end - input.start < MIN_LENGTH || input.end > duration() || project.clips.length >= 2000) throw new Error('歌詞と、曲の範囲内の開始・終了時刻を指定してください。');
        const c = makeClip(input.text.trim(), input.start, input.end);
        const inserted=insertClips(project.clips,[c],duration());change(() => { project.clips=inserted; selectedId = c.id; }); selectClip(c.id);
        return { id: c.id, start: c.start, end: c.end };
      },
    },
  ]) {
    try { Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Optional API. */ }
  }
}
