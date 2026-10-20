// FAQ storage as Shopify metaobjects (type faq_item) referenced from product metafield custom.faqs.
const { gql } = require('./shopify');

async function ensureFaqMetaobjectType() {
  const data = await gql(`{ metaobjectDefinitions(first: 50) { nodes { id type } } }`);
  if (data.metaobjectDefinitions.nodes.some(d => d.type === 'faq_item')) return;
  await gql(`
    mutation CreateMetaobjectDef($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition { id type }
        userErrors { field message }
      }
    }`, {
    definition: {
      type: 'faq_item',
      name: 'FAQ Item',
      fieldDefinitions: [
        { name: 'Question', key: 'question', type: 'single_line_text_field', required: true },
        { name: 'Answer',   key: 'answer',   type: 'multi_line_text_field',  required: true },
      ],
    },
  });
  console.log('  ✅  Created faq_item metaobject type');
}

async function ensureFaqMetafieldDefinition() {
  const data = await gql(`{
    metafieldDefinitions(first: 50, ownerType: PRODUCT, namespace: "custom") {
      nodes { id namespace key type { name } }
    }
  }`);
  if (data.metafieldDefinitions.nodes.some(d => d.key === 'faqs' && d.namespace === 'custom')) {
    console.log('  ✅  Metafield definition custom.faqs already exists');
    return;
  }
  // A definition is required before Shopify accepts list.metaobject_reference values
  const result = await gql(`
    mutation CreateMetafieldDef($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id namespace key }
        userErrors { field message code }
      }
    }`, {
    definition: {
      namespace: 'custom', key: 'faqs', name: 'FAQs', ownerType: 'PRODUCT',
      type: 'list.metaobject_reference',
      validations: [{ name: 'metaobject_definition_id', value: 'faq_item' }],
    },
  });
  if (result.metafieldDefinitionCreate?.userErrors?.length) {
    console.warn(`  ⚠️  Metafield def errors: ${JSON.stringify(result.metafieldDefinitionCreate.userErrors).slice(0, 200)}`);
  } else {
    console.log('  ✅  Created metafield definition: custom.faqs (list.metaobject_reference → faq_item)');
  }
}

async function createFaqMetaobject(question, answer) {
  const data = await gql(`
    mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`, {
    metaobject: {
      type: 'faq_item',
      capabilities: { publishable: { status: 'ACTIVE' } },
      fields: [{ key: 'question', value: question }, { key: 'answer', value: answer }],
    },
  });
  const r = data.metaobjectCreate;
  if (r.userErrors?.length) throw new Error(JSON.stringify(r.userErrors));
  return r.metaobject.id;
}

async function productHasFaqs(productGid) {
  const d = await gql(`query($id:ID!){ product(id:$id){ metafield(namespace:"custom", key:"faqs"){ value } } }`, { id: productGid });
  return Boolean(d.product?.metafield?.value);
}

async function assignFaqsToProduct(productGid, faqGids) {
  const data = await gql(`
    mutation SetFaqMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message code }
      }
    }`, {
    metafields: [{ ownerId: productGid, namespace: 'custom', key: 'faqs', type: 'list.metaobject_reference', value: JSON.stringify(faqGids) }],
  });
  if (data.metafieldsSet.userErrors?.length) throw new Error(JSON.stringify(data.metafieldsSet.userErrors));
  console.log(`  ✅  FAQ metafield assigned with ${faqGids.length} references`);
}

// Create metaobjects for each {q, a} and attach them. Skips products that already have FAQs.
async function attachFaqs(productGid, faqs, { sleep } = {}) {
  if (!faqs?.length) return 0;
  if (await productHasFaqs(productGid)) { console.log('  ⏭️   FAQs already present — skipping'); return 0; }
  const gids = [];
  for (const f of faqs) {
    try {
      gids.push(await createFaqMetaobject(f.q, f.a));
      if (sleep) await sleep(250);
    } catch (e) {
      console.warn(`  ⚠️  FAQ metaobject error: ${e.message.slice(0, 80)}`);
    }
  }
  if (gids.length) await assignFaqsToProduct(productGid, gids);
  return gids.length;
}

module.exports = { ensureFaqMetaobjectType, ensureFaqMetafieldDefinition, attachFaqs };
