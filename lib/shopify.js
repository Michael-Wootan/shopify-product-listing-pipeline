// Shopify Admin API helpers (REST + GraphQL), staged uploads and media operations.
const fs   = require('fs');
const path = require('path');
const { REST, GQL, TOKEN, sleep } = require('./config');

const HEADERS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };

// ─── REST ─────────────────────────────────────────────────────────────────────
async function shopify(method, endpoint, body) {
  const res = await fetch(`${REST}${endpoint}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!text.trim()) throw new Error(`Shopify empty response: ${res.status} ${endpoint}`);
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(`Shopify ${method} ${endpoint}: ${res.status} — ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  return data;
}

// ─── GraphQL with retry on 429 / Throttled ────────────────────────────────────
async function gql(query, variables = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(GQL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ query, variables }) });
    if (res.status === 429) { await sleep(2000 * attempt); continue; }
    const data = await res.json();
    if (data.errors) {
      const throttled = JSON.stringify(data.errors).includes('Throttled');
      if (throttled && attempt < 3) { await sleep(2500 * attempt); continue; }
      throw new Error(`GQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
    }
    return data.data;
  }
  throw new Error('GQL: exhausted retries');
}

async function getProductByHandle(handle) {
  const d = await gql(`query($q:String!){ products(first:1, query:$q){ nodes{ id title handle status descriptionHtml
    media(first:30){ nodes{ id alt ... on MediaImage { image { url } } } } } } }`, { q: `handle:${handle}` });
  const p = d.products.nodes[0];
  if (p && p.handle !== handle) return null;   // search is fuzzy; require an exact handle match
  return p || null;
}

// ─── Staged upload of a local image to Shopify's CDN ─────────────────────────
async function stagedUpload(filePath) {
  const filename = path.basename(filePath);
  const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const d = await gql(`mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
    stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ message } } }`,
    { input: [{ filename, mimeType, fileSize: String(fs.statSync(filePath).size), resource: 'IMAGE', httpMethod: 'POST' }] });
  const t = d.stagedUploadsCreate.stagedTargets[0];
  if (!t) throw new Error('staged upload: no target');
  const form = new FormData();
  t.parameters.forEach(p => form.append(p.name, p.value));
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: mimeType }), filename);
  const up = await fetch(t.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`S3 upload ${up.status}`);
  return t.resourceUrl;
}

// ─── Media ops ────────────────────────────────────────────────────────────────
async function addMedia(productId, sources /* [{src, alt}] */) {
  if (!sources.length) return [];
  const d = await gql(`mutation($productId:ID!, $media:[CreateMediaInput!]!){
    productCreateMedia(productId:$productId, media:$media){ media{ ... on MediaImage { id } } mediaUserErrors{ message } } }`,
    { productId, media: sources.map(s => ({ originalSource: s.src, alt: s.alt, mediaContentType: 'IMAGE' })) });
  const errs = d.productCreateMedia.mediaUserErrors;
  if (errs?.length) throw new Error(`createMedia: ${JSON.stringify(errs).slice(0, 200)}`);
  return d.productCreateMedia.media.map(m => m.id);
}

async function deleteMedia(productId, mediaIds) {
  if (!mediaIds.length) return;
  const d = await gql(`mutation($productId:ID!, $mediaIds:[ID!]!){
    productDeleteMedia(productId:$productId, mediaIds:$mediaIds){ deletedMediaIds mediaUserErrors{ message } } }`,
    { productId, mediaIds });
  const errs = d.productDeleteMedia.mediaUserErrors;
  if (errs?.length) throw new Error(`deleteMedia: ${JSON.stringify(errs).slice(0, 200)}`);
}

async function moveMediaFirst(productId, mediaId) {
  await gql(`mutation($id:ID!, $moves:[MoveInput!]!){
    productReorderMedia(id:$id, moves:$moves){ job{ id } userErrors{ message } } }`,
    { id: productId, moves: [{ id: mediaId, newPosition: '0' }] });
}

async function waitForMediaReady(mediaIds, maxWaitMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const d = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on MediaImage { id status } } }`, { ids: mediaIds });
    const statuses = (d.nodes || []).map(n => n?.status);
    if (statuses.every(st => st === 'READY')) return true;
    if (statuses.some(st => st === 'FAILED')) return false;
    await sleep(3000);
  }
  return false;
}

async function assignVariantMedia(productGid, pairs /* [{variantId, mediaId}] */) {
  if (!pairs.length) return;
  const d = await gql(`mutation($productId:ID!, $variants:[ProductVariantsBulkInput!]!){
    productVariantsBulkUpdate(productId:$productId, variants:$variants){ productVariants{ id } userErrors{ field message } } }`,
    { productId: productGid, variants: pairs.map(p => ({ id: p.variantId, mediaId: p.mediaId })) });
  const errs = d.productVariantsBulkUpdate.userErrors;
  if (errs?.length) throw new Error(`variant media: ${JSON.stringify(errs).slice(0, 200)}`);
}

module.exports = {
  shopify, gql, getProductByHandle, stagedUpload,
  addMedia, deleteMedia, moveMediaFirst, waitForMediaReady, assignVariantMedia,
};
