# AI Listener — PBX → Whisper → GPT-4o-mini → AmoCRM

Сервис принимает вебхуки от АТС, скачивает запись звонка, транскрибирует её через Whisper, генерирует AI-резюме и публикует заметку в AmoCRM.

---

## Структура проекта

```
.
├── index.js          # Express-сервер, точка входа
├── src/
│   ├── webhook.js    # Основная логика обработки звонка
│   └── amocrm.js     # AmoCRM API-клиент
├── .env.example      # Шаблон переменных окружения
└── package.json
```

---

## Настройка .env

Скопируйте `.env.example` в `.env` и заполните значения:

```bash
cp .env.example .env
```

| Переменная      | Описание |
|-----------------|----------|
| `PBX_CRM_TOKEN` | Токен, который АТС отправляет в поле `crm_token` — задаётся в настройках АТС |
| `OPENAI_API_KEY` | API-ключ OpenAI (нужен доступ к Whisper и GPT-4o-mini) |
| `AMO_LONG_TOKEN` | Долгосрочный токен AmoCRM (OAuth или личный токен из настроек интеграции) |
| `AMO_SUBDOMAIN`  | Поддомен вашего AmoCRM, например `deniskosharny` |
| `PORT`           | Порт сервера (Railway подставляет автоматически) |

### Как получить AMO_LONG_TOKEN

1. В AmoCRM: **Настройки → Интеграции → API**
2. Создайте интеграцию или используйте уже созданную
3. Скопируйте долгосрочный токен (Long-lived access token)

---

## Локальный запуск

```bash
npm install
cp .env.example .env   # заполните .env
npm run dev            # запуск с --watch (авто-перезагрузка)
```

Проверка работоспособности:
```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Тестовый вебхук:
```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": "history",
    "type": "in",
    "status": "Success",
    "phone": "+37369123456",
    "link": "https://example.com/recording.mp3",
    "callid": "test-001",
    "duration": "120",
    "start": "1700000000",
    "crm_token": "ВАШ_PBX_CRM_TOKEN"
  }'
```

---

## Деплой на Railway

### Шаг 1 — Создать проект

1. Зайдите на [railway.app](https://railway.app) и нажмите **New Project**
2. Выберите **Deploy from GitHub repo** (или **Empty Project** для деплоя через CLI)

### Шаг 2 — Подключить репозиторий

**Вариант A — через GitHub:**
1. Загрузите код в GitHub-репозиторий
2. В Railway: **New Project → Deploy from GitHub repo → выберите репозиторий**

**Вариант B — через Railway CLI:**
```bash
npm install -g @railway/cli
railway login
railway init          # в папке проекта
railway up
```

### Шаг 3 — Добавить переменные окружения

В Dashboard Railway:
1. Откройте ваш сервис → вкладка **Variables**
2. Добавьте все переменные из `.env.example`:
   - `PBX_CRM_TOKEN`
   - `OPENAI_API_KEY`
   - `AMO_LONG_TOKEN`
   - `AMO_SUBDOMAIN`
   - `PORT` — **не добавляйте**, Railway устанавливает его автоматически

### Шаг 4 — Получить публичный URL

1. В Railway: сервис → вкладка **Settings → Networking**
2. Нажмите **Generate Domain**
3. Скопируйте URL вида `https://ai-listener-production.up.railway.app`

### Шаг 5 — Проверить деплой

```bash
curl https://ВАШ_ДОМЕН.up.railway.app/health
# {"status":"ok"}
```

---

## Настройка АТС

После деплоя введите в поле **«Адрес вашей CRM»** в настройках АТС:

```
https://ВАШ_ДОМЕН.up.railway.app/webhook
```

> **Важно:** в поле **«CRM Token»** (или аналогичное поле токена) в настройках АТС  
> введите то же значение, что вы задали в `PBX_CRM_TOKEN`.

---

## Логика обработки звонка

```
АТС → POST /webhook
        │
        ├─ crm_token неверный → 401
        │
        ├─ status != "Success" OR duration < 10 OR нет link → 200 (пропуск)
        │
        ├─ Скачать MP3 → /tmp/call_{id}.mp3
        │
        ├─ Whisper → транскрипт
        │     └─ ошибка → summary = "Транскрипция недоступна"
        │
        ├─ GPT-4o-mini → краткое резюме на русском
        │
        ├─ AmoCRM: поиск контакта по номеру телефона
        │     ├─ найдена сделка → заметка в сделку
        │     ├─ найден контакт → заметка в контакт
        │     └─ не найдено → предупреждение в лог
        │
        └─ Удалить temp файл
```

---

## Устранение неполадок

| Симптом | Причина | Решение |
|---------|---------|---------|
| 401 от сервера | Неверный `crm_token` | Проверьте `PBX_CRM_TOKEN` в `.env` и настройках АТС |
| Заметка не появляется в AmoCRM | Контакт не найден | Проверьте формат номера телефона в AmoCRM |
| «Транскрипция недоступна» | Ошибка OpenAI | Проверьте `OPENAI_API_KEY` и лимиты аккаунта |
| Сервер не стартует | Отсутствует переменная | Смотрите сообщение в логах Railway |
