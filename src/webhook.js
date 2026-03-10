import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import OpenAI from 'openai';
import { searchByPhone, createContactWithLead, postNote } from './amocrm.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SUMMARY_SYSTEM_PROMPT =
  'Ты помощник менеджера по продажам. Проанализируй транскрипцию звонка и напиши краткое резюме для CRM на русском языке. Включи: 1) О чём говорили, 2) Что пообещали клиенту, 3) Следующий шаг. Будь конкретным и кратким.';

const CALL_TYPE_LABEL = { in: 'Входящий', out: 'Исходящий' };

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
 * Build the final CRM note text from metadata + AI summary.
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
    '📝 Резюме звонка:',
    summary,
  ].join('\n');
}

/**
 * Download MP3 from url, stream it to a temp file, return the file path.
 *
 * @param {string} url
 * @param {string} callid  Used to generate a unique filename.
 * @returns {Promise<string>} Absolute path to the temp file.
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
 * Summarise a transcript using GPT-4o-mini.
 *
 * @param {string} transcript
 * @returns {Promise<string>}
 */
async function summariseTranscript(transcript) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    temperature: 0.3,
    max_tokens: 500,
  });

  return completion.choices[0].message.content.trim();
}

/**
 * Post a note to AmoCRM.
 * Tries lead first, falls back to contact, logs warning if nothing found.
 *
 * @param {{ contactId: number, leadId: number|null }|null} amoResult
 * @param {string} noteText
 * @param {string} phone
 * @returns {Promise<void>}
 */
async function postNoteToAmo(amoResult, noteText, phone) {
  if (!amoResult) {
    console.warn(`[AMO] Нет данных сущности для ${phone} — заметка не опубликована.`);
    return;
  }

  if (amoResult.leadId) {
    await postNote('leads', amoResult.leadId, noteText);
    console.log(`[AMO] Заметка добавлена в сделку #${amoResult.leadId}`);
  } else {
    await postNote('contacts', amoResult.contactId, noteText);
    console.log(`[AMO] Заметка добавлена в контакт #${amoResult.contactId}`);
  }
}

/**
 * Express route handler for POST /webhook
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleWebhook(req, res) {
  const { cmd, type, status, phone, link, callid, duration, start, crm_token } = req.body;

  // ── Step 1: Validate CRM token ───────────────────────────────────────────
  if (crm_token !== process.env.PBX_CRM_TOKEN) {
    console.warn(`[WEBHOOK] Неверный crm_token: ${crm_token}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[WEBHOOK] Получен звонок callid=${callid} status=${status} duration=${duration} type=${type} phone=${phone}`);

  // ── Step 2: Skip short / missed / unrecorded calls ────────────────────────
  const durationNum = Number(duration);
  if (status !== 'Success' || durationNum < 10 || !link) {
    console.log(`[WEBHOOK] Пропуск звонка callid=${callid}: status=${status}, duration=${durationNum}, link=${link}`);
    return res.status(200).json({ ok: true });
  }

  // Always answer 200 to PBX — errors are handled internally
  res.status(200).json({ ok: true });

  const meta = { type, duration: durationNum, phone, callid };
  let tmpPath = null;

  try {
    // ── Step 3: Download MP3 ────────────────────────────────────────────────
    console.log(`[WEBHOOK] Скачиваю запись: ${link}`);
    tmpPath = await downloadMp3(link, callid);
    console.log(`[WEBHOOK] Файл сохранён: ${tmpPath}`);

    let summary;

    try {
      // ── Step 4: Transcribe ────────────────────────────────────────────────
      console.log(`[WEBHOOK] Транскрибирую...`);
      const transcript = await transcribeAudio(tmpPath);
      console.log(`[WEBHOOK] Транскрипция (${transcript.length} символов)`);

      // ── Step 5: Summarise ─────────────────────────────────────────────────
      console.log(`[WEBHOOK] Генерирую резюме...`);
      summary = await summariseTranscript(transcript);
      console.log(`[WEBHOOK] Резюме готово`);
    } catch (aiErr) {
      console.error(`[WEBHOOK] Ошибка AI (callid=${callid}):`, aiErr.message);
      summary = 'Транскрипция недоступна (ошибка обработки).';
    }

    const noteText = buildNoteText(meta, summary);

    // ── Step 6: Search AmoCRM, create if not found ──────────────────────────
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

    // ── Steps 7 & 8: Post note ───────────────────────────────────────────────
    try {
      await postNoteToAmo(amoResult, noteText, phone);
    } catch (noteErr) {
      console.error(`[AMO] Ошибка публикации заметки (callid=${callid}):`, noteErr.message);
    }
  } catch (err) {
    console.error(`[WEBHOOK] Необработанная ошибка (callid=${callid}):`, err.message);
  } finally {
    // ── Step 9: Clean up temp file ───────────────────────────────────────────
    if (tmpPath) {
      fs.unlink(tmpPath, (err) => {
        if (err) console.warn(`[WEBHOOK] Не удалось удалить temp файл ${tmpPath}:`, err.message);
        else console.log(`[WEBHOOK] Temp файл удалён: ${tmpPath}`);
      });
    }
  }
}
