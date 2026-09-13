# Редактор графа

React + TypeScript + React Flow (`@xyflow/react`), сборка Vite. Workspace: `@canvas/web`.

Работают создание и восстановление пространства, чтение серверного графа, добавление,
перемещение и удаление нод, ввод текста, соединения и viewport.

**Правки пока живут только в памяти.** PUT, debounce, очередь сохранения, обработка конфликтов
и генерация ещё не реализованы. Перезагрузка открывает тот же space и его серверный граф;
локальные несохранённые правки теряются. Интерфейс явно предупреждает об этом.

## Запуск

Node.js 24.x, npm 11.x. Все команды ниже выполняются из корня репозитория.

```sh
npm ci
npm run dev
```

В другом терминале:

```sh
npm run dev:web
```

API: `http://localhost:4001`. Редактор: `http://127.0.0.1:5173`.
Команда `dev:web` сначала собирает contracts. Корневые `dev`, `build` и `test`
по-прежнему относятся к backend.

Для другого адреса API скопируйте `apps/web/.env.example` в `apps/web/.env`, измените
`VITE_API_BASE_URL` и перезапустите Vite. Переменные Vite публичные: секретов в них нет.
Для адресов frontend вне localhost потребуется существующая настройка API `CORS_ORIGINS`.

```sh
npm run typecheck:web
npm run build:web
npm run test:web
npm run check:web
npm test
```

`check:web` проверяет формат frontend, TypeScript, production build и frontend tests.
Он не форматирует файлы. После сборки доступен `npm run preview -w @canvas/web`.

## Поток данных и общий API

`main.tsx` связывает один HTTP client, `spacesApi`, `graphApi` и `spaceLoader`.
`App` показывает loading/error/ready; `GraphEditor` управляет локальным графом через reducer.
Node components получают данные React Flow и стабильные действия через context.

- `api/httpClient.ts`: base URL, headers, JSON body, status, пустые ответы, JSON parsing,
  AbortSignal и извлечение metadata. `ETag`, `Location`, `Retry-After`, `X-Request-Id`
  доступны как обычные поля `meta`. Компоненты не получают raw Response.
- `api/apiError.ts`: единый `ApiRequestError` для network, HTTP, invalid-response,
  ошибки подготовки request и cancellation. Статус, server code и request id сохраняются.
- `api/responseSchemas.ts`: Ajv и ajv-formats проверяют официальные схемы
  `@canvas/contracts`. Компиляция выполняется один раз, данные не исправляются и не очищаются
  молча. Эти библиотеки уже использовались в репозитории; здесь они явно объявлены также
  зависимостями frontend. TypeBox нужен для типов схем.
- Domain API указывает endpoint, body, schema и необходимые headers. Сервер возвращает
  сам ресурс; `{ data, meta }` — результат нашего transport, а не server envelope.

`spaceLoader` объединяет одновременные вызовы загрузки, включая повтор effect в StrictMode.
Созданный id записывается до GET graph. В `localStorage` находится только строка UUID под
ключом `canvas.current-space.v1`. После reload сервер возвращает актуальные данные.
`SPACE_NOT_FOUND` позволяет создать новое пространство; network/5xx не подменяют его новым.
Недоступный storage сопровождается предупреждением.

В `loaded.graph.meta.etag` хранится оригинальный ETag с кавычками. Он относится к загруженной
серверной версии и не меняется от локального ввода.

## Graph и React Flow

`graphModel.ts` отделяет `CanvasGraph` от `GraphData`. `fromPersistedGraph` создаёт независимые
объекты для редактирования; `toPersistedGraph` явно перечисляет допустимые поля, включая
вложенные `position` и `data`. Служебные `selected`, `dragging`, `measured`, handles и callbacks
не попадают в снимок. Сейчас приложение не отправляет этот снимок через PUT.

`connectionRules.ts` — единственное место проверки соединений. `canConnect` используется
в `isValidConnection` и повторно в reducer перед добавлением edge по актуальному state.
Разрешены только `prompt → generator` и `generator → result`; вход один, выход генератора
один, prompt может питать несколько generators. Каждый тип имеет один порт нужного
направления без отдельного handle id. Серверный edge хранит только id/source/target.

