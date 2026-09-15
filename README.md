# Тестовое задание: канвас на React Flow

Нужно сделать редактор с нодами «текст → генератор → результат», сохранением через REST и имитацией генерации изображения. Бэкенд готов, фронтенд добавьте в `apps/web`.

Для отбора нужно выполнить оба тестовых: [оформление заказа](https://github.com/instatdigital/frontend-checkout-challenge) и [канвас на React Flow](https://github.com/instatdigital/frontend-canvas-challenge). Пришлите ссылки на оба решения.

[Условия задания](docs/ASSIGNMENT.md) · [Работа с API](docs/INTEGRATION.md) · [Критерии оценки](docs/EVALUATION.md)

Главный критерий — обобщение кода и минимум повторяющихся операций. Одинаковые проверки HTTP-ответов и разбор ошибок в компонентах недопустимы. Отдельно оцениваем стоимость обработки данных: лишние проходы, копирования и повторные поиски снижают результат.

## Решение

Frontend-реализация находится в [`apps/web`](./apps/web).

Реализованы редактор React Flow, сохранение графа через ETag/If-Match, последовательная очередь PUT,
`flush()` перед генерацией, восстановление неизвестного результата записи, idempotent generation flow,
polling с `Retry-After`, восстановление после reload и защита от устаревших асинхронных результатов.

Подробное описание архитектуры, API/recovery-механизмов, обработки данных, проверенных сценариев
и известных ограничений находится в [`apps/web/README.md`](./apps/web/README.md).

Frontend-проверки: 75/75 тестов. Исходные 10 backend-тестов и официальный HTTP smoke также проходят.

## Запуск

Потребуются Node.js 24.x и npm 11.x. База данных и ключи внешних сервисов не нужны.

```sh
git clone https://github.com/Alexandr-Dudarin/frontend-canvas-challenge.git
cd frontend-canvas-challenge
npm ci
npm run dev
```

В другом терминале запустите frontend:

```sh
npm run dev:web
```

Frontend: `http://127.0.0.1:5173`.

API: `http://localhost:4001`.

Swagger: [http://localhost:4001/docs/](http://localhost:4001/docs/). Спецификация: [http://localhost:4001/openapi.json](http://localhost:4001/openapi.json) и [файл в репозитории](docs/openapi.json).

В Swagger создайте пространство через `POST /api/spaces`, затем получите его граф. Авторизация не нужна. Все пространства видны в одном локальном экземпляре сервера.

## Структура и команды

```text
apps/api/             бэкенд
apps/web/             frontend-решение
packages/contracts/   схемы API и типы TypeScript
docs/                 задание и документация
scripts/              проверки
```

Frontend workspace называется `@canvas/web`.

Frontend-команды:

```sh
npm run dev:web
npm run typecheck:web
npm run build:web
npm run test:web
npm run check:web
```

`check:web` проверяет форматирование frontend, TypeScript, production build и frontend tests.

Корневые `dev`, `build` и `test` по-прежнему относятся к backend:

```sh
npm run check       # форматирование, сборка, тесты, OpenAPI
npm run build
npm start           # собранный бэкенд
npm run smoke       # проверка по HTTP; API должен работать
```

## Настройки

Адрес API по умолчанию — `127.0.0.1:4001`. При необходимости скопируйте `.env.example` в `.env` и измените `PORT`. Для проверки другого адреса: `BASE_URL=http://localhost:4101 npm run smoke`.

Для другого адреса API во frontend скопируйте `apps/web/.env.example` в `apps/web/.env`, задайте `VITE_API_BASE_URL` и перезапустите Vite.

Фронтенд может работать на любом HTTP-порту `localhost`, `127.0.0.1` или `[::1]`. Другие адреса задаются в `CORS_ORIGINS`. Cookies не нужны.

Данные сохраняются в `.data/store.json`. Используйте один процесс API на один файл. Для сброса остановите сервер и выполните `npm run data:reset`. Если меняли `DATA_FILE`, свой файл удалите вручную при остановленном сервере.

Генерация тестовая: после заданной задержки сервер возвращает локальное SVG-изображение или ошибку сценария. Внешних запросов и списаний нет.
