# Редактор графа

React + TypeScript + React Flow (`@xyflow/react`), сборка Vite. Workspace: `@canvas/web`.

Работают создание и восстановление пространства, чтение серверного графа, добавление,
перемещение и удаление нод, ввод текста, соединения и viewport. Граф сохраняется через
последовательные PUT с debounce 500 мс и актуальным If-Match.

Перезагрузка после состояния «Все изменения сохранены» открывает тот же space и сохранённый
серверный граф. Генерация и изображения пока не реализованы. Незавершённые локальные правки
не переживают закрытие/перезагрузку вкладки: дождитесь подтверждения сохранения.

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
серверной версии. Дальнейшими подтверждёнными ETag владеет save coordinator; локальный ввод
не меняет ETag, и frontend не вычисляет его самостоятельно.

## Graph и React Flow

`graphModel.ts` отделяет `CanvasGraph` от `GraphData`. `fromPersistedGraph` создаёт независимые
объекты для редактирования; `toPersistedGraph` явно перечисляет допустимые поля, включая
вложенные `position` и `data`. Служебные `selected`, `dragging`, `measured`, handles и callbacks
не попадают в снимок. Только этот persisted snapshot передаётся в PUT.

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

## Автосохранение, очередь и recovery

`graphState.ts` увеличивает локальную `revision` только при реальном изменении persisted
полей. Selected, measured, dragging-only и no-op position не создают новую revision.
`useGraphAutosave` хранит последнее committed editor state в ref и сообщает coordinator
номер правки. Полный Graph не сериализуется на каждой букве или drag-событии.

`save/graphSaveCoordinator.ts` владеет одним lifecycle: таймером 500 мс, текущим запросом,
не более чем одним queued snapshot, confirmed ETag, savedRevision и ожидающими `flush()`.
Снимок создаётся только при срабатывании таймера либо `flush()` и отделён от React Flow state.
Новый queued snapshot заменяет предыдущий; начатый PUT сохраняет свой точный снимок.
Следующий PUT начинается после завершения предыдущего и использует его новый ETag.
Response Graph не подставляется обратно в редактор: старый ответ не откатывает новые правки.

`flush()` отменяет debounce, ставит latest snapshot в очередь и возвращает Promise с ETag,
когда target revision подтверждена (возможно, вместе с более новой объединённой revision).
Он ждёт текущий PUT и нужный queued PUT, отклоняется при ошибке/конфликте. Правки, возникшие
уже после вызова, не расширяют target автоматически. Пока нет кнопки генерации — публичный
метод подготовлен и проверен отдельно, сетевой запуск генерации не добавлен.

`GraphSaveStatus` показывает dirty/saving/saved/error/conflict. При error/conflict autosave
приостановлен, редактор доступен, черновик остаётся в памяти. Явное действие «Загрузить версию
с сервера» делает GET и заменяет локальный граф/ETag/baseline. Рядом указано, что локальные
правки будут заменены. Если во время GET появились новые правки, замена не выполняется:
пользователь должен повторить действие сознательно.

`412 GRAPH_VERSION_CONFLICT` не вызывает автоматического PUT. Обычный 4xx означает отказ
до записи; Retry повторяет сохранение latest через `flush()`. Ошибка подготовки request
также не считается commit. Network, HTTP 408/5xx, повреждённый success или неправильный ETag
в ответе PUT могут скрывать успешную запись. Coordinator удерживает attempted snapshot и
один раз выполняет reconciliation GET:

- Совпали persisted fields — принимаем GET ETag, подтверждаем attempted revision и продолжаем очередь.
- Граф другой — сохраняем local draft, показываем конфликт. Автоматического merge/overwrite нет.
- GET тоже не удался — Retry начинает с GET, а не повторяет PUT со старым ETag.

`samePersistedGraph` вызывается только для этой аварийной сверки. Он сравнивает persisted
поля за O(N + E), без stringify/сортировок; порядок arrays учитывается, порядок ключей объектов
и служебные поля — нет. API сохраняет массивы в переданном порядке.

Unmount очищает таймер, отменяет запрос через AbortController и отклоняет ожидающие flush.
Проверка identity текущего request вместе с disposed защищает от позднего ответа даже тогда,
когда транспорт не успел отменить запрос. Abort не отменяет уже выполненную серверную запись.
После нового открытия граф снова читается через GET.

## Обработка данных: пример P1/P2

