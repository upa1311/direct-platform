# Развёртывание защищённых котировок

## Обязательные внешние ресурсы

1. PostgreSQL/Neon database и `DATABASE_URL`.
2. GitHub OAuth App с callback `https://<production-host>/api/auth/callback/github`.
3. Vercel project, связанный с `upa1311/direct-platform`.
4. Секреты `AUTH_SECRET` и `QUOTE_TOKEN_SECRET` длиной не менее 32 символов.
5. Числовые GitHub user ID в `ADMIN_GITHUB_USER_IDS`.

## Порядок

1. Добавить production environment variables из `.env.example` в Vercel; `AUTH_E2E_CREDENTIAL_SECRET` и `QUOTE_E2E_MODE` в production не добавлять.
2. Выполнить `npm ci` и `npm run db:migrate` с production `DATABASE_URL`.
3. Развернуть приложение и проверить `401` для `/api/quotes` без сессии.
4. Войти через GitHub OAuth allowlisted-пользователем, выполнить живой OSRM-расчёт, явно сохранить котировку и проверить её после reload и повторного deployment.
5. Проверить logout, JSON/CSV exports и отсутствие секретов в клиентских assets.

Схема миграций защищает расчётный снимок PostgreSQL trigger-ом: update разрешён только для `status` и `notes`.
