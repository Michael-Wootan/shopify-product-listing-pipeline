#!/usr/bin/env node
/**
 * product-feedback-fixes.js — Re-runnable fixer driven by product-feedback/feedback-plan.json.
 *
 * After a batch of drafts is reviewed, the reviewer writes what's wrong into the plan
 * ("hero has a timestamp overlay", "two listings are duplicates", "FAQs missing") and
 * commits it. This script applies those fixes, per product:
 *   • images: regenerate / add / replace specific shots, anchored to a reference photo
 *   • regional availability block: add, or upgrade an older version in place (tag-scoped)
 *   • FAQs: create metaobjects for products listed in faq_products (skips if present)
 *   • duplicates: move images to the keeper, archive the dupe, create a 301 redirect
 * and writes product-feedback/last-run-report.json (committed back by the workflow).
 *
 * Flags:
 *   --dry-run          no writes to Shopify (still calls Gemini unless --skip-images)
 *   --skip-images      skip all image work
 *   --skip-text        skip regional sections + FAQs
 *   --skip-dupes       skip duplicate consolidation
 *   --only=h1,h2       only process these handles (images phase)
 *   --limit=N          stop the image phase after N products (staged rollouts)
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./lib/config');
const { gql, getProductByHandle, stagedUpload, addMedia, deleteMedia, moveMediaFirst } = require('./lib/shopify');
const { downloadRef, generateImage, shotsForPlanEntry } = require('./lib/images');
const { attachFaqs } = require('./lib/faq');
const { upsertRegionalSection } = require('./lib/regional');
const { sendMail } = require('./lib/mail');

const { sleep, STORE_NAME, REGIONAL } = cfg;
const argv       = process.argv.slice(2);
const DRY        = argv.includes('--dry-run');
const SKIP_IMG   = argv.includes('--skip-images');
const SKIP_TEXT  = argv.includes('--skip-text');
const SKIP_DUPES = argv.includes('--skip-dupes');
const ONLY       = (argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
const LIMIT      = parseInt((argv.find(a => a.startsWith('--limit=')) || '').replace('--limit=', ''), 10) || Infinity;

const FEEDBACK_DIR = path.join(cfg.ROOT, 'product-feedback');
const GEN_DIR      = path.join(FEEDBACK_DIR, 'generated');
const PLAN = JSON.parse(fs.readFileSync(path.join(FEEDBACK_DIR, 'feedback-plan.json'), 'utf8'));
const OUT  = { images: [], text: [], dupes: [], errors: [] };

const shortTitle = t => t.split('—')[0].split('|')[0].trim();

// ─── Phase 1: images ─────────────────────────────────────────────────────────
// ref: "none" | "first" (this product's current first image) | "handle:<other>" (another product's first image)
async function resolveRef(p, product) {
  if (!p.ref || p.ref === 'none') return null;
  let url = null;
  if (p.ref === 'first') url = product.media.nodes.find(n => n.image?.url)?.image?.url;
  if (p.ref.startsWith('handle:')) {
    const other = await getProductByHandle(p.ref.slice(7));
    url = other?.media.nodes.find(n => n.image?.url)?.image?.url;
  }
  if (!url) return null;
  try { return await downloadRef(url, GEN_DIR); }
  catch (e) { console.warn(`  ⚠️  ref image failed (${e.message}) — generating without reference`); return null; }
}

/**
 * Modes:
 *   add                  append new shots
 *   add_main             append, then move the new first shot to position 1
 *   replace_match        delete media whose alt/url contains any delete_match string, add new shots
 *   keep_first_redo_rest keep image 1, replace everything else
 *   redo_all             replace every image
 */
