// Load a real installed face; CSS fallback must never count as detection.
export async function loadLocalFont(font) {
  const faces = font.localFaces ?? { 400: [font.local] };
  const loadFace = async (names, weight) => {
    if (!names?.length) return false;
    const source = names.map(name => `local(${JSON.stringify(name)})`).join(', ');
    try {
      const face = new FontFace(font.family, source, { weight: String(weight) });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch { return false; }
  };
  const loaded = await Promise.all(Object.entries(faces).map(async ([weight, names]) => await loadFace(names, weight) ? Number(weight) : null));
  return loaded.filter(weight => weight !== null).sort((a, b) => a - b);
}
