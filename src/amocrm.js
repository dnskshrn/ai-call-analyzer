import axios from 'axios';

const BASE_URL = `https://${process.env.AMO_SUBDOMAIN}.amocrm.ru/api/v4`;

const amoClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.AMO_LONG_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 15_000,
});

/**
 * Normalize a phone number into multiple candidate variants to maximise
 * AmoCRM search coverage (Moldova +373, Russia +7/8, bare number).
 *
 * @param {string} rawPhone
 * @returns {string[]} ordered list of candidates
 */
function buildPhoneCandidates(rawPhone) {
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return [];

  const candidates = new Set();

  // Exact digits string (e.g. "37369123456")
  candidates.add(digits);

  // With leading +
  candidates.add(`+${digits}`);

  // Moldova: 373XXXXXXXX → also try 0XXXXXXXX and XXXXXXXX
  if (digits.startsWith('373') && digits.length === 11) {
    const local = digits.slice(3);       // 8-digit local
    candidates.add(local);
    candidates.add(`0${local}`);
    candidates.add(`+373${local}`);
  }

  // Russia: 7XXXXXXXXXX → also try 8XXXXXXXXXX and 10-digit
  if (digits.startsWith('7') && digits.length === 11) {
    const local = digits.slice(1);
    candidates.add(`8${local}`);
    candidates.add(local);
    candidates.add(`+7${local}`);
  }

  // Russia: 8XXXXXXXXXX → also try 7XXXXXXXXXX
  if (digits.startsWith('8') && digits.length === 11) {
    const local = digits.slice(1);
    candidates.add(`7${local}`);
    candidates.add(`+7${local}`);
    candidates.add(local);
  }

  return [...candidates];
}

/**
 * Search AmoCRM contacts by phone number.
 * Returns the first matching contact with its embedded leads, or null.
 *
 * @param {string} phone
 * @returns {Promise<{contactId: number, leadId: number|null}|null>}
 */
export async function searchByPhone(phone) {
  const candidates = buildPhoneCandidates(phone);

  for (const candidate of candidates) {
    try {
      const { data } = await amoClient.get('/contacts', {
        params: {
          query: candidate,
          with: 'leads',
        },
      });

      const contact = data?._embedded?.contacts?.[0];
      if (!contact) continue;

      const leadId = contact._embedded?.leads?.[0]?.id ?? null;
      return { contactId: contact.id, leadId };
    } catch (err) {
      if (err.response?.status === 204 || err.response?.status === 404) {
        // No results for this candidate — try next
        continue;
      }
      throw err;
    }
  }

  return null;
}

/**
 * Create a new contact + lead in AmoCRM and link them together.
 * Used when searchByPhone() returns null.
 *
 * @param {string} phone
 * @returns {Promise<{contactId: number, leadId: number, entityType: 'leads'}>}
 */
export async function createContactWithLead(phone) {
  // 1. Create contact
  const { data: contactData } = await amoClient.post('/contacts', [
    {
      name: `Звонок ${phone}`,
      custom_fields_values: [
        {
          field_id: 264,
          values: [{ value: phone, enum_code: 'WORK' }],
        },
      ],
    },
  ]);

  const contactId = contactData._embedded.contacts[0].id;
  console.log(`[AMO] Создан контакт #${contactId}`);

  // 2. Create lead
  const { data: leadData } = await amoClient.post('/leads', [
    {
      name: `Входящий звонок ${phone}`,
    },
  ]);

  const leadId = leadData._embedded.leads[0].id;
  console.log(`[AMO] Создана сделка #${leadId}`);

  // 3. Link contact to lead
  await amoClient.post(`/leads/${leadId}/links`, [
    {
      to_entity_id: contactId,
      to_entity_type: 'contacts',
    },
  ]);

  console.log(`[AMO] Контакт #${contactId} привязан к сделке #${leadId}`);

  return { contactId, leadId, entityType: 'leads' };
}

/**
 * Post a common note to a lead or contact in AmoCRM.
 *
 * @param {'leads'|'contacts'} entityType
 * @param {number} entityId
 * @param {string} noteText
 * @returns {Promise<void>}
 */
export async function postNote(entityType, entityId, noteText) {
  await amoClient.post(`/${entityType}/${entityId}/notes`, [
    {
      note_type: 'common',
      params: {
        text: noteText,
      },
    },
  ]);
}
