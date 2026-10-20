// AI image generation (Gemini image model) + shot-list builder driven by config/image-rules.json.
const fs   = require('fs');
const path = require('path');
const { GEMINI_KEY, GEMINI_MODEL, IMAGE_RULES, sleep } = require('./config');

// Reference images may be URLs (label art or real photos on the Shopify CDN).
// Downloaded once into <dir>/refs/ and passed to Gemini like a local file.
async function downloadRef(url, dir) {
  const refDir = path.join(dir, 'refs');
  fs.mkdirSync(refDir, { recursive: true });
  const name = path.basename(new URL(url).pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(refDir, name);
  if (fs.existsSync(file)) return file;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ref download ${res.status}: ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// refMode: 'product' (the reference is a photo of the product; keep it identical) or
// 'label' (the reference is printed label artwork; reproduce it faithfully on the package).
function wrapWithReference(prompt, refMode) {
  const tpl = IMAGE_RULES.reference_prompts[refMode] || IMAGE_RULES.reference_prompts.product;
  return tpl.replace('{PROMPT}', prompt);
}

/**
 * Generate one image. Retries on 429/5xx. Returns the saved file path, or null on failure
 * (callers decide whether a missing image is fatal).
 */
async function generateImage({ prompt, outDir, slug, label, refFilePath = null, refMode = 'product' }) {
  if (!GEMINI_KEY) { console.warn('  ⚠️  No GEMINI_API_KEY — skipping image'); return null; }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

  // Consistency anchoring: when a reference image is given (usually the hero shot),
  // pass it inline so every subsequent photo shows the SAME product.
  const parts = [];
  if (refFilePath && fs.existsSync(refFilePath)) {
    const refMime = refFilePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    parts.push({ inlineData: { mimeType: refMime, data: fs.readFileSync(refFilePath).toString('base64') } });
    prompt = wrapWithReference(prompt, refMode);
  }
  parts.push({ text: prompt });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  🎨  [${label}]${attempt > 1 ? ` retry ${attempt}` : ''}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(5000 * attempt); continue; }
      if (!res.ok) { console.error(`  ❌  Gemini ${res.status}`); return null; }
      const data = await res.json();
      const img = (data?.candidates?.[0]?.content?.parts ?? []).find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!img) { console.error('  ❌  No image in Gemini response'); return null; }
      const ext  = img.inlineData.mimeType.includes('png') ? 'png' : 'jpg';
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${slug}-${label}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.inlineData.data, 'base64'));
      console.log(`  ✅  [${label}] → ${path.basename(file)}`);
      return file;
    } catch (e) {
      console.error(`  ❌  Gemini exception: ${e.message}`);
      if (attempt === 3) return null;
    }
  }
  return null;
}

// ─── Shot lists ───────────────────────────────────────────────────────────────
function fill(template, vars) {
  return template.replace(/\{(BASE|GRADE|STYLE)\}/g, (_, k) => vars[k] || '');
}

function renderArchetype(arch, base, gradeKey) {
  const vars = {
    BASE:  base,
    GRADE: IMAGE_RULES.grades[gradeKey] || IMAGE_RULES.grades[IMAGE_RULES.default_grade],
    STYLE: IMAGE_RULES.styles[arch.style] || IMAGE_RULES.styles.studio,
  };
  return arch.shots.map(s => ({ label: s.label, prompt: fill(s.prompt, vars) }));
}

// Pick the first archetype for this channel whose regex matches the spec's type/name.
function buildImagePrompts(spec, isWholesale = false) {
  const channel  = isWholesale ? 'wholesale' : 'retail';
  const haystack = `${spec.product_type || ''} ${spec.product_name || ''}`;
  const arch = IMAGE_RULES.archetypes.find(a => a.channel === channel && new RegExp(a.match, 'i').test(haystack));
  const base = [spec.product_name, spec.product_type_label, spec.key_attribute].filter(Boolean).join(', ');
  return renderArchetype(arch, base, spec.quality_grade);
}

// Feedback-plan entries name an archetype directly and supply their own subject.
function shotsForPlanEntry(p) {
  const arch = IMAGE_RULES.archetypes.find(a => a.name === p.archetype)
            || IMAGE_RULES.archetypes.find(a => a.name === 'retail-default');
  let list = renderArchetype(arch, p.subject, p.grade);
  if (p.shot_override) {
    const hit = list.filter(s => s.label === p.shot_override || s.label.endsWith(`-${p.shot_override}`));
    list = hit.length ? hit
      : [{ label: p.shot_override, prompt: `${p.subject}: ${p.shot_override} product shot. ${IMAGE_RULES.styles.studio}` }];
  }
  return list.slice(0, p.count || list.length);
}

module.exports = { downloadRef, generateImage, buildImagePrompts, shotsForPlanEntry, renderArchetype };