`editPrompt` вызывается на каждое событие изменения текста. `findIndex` ищет только первую
нужную ноду — максимум один проход по 20 элементам. При реальном изменении `slice` создаёт
один плотный массив ссылок длины N, затем заменяется один node object и его data.
Итого: до N проверок id + N копирований ссылок; один массив, одна нода, один data object
и новое верхнее состояние. Остальные ноды, edges и viewport сохраняют прежние ссылки.
При отсутствии изменения возвращается прежний state без копии массива.

Индекс ради одного поиска не строится. `canConnect` за один проход ищет два endpoint,
затем проверяет edges с ранним выходом — без промежуточных массивов и без вложенного find.
Полная serialization вызывается после debounce или из flush, не на render/keypress/drag.
При возможной persistent правке React Flow reducer дополнительно проходит ссылки nodes/edges
и сравнивает поля только изменившихся объектов; service-only события эту проверку пропускают.
Сравнение отдельных node/edge fields переиспользует те же predicates, что reconciliation.
`nodeTypes`, context actions и основные React Flow callbacks стабильны.
`isValidConnection` обновляется только вместе с nodes/edges, а не при движении viewport.
Удаление делает по одному filter для разных коллекций; это редкое действие, а не цепочка
map/filter над одним массивом. `applyNodeChanges`/`applyEdgeChanges` оставлены библиотечными.
Измеренного ускорения или результатов профилирования не заявляем.

## Проверки и ограничения

42 frontend tests проверяют transport/errors, domain API, правила графа, revision,
reference stability, serialization, bootstrap, debounce, последовательную очередь,
ETag chaining, flush, 412, explicit reload, unknown commit, Retry и cleanup.
Таймеры и задержанные ответы в regression tests управляются вручную, без долгих ожиданий.
Это проверки coordinator/reducer, а не имитация браузерного QA.

Интеграционные тесты запускают настоящий HTTP API: создание пространства, PUT/GET,
нормализованный 412, восстановление сохранённого графа через новый loader. В отдельном
тесте сервер реально отвечает 200 на PUT, после чего тестовый fetch adapter отбрасывает
response; проверяется GET reconciliation, следующий PUT с новым ETag и восстановление.

Проверены TypeScript, production build, исходные 10 API tests и официальный HTTP smoke.
Сценарии генерации внутри исходного backend smoke не означают наличие frontend generation.
Production build выдаёт прежнее предупреждение о едином JS chunk больше 500 kB. Code splitting
пока не добавлен; повышение порога предупреждения его не маскирует.

Базовый редактор и handles проверены локально в браузере. Для нового автосохранения ещё
нужны browser QA: Network/debounce, ввод во время PUT, F5 после saved, две вкладки/412,
ошибка API/Retry, keyboard и layout 1280 px с расширенным сообщением об ошибке.

Ограничения:

- Нет generation, polling, результатов и их восстановления.
- Local draft и attempted PUT snapshot хранятся только в памяти, не в localStorage.
  F5 до saved может потерять неподтверждённые правки. Закрытие не вызывает неявный flush.
- При GET, отличающемся от attempted snapshot, выбирается конфликт даже если PUT вообще
  не дошёл: безопасно определить чужие изменения без дополнительных серверных гарантий нельзя.
- Таймаут приложения отдельно не задан: запрос ждёт завершения fetch или cleanup/Abort.
- Ошибка блокирует autosave до явного Retry; при 4xx сначала исправьте данные.
  Backend ограничивает body 64 КБ, поэтому слишком большой граф может получить 413.
- Упрощённое размещение нод не является auto-layout; разнести ноды можно вручную.
- Одновременное первое создание space в разных вкладках не координируется. Потеря POST
  до получения id может оставить лишнее пространство: этот endpoint не предоставляет idempotency.

Корневые Windows checks имеют исходное различие CRLF/LF в официальных файлах.
Frontend использует локальную `.prettierrc.cjs`: наследует стиль репозитория и задаёт
`endOfLine: auto`, чтобы принимать как LF, так и CRLF после checkout/apply на Windows.
Другие проверки форматирования сохраняются; backend/docs не меняются.

[Задание](../../docs/ASSIGNMENT.md) · [API](../../docs/INTEGRATION.md) ·
[Оценка](../../docs/EVALUATION.md) ·
[Custom nodes](https://reactflow.dev/learn/customization/custom-nodes) ·
[Utility classes](https://reactflow.dev/learn/customization/utility-classes) ·
[React Flow props](https://reactflow.dev/api-reference/react-flow)
