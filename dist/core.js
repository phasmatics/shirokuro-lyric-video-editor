export const MIN_LENGTH = 0.04;
export const FONT_FAMILIES = {
  'noto-sans': { label: 'Noto Sans JP', family: 'Noto Sans JP Variable', bundled: true },
  'noto-serif': { label: 'Noto Serif JP', family: 'Noto Serif JP Variable', bundled: true },
  'm-plus-1': { label: 'M+（M PLUS 1）', family: 'M PLUS 1 Variable', bundled: true },
  'ms-gothic': { label: 'MS ゴシック', family: 'Tomei MS Gothic', local: 'MS Gothic', weights: [400] },
  'ms-pgothic': { label: 'MS Pゴシック', family: 'Tomei MS PGothic', local: 'MS PGothic', weights: [400] },
  'ms-mincho': { label: 'MS 明朝', family: 'Tomei MS Mincho', local: 'MS Mincho', weights: [400] },
  'ms-pmincho': { label: 'MS P明朝', family: 'Tomei MS PMincho', local: 'MS PMincho', weights: [400] },
  'hiragino': { label: 'ヒラギノ角ゴ', family: 'Tomei Hiragino', local: 'Hiragino Sans', boldLocal: 'HiraginoSans-W6' },
};
export const fontWeights = font => FONT_FAMILIES[font]?.weights ?? [400,700];
export const fontWeight = (font, weight) => fontWeights(font).includes(weight) ? weight : 400;
export function normalizeFontWeights(clip, available = null) {
  const resolve = (font, weight) => (available?.get(font) ?? fontWeights(font)).includes(weight) ? weight : 400;
  const originalWeight = clip.weight, baseWeight = resolve(clip.font,originalWeight);
  for (const r of clip.styles ?? []) {
    const before = r.style.weight ?? originalWeight, after = resolve(r.style.font ?? clip.font,before);
    if (after !== before || (r.style.weight === undefined && after !== baseWeight)) r.style.weight = after;
  }
  clip.weight = baseWeight;
  return clip;
}
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const round = n => Math.round(n * 1000) / 1000;
export function emptyProject() { return { version: 1, title: '', audio: null, master: { in: 0.2, out: 0.2 }, tracks: 1, clips: [] }; }
export function splitLyrics(text) { return text.replace(/\r\n?/g, '\n').split(/\n[\t \u3000]*\n(?:[\t \u3000]*\n)*/).map(s => s.trim()).filter(Boolean); }
export function makeClip(text, start, end, kind = 'lyric') {
  return { id: crypto.randomUUID(), text, kind, start: round(start), end: round(end), font: 'noto-sans', size: kind === 'title' ? 88 : 64, weight: 400, letterSpacing: 0, lineHeight: 1.55, kerning: [], x: 50, y: 50, align: 'center', fade: null, track: 0, writingMode: 'horizontal', baselineShift: 0, rotation: 0, styles: [], cues: [], revealMode: 'accumulate' };
}
export function distribute(text, start, end) {
  const parts = splitLyrics(text);
  if (!parts.length) throw new Error('歌詞を入力してください。');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (end - start) / parts.length < MIN_LENGTH) throw new Error('配置範囲を広げてください。');
  return parts.map((text, i) => makeClip(text, start + (end - start) * i / parts.length, start + (end - start) * (i + 1) / parts.length));
}
export function effectiveFade(clip, master) {
  const fade = clip.fade ?? master;
  const sum = fade.in + fade.out;
  const scale = sum > clip.end - clip.start ? (clip.end - clip.start) / sum : 1;
  return { in: fade.in * scale, out: fade.out * scale };
}
export function opacityAt(clip, time, master) {
  if (time < clip.start || time >= clip.end) return 0;
  const f = effectiveFade(clip, master);
  return clamp(Math.min(f.in > 0 ? (time - clip.start) / f.in : 1, f.out > 0 ? (clip.end - time) / f.out : 1), 0, 1);
}
export function moveClip(clip, mode, delta, duration) {
  if (mode === 'start') return { ...clip, start: round(clamp(clip.start + delta, 0, clip.end - MIN_LENGTH)) };
  if (mode === 'end') return { ...clip, end: round(clamp(clip.end + delta, clip.start + MIN_LENGTH, duration)) };
  const start = round(clamp(clip.start + delta, 0, Math.max(0, duration - (clip.end - clip.start))));
  return { ...clip, start, end: round(start + clip.end - clip.start) };
}
export function formatTime(t, fraction = true) {
  const total = Math.round(Math.max(0, t) * 100);
  return `${String(Math.floor(total / 6000)).padStart(2, '0')}:${String(Math.floor(total / 100) % 60).padStart(2, '0')}${fraction ? '.' + String(total % 100).padStart(2, '0') : ''}`;
}
export function validateProject(data) {
  const fail = () => { throw new Error('対応するプロジェクトファイルではありません。'); };
  const num = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
  const validFade = f => f && num(f.in, 0, 60) && num(f.out, 0, 60);
  if (!data || data.version !== 1 || typeof data.title !== 'string' || data.title.length > 1000 || !validFade(data.master) || !Array.isArray(data.clips) || data.clips.length > 2000) fail();
  if (data.audio !== null && (!data.audio || typeof data.audio.name !== 'string' || !num(data.audio.duration, MIN_LENGTH, 21600) || !num(data.audio.size, 0, 1e12))) fail();
  const legacy = !data.clips.some(c => c.track !== undefined);
  const legacyLanes = new Map(); const ends = [];
  if (legacy) for (const c of [...data.clips].sort((a,b)=>a.start-b.start)) { let lane=ends.findIndex(end=>end<=c.start+.001);if(lane<0)lane=ends.length;ends[lane]=c.end;legacyLanes.set(c.id,lane); }
  const ids = new Set();
  const clips = data.clips.map(c => {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) || ids.has(c.id) || typeof c.text !== 'string' || c.text.length > 20000 || !['title', 'lyric'].includes(c.kind) || !num(c.start, 0, 21600) || !num(c.end, c.start + MIN_LENGTH - 0.001, 21600) || !Object.hasOwn(FONT_FAMILIES, c.font) || !num(c.size, 16, 240) || ![400, 700].includes(c.weight) || !num(c.x, 0, 100) || !num(c.y, 0, 100) || !['left', 'center', 'right'].includes(c.align) || !(c.fade === null || validFade(c.fade))) fail();
    if (data.audio && c.end > data.audio.duration + 0.002) fail();
    if ((c.letterSpacing !== undefined && !num(c.letterSpacing, -5, 100)) || (c.lineHeight !== undefined && !num(c.lineHeight, 0.5, 4))) fail();
    const boundaries = new Set(textBoundaries(c.text)), kernIds = new Set();
    if (c.kerning !== undefined && (!Array.isArray(c.kerning) || c.kerning.length > c.text.length || c.kerning.some(k => {
      if (!k || !Number.isInteger(k.at) || !boundaries.has(k.at) || !num(k.value, -100, 100) || kernIds.has(k.at)) return true;
      kernIds.add(k.at); return false;
    }))) fail();
    ids.add(c.id);
    return normalizeFontWeights({ ...validateExtras({ ...c, track: c.track ?? legacyLanes.get(c.id) ?? 0 }, fail), id: c.id, kind: c.kind, text: c.text, start: c.start, end: c.end, font: c.font, size: c.size, weight: c.weight, letterSpacing: c.letterSpacing ?? 0, lineHeight: c.lineHeight ?? 1.55, kerning: (c.kerning ?? []).map(k => ({ at: k.at, value: k.value })), x: c.x, y: c.y, align: c.align, fade: c.fade === null ? null : { in: c.fade.in, out: c.fade.out } });
  });
  if (data.tracks !== undefined && (!Number.isInteger(data.tracks) || data.tracks < 1 || data.tracks > 32)) fail();
  return { version: 1, tracks: Math.max(data.tracks ?? 1, ...clips.map(c=>c.track+1)), title: data.title, audio: data.audio ? { name: data.audio.name, size: data.audio.size, duration: data.audio.duration } : null, master: { in: data.master.in, out: data.master.out }, clips };
}
export function clipLanes(clips) { return [...clips].sort((a,b)=>a.start-b.start).map(clip=>({clip,lane:clip.track ?? 0})); }

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
// UTF-16 offsets match DOM selections; never split a combining character or emoji.
export function textBoundaries(text) {
  return [...segmenter.segment(text)].map(s => s.index).filter(i => i > 0 && text[i - 1] !== '\n' && text[i] !== '\n');
}
export function replaceClipText(clip, text) {
  const old = clip.text;
  let start = 0, end = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
  const valid = new Set(textBoundaries(text));
  clip.kerning = (clip.kerning ?? []).flatMap(k => {
    const at = k.at < start ? k.at : k.at > old.length - end ? k.at + text.length - old.length : -1;
    return valid.has(at) ? [{ at, value: k.value }] : [];
  });
  const shift = text.length-old.length, oldEnd=old.length-end, newEnd=text.length-end;
  const mapRanges = (ranges, type) => ranges.flatMap(r => {
    if(r.end<=start) return [r];
    if(r.start>=oldEnd) return [{...r,start:r.start+shift,end:r.end+shift}];
    const result=[];
    if(r.start<start) result.push({...r,end:start});
    if(r.end>oldEnd) result.push({...r,start:newEnd,end:r.end+shift});
    return result;
  }).filter(r=>r.end>r.start);
  const insertionStyle=styleAt(clip,Math.max(0,start-1));
  clip.styles=mapRanges(clip.styles ?? []);clip.cues=mapRanges(clip.cues ?? []);
  if(newEnd>start){const style=Object.fromEntries(STYLE_KEYS.filter(k=>insertionStyle[k] !== (clip[k]??0)).map(k=>[k,insertionStyle[k]]));if(Object.keys(style).length)clip.styles.push({start,end:newEnd,style});}
  const rangeBoundaries=new Set([0,...graphemes(text).map(g=>g.end)]);
  clip.styles=clip.styles.filter(r=>rangeBoundaries.has(r.start)&&rangeBoundaries.has(r.end)).sort((a,b)=>a.start-b.start);
  clip.cues=clip.cues.filter(r=>rangeBoundaries.has(r.start)&&rangeBoundaries.has(r.end));
  clip.text = text;
  anchorFirstCue(clip);
}
export function duplicateClips(clips, at, duration) {
  if (!clips.length) return [];
  const first = Math.min(...clips.map(c => c.start)), last = Math.max(...clips.map(c => c.end));
  if (last - first > duration + 0.001) throw new Error('コピーしたブロックが曲の長さに収まりません。');
  const delta = clamp(at, 0, Math.max(0, duration - (last - first))) - first;
  return clips.map(c => ({ ...structuredClone(c), id: crypto.randomUUID(), start: round(c.start + delta), end: round(c.end + delta) }));
}

