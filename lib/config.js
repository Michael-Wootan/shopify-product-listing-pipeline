// Shared runtime configuration: environment variables + JSON config files.
require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const STORE       = process.env.SHOPIFY_STORE || 'your-store.myshopify.com';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

module.exports = {
  ROOT,
  STORE,
  STORE_NAME:     process.env.STORE_NAME || 'Acme Store',
  STOREFRONT_URL: (process.env.STOREFRONT_URL || 'https://www.example.com').replace(/\/$/, ''),
  TOKEN:          process.env.SHOPIFY_ADMIN_TOKEN,
  GEMINI_KEY:     process.env.GEMINI_API_KEY,
  GEMINI_MODEL:   process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
  REST:           `https://${STORE}/admin/api/${API_VERSION}`,
  GQL:            `https://${STORE}/admin/api/${API_VERSION}/graphql.json`,
  // admin.shopify.com/store/<slug>/... uses the part before .myshopify.com
  ADMIN_SLUG:     STORE.replace(/\.myshopify\.com$/, ''),
  NOTIFY_EMAIL:   process.env.NOTIFY_EMAIL,
  // Starting stock for new variants without their own inventory_quantity (production used 999)
  DEFAULT_INVENTORY: Number.isFinite(parseInt(process.env.DEFAULT_INVENTORY, 10)) ? parseInt(process.env.DEFAULT_INVENTORY, 10) : 999,
  COLLECTIONS:    readJson('config/collections.json'),
  IMAGE_RULES:    readJson('config/image-rules.json'),
  REGIONAL:       readJson('config/regional-section.json'),
  sleep:          ms => new Promise(r => setTimeout(r, ms)),
};
