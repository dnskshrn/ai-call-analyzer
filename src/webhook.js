import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import OpenAI from 'openai';
import {
  searchByPhone,
  createContactWithLead,
  postNote,
  createTask,
  updateLeadTags,
  updateContactName,
  updateLeadName,
  getResponsibleUser,
} from './amocrm.js';
import { analyzeTranscript } from './analyze.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CALL_TYPE_LABEL = { in: 'Входящий', out: 'Исходящий' };

/** Cached responsible user ID — fetched once at first use. */
let cachedResponsibleUserId = null;

/**
 * @returns {Promise<number>}
 */
async function getResponsibleUserId() {
  if (cachedResponsibleUserId) return cachedResponsibleUserId;
  try {
    cachedResponsibleUserId = await getResponsibleUser();
    console.log(`[AMO] Ответственный пользователь по умолчанию: #${cachedResponsibleUserId}`);
  } catch (err) {
    console.error('[AMO] Не удалось получить пользователя:', err.message);
    cachedResponsibleUserId = null;
  }
  return cachedResponsibleUserId;
}

/**
 * Format seconds into a human-readable "Xм Yс" string.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}м ${s}с` : `${s}с`;
}

/**
 * Build the final CRM note header + AI summary block.
 *
 * @param {{ type: string, duration: number, phone: string, callid: string }} meta
 * @param {string} summary
 * @returns {string}
 */
function buildNoteText(meta, summary) {
  const typeLabel = CALL_TYPE_LABEL[meta.type] ?? meta.type;
  const durationStr = formatDuration(Number(meta.duration));

  return [
    `📞 ${typeLabel} звонок | ${durationStr} | ${meta.phone}`,
    `🆔 Call ID: ${meta.callid}`,
    '',
    summary,
  ].join('\n');
}

/**
 * Download MP3 from url, stream it to a temp file, return the file path.
 *
 * @param {string} url
 * @param {string} callid
 * @returns {Promise<string>}
 */
async function downloadMp3(url, callid) {
  const tmpPath = path.join('/tmp', `call_${callid}_${Date.now()}.mp3`);
  const writer = fs.createWriteStream(tmpPath);
  const response = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  await pipeline(response.data, writer);
  return tmpPath;
}