// Typography and timed reveals use UTF-16 ranges aligned to complete graphemes.
export const STYLE_KEYS = ['font', 'size', 'weight', 'letterSpacing', 'baselineShift', 'rotation'];
export function graphemes(text) { return [...segmenter.segment(text)].map(s => ({ text: s.segment, start: s.index, end: s.index + s.segment.length })); }
export function styleAt(clip, at) {
  const base = { font: clip.font, size: clip.size, weight: clip.weight, letterSpacing: clip.letterSpacing ?? 0, baselineShift: clip.baselineShift ?? 0, rotation: clip.rotation ?? 0 };
  Object.assign(base, (clip.styles ?? []).find(s => at >= s.start && at < s.end)?.style ?? {});
  base.weight = fontWeight(base.font,base.weight);
  return base;
}
export function styleValues(clip, key, range = null) {
  const glyphs = graphemes(clip.text).filter(g => g.text !== '\n' && (!range || g.end > range.start && g.start < range.end));
  return [...new Set(glyphs.map(g => styleAt(clip, g.start)[key]))];
}
export function applyTextStyle(clip, patch, range = null) {
  if (!range || range.start === range.end) {
    Object.assign(clip, patch);
    clip.styles = (clip.styles ?? []).map(r => ({ ...r, style: Object.fromEntries(Object.entries(r.style).filter(([key]) => !(key in patch))) })).filter(r => Object.keys(r.style).length);
    normalizeFontWeights(clip);
    return;
  }
  const runs = [];
  for (const g of graphemes(clip.text)) {
    const style = styleAt(clip, g.start);
    if (g.end > range.start && g.start < range.end) Object.assign(style, patch);
    style.weight = fontWeight(style.font,style.weight);
    const overrides = Object.fromEntries(STYLE_KEYS.filter(k => style[k] !== (clip[k] ?? 0)).map(k => [k, style[k]]));
    const prev = runs.at(-1);
    if (prev && prev.end === g.start && JSON.stringify(prev.style) === JSON.stringify(overrides)) prev.end = g.end;
    else runs.push({ start: g.start, end: g.end, style: overrides });
  }
  clip.styles = runs.filter(r => Object.keys(r.style).length);
}
export function validateExtras(c, fail) {
  const number = (v, min, max) => Number.isFinite(v) && typeof v === 'number' && v >= min && v <= max;
  const check = (key, value) => key === 'font' ? Object.hasOwn(FONT_FAMILIES, value) : key === 'weight' ? [400,700].includes(value) : key === 'size' ? number(value,16,240) : key === 'letterSpacing' ? number(value,-5,100) : key === 'baselineShift' ? number(value,-500,500) : key === 'rotation' && number(value,-180,180);
  const valid = new Set([0, ...graphemes(c.text).map(g => g.end)]);
  const writingMode = c.writingMode ?? 'horizontal', track = c.track ?? 0;
  if (!['horizontal','vertical'].includes(writingMode) || !Number.isInteger(track) || !number(track,0,31)) fail();
  for (const key of ['baselineShift','rotation']) if (c[key] !== undefined && !check(key,c[key])) fail();
  const styles = c.styles ?? [], cues = c.cues ?? [];
  if (!Array.isArray(styles) || styles.length > c.text.length || !Array.isArray(cues) || cues.length > c.text.length) fail();
  let end = 0;
  for (const r of styles) {
    if (!r || !valid.has(r.start) || !valid.has(r.end) || r.start < end || r.end <= r.start || !r.style || typeof r.style !== 'object' || Array.isArray(r.style) || Object.entries(r.style).some(([k,v]) => !STYLE_KEYS.includes(k) || !check(k,v))) fail();
    end = r.end;
  }
  end = 0;
  for (const r of cues) {
    if (!r || !valid.has(r.start) || !valid.has(r.end) || r.start < end || r.end <= r.start || !number(r.at,-21600,21600)) fail();
    end = r.end;
  }
  if (c.revealMode !== undefined && !['accumulate','replace'].includes(c.revealMode)) fail();
  return anchorFirstCue({ writingMode, track, baselineShift:c.baselineShift ?? 0, rotation:c.rotation ?? 0, styles:structuredClone(styles), cues:structuredClone(cues), revealMode:c.revealMode ?? 'accumulate' });
}
export function anchorFirstCue(clip) {
  if (clip.cues?.length) clip.cues[0].at = 0;
  return clip;
}
export function makeCues(clip, unit) {
  let parts;
  if (unit === 'character') parts = graphemes(clip.text).filter(g => !/^\s+$/.test(g.text));
  else {
    const pattern = unit === 'line' ? /[^\n]+/gu : /\S+/gu;
    parts = [...clip.text.matchAll(pattern)].map(m => ({ start:m.index,end:m.index+m[0].length }));
  }
  return parts.map((p,i) => ({start:p.start,end:p.end,at:round(i / Math.max(1,parts.length) * (clip.end-clip.start))}));
}
export function glyphVisible(clip, at, time) {
  const cues = clip.cues ?? [], cue = cues.find(c => at >= c.start && at < c.end);
  if (!cue) return true;
  const elapsed = time - clip.start;
  if (elapsed + .00001 < cue.at) return false;
  if (clip.revealMode !== 'replace') return true;
  const next = cues.filter(c => c.at > cue.at).reduce((v,c) => Math.min(v,c.at),Infinity);
  return elapsed < next;
}
export function glyphOpacityAt(clip, at, time, master) {
  const blockOpacity = opacityAt(clip, time, master);
  if (blockOpacity <= 0) return 0;
  const cues = clip.cues ?? [], cue = cues.find(c => at >= c.start && at < c.end);
  if (!cue) return blockOpacity;
  const next = clip.revealMode === 'replace'
    ? cues.reduce((end, c) => c.at > cue.at ? Math.min(end, clip.start + c.at) : end, clip.end)
    : clip.end;
  const start = clip.start + cue.at;
  if (next <= start) return 0;
  const cueOpacity = opacityAt({ start, end: next, fade: clip.fade }, time, master);
  // Share the existing fade envelope without multiplying the same fade twice.
  return Math.min(blockOpacity, cueOpacity);
}
function cropped(clip, start, end, newId = false) {
  const shift = start - clip.start;
  // The first cue follows the block edge; later cues keep their absolute timing.
  return anchorFirstCue({ ...structuredClone(clip), id:newId ? crypto.randomUUID() : clip.id, start:round(start), end:round(end), cues:(clip.cues ?? []).map(c => ({...c,at:round(c.at-shift)})) });
}
export function overwriteClips(clips, edited) {
  const result = [];
  for (const c of clips) {
    if (c.id === edited.id) continue;
    if ((c.track ?? 0) !== (edited.track ?? 0) || c.end <= edited.start || c.start >= edited.end) { result.push(structuredClone(c)); continue; }
    if (edited.start - c.start >= MIN_LENGTH) result.push(cropped(c,c.start,edited.start));
    if (c.end - edited.end >= MIN_LENGTH) result.push(cropped(c,edited.end,c.end,c.start < edited.start));
  }
  return [...result, edited];
}
export function editTimeline(clips, id, mode, delta, duration, options = {}) {
  const original = clips.find(c => c.id === id);
  if (!original) return clips;
  if (mode !== 'move') {
    const edited = moveClip(original,mode,delta,duration);
    const resized = options.stretchCues
      ? anchorFirstCue({ ...structuredClone(original), start:edited.start, end:edited.end,
          cues:(original.cues ?? []).map(c => ({...c,at:clamp(round(c.at*(edited.end-edited.start)/(original.end-original.start)),-21600,21600)})) })
      : cropped(original,edited.start,edited.end);
    return overwriteClips(clips,resized);
  }
  if (options.track !== undefined && options.track !== (original.track ?? 0)) {
    const target = moveClip(structuredClone(original),'move',delta,duration);
    target.track = options.track;
    return insertClips(clips.filter(c => c.id !== id),[target],duration);
  }
  // Use the order at drag start: a large pointer jump must not skip a neighbor.
  const lane = clips.filter(c => (c.track ?? 0) === (original.track ?? 0)).sort((a,b) => a.start-b.start);
  const index = lane.findIndex(c => c.id === id);
  const neighbors = delta >= 0 ? lane.slice(index+1) : lane.slice(0,index).reverse();
  const attempt = d => {
    const target = moveClip(structuredClone(original),'move',d,duration), others = clips.filter(c => c.id !== id).map(c => structuredClone(c));
    let edge = delta >= 0 ? target.end : target.start;
    const byId = new Map(others.map(c => [c.id,c]));
    for (const neighbor of neighbors) {
      const c = byId.get(neighbor.id);
      if (delta >= 0 && c.start < edge) { const length=c.end-c.start;c.start=round(edge);c.end=round(edge+length);edge=c.end; }
      else if (delta < 0 && c.end > edge) { const length=c.end-c.start;c.end=round(edge);c.start=round(edge-length);edge=c.start; }
      else break;
    }
    return { valid:others.every(c => c.start >= 0 && c.end <= duration+.001), clips:[...others,target] };
  };
  let result=attempt(delta);
  if (result.valid) return result.clips;
  let low=0, high=1;result=attempt(0);
  for(let i=0;i<30;i++){const mid=(low+high)/2,next=attempt(delta*mid);if(next.valid){low=mid;result=next;}else high=mid;}
  return result.clips;
}
export function insertClips(clips, additions, duration) {
  const existing=structuredClone(clips), added=structuredClone(additions);
  for(const track of new Set(added.map(c=>c.track??0))) {
    let edge=0;
    const fixed=added.filter(c=>(c.track??0)===track);
    for(const c of existing.filter(c=>(c.track??0)===track).sort((a,b)=>a.start-b.start)) {
      const length=c.end-c.start;let start=Math.max(c.start,edge),hit;
      while((hit=fixed.find(f=>f.start<start+length-.0001&&f.end>start+.0001))) start=hit.end;
      c.start=round(start);c.end=round(start+length);edge=c.end;
      if(c.end>duration+.001) throw new Error('この位置には配置できる空きがありません。前の位置に移すか、別トラックを選んでください。');
    }
  }
  return [...existing,...added];
}
