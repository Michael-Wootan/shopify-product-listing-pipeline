// Versioned, marker-wrapped "international availability" description block (config/regional-section.json).
const { REGIONAL, STORE_NAME } = require('./config');

const shortName = title => (title || '').split('—')[0].split('|')[0].trim();

function regionalSection(title, isWholesale) {
  if (!REGIONAL.enabled) return '';
  const tpl = isWholesale ? REGIONAL.wholesale_html : REGIONAL.retail_html;
  const body = tpl
    .replace(/\{NAME\}/g, shortName(title))
    .replace(/\{STORE_NAME\}/g, STORE_NAME)
    .replace(/\{COUNTRIES\}/g, REGIONAL.countries.join(', '));
  return `<!-- ${REGIONAL.marker} ${REGIONAL.version} -->\n${body}\n<!-- /${REGIONAL.marker} -->`;
}

const sectionRegex = () =>
  new RegExp(`\\n?<!-- ${REGIONAL.marker}[^>]*-->[\\s\\S]*?<!-- \\/${REGIONAL.marker} -->`, 'g');

/**
 * Returns { html, action } where action is 'current' | 'replaced' | 'added'.
 * - current version already present → unchanged
 * - older version present → replaced in place
 * - absent → inserted before the disclaimer marker if there is one, else appended
 */
function upsertRegionalSection(bodyHtml, title, isWholesale) {
  const body = bodyHtml || '';
  if (body.includes(`${REGIONAL.marker} ${REGIONAL.version}`)) return { html: body, action: 'current' };
  const section = regionalSection(title, isWholesale);
  if (body.includes(REGIONAL.marker)) return { html: body.replace(sectionRegex(), '\n' + section), action: 'replaced' };
  const at = REGIONAL.insert_before_marker ? body.indexOf(REGIONAL.insert_before_marker) : -1;
  const html = at >= 0 ? body.slice(0, at) + section + '\n' + body.slice(at) : body + '\n' + section;
  return { html, action: 'added' };
}

module.exports = { regionalSection, upsertRegionalSection };
