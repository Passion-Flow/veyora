/**
 * Vault item schema: templates, field layouts, and type metadata.
 * Template definitions drive both the create/edit modal and the detail view,
 * so adding a template type is a data change, not a view change.
 */
export const TYPES = Object.freeze({
  login:     Object.freeze({ key: 'login',     icon: 'key',      code: 'LG' }),
  note:      Object.freeze({ key: 'note',      icon: 'note',     code: 'NO' }),
  'api-token': Object.freeze({ key: 'api-token', icon: 'token',  code: 'TK' }),
  ssh:       Object.freeze({ key: 'ssh',       icon: 'terminal', code: 'SS' }),
  identity:  Object.freeze({ key: 'identity',  icon: 'user',     code: 'ID' }),
});

/**
 * Field layout per template.
 *   k        property name on the entry object
 *   labelKey i18n key for the field label
 *   phKey    i18n key for the placeholder (optional)
 *   secret   masked until revealed
 *   gen      offers inline generation
 *   textarea multi-line input
 *   mono     monospace input
 *   span     full-width in the modal grid
 */
export const TEMPLATE_FIELDS = Object.freeze({
  login: Object.freeze([
    Object.freeze({ k: 'name', labelKey: 'field.name', phKey: 'ph.name', span: true }),
    Object.freeze({ k: 'username', labelKey: 'field.username', phKey: 'ph.username' }),
    Object.freeze({ k: 'website', labelKey: 'field.website', phKey: 'ph.website' }),
    Object.freeze({ k: 'secret', labelKey: 'field.password', secret: true, gen: true }),
    Object.freeze({ k: 'totpSecret', labelKey: 'field.totpSecret', phKey: 'ph.totpSecret' }),
    Object.freeze({ k: 'notes', labelKey: 'field.notes', phKey: 'ph.notes', textarea: true, span: true }),
  ]),
  note: Object.freeze([
    Object.freeze({ k: 'name', labelKey: 'field.name', phKey: 'ph.noteName', span: true }),
    Object.freeze({ k: 'secret', labelKey: 'field.content', phKey: 'ph.content', textarea: true, mono: true, span: true }),
  ]),
  'api-token': Object.freeze([
    Object.freeze({ k: 'name', labelKey: 'field.name', phKey: 'ph.tokenName', span: true }),
    Object.freeze({ k: 'service', labelKey: 'field.service', phKey: 'ph.service' }),
    Object.freeze({ k: 'secret', labelKey: 'field.token', secret: true, gen: true, span: true }),
    Object.freeze({ k: 'notes', labelKey: 'field.notes', phKey: 'ph.notes', textarea: true, span: true }),
  ]),
  ssh: Object.freeze([
    Object.freeze({ k: 'name', labelKey: 'field.name', phKey: 'ph.sshName', span: true }),
    Object.freeze({ k: 'host', labelKey: 'field.host', phKey: 'ph.host' }),
    Object.freeze({ k: 'secret', labelKey: 'field.passphrase', secret: true, gen: true }),
    Object.freeze({ k: 'secretkey', labelKey: 'field.privateKey', phKey: 'ph.privateKey', textarea: true, mono: true, span: true }),
  ]),
  identity: Object.freeze([
    Object.freeze({ k: 'name', labelKey: 'field.itemName', phKey: 'ph.itemName', span: true }),
    Object.freeze({ k: 'fullName', labelKey: 'field.fullName', phKey: 'ph.fullName' }),
    Object.freeze({ k: 'secret', labelKey: 'field.idNumber', secret: true, span: true }),
    Object.freeze({ k: 'notes', labelKey: 'field.notes', phKey: 'ph.notes', textarea: true, span: true }),
  ]),
});

/** Templates whose primary secret field is required before saving. */
export const SECRET_REQUIRED = Object.freeze(['login', 'api-token', 'identity', 'note']);

/** Derive a storage-safe record id from an entry name. */
export function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'entry';
}

/**
 * Ordered field descriptors for the detail view of an entry.
 * Returned labelKey selection depends on the template type.
 */
export function detailFields(entry) {
  const fields = [];
  if (entry.username) fields.push({ labelKey: 'field.username', value: entry.username, mono: true, copy: true });
  if (entry.fullName) fields.push({ labelKey: 'field.fullName', value: entry.fullName });
  if (entry.website) fields.push({ labelKey: 'field.website', value: entry.website, mono: true, copy: true });
  if (entry.service) fields.push({ labelKey: 'field.service', value: entry.service });
  if (entry.host) fields.push({ labelKey: 'field.host', value: entry.host, mono: true, copy: true });
  const secretLabelKeys = {
    login: 'field.password', 'api-token': 'field.token', ssh: 'field.passphrase',
    identity: 'field.idNumber', note: 'field.content',
  };
  fields.push({
    labelKey: secretLabelKeys[entry.type] || 'field.password',
    value: entry.secret, mono: true, secret: true, copy: true,
    pre: entry.type === 'ssh' || entry.type === 'note',
  });
  if (entry.secretkey) {
    fields.push({ labelKey: 'field.privateKey', value: entry.secretkey, mono: true, secret: true, copy: true, pre: true });
  }
  if (entry.totpSecret) fields.push({ labelKey: 'field.totpSecret', value: entry.totpSecret, mono: true, copy: true, totp: true });
  if (entry.notes) fields.push({ labelKey: 'field.notes', value: entry.notes, notes: true });
  return fields;
}