async function processImages(p) {
  const product = await getProductByHandle(p.handle);
  if (!product) { OUT.errors.push(`${p.handle}: not found`); return; }
  const existing = product.media.nodes;
  console.log(`\n📦  ${p.handle} [${p.mode}] — ${existing.length} existing media`);
  const refFile = await resolveRef(p, product);
  let plan = shotsForPlanEntry(p);

  // Rule: the first image is always a white-background hero. In additive modes, if the current
  // first image isn't a hero and the plan doesn't add one, generate one and move it to position 1.
  const firstAlt  = (existing[0]?.alt || '').toLowerCase();
  const needsHero = ['add', 'replace_match'].includes(p.mode) && existing.length > 0 &&
                    !firstAlt.includes('hero') && !plan.some(s => s.label === 'hero') && p.hero_first !== false;
  if (needsHero) {
    const hero = shotsForPlanEntry({ ...p, archetype: 'retail-default', count: 1, shot_override: 'hero' })[0];
    plan = [hero, ...plan];
    console.log('  ➕  adding white-background hero (first-image rule)');
  }

  let toDelete = [];
  if (p.mode === 'redo_all') toDelete = existing.map(m => m.id);
  else if (p.mode === 'keep_first_redo_rest') toDelete = existing.slice(1).map(m => m.id);
  else if (p.mode === 'replace_match') {
    const needles = [].concat(p.delete_match).map(d => String(d).toLowerCase());
    toDelete = existing.filter(m => needles.some(d =>
      (m.alt || '').toLowerCase().includes(d) || (m.image?.url || '').toLowerCase().includes(d))).map(m => m.id);
  }

  const uploads = [];
  for (const { label, prompt } of plan) {
    const file = await generateImage({ prompt, outDir: GEN_DIR, slug: p.handle, label, refFilePath: refFile, refMode: 'product' });
    if (!file) { OUT.errors.push(`${p.handle}/${label}: generation failed`); continue; }
    if (!DRY) {
      try { uploads.push({ src: await stagedUpload(file), alt: `${shortTitle(product.title)} — ${label}`, label }); }
      catch (e) { OUT.errors.push(`${p.handle}/${label}: upload ${e.message}`); }
    }
    await sleep(1200);
  }

  if (DRY) { console.log(`  (dry-run: would delete ${toDelete.length}, add ${plan.length})`); return; }
  // Safety: never delete existing media if nothing was generated to replace it
  if (!uploads.length && plan.length) { console.warn('  ⚠️  no images generated — leaving existing media untouched'); return; }

  if (toDelete.length) { await deleteMedia(product.id, toDelete); console.log(`  🗑️   deleted ${toDelete.length} media`); }
  const newIds = await addMedia(product.id, uploads);
  console.log(`  ✅  added ${newIds.length} media`);
  const heroAdded = uploads[0]?.label === 'hero' && (p.mode === 'add_main' || needsHero || p.hero_first === true);
  if ((p.mode === 'add_main' || heroAdded) && newIds[0]) {
    await sleep(4000);   // media must finish processing before it can be reordered
    await moveMediaFirst(product.id, newIds[0]);
    console.log('  ✅  moved new hero to position 1');
  }
  OUT.images.push(`${p.handle}: -${toDelete.length} +${newIds.length}`);
}

