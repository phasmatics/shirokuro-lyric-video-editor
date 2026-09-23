// Load a real installed face; CSS fallback must never count as detection.
export async function loadLocalFont(font) {
  const variants = font.localVariants ?? [{ regular: [font.local], bold: font.boldLocal ? [font.boldLocal] : [] }];
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
  for (const variant of variants) {
    if (!await loadFace(variant.regular, 400)) continue;
    return await loadFace(variant.bold, 700) ? [400, 700] : [400];
  }
  return [];
}