`graphState.ts` применяет изменения React Flow и сохраняет ссылки нетронутых объектов.
Удаление кнопкой и удаление клавиатурой используют общий механизм очистки incident edges.
UUID создаётся в обработчике события, reducer остаётся чистым. Ограничения нод, связей,
координат, текста и zoom взяты из contracts.

`NodeFrame` объединяет заголовок, кнопку удаления и порты. `CanvasNodes` содержит три
мемоизированных компонента. Поле текста имеет label и классы `nodrag nopan nowheel`.
Кнопки нативные; focus видим. Viewport controlled, без начального `fitView`, который
перезаписал бы серверное положение камеры. Кнопка «Показать весь граф» доступна отдельно.

## Обработка данных: пример P1/P2

`editPrompt` вызывается на каждое событие изменения текста. `findIndex` ищет только первую
нужную ноду — максимум один проход по 20 элементам. При реальном изменении `slice` создаёт
один плотный массив ссылок длины N, затем заменяется один node object и его data.
Итого: до N проверок id + N копирований ссылок; один массив, одна нода, один data object
и новое верхнее состояние. Остальные ноды, edges и viewport сохраняют прежние ссылки.
При отсутствии изменения возвращается прежний state без копии массива.

Индекс ради одного поиска не строится. `canConnect` за один проход ищет два endpoint,
затем проверяет edges с ранним выходом — без промежуточных массивов и без вложенного find.
Полная serialization вызывается только явно, не на render/keypress/drag.
`nodeTypes`, context actions и основные React Flow callbacks стабильны.
`isValidConnection` обновляется только вместе с nodes/edges, а не при движении viewport.
Удаление делает по одному filter для разных коллекций; это редкое действие, а не цепочка
map/filter над одним массивом. `applyNodeChanges`/`applyEdgeChanges` оставлены библиотечными.
Измеренного ускорения или результатов профилирования не заявляем.

## Проверки и ограничения

20 frontend tests: transport/errors/пустые ответы, domain API, connection rules, удаление,
serialization, сохранение ссылок, ограничения и bootstrap recovery. Один интеграционный
тест запускает настоящий локальный HTTP API: 201 space, GET graph + ETag, восстановление
id/серверного графа и 404. PUT в этом тесте только готовит fixture и проверяет, что backend
принимает очищенный снимок; приложения сохранения это не добавляет.

Проверены TypeScript, production build и исходные 10 API tests, официальный HTTP smoke.
Production build выдаёт предупреждение о едином JS chunk больше 500 kB. Code splitting
пока не добавлен; повышение порога предупреждения его не маскирует.

Браузерный review перетаскивания, портов, keyboard focus и layout на 1280 px ещё требуется.
Упрощённое размещение новых нод не является auto-layout; ноды можно разнести вручную.
`hasLocalChanges` отмечает факт правок, а не сравнение с сервером: ручной возврат значений
не снимает индикатор. Одновременное первое открытие в разных вкладках не координируется.
Если ответ POST space потерян до получения id, повтор может оставить лишнее пространство
на сервере: этот endpoint не предоставляет idempotency. Graph в localStorage не копируется.

Корневые Windows checks имеют исходное различие CRLF/LF в официальных файлах.
Frontend использует локальную `.prettierrc.cjs`: наследует стиль репозитория и задаёт
`endOfLine: auto`, чтобы принимать как LF, так и CRLF после checkout/apply на Windows.
Другие проверки форматирования сохраняются; backend/docs не меняются.

[Задание](../../docs/ASSIGNMENT.md) · [API](../../docs/INTEGRATION.md) ·
[Оценка](../../docs/EVALUATION.md) ·
[Custom nodes](https://reactflow.dev/learn/customization/custom-nodes) ·
[Utility classes](https://reactflow.dev/learn/customization/utility-classes) ·
[React Flow props](https://reactflow.dev/api-reference/react-flow)
