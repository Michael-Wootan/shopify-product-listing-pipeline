#!/usr/bin/env node
/**
 * push-product.js — Product listing pipeline
 *
 * Reads product spec JSON files from product-specs/pending/, generates product
 * images with a Gemini image model, creates retail and/or wholesale Shopify
 * products as DRAFTS, assigns collections (config/collections.json), attaches
 * FAQ metaobjects, and emails a summary. Each processed spec is moved to
 * product-specs/done/ so the git history shows what was onboarded and when.
 *
 * Usage:
 *   node push-product.js                                  # oldest pending spec
 *   node push-product.js --batch                          # every pending spec
 *   node push-product.js product-specs/pending/foo.json   # one specific file
 *   node push-product.js --dry-run                        # no Shopify writes
 *   node push-product.js --skip-images                    # no image generation
 *   node push-product.js --no-publish                     # don't add drafts to sales channels
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./lib/config');
const { shopify, gql, addMedia, waitForMediaReady, assignVariantMedia, stagedUpload } = require('./lib/shopify');
const { downloadRef, generateImage, buildImagePrompts } = require('./lib/images');
const { ensureFaqMetaobjectType, ensureFaqMetafieldDefinition, attachFaqs } = require('./lib/faq');
const { regionalSection } = require('./lib/regional');
const { sendMail } = require('./lib/mail');

const { sleep, STORE_NAME, STOREFRONT_URL, ADMIN_SLUG, COLLECTIONS, DEFAULT_INVENTORY } = cfg;
const PENDING_DIR = path.join(cfg.ROOT, 'product-specs', 'pending');
const DONE_DIR    = path.join(cfg.ROOT, 'product-specs', 'done');
const IMAGES_DIR  = path.join(cfg.ROOT, 'product-images');

const DRY_RUN     = process.argv.includes('--dry-run');
const BATCH_MODE  = process.argv.includes('--batch');
const SKIP_IMAGES = process.argv.includes('--skip-images');
const NO_PUBLISH  = process.argv.includes('--no-publish');

// ─── Spec validation (fail fast, before any API call) ────────────────────────
function validateSpec(spec, file) {
  const errs = [];
  for (const k of ['product_name', 'product_type', 'sku_base']) if (!spec[k]) errs.push(`missing ${k}`);
  const channels = spec.channels || ['retail', 'wholesale'];
  for (const ch of channels) {
    const s = spec[ch];
    if (!s) { errs.push(`channel "${ch}" listed but spec.${ch} is empty`); continue; }
    for (const k of ['product_title', 'url_handle', 'short_description']) if (!s[k]) errs.push(`${ch}.${k} missing`);
    if (!/^[a-z0-9-]+$/.test(s.url_handle || '')) errs.push(`${ch}.url_handle must be lowercase-kebab`);
    const hasVariants = Array.isArray(s.variants) && s.variants.length;
    if (!hasVariants && !(s.sizes || []).length) errs.push(`${ch} needs sizes[] or options[]+variants[]`);
  }
  if (errs.length) throw new Error(`${path.basename(file)} invalid: ${errs.join('; ')}`);
}

// ─── Collections from config ──────────────────────────────────────────────────
function collectionsFor(spec, channel) {
  const key   = spec.collection_key || spec.product_type;
  const entry = COLLECTIONS.map[key] || COLLECTIONS.map[COLLECTIONS.fallback] || { retail: [], wholesale: [] };
  if (!COLLECTIONS.map[key]) console.warn(`  ⚠️  No collection mapping for "${key}" — using fallback "${COLLECTIONS.fallback}"`);
  return [...new Set([...(entry[channel] || []), ...(COLLECTIONS.base[channel] || [])])];
}

async function addToCollections(productId, collectionIds) {
  for (const colId of collectionIds) {
    try {
      await shopify('POST', '/collects.json', { collect: { product_id: productId, collection_id: colId } });
      await sleep(300);
    } catch (e) {
      // "already exists" is fine — makes re-runs safe
      if (!e.message.includes('taken') && !e.message.includes('already')) {
        console.warn(`  ⚠️  Collection ${colId}: ${e.message.slice(0, 80)}`);
      }
    }
  }
}

// ─── Body HTML ────────────────────────────────────────────────────────────────
function buildBodyHtml(spec, isWholesale) {
  const s = isWholesale ? spec.wholesale : spec.retail;

  const specsRows = Object.entries(s.specs || {})
    .map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join('\n');
  const howToHtml = (s.how_to_use || []).map(item => `<li>${item}</li>`).join('\n');
  const internalLinks = (spec.internal_links || []).map(l => `<a href="${l.url}">${l.anchor}</a>`).join(' · ');
  const schemaTag = s.product_schema_json
    ? `<script type="application/ld+json">\n${JSON.stringify(s.product_schema_json, null, 2)}\n</script>`
    : '';

  // FAQs live in metaobjects (rendered by the theme), not in the body HTML
  return `
${schemaTag}

<p class="product-short-desc">${s.short_description}</p>

${s.full_description || ''}

${howToHtml ? `<h2>How to Use</h2>\n<ul>\n${howToHtml}\n</ul>` : ''}

${specsRows ? `<h2>Product Details</h2>\n<table class="product-specs">\n  <tbody>\n${specsRows}\n  </tbody>\n</table>` : ''}

${internalLinks ? `<p class="related-links">Related: ${internalLinks}</p>` : ''}

${spec.regional_section ? regionalSection(s.product_title, isWholesale) : ''}
`.trim();
}

// ─── Variant images (branded lines with a per-variant option, e.g. Flavor) ───
// For each spec variant carrying `image_url` (existing photo) or `image_ref_url` (label art or a
// photo to render from), attach one image and pin it to that variant so the gallery swaps when the
// shopper picks it. `variant_image_prompt` may use {OPTION1}, {OPTION2} placeholders.
async function attachVariantImages(s, product, slug) {
  if (!Array.isArray(s.variants) || !product?.variants) return 0;
  const sources = [];
  for (const v of s.variants) {
    const restVariant = product.variants.find(rv =>
      rv.option1 === v.options[0] && (rv.option2 || null) === (v.options[1] || null) && (rv.option3 || null) === (v.options[2] || null));
    if (!restVariant) { console.warn(`  ⚠️  variant not found for ${v.options.join(' / ')}`); continue; }
    const alt = `${s.product_title.split('—')[0].split('|')[0].trim()} — ${v.options.join(' / ')}`;
    if (v.image_url) { sources.push({ variantId: restVariant.admin_graphql_api_id, src: v.image_url, alt }); continue; }
    if (v.image_ref_url && !SKIP_IMAGES) {
      try {
        const ref = await downloadRef(v.image_ref_url, IMAGES_DIR);
        const prompt = (v.image_prompt || s.variant_image_prompt || '')
          .replace(/\{OPTION1\}/g, v.options[0] || '').replace(/\{OPTION2\}/g, v.options[1] || '');
        if (!prompt) { console.warn(`  ⚠️  no variant_image_prompt for ${alt}`); continue; }
        const file = await generateImage({ prompt, outDir: IMAGES_DIR, slug: `${slug}-${v.sku_suffix}`.toLowerCase(),
          label: 'variant', refFilePath: ref, refMode: v.image_ref_mode || 'label' });
        if (!file) continue;
        sources.push({ variantId: restVariant.admin_graphql_api_id, src: await stagedUpload(file), alt });
        await sleep(1000);
      } catch (e) { console.warn(`  ⚠️  variant image (${alt}): ${e.message.slice(0, 120)}`); }
    }
  }
  if (!sources.length) return 0;
  const mediaIds = await addMedia(product.admin_graphql_api_id, sources.map(x => ({ src: x.src, alt: x.alt })));
  if (!(await waitForMediaReady(mediaIds))) console.warn('  ⚠️  some variant media not READY after 60s — assigning anyway');
  await assignVariantMedia(product.admin_graphql_api_id,
    sources.map((x, i) => ({ variantId: x.variantId, mediaId: mediaIds[i] })).filter(p => p.mediaId));
  console.log(`  ✅  ${sources.length} variant image(s) attached and assigned`);
  return sources.length;
}

// ─── Create product (draft) ───────────────────────────────────────────────────
async function createProduct(spec, isWholesale, images) {
  const s     = isWholesale ? spec.wholesale : spec.retail;
  const label = isWholesale ? 'WHOLESALE' : 'RETAIL';
  console.log(`\n  📦  Creating ${label} product draft...`);

  // A spec may define its own options + variants (e.g. Flavor × Size) instead of the
  // default single "Size" option built from `sizes`.
  const hasCustomVariants = Array.isArray(s.options) && Array.isArray(s.variants) && s.variants.length > 0;
  const toVariant = (opts, v) => ({
    ...opts,
    price:                String(v.price),
    sku:                  `${spec.sku_base}-${v.sku_suffix}`.toUpperCase(),
    inventory_management: 'shopify',
    inventory_quantity:   v.inventory_quantity ?? DEFAULT_INVENTORY,   // per-variant override, else env default
    weight:               v.weight_grams || 0,
    weight_unit:          'g',
    requires_shipping:    true,
    taxable:              true,
  });
  const variants = hasCustomVariants
    ? s.variants.map(v => toVariant({ option1: v.options[0], option2: v.options[1], option3: v.options[2] }, v))
    : (s.sizes || []).map(size => toVariant({ option1: size.title }, size));

  const productPayload = {
    product: {
      title:        s.product_title,
      handle:       s.url_handle,
      body_html:    buildBodyHtml(spec, isWholesale),
      vendor:       spec.vendor || STORE_NAME,
      product_type: spec.product_type_label,
      status:       'draft',                          // always draft: a human reviews before going live
      tags:         (s.tags || []).join(', '),
      options:      hasCustomVariants
        ? s.options.map(o => ({ name: o.name, values: o.values }))
        : [{ name: 'Size', values: (s.sizes || []).map(z => z.title) }],
      variants,
      metafields: [
        { namespace: 'global', key: 'title_tag',       type: 'single_line_text_field', value: s.seo_title || s.product_title },
        { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: s.meta_description || s.short_description },
      ],
    },
  };

  // Existing CDN photos (`image_urls`) go first; generated images follow.
  const urlImages = (s.image_urls || []).map((u, i) => ({ src: u.src, alt: u.alt || s.product_title, position: i + 1 }));
  if (urlImages.length || images.length) {
    productPayload.product.images = [
      ...urlImages,
      ...images.map((img, i) => ({
        attachment: fs.readFileSync(img.filePath).toString('base64'),
        filename:   path.basename(img.filePath),
        alt:        `${s.product_title} — ${img.label}`,
        position:   urlImages.length + i + 1,
      })),
    ];
  }

  if (DRY_RUN) {
    console.log(`  🔍  [DRY RUN] Would create: "${s.product_title}" (${variants.length} variants, ${urlImages.length + images.length} images)`);
    return { id: 0, admin_graphql_api_id: null, handle: s.url_handle, _dry_run: true };
  }

  // Idempotency guard: if a product with this handle already exists, SKIP creation instead of
  // letting Shopify silently create "<handle>-1". Re-running a spec never duplicates a listing.
  const existing = await gql(`query($q:String!){ products(first:1, query:$q){ nodes{ id handle } } }`, { q: `handle:${s.url_handle}` });
  const dupe = existing.products.nodes.find(n => n.handle === s.url_handle);
  if (dupe) {
    console.warn(`  ⏭️   SKIP: handle "${s.url_handle}" already exists (${dupe.id}) — not creating a duplicate`);
    return { id: parseInt(dupe.id.split('/').pop(), 10), admin_graphql_api_id: dupe.id, handle: s.url_handle, _skipped_existing: true };
  }

  const { product } = await shopify('POST', '/products.json', productPayload);
  console.log(`  ✅  ${label} draft created: /products/${product.handle} (ID ${product.id})`);
  return product;
}

// ─── Make the draft available on every sales channel ─────────────────────────
// This is the flow that ran in production: the product is set ACTIVE (channel publishing
// was done against active products), published to every channel, then set back to DRAFT.
// The product is live for the few seconds in between; it ends as a draft that only needs
// its status flipped after review. Use --no-publish to skip this step entirely.
async function publishToAllChannels(productGid, productRestId) {
  console.log('  📡  Setting product to active status...');
  try {
    await shopify('PUT', `/products/${productRestId}.json`, { product: { id: productRestId, status: 'active' } });
    console.log('  ✅  Product status set to active');
  } catch (e) {
    console.warn(`  ⚠️  Could not set active status: ${e.message.slice(0, 100)}`);
  }
  await sleep(500);

  const { publications } = await gql(`{ publications(first: 20) { nodes { id name } } }`);
  for (const pub of publications.nodes) {
    try {
      const r = await gql(`
        mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { userErrors { field message } }
        }`, { id: productGid, input: [{ publicationId: pub.id }] });
      const errs = r.publishablePublish?.userErrors;
      if (errs?.length) console.warn(`  ⚠️  ${pub.name}: ${JSON.stringify(errs).slice(0, 150)}`);
      else console.log(`  ✅  Channel: ${pub.name}`);
      await sleep(300);
    } catch (e) {
      console.warn(`  ⚠️  ${pub.name}: ${e.message.slice(0, 100)}`);
    }
  }

  // Back to draft: a human reviews before the listing goes live
  try {
    await shopify('PUT', `/products/${productRestId}.json`, { product: { id: productRestId, status: 'draft' } });
    console.log('  ✅  Product status set back to draft');
  } catch (e) {
    console.warn(`  ⚠️  Could not set draft status: ${e.message.slice(0, 100)}`);
  }
}

// ─── Summary email ────────────────────────────────────────────────────────────
function productLine(label, s, product) {
  if (!product) return '';
  const status = product._dry_run ? 'DRY RUN — not created'
    : product._skipped_existing ? 'SKIPPED — handle already exists'
    : 'Draft created';
  return `
${label}: ${s.product_title}
  Status:    ${status}
  Admin:     https://admin.shopify.com/store/${ADMIN_SLUG}/products/${product.id}
  Live URL (after publish): ${STOREFRONT_URL}/products/${product.handle}
  Prices:    ${(s.sizes || s.variants || []).map(v => `${v.title || v.options.join('/')}: $${v.price}`).join(' | ')}
  FAQs:      ${(s.faqs || []).length}`;
}

async function sendSummary(spec, retailProduct, wholesaleProduct) {
  const text = `
New product drafts for ${STORE_NAME}:
${productLine('RETAIL', spec.retail, retailProduct)}
${productLine('WHOLESALE', spec.wholesale, wholesaleProduct)}

Images generated: ${spec._images_generated || 0}   Variant images: ${spec._variant_images || 0}

Notes from the spec:
${spec.pricing_notes || '—'}

Review the drafts in Shopify admin and set them to Active when ready.
`.trim();
  await sendMail({ subject: `[${STORE_NAME}] New product draft: ${spec.retail?.product_title || spec.wholesale?.product_title}`, text });
}

// ─── Process one spec ─────────────────────────────────────────────────────────
async function processSpec(specFile) {
  console.log(`\n  📋  Processing: ${path.basename(specFile)}`);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  validateSpec(spec, specFile);

  const channels    = spec.channels || ['retail', 'wholesale'];
  const doRetail    = channels.includes('retail')    && spec.retail;
  const doWholesale = channels.includes('wholesale') && spec.wholesale;
  console.log(`  📦  ${spec.product_name} | type: ${spec.product_type} | channels: ${channels.join(', ')}`);

  // 1. Images — retail and wholesale get SEPARATE shot lists. Every shot after the first is
  //    anchored to the first (hero) image so all photos show the same product.
  let retailImages = [], wholesaleImages = [];
  spec._images_generated = 0;
  if (!SKIP_IMAGES) {
    for (const [on, s, isWs, out, slug] of [
      [doRetail,    spec.retail,    false, retailImages,    spec.sku_base],
      [doWholesale, spec.wholesale, true,  wholesaleImages, `${spec.sku_base}-wholesale`],
    ]) {
      if (!on) continue;
      console.log(`\n  🎨  Generating ${isWs ? 'WHOLESALE' : 'RETAIL'} images...`);
      const prompts = Array.isArray(s.image_prompts) ? s.image_prompts : buildImagePrompts(spec, isWs);
      for (const p of prompts) {
        const anchor = retailImages[0]?.filePath || out[0]?.filePath || null;
        const ref = p.ref_url ? await downloadRef(p.ref_url, IMAGES_DIR) : anchor;
        const filePath = await generateImage({ prompt: p.prompt, outDir: IMAGES_DIR, slug, label: p.label,
          refFilePath: ref, refMode: p.ref_url ? (p.ref_mode || 'label') : 'product' });
        if (filePath) out.push({ filePath, label: p.label });
        await sleep(1000);
      }
      console.log(`  🖼️   ${out.length}/${prompts.length} images generated`);
    }
    spec._images_generated = retailImages.length + wholesaleImages.length;
  } else {
    console.log('\n  🎨  Skipping image generation (--skip-images)');
  }

  // 2. FAQ storage definitions (idempotent)
  if (!DRY_RUN) {
    await ensureFaqMetaobjectType();
    await ensureFaqMetafieldDefinition();
  }

  // 3. Products
  const created = {};
  for (const [on, ch, imgs, slug] of [
    [doRetail,    'retail',    retailImages,    spec.sku_base],
    [doWholesale, 'wholesale', wholesaleImages, `${spec.sku_base}-wholesale`],
  ]) {
    if (!on) { console.log(`\n  ⏭️   Skipping ${ch} (not in channels)`); continue; }
    const product = await createProduct(spec, ch === 'wholesale', imgs);
    created[ch] = product;
    await sleep(800);
    if (DRY_RUN || product._skipped_existing) continue;

    try { spec._variant_images = (spec._variant_images || 0) + await attachVariantImages(spec[ch], product, slug); }
    catch (e) { console.warn(`  ⚠️  ${ch} variant images: ${e.message.slice(0, 120)}`); }

    // 4. Collections, FAQs, channels — only for products created in this run
    await addToCollections(product.id, collectionsFor(spec, ch));
    console.log('  ✅  Collections assigned');
    await attachFaqs(product.admin_graphql_api_id, spec[ch].faqs, { sleep });
    if (!NO_PUBLISH) await publishToAllChannels(product.admin_graphql_api_id, product.id);
  }

  // 5. Summary email (always sent, including skips, so nothing happens silently)
  await sendSummary(spec, created.retail, created.wholesale);

  // 6. Archive the spec. The workflow commits this move, so git history is the onboarding log.
  if (!DRY_RUN) {
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.renameSync(specFile, path.join(DONE_DIR, path.basename(specFile)));
    console.log('\n  📁  Spec archived to product-specs/done/');
  }
  return created;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  ${STORE_NAME} — Product Listing Pipeline`);
  console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}${BATCH_MODE ? ' | BATCH' : ''}${SKIP_IMAGES ? ' | NO IMAGES' : ''}${NO_PUBLISH ? ' | NO CHANNELS' : ''}`);
  console.log('══════════════════════════════════════════════════════\n');

  if (!cfg.TOKEN && !DRY_RUN) { console.error('❌  SHOPIFY_ADMIN_TOKEN not set'); process.exit(1); }

  const explicitFile = process.argv.slice(2).find(a => a.endsWith('.json'));
  let specFiles = explicitFile
    ? [explicitFile]
    : (fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR) : [])
        .filter(f => f.endsWith('.json')).sort().map(f => path.join(PENDING_DIR, f));

  if (!specFiles.length) { console.log('  ✅  No pending specs in product-specs/pending/. Nothing to do.'); return; }
  if (!BATCH_MODE && !explicitFile) specFiles = [specFiles[0]];
  console.log(`  📋  ${specFiles.length} spec(s) queued\n`);

  let processed = 0, failed = 0;
  for (const [i, specFile] of specFiles.entries()) {
    try {
      await processSpec(specFile);
      processed++;
    } catch (e) {
      console.error(`\n  ❌  FAILED: ${path.basename(specFile)} — ${e.message}`);
      failed++;
      if (!BATCH_MODE) process.exit(1);   // batch mode: one bad spec doesn't block the rest
    }
    if (BATCH_MODE && i < specFiles.length - 1) await sleep(2000);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Done. Processed: ${processed} | Failed: ${failed}`);
  console.log('  Review drafts in Shopify admin and publish when ready.');
  console.log('══════════════════════════════════════════════════════\n');
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('❌  Fatal:', e.message); process.exit(1); });
