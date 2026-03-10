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
 * Create a new contact + lead in AmoCRM in two requests.
 * Contact is embedded directly in the lead creation body — no separate linking call needed.
 * Used when searchByPhone() returns null.
 *
 * @param {string} phone
 * @returns {Promise<{contactId: number, leadId: number, entityType: 'leads'}>}
 */
export async function createContactWithLead(phone) {
  // 1. Create contact with phone field (field_code instead of field_id)
  let contactId;
  try {
    const { data: contactData } = await amoClient.post('/contacts', [
      {
        name: `Звонок ${phone}`,
        custom_fields_values: [
          {
            field_code: 'PHONE',
            values: [{ value: phone, enum_code: 'WORK' }],
          },
        ],
      },
    ]);

    contactId = contactData._embedded.contacts[0].id;
    console.log(`[AMO] Создан контакт #${contactId}`);
  } catch (err) {
    console.error('[AMO] 400 error body:', JSON.stringify(err.response?.data));
    console.error('[AMO] 400 request body:', JSON.stringify(err.config?.data));
    throw err;
  }

  // 2. Create lead with contact embedded — AmoCRM links them automatically
  let leadId;
  try {
    const { data: leadData } = await amoClient.post('/leads', [
      {
        name: `Входящий звонок ${phone}`,
        _embedded: {
          contacts: [{ id: contactId }],
        },
      },
    ]);

    leadId = leadData._embedded.leads[0].id;
    console.log(`[AMO] Создана сделка #${leadId} с привязанным контактом #${contactId}`);
  } catch (err) {
    console.error('[AMO] 400 error body:', JSON.stringify(err.response?.data));
    console.error('[AMO] 400 request body:', JSON.stringify(err.config?.data));
    throw err;
  }

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

/**
 * Create a follow-up task on a lead in AmoCRM.
 *
 * @param {number} leadId
 * @param {number} responsibleUserId
 * @param {string} text
 * @param {number} deadlineDays  Number of days from now until the task deadline.
 * @returns {Promise<void>}
 */
export async function createTask(leadId, responsibleUserId, text, deadlineDays) {
  await amoClient.post('/tasks', [
    {
      task_type_id: 1,
      text,
      complete_till: Math.floor(Date.now() / 1000) + deadlineDays * 86400,
      entity_type: 'leads',
      entity_id: leadId,
      responsible_user_id: responsibleUserId,
    },
  ]);
}

/**
 * Replace tags on a lead (additive — AmoCRM merges by tag name).
 *
 * @param {number} leadId
 * @param {string[]} tags
 * @returns {Promise<void>}
 */
export async function updateLeadTags(leadId, tags) {
  await amoClient.patch(`/leads/${leadId}`, {
    _embedded: {
      tags: tags.map((name) => ({ name })),
    },
  });
}

/**
 * Update a contact's display name.
 *
 * @param {number} contactId
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function updateContactName(contactId, name) {
  await amoClient.patch('/contacts', [{ id: contactId, name }]);
}

/**
 * Update a lead's name.
 *
 * @param {number} leadId
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function updateLeadName(leadId, name) {
  await amoClient.patch('/leads', [{ id: leadId, name }]);
}

/**
 * Fetch the first user in the account and return their ID.
 * Used as a default responsible_user_id for tasks.
 *
 * @returns {Promise<number>}
 */
export async function getResponsibleUser() {
  const { data } = await amoClient.get('/users', { params: { limit: 1 } });
  return data._embedded.users[0].id;
}