/**
 * Transcribe an MP3 file using OpenAI Whisper.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function transcribeAudio(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1',
    language: 'ru',
  });
  return transcription.text;
}

/**
 * Express route handler for POST /webhook
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleWebhook(req, res) {
  const { type, status, phone, link, callid, duration, crm_token } = req.body;

  // ── Step 1: Validate CRM token ───────────────────────────────────────────
  if (crm_token !== process.env.PBX_CRM_TOKEN) {
    console.warn(`[WEBHOOK] Неверный crm_token: ${crm_token}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[WEBHOOK] Получен звонок callid=${callid} status=${status} duration=${duration} type=${type} phone=${phone}`);

  // ── Step 2: Skip short / missed / unrecorded calls ────────────────────────
  const durationNum = Number(duration);
  if (status !== 'Success' || durationNum < 10 || !link) {
    console.log(`[WEBHOOK] Пропуск callid=${callid}: status=${status}, duration=${durationNum}, link=${link}`);
    return res.status(200).json({ ok: true });
  }

  // Respond immediately so PBX doesn't retry
  res.status(200).json({ ok: true });

  const meta = { type, duration: durationNum, phone, callid };
  let tmpPath = null;

  try {
    // ── Step 3: Download MP3 ─────────────────────────────────────────────────
    console.log(`[WEBHOOK] Скачиваю запись: ${link}`);
    tmpPath = await downloadMp3(link, callid);
    console.log(`[WEBHOOK] Файл сохранён: ${tmpPath}`);

    // ── Step 4: Transcribe ───────────────────────────────────────────────────
    let transcript = '';
    try {
      console.log('[WEBHOOK] Транскрибирую...');
      transcript = await transcribeAudio(tmpPath);
      console.log(`[WEBHOOK] Транскрипция (${transcript.length} символов)`);
    } catch (whisperErr) {
      console.error(`[WEBHOOK] Ошибка Whisper (callid=${callid}):`, whisperErr.message);
    }

    // ── Step 5: Analyse with GPT ─────────────────────────────────────────────
    console.log('[WEBHOOK] Анализирую транскрипцию...');
    const analysis = await analyzeTranscript(transcript);
    console.log(`[WEBHOOK] Анализ готов. client_name=${analysis.client_name} tags=${analysis.tags.join(', ')} has_next_step=${analysis.has_next_step}`);

    const noteText = buildNoteText(meta, analysis.summary);

    // ── Step 6: Search AmoCRM, create if not found ───────────────────────────
    console.log(`[AMO] Ищу контакт по номеру: ${phone}`);
    let amoResult = null;
    try {
      amoResult = await searchByPhone(phone);
      if (!amoResult) {
        console.log(`[AMO] Контакт не найден, создаю новый контакт и сделку для ${phone}`);
        amoResult = await createContactWithLead(phone);
      }
    } catch (amoErr) {
      console.error(`[AMO] Ошибка поиска/создания (callid=${callid}):`, amoErr.message);
    }

    if (!amoResult) {
      console.warn(`[AMO] Нет данных сущности для ${phone} — пропускаем обогащение.`);
      return;
    }

    const { contactId, leadId } = amoResult;

    // ── Step 7: Post note ────────────────────────────────────────────────────
    try {
      const entityType = leadId ? 'leads' : 'contacts';
      const entityId = leadId ?? contactId;
      await postNote(entityType, entityId, noteText);
      console.log(`[AMO] Заметка добавлена в ${entityType} #${entityId}`);
    } catch (noteErr) {
      console.error(`[AMO] Ошибка публикации заметки (callid=${callid}):`, noteErr.message);
    }

    // ── Step 8: Enrich contact name ──────────────────────────────────────────
    if (analysis.client_name && contactId) {
      try {
        await updateContactName(contactId, analysis.client_name);
        console.log(`[AMO] Имя контакта #${contactId} обновлено: "${analysis.client_name}"`);
      } catch (err) {
        console.error(`[AMO] Ошибка обновления имени контакта:`, err.message);
      }
    }

    // ── Step 9: Enrich lead name ─────────────────────────────────────────────
    if (analysis.client_name && leadId) {
      try {
        const newLeadName = `${analysis.client_name} ${phone}`;
        await updateLeadName(leadId, newLeadName);
        console.log(`[AMO] Название сделки #${leadId} обновлено: "${newLeadName}"`);
      } catch (err) {
        console.error(`[AMO] Ошибка обновления названия сделки:`, err.message);
      }
    }

    // ── Step 10: Update lead tags ────────────────────────────────────────────
    if (analysis.tags.length > 0 && leadId) {
      try {
        await updateLeadTags(leadId, analysis.tags);
        console.log(`[AMO] Теги сделки #${leadId} обновлены: ${analysis.tags.join(', ')}`);
      } catch (err) {
        console.error(`[AMO] Ошибка обновления тегов:`, err.message);
      }
    }

    // ── Step 11: Create follow-up task ───────────────────────────────────────
    if (analysis.has_next_step && analysis.next_step_text && leadId) {
      try {
        const responsibleUserId = await getResponsibleUserId();
        if (responsibleUserId) {
          await createTask(leadId, responsibleUserId, analysis.next_step_text, analysis.next_step_deadline_days);
          console.log(`[AMO] Задача создана в сделке #${leadId}: "${analysis.next_step_text}" (через ${analysis.next_step_deadline_days} дн.)`);
        }
      } catch (err) {
        console.error(`[AMO] Ошибка создания задачи:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[WEBHOOK] Необработанная ошибка (callid=${callid}):`, err.message);
  } finally {
    // ── Cleanup: Delete temp MP3 ─────────────────────────────────────────────
    if (tmpPath) {
      fs.unlink(tmpPath, (err) => {
        if (err) console.warn(`[WEBHOOK] Не удалось удалить temp файл ${tmpPath}:`, err.message);
        else console.log(`[WEBHOOK] Temp файл удалён: ${tmpPath}`);
      });
    }
  }
}
