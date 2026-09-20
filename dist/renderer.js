import { FONT_FAMILIES, opacityAt, graphemes, styleAt, glyphOpacityAt, fontWeight } from './core.js';
export function measureClip(ctx, clip) {
  if (advancedText(clip)) return measureAdvanced(ctx, clip);
  const family = FONT_FAMILIES[clip.font].family;
  ctx.font = `${fontWeight(clip.font,clip.weight)} ${clip.size}px "${family}"`;
  ctx.letterSpacing = `${clip.letterSpacing ?? 0}px`;
  const lines = clip.text.split('\n');
  let offset = 0;
  const runs = lines.map(line => {
    let previous = 0;
    const result = [];
    for (const k of [...(clip.kerning ?? [])].sort((a, b) => a.at - b.at)) {
      const at = k.at - offset;
      if (at <= 0 || at >= line.length) continue;
      const text = line.slice(previous, at);
      result.push({ text, width: ctx.measureText(text).width, after: k.value }); previous = at;
    }
    const text = line.slice(previous); result.push({ text, width: ctx.measureText(text).width, after: 0 });
    offset += line.length + 1;
    return result;
  });
  const widths = runs.map(line => line.reduce((sum, run) => sum + run.width + run.after, 0));
  const width = Math.max(0, ...widths);
  const lineHeight = clip.size * (clip.lineHeight ?? 1.55);
  const height = lines.length * lineHeight;
  return { lines, runs, widths, width, height, lineHeight, left: clip.x * 19.2 - width / 2, top: clip.y * 10.8 - height / 2 };
}
export function drawFrame(canvas, project, time) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / 1920, canvas.height / 1080);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'middle';
  for (const clip of project.clips) {
    const opacity = opacityAt(clip, time, project.master);
    if (opacity <= 0) continue;
    const box = measureClip(ctx, clip);
    ctx.globalAlpha = opacity;
    if (box.glyphs) {
      for (const g of box.glyphs) {
        const glyphOpacity = glyphOpacityAt(clip,g.start,time,project.master);
        if (glyphOpacity <= 0) continue;
        ctx.save(); ctx.globalAlpha=glyphOpacity;ctx.font=fontCSS(g.style);ctx.letterSpacing='0px';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.translate(box.left+g.x,box.top+g.y);ctx.rotate(g.angle*Math.PI/180);ctx.fillText(g.display,0,0);ctx.restore();
      }
      continue;
    }
    ctx.textAlign = 'left';
    box.runs.forEach((runs, i) => {
      let x = box.left + (clip.align === 'center' ? (box.width - box.widths[i]) / 2 : clip.align === 'right' ? box.width - box.widths[i] : 0);
      for (const run of runs) { ctx.fillText(run.text, x, box.top + (i + 0.5) * box.lineHeight); x += run.width + run.after; }
    });
  }
  // Keep every glyph monochrome, including an OS fallback for a color symbol.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.restore();
}
export function checkBounds(project) {
  const ctx = document.createElement('canvas').getContext('2d');
  return project.clips.filter(c => { const b = measureClip(ctx, c); return b.left < 0 || b.top < 0 || b.left + b.width > 1920 || b.top + b.height > 1080; });
}
export async function loadProjectFonts(project) {
  const groups = new Map();
  for (const c of project.clips) {
    const key = `${fontWeight(c.font,c.weight)} 64px "${FONT_FAMILIES[c.font].family}"`;
    groups.set(key, (groups.get(key) || '') + c.text);
    for (const r of c.styles ?? []) { const st=styleAt(c,r.start),k=fontCSS({...st,size:64});groups.set(k,(groups.get(k)||'')+c.text.slice(r.start,r.end)); }
  }
  await Promise.all([...groups].map(([font, text]) => document.fonts.load(font, text)));
}

export const advancedText = c => c.writingMode === 'vertical' || !!c.styles?.length || !!c.cues?.length || !!c.baselineShift || !!c.rotation;
const fontCSS = s => fontWeight(s.font,s.weight)+' '+s.size+'px "'+FONT_FAMILIES[s.font].family+'"';
const verticalForms = {'、':'︑','。':'︒','「':'﹁','」':'﹂','『':'﹃','』':'﹄','（':'︵','）':'︶','〔':'︹','〕':'︺','【':'︻','】':'︼','［':'﹇','］':'﹈','…':'︙','‥':'︰'};
export function measureAdvanced(ctx, clip) {
  const vertical=clip.writingMode==='vertical', lines=clip.text.split('\n'), glyphs=[], widths=[], heights=[];
  let offset=0, cross=0;
  for (const line of lines) {
    const gs=graphemes(line).map(g=>({...g,start:g.start+offset,end:g.end+offset,style:styleAt(clip,g.start+offset)}));
    const maxSize=gs.length?Math.max(...gs.map(g=>g.style.size)):clip.size, thickness=maxSize*(clip.lineHeight??1.55);
    let advance=0;
    for (const g of gs) {
      ctx.font=fontCSS(g.style);ctx.letterSpacing='0px';
      // A half-width space keeps the font's space advance, as in the inline editor.
      const width=ctx.measureText(g.text).width, cell=vertical&&g.text!==' '?g.style.size:width;
      const kern=(clip.kerning??[]).find(k=>k.at===g.start)?.value??0;advance+=kern;
      const display=vertical?(verticalForms[g.text]??g.text):g.text;
      const naturalAngle=vertical && display===g.text && (/^[\u0021-\u007e]+$/.test(g.text) || /[ー―—〜～]/u.test(g.text))?90:0;
      glyphs.push({...g,display,angle:g.style.rotation+naturalAngle,width,
        x:vertical?cross+thickness/2+g.style.baselineShift:advance+width/2,
        y:vertical?advance+cell/2:cross+thickness/2+(maxSize-g.style.size)*.35-g.style.baselineShift,
        line:widths.length});
      advance+=cell+g.style.letterSpacing;
    }
    widths.push(Math.max(0,advance));heights.push(thickness);cross+=thickness;offset+=line.length+1;
  }
  const main=Math.max(0,...widths), width=vertical?cross:main,height=vertical?main:cross;
  for (const g of glyphs) {
    const align=clip.align==='center'?(main-widths[g.line])/2:clip.align==='right'?main-widths[g.line]:0;
    if(vertical){g.x=width-g.x;g.x+=2*g.style.baselineShift;g.y+=align;}else g.x+=align;
  }
  let minX=0,minY=0,maxX=width,maxY=height;
  for(const g of glyphs){if(/^\s+$/u.test(g.text))continue;const a=g.angle*Math.PI/180,w=Math.abs(Math.cos(a))*g.width+Math.abs(Math.sin(a))*g.style.size,h=Math.abs(Math.sin(a))*g.width+Math.abs(Math.cos(a))*g.style.size;minX=Math.min(minX,g.x-w/2);maxX=Math.max(maxX,g.x+w/2);minY=Math.min(minY,g.y-h/2);maxY=Math.max(maxY,g.y+h/2);}
  for(const g of glyphs){g.x-=minX;g.y-=minY;}
  return {lines,glyphs,widths,width:maxX-minX,height:maxY-minY,lineHeight:clip.size*clip.lineHeight,left:clip.x*19.2-(maxX-minX)/2,top:clip.y*10.8-(maxY-minY)/2};
}