// ─── Phase 2: regional availability block (add or upgrade, tag-scoped) ───────
async function processRegionalSections() {
  if (!REGIONAL.enabled) return;
  console.log(`\n🌍  Regional section ${REGIONAL.version} on products tagged "${REGIONAL.applies_to_tag}"...`);
  const counts = { added: 0, replaced: 0, current: 0 };
  let after = null;
  do {
    const d = await gql(`query($after:String, $q:String!){ products(first:50, after:$after, query:$q){
      pageInfo{ hasNextPage endCursor } nodes{ id title handle tags descriptionHtml } } }`,
      { after, q: `status:active tag:'${REGIONAL.applies_to_tag}'` });
    for (const prod of d.products.nodes) {
      const isWholesale = prod.tags.includes('wholesale') || /wholesale|bulk/i.test(prod.handle);
      const { html, action } = upsertRegionalSection(prod.descriptionHtml, prod.title, isWholesale);
      counts[action]++;
      if (action !== 'current' && !DRY) {
        await gql(`mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ message } } }`,
          { input: { id: prod.id, descriptionHtml: html } });
        await sleep(300);
      }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  console.log(`  → ${counts.added} added, ${counts.replaced} upgraded, ${counts.current} already current`);
  OUT.text.push(`Regional ${REGIONAL.version}: +${counts.added} new, ${counts.replaced} upgraded, ${counts.current} current`);
}

// ─── Phase 3: FAQs ────────────────────────────────────────────────────────────
async function processFaqs() {
  for (const fp of PLAN.faq_products || []) {
    const product = await getProductByHandle(fp.handle);
    if (!product) { OUT.errors.push(`faq ${fp.handle}: not found`); continue; }
    console.log(`\n❓  FAQs → ${fp.handle} (${fp.faqs.length})`);
    if (DRY) continue;
    const n = await attachFaqs(product.id, fp.faqs, { sleep });
    if (n) OUT.text.push(`FAQs: ${fp.handle} +${n}`);
  }
}

// ─── Phase 4: duplicate consolidation ─────────────────────────────────────────
async function processDupes() {
  for (const pair of PLAN.duplicate_pairs || []) {
    console.log(`\n🔀  Consolidating ${pair.dupe} → ${pair.keep}`);
    const keep = await getProductByHandle(pair.keep);
    const dupe = await getProductByHandle(pair.dupe);
    if (!keep || !dupe) { OUT.errors.push(`dupe pair ${pair.keep}: product missing`); continue; }
    if (dupe.status === 'ARCHIVED') { console.log('  already archived — skipping'); continue; }
    if (DRY) continue;
    const imgs = dupe.media.nodes.filter(m => m.image?.url).map(m => ({ src: m.image.url, alt: m.alt || keep.title }));
    if (keep.media.nodes.length === 0 && imgs.length) {
      await addMedia(keep.id, imgs);
      console.log(`  ✅  copied ${imgs.length} images to keeper`);
    }
    // Archive (not delete) so the change is reversible
    await gql(`mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id status } userErrors{ message } } }`,
      { input: { id: dupe.id, status: 'ARCHIVED' } });
    console.log('  ✅  duplicate archived');
    const r = await gql(`mutation($redirect:UrlRedirectInput!){ urlRedirectCreate(urlRedirect:$redirect){
      urlRedirect{ id } userErrors{ message } } }`,
      { redirect: { path: `/products/${pair.dupe}`, target: `/products/${pair.keep}` } });
    if (r.urlRedirectCreate.userErrors?.length) console.warn(`  ⚠️  redirect: ${JSON.stringify(r.urlRedirectCreate.userErrors)}`);
    else console.log(`  ✅  redirect /products/${pair.dupe} → /products/${pair.keep}`);
    OUT.dupes.push(`${pair.dupe} → ${pair.keep} (${imgs.length} images moved)`);
  }
}

// ─── Summary email ────────────────────────────────────────────────────────────
async function emailSummary() {
  if (DRY) return;
  const html = `<div style="font-family:Arial,sans-serif;padding:20px">
    <h2>Product feedback fixes — run complete</h2>
    <h3>Images (${OUT.images.length} products)</h3><pre>${OUT.images.join('\n') || '—'}</pre>
    <h3>Text</h3><pre>${OUT.text.join('\n') || '—'}</pre>
    <h3>Duplicates</h3><pre>${OUT.dupes.join('\n') || '—'}</pre>
    <h3 style="color:${OUT.errors.length ? '#c62828' : '#2e7d32'}">Errors (${OUT.errors.length})</h3><pre>${OUT.errors.join('\n') || 'none'}</pre></div>`;
  await sendMail({ subject: `[${STORE_NAME}] Product feedback fixes — ${OUT.images.length} products updated, ${OUT.errors.length} errors`, html });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!cfg.TOKEN) { console.error('SHOPIFY_ADMIN_TOKEN missing'); process.exit(1); }
  console.log(`product-feedback-fixes ${DRY ? '(DRY RUN)' : ''}`);
  if (PLAN.comment) console.log(`plan: ${PLAN.comment}`);

  if (!SKIP_DUPES) await processDupes();
  if (!SKIP_TEXT)  { await processFaqs(); await processRegionalSections(); }

  if (!SKIP_IMG) {
    let n = 0;
    for (const p of PLAN.products || []) {
      if (ONLY.length && !ONLY.includes(p.handle)) continue;
      if (++n > LIMIT) break;
      try { await processImages(p); }
      catch (e) { console.error(`❌ ${p.handle}: ${e.message}`); OUT.errors.push(`${p.handle}: ${e.message}`); }
    }
  }

  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
  fs.writeFileSync(path.join(FEEDBACK_DIR, 'last-run-report.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), dryRun: DRY, ...OUT }, null, 2) + '\n');
  await emailSummary();
  console.log(`\nDONE — images:${OUT.images.length} text:${OUT.text.length} dupes:${OUT.dupes.length} errors:${OUT.errors.length}`);
  // Per-item errors are reported via email + report file rather than failing the job,
  // so one bad image doesn't hide the fixes that did land.
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
