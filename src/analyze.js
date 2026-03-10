import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Ты помощник менеджера по продажам. Проанализируй транскрипцию звонка и верни JSON объект со следующими полями:

{
  "client_name": "имя клиента если назвал себя, иначе null",
  "summary": "подробное резюме звонка с эмодзи секциями:\\n📋 Тема звонка: ...\\n💬 Детали разговора: ...\\n💰 Финансовые детали: ... (суммы точно как сказано)\\n✅ Договорённости: ...\\n🎯 Следующий шаг: ...",
  "tags": ["массив тегов из этого списка если применимо: входящий звонок, исходящий звонок, горячий клиент, холодный клиент, перезвонить, квартира, дом, коммерческая недвижимость, жалоба, консультация"],
  "has_next_step": true или false,
  "next_step_text": "текст следующего шага если есть, иначе null",
  "next_step_deadline_days": число дней до дедлайна если упоминался срок (1=завтра, 7=неделя), иначе 1
}`;

/**
 * @typedef {Object} CallAnalysis
 * @property {string|null} client_name
 * @property {string} summary
 * @property {string[]} tags
 * @property {boolean} has_next_step
 * @property {string|null} next_step_text
 * @property {number} next_step_deadline_days
 */

/**
 * Fallback analysis object used when GPT fails or returns unparseable JSON.
 *
 * @param {string} rawText
 * @returns {CallAnalysis}
 */
function fallbackAnalysis(rawText) {
  return {
    client_name: null,
    summary: rawText || 'Транскрипция недоступна (ошибка обработки).',
    tags: [],
    has_next_step: false,
    next_step_text: null,
    next_step_deadline_days: 1,
  };
}

/**
 * Analyse a call transcript with GPT-4o-mini.
 * Returns a structured CallAnalysis object.
 * Falls back gracefully if the model returns non-JSON.
 *
 * @param {string} transcript
 * @returns {Promise<CallAnalysis>}
 */
export async function analyzeTranscript(transcript) {
  let raw;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });

    raw = completion.choices[0].message.content;
  } catch (err) {
    console.error('[ANALYZE] Ошибка вызова OpenAI:', err.message);
    return fallbackAnalysis('');
  }

  try {
    const parsed = JSON.parse(raw);

    return {
      client_name: parsed.client_name ?? null,
      summary: parsed.summary ?? raw,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      has_next_step: Boolean(parsed.has_next_step),
      next_step_text: parsed.next_step_text ?? null,
      next_step_deadline_days: Number(parsed.next_step_deadline_days) || 1,
    };
  } catch (parseErr) {
    console.error('[ANALYZE] Не удалось распарсить JSON от GPT, используем raw текст:', parseErr.message);
    return fallbackAnalysis(raw);
  }
}
